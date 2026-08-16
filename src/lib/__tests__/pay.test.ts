import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Voucher } from '@imani/voucher-send'
import type { VoucherRow } from '@imani/wallet-storage'

import {
  buildSendParams,
  checkSplittable,
  loadPendingSends,
  minSplitStep,
  reconcilePendingSends,
  replaceVoucherToken,
  selectVouchers,
  splitObstacle,
} from '../pay'

// Stand-ins for the wallet store and imani-apps' classic-script API client. The
// reconcile path is the only thing here that reaches for either; every other
// test in this file works on values.
const stubs = vi.hoisted(() => ({
  wallet: {} as Record<string, unknown>,
  api: {} as Record<string, unknown>,
  notified: { count: 0 },
}))

vi.mock('../wallet', () => ({
  getWallet: () => stubs.wallet,
  listVouchers: async () => [],
  notifyWalletChanged: () => {
    stubs.notified.count += 1
  },
}))

vi.mock('../legacyBridge', () => ({ legacyApi: async () => stubs.api }))
import { tokenIdFrom } from '../../../../imani-apps/packages/wallet-storage/src/tokenId'
import type { NUT18VRequest } from '../nap'

/** A €5.00 coupon, the only denomination this stack issues. */
const coupon = (over: Partial<Voucher> = {}): Voucher =>
  ({
    voucher_id: 'v-1',
    token: 'cashuBv2xyz',
    face_value: 500,
    face_unit: 'EUR',
    face_decimals: 2,
    token_amount: 500,
    issuer_id: 'f'.repeat(64),
    status: 'active',
    ...over,
  }) as Voucher

const request = (amount: number): NUT18VRequest =>
  ({
    paymentId: 'pay-1',
    issuerId: 'f'.repeat(64),
    amount,
    unit: 'EUR',
    decimals: 2,
    description: 'Half a punnet',
  }) as unknown as NUT18VRequest

describe('buildSendParams', () => {
  it('sends the requested amount, not the coupon it is taken from', () => {
    // The regression that matters. gateway-core splits for `faceValue` in
    // preference to `amount`, so passing the coupon's 500 here made a €2.50
    // request complete as is_full_send=true: the farmer received the whole
    // €5.00 coupon and the customer got no change back.
    const params = buildSendParams(request(250), coupon())

    expect(params.faceValue).toBe(250)
    expect(params.amount).toBe(250)
    expect(params.faceValue).not.toBe(500)
  })

  it('still agrees with itself when the amounts happen to match', () => {
    // Why the bug survived so long: on an exact-value payment the right and
    // wrong values are the same number, so this case proves nothing on its own.
    const params = buildSendParams(request(500), coupon())
    expect(params.faceValue).toBe(500)
    expect(params.amount).toBe(500)
  })

  it('takes unit and decimals from the coupon, since they describe the money', () => {
    const params = buildSendParams(request(250), coupon({ face_unit: 'XAF', face_decimals: 0 }))

    expect(params.faceUnit).toBe('XAF')
    expect(params.faceDecimals).toBe(0)
    // …but the amount is still the request's.
    expect(params.faceValue).toBe(250)
  })

  it('carries the ids the gateway and the receipt need', () => {
    const params = buildSendParams(request(250), coupon())

    expect(params.token).toBe('cashuBv2xyz')
    expect(params.recipientPubkey).toBe('f'.repeat(64))
    expect(params.voucherId).toBe('v-1')
    expect(params.paymentRequestId).toBe('pay-1')
    expect(params.memo).toBe('Half a punnet')
  })
})

/**
 * A 5000 XAF coupon backed by 200 sats — issuance ratio 25.
 *
 * The EUR coupons this stack issues sit at ratio 1.0, where the minimum split
 * step is one cent and no realistic amount can hit the floor. At ratio 25 the
 * floor is 25 XAF and the guard becomes reachable, which is the only way to
 * test it.
 */
const xaf = (over: Partial<Voucher> = {}): Voucher =>
  ({
    voucher_id: 'v-xaf',
    token: 'cashuBv2xaf',
    face_value: 5000,
    face_unit: 'XAF',
    face_decimals: 0,
    token_amount: 200,
    issuance_ratio: 25,
    issuer_id: 'f'.repeat(64),
    status: 'active',
    ...over,
  }) as Voucher

describe('minSplitStep', () => {
  it('is one sat expressed in face minor units, rounded up', () => {
    expect(minSplitStep(xaf())).toBe(25)
    // Ratio 0.5 would allow half a minor unit per sat; money has no half cent,
    // so the floor never drops below 1.
    expect(minSplitStep(xaf({ issuance_ratio: 0.5 }))).toBe(1)
    expect(minSplitStep(coupon())).toBe(1)
  })

  it('derives the ratio when it was never stored', () => {
    expect(minSplitStep(xaf({ issuance_ratio: undefined }))).toBe(25)
  })
})

describe('checkSplittable', () => {
  it('allows a full send regardless of divisibility', () => {
    // No split happens, so the floor is irrelevant — this is the only way a
    // 1-sat coupon can ever be spent.
    expect(checkSplittable(xaf(), 5000).ok).toBe(true)
    expect(checkSplittable(xaf({ token_amount: 1, issuance_ratio: 5000 }), 5000).ok).toBe(true)
  })

  it('refuses an amount smaller than one sat is worth', () => {
    const check = checkSplittable(xaf(), 10)
    expect(check.ok).toBe(false)
    expect(check.ok === false && check.reason).toContain('25')
  })

  it('allows an amount on the floor', () => {
    expect(checkSplittable(xaf(), 25).ok).toBe(true)
  })

  it('refuses a split that would leave un-splittable dust behind', () => {
    // 4990 of 5000 leaves 10 XAF — less than one sat's worth, so the change
    // could not be issued.
    const check = checkSplittable(xaf(), 4990)
    expect(check.ok).toBe(false)
    expect(check.ok === false && check.reason).toContain('behind')
  })

  it('refuses to split a coupon backed by a single sat', () => {
    const check = checkSplittable(xaf({ token_amount: 1 }), 25)
    expect(check.ok).toBe(false)
    expect(check.ok === false && check.reason).toContain('single sat')
  })

  it('refuses a coupon with no backing at all', () => {
    expect(checkSplittable(xaf({ token_amount: 0 }), 25).ok).toBe(false)
  })

  it('refuses an amount the coupon cannot cover, or a nonsense one', () => {
    expect(checkSplittable(xaf(), 6000).ok).toBe(false)
    expect(checkSplittable(xaf(), 0).ok).toBe(false)
    expect(checkSplittable(xaf(), -25).ok).toBe(false)
  })

  it('does not bite at ratio 1, which is what this stack issues', () => {
    // Guards against over-tightening: a €0.01 payment from a €5.00 coupon is
    // legitimate and must stay allowed.
    expect(checkSplittable(coupon(), 1).ok).toBe(true)
    expect(checkSplittable(coupon(), 250).ok).toBe(true)
  })
})

describe('selectVouchers and splitObstacle', () => {
  it('offers only coupons that can actually produce the amount', () => {
    const divisible = xaf()
    const indivisible = xaf({ voucher_id: 'v-1sat', token_amount: 1 })

    const chosen = selectVouchers([indivisible, divisible], 25)

    expect(chosen).toHaveLength(1)
    expect(chosen[0].voucher_id).toBe('v-xaf')
  })

  it('puts an exact match first, since it needs no split', () => {
    const exact = xaf({ voucher_id: 'v-exact', face_value: 25, token_amount: 1 })
    const chosen = selectVouchers([xaf(), exact], 25)
    expect(chosen[0].voucher_id).toBe('v-exact')
  })

  it('explains the obstacle when nothing qualifies, and stays silent when one does', () => {
    expect(splitObstacle([xaf()], 10)).toContain('25')
    expect(splitObstacle([xaf()], 25)).toBeNull()
    expect(splitObstacle([], 25)).toBeNull()
  })
})

describe('replaceVoucherToken', () => {
  // Long enough to clear looksLikeCashuToken's 22-char minimum.
  const OLD_TOKEN = `cashuB${'o'.repeat(30)}`
  const NEW_TOKEN = `cashuB${'n'.repeat(30)}`

  /**
   * 5000 XAF backed by 200 sats, and NO `voucher_id` — the shape that broke.
   *
   * A row stored without one appears in no `by-voucher-id` index, and `toVoucher`
   * hands callers `voucher_id: row.voucher_id ?? row.token_id`. The old code
   * looked the row up through that index, missed, and then both no-opped the
   * removal and spread nothing onto the change row.
   */
  const sourceRow = (over: Partial<VoucherRow> = {}) =>
    ({
      token_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      voucher_id: undefined,
      token: OLD_TOKEN,
      amount: 200,
      face_value: 5000,
      face_unit: 'XAF',
      face_decimals: 0,
      token_amount: 200,
      issuer_id: 'farmerpubkey',
      issuance_ratio: 25,
      status: 'active',
      created_at: '2026-08-12T09:00:00.000Z',
      updated_at: '2026-08-12T09:00:00.000Z',
      ...over,
    }) as VoucherRow

  function fakeWallet(row: VoucherRow | null) {
    const saved: VoucherRow[] = []
    const removed: string[] = []
    return {
      saved,
      removed,
      wallet: {
        // Keyed by token_id only, like the real store. There is deliberately no
        // by-voucher-id index here: an implementation that reaches for one finds
        // nothing, which is exactly the bug being pinned.
        getVoucher: vi.fn(async (tokenId: string) => (row && tokenId === row.token_id ? row : null)),
        removeVoucher: vi.fn(async (tokenId: string) => {
          removed.push(tokenId)
          return Boolean(row && tokenId === row.token_id)
        }),
        saveVoucher: vi.fn(async (next: VoucherRow) => {
          saved.push(next)
          return next
        }),
      },
    }
  }

  it('removes the spent coupon by its primary key', async () => {
    const row = sourceRow()
    const { wallet, removed } = fakeWallet(row)

    await replaceVoucherToken(wallet, row.token_id, NEW_TOKEN, 2500)

    // The old code passed a voucher_id here and removeVoucher returned false
    // without throwing, leaving the spent coupon listed at full face value.
    expect(removed).toEqual([row.token_id])
  })

  it('carries the issuer and currency onto the change row', async () => {
    const row = sourceRow()
    const { wallet, saved } = fakeWallet(row)

    await replaceVoucherToken(wallet, row.token_id, NEW_TOKEN, 2500)

    // Losing these is what made change coupons render unit-less under the
    // synthetic "unknown" farmer.
    expect(saved[0].issuer_id).toBe('farmerpubkey')
    expect(saved[0].face_unit).toBe('XAF')
    expect(saved[0].face_decimals).toBe(0)
    expect(saved[0].issuance_ratio).toBe(25)
  })

  it('re-keys the change row to the new token', async () => {
    const row = sourceRow()
    const { wallet, saved } = fakeWallet(row)

    await replaceVoucherToken(wallet, row.token_id, NEW_TOKEN, 2500)

    // token_id is content-derived, so a row keeping the old key would claim an
    // id that does not hash to its own token.
    expect(saved[0].token_id).toBe(await tokenIdFrom(NEW_TOKEN))
    expect(saved[0].token_id).not.toBe(row.token_id)
    expect(saved[0].token).toBe(NEW_TOKEN)
  })

  it('moves the sats with the face value', async () => {
    const row = sourceRow()
    const { wallet, saved } = fakeWallet(row)

    await replaceVoucherToken(wallet, row.token_id, NEW_TOKEN, 2500)

    // Half the face left, so half the backing. A row that kept 200 sats against
    // 2500 XAF re-inflates its own face value on the next read — imani-apps'
    // "25 XAF credited as 5000".
    expect(saved[0].face_value).toBe(2500)
    expect(saved[0].token_amount).toBe(100)
    expect(saved[0].amount).toBe(100)
  })

  it('does not invent a voucher_id for a row that had none', async () => {
    const row = sourceRow()
    const { wallet, saved } = fakeWallet(row)

    await replaceVoucherToken(wallet, row.token_id, NEW_TOKEN, 2500)

    // The old code wrote `voucher_id: <whatever the caller held>`, which for
    // this row was a token_id wearing a voucher_id's name.
    expect(saved[0].voucher_id).toBeUndefined()
  })

  it('keeps a real voucher_id when the row has one', async () => {
    const row = sourceRow({ voucher_id: 'bbc1c485-122e-46c6-abc5-ee9f7174ecff' })
    const { wallet, saved } = fakeWallet(row)

    await replaceVoucherToken(wallet, row.token_id, NEW_TOKEN, 2500)

    expect(saved[0].voucher_id).toBe('bbc1c485-122e-46c6-abc5-ee9f7174ecff')
  })

  it('still writes the change token when the row has vanished', async () => {
    const { wallet, saved, removed } = fakeWallet(null)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    await replaceVoucherToken(wallet, 'gone', NEW_TOKEN, 2500)

    // Dropping the replacement would lose real money, so it is written even with
    // no source row to merge — but never silently.
    expect(removed).toEqual([])
    expect(saved[0].token).toBe(NEW_TOKEN)
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })
})

/**
 * The path that pays for a 20s poll being wrong.
 *
 * Staging send as_fc6bd90785a74a9e finished 7m48s after DM_SENT — long after the
 * poll gave up. The gateway was right and the wallet was silent: the farmer had
 * the coupon, the customer's wallet still listed one whose proofs were burnt,
 * their history showed no payment, and £9.00 of change sat unclaimed.
 */
describe('reconcilePendingSends', () => {
  const PK = 'c'.repeat(64)
  const KEEP_TOKEN = `cashuB${'k'.repeat(30)}`
  const KEY = `imani-wallet:pending-sends:${PK}`

  const store = new Map<string, string>()

  const pending = (over: Record<string, unknown> = {}) => ({
    sendId: 'as_fc6bd90785a74a9e',
    tokenId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    amount: 300,
    unit: 'GBP',
    decimals: 2,
    farmerPubkey: 'f'.repeat(64),
    farmerName: 'Hill Farm',
    voucherId: '71fa3948-0f65-4b54-b1eb-09d19a01e210',
    memo: 'Saturday veg box',
    sourceFaceValue: 1200,
    at: Date.now() - 60_000,
    ...over,
  })

  const sourceRow = {
    token_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    token: `cashuB${'o'.repeat(30)}`,
    face_value: 1200,
    face_unit: 'GBP',
    face_decimals: 2,
    token_amount: 1200,
    amount: 1200,
    issuer_id: 'f'.repeat(64),
    status: 'active',
  } as unknown as VoucherRow

  /** @returns what the fake store ended up holding. */
  function wallet(row: VoucherRow | null) {
    const saved: VoucherRow[] = []
    const transactions: Record<string, unknown>[] = []
    const removed: string[] = []
    Object.assign(stubs.wallet, {
      getVoucher: async (id: string) => (row && id === row.token_id ? row : null),
      removeVoucher: async (id: string) => {
        removed.push(id)
        return Boolean(row && id === row.token_id)
      },
      saveVoucher: async (next: VoucherRow) => void saved.push(next),
      addTransaction: async (tx: Record<string, unknown>) => void transactions.push(tx),
    })
    return { saved, transactions, removed }
  }

  beforeEach(() => {
    store.clear()
    stubs.notified.count = 0
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    })
  })

  it('settles a send that completed after the wallet stopped waiting', async () => {
    store.set(KEY, JSON.stringify([pending()]))
    const acked: string[] = []
    Object.assign(stubs.api, {
      getAtomicSendStatus: async () => ({
        status: 'COMPLETED',
        keep_token: KEEP_TOKEN,
        keep_face_value: 900,
      }),
      ackKeepToken: async (id: string) => void acked.push(id),
      reclaimAtomicSend: async () => ({}),
    })
    const { saved, transactions } = wallet(sourceRow)

    expect(await reconcilePendingSends(PK)).toBe(1)

    // The change coupon carries the gateway's face value, not a local
    // subtraction — the split rounds and the token is what it is.
    expect(saved[0].face_value).toBe(900)
    expect(saved[0].token).toBe(KEEP_TOKEN)
    // And the spend is in the history, at the time it was made.
    expect(transactions[0].amount).toBe(300)
    expect(transactions[0].direction).toBe('out')
    // Acked only after the local write, so the gateway keeps the change until
    // this wallet has it.
    expect(acked).toEqual(['as_fc6bd90785a74a9e'])
    expect(loadPendingSends(PK)).toEqual([])
    expect(stubs.notified.count).toBe(1)
  })

  it('keeps waiting on a send that is still in flight', async () => {
    store.set(KEY, JSON.stringify([pending()]))
    Object.assign(stubs.api, {
      getAtomicSendStatus: async () => ({ status: 'DM_SENT' }),
      ackKeepToken: async () => {},
      reclaimAtomicSend: async () => ({}),
    })
    const { saved, transactions, removed } = wallet(sourceRow)

    expect(await reconcilePendingSends(PK)).toBe(0)

    expect([saved, transactions, removed]).toEqual([[], [], []])
    expect(loadPendingSends(PK)).toHaveLength(1)
  })

  it('does not settle twice when the coupon is already gone', async () => {
    store.set(KEY, JSON.stringify([pending()]))
    Object.assign(stubs.api, {
      getAtomicSendStatus: async () => ({ status: 'COMPLETED', keep_token: KEEP_TOKEN }),
      ackKeepToken: async () => {},
      reclaimAtomicSend: async () => ({}),
    })
    // No source row: the live path already settled this one.
    const { saved, transactions } = wallet(null)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(await reconcilePendingSends(PK)).toBe(0)

    // Writing the change again would re-key it from a null row and strip its
    // issuer, unit and decimals.
    expect(saved).toEqual([])
    expect(transactions).toEqual([])
    expect(loadPendingSends(PK)).toEqual([])
    warn.mockRestore()
  })

  it('keeps the record when the gateway cannot be reached', async () => {
    store.set(KEY, JSON.stringify([pending()]))
    Object.assign(stubs.api, {
      getAtomicSendStatus: async () => {
        throw new Error('Failed to fetch')
      },
      ackKeepToken: async () => {},
      reclaimAtomicSend: async () => ({}),
    })
    wallet(sourceRow)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(await reconcilePendingSends(PK)).toBe(0)

    // A network answer is not a payment answer.
    expect(loadPendingSends(PK)).toHaveLength(1)
    error.mockRestore()
  })
})
