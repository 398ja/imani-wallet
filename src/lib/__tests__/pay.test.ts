import { describe, it, expect, vi, beforeEach, onTestFinished } from 'vitest'
import type { Voucher } from '@imani/voucher-send'
import type { VoucherRow } from '@imani/wallet-storage'

import {
  buildSendParams,
  isDeadReplay,
  sendVouchers,
  loadPendingSends,
  payRequest,
  POLL_ATTEMPTS,
  POLL_INTERVAL_MS,
  reconcilePendingSends,
  replaceVoucherToken,
  RETRY_WAIT_MS,
  SendOutcomeUnknownError,
  signedPartOf,
  unreclaimableNote,
  debitFor,
  recordedAmount,
} from '../pay'
import { VoucherFullyRedeemedError } from '../fullyRedeemed'
import { RequestAlreadyPaidError } from '../settledSends'
import { fullyRedeemedRows, spendable, toVoucher } from '../merchants'
import { sendFaceOf } from '../sendFace'

// Stand-ins for the wallet store and imani-apps' classic-script API client. The
// reconcile path is the only thing here that reaches for either; every other
// test in this file works on values.
const stubs = vi.hoisted(() => ({
  wallet: {} as Record<string, unknown>,
  api: {} as Record<string, unknown>,
  notified: { count: 0 },
  /** What `listVouchers` answers. Empty unless a test fills it. */
  rows: [] as unknown[],
  /** Pubkeys `merchantStatus` answers 'merchant' for. Everyone else is a customer. */
  merchants: new Set<string>(),
  /** Pubkeys the relay could not be asked about at all. */
  unreachable: new Set<string>(),
}))

vi.mock('../wallet', () => ({
  getWallet: () => stubs.wallet,
  listVouchers: async () => stubs.rows,
  notifyWalletChanged: () => {
    stubs.notified.count += 1
  },
}))

vi.mock('../legacyBridge', () => ({ legacyApi: async () => stubs.api }))

// The real one reaches a relay for a kind-30078 record. Mocked so the send
// tests stay offline, and so a test can say who is trading as a merchant.
vi.mock('../merchant', () => ({
  merchantStatus: async (pubkey: string) => {
    const key = pubkey.toLowerCase()
    if (stubs.unreachable.has(key)) return 'unknown'
    return stubs.merchants.has(key) ? 'merchant' : 'customer'
  },
}))
// The sender's signature over a transfer (#91), captured at the boundary so a
// test can say WHEN the send path signs, and that a failure there changes
// nothing about the send. transferSignature.test.ts covers the crypto.
const signatures = vi.hoisted(() => ({
  calls: [] as Record<string, unknown>[],
  rejects: false,
}))
vi.mock('../transferSignature', () => ({
  sendTransferSignature: async (p: Record<string, unknown>) => {
    signatures.calls.push(p)
    if (signatures.rejects) throw new Error('relay down')
    return true
  },
}))
import { tokenIdFrom } from '../../../packages/wallet-storage/src/tokenId'
import type { NUT18VRequest } from '../nap'
import { creditableFaceValue, parseVoucherToken } from '../voucherToken'
import { buildLicenceVoucherToken, buildVoucherToken } from './voucherFixtures'

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

const request = (amount: number, over: Partial<NUT18VRequest> = {}): NUT18VRequest =>
  ({
    paymentId: 'pay-1',
    issuerId: 'f'.repeat(64),
    amount,
    unit: 'EUR',
    description: 'Half a punnet',
    ...over,
  }) as unknown as NUT18VRequest

describe('buildSendParams', () => {
  /** What `payRequest` hands the builder for a whole-request payment. */
  const paying = (amount: number) => ({
    amount,
    recipientPubkey: 'f'.repeat(64),
    memo: 'Half a punnet',
    paymentRequestId: 'pay-1',
  })

  it('sends the requested amount, not the voucher it is taken from', () => {
    // The regression that matters. gateway-core splits for `faceValue` in
    // preference to `amount`, so passing the coupon's 500 here made a €2.50
    // request complete as is_full_send=true: the merchant received the whole
    // €5.00 coupon and the customer got no change back.
    const params = buildSendParams(coupon(), paying(250))

    expect(params.faceValue).toBe(250)
    expect(params.amount).toBe(250)
    expect(params.faceValue).not.toBe(500)
  })

  it('still agrees with itself when the amounts happen to match', () => {
    // Why the bug survived so long: on an exact-value payment the right and
    // wrong values are the same number, so this case proves nothing on its own.
    const params = buildSendParams(coupon(), paying(500))
    expect(params.faceValue).toBe(500)
    expect(params.amount).toBe(500)
  })

  it('takes unit and decimals from the voucher, since they describe the money', () => {
    const params = buildSendParams(coupon({ face_unit: 'XAF', face_decimals: 0 }), paying(250))

    expect(params.faceUnit).toBe('XAF')
    expect(params.faceDecimals).toBe(0)
    // …but the amount is still the request's.
    expect(params.faceValue).toBe(250)
  })

  it('carries the ids the gateway and the receipt need', () => {
    const params = buildSendParams(coupon(), paying(250))

    expect(params.token).toBe('cashuBv2xyz')
    expect(params.recipientPubkey).toBe('f'.repeat(64))
    expect(params.voucherId).toBe('v-1')
    expect(params.paymentRequestId).toBe('pay-1')
    expect(params.memo).toBe('Half a punnet')
  })

  it('omits the payment request on a person-to-person send', () => {
    // Not null, not empty — absent. That one field is the whole difference
    // between a redemption and a send at the gateway, and a present-but-empty
    // value is the kind of thing a `!= null` check on the far side lets through.
    const params = buildSendParams(coupon(), {
      amount: 250,
      recipientPubkey: 'd'.repeat(64),
    })

    expect('paymentRequestId' in params).toBe(false)
  })

  it('writes the bundle part id the gateway insists on, or no bundle fields at all', () => {
    // `AtomicSendService.validateBundleMetadata` rejects a part id of any other
    // shape with invalid_bundle_part_id, and rejects a partial set of the five
    // core fields with bundle_metadata_incomplete.
    const id = 'a'.repeat(32)
    const part = buildSendParams(coupon(), {
      amount: 250,
      recipientPubkey: 'd'.repeat(64),
      bundle: { bundleId: id, total: 700, index: 1, count: 2 },
    })

    expect(part.bundlePartId).toBe(`${id}:1`)
    expect(part.bundleTotal).toBe(700)
    expect(part.bundlePartCount).toBe(2)

    const alone = buildSendParams(coupon(), { amount: 250, recipientPubkey: 'd'.repeat(64) })
    expect('bundleId' in alone).toBe(false)
    expect('bundlePartId' in alone).toBe(false)
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
      issuer_id: 'merchantpubkey',
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

  it('removes the spent voucher by its primary key', async () => {
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
    // synthetic "unknown" merchant.
    expect(saved[0].issuer_id).toBe('merchantpubkey')
    expect(saved[0].face_unit).toBe('XAF')
    expect(saved[0].face_decimals).toBe(0)
    expect(saved[0].issuance_ratio).toBe(25)
  })

  it('carries the expiry reminders already filed for the coupon to the change (#269 review)', async () => {
    const row = sourceRow()
    const { wallet } = fakeWallet(row)
    const filedKey = 'imani-wallet:expiry-reminders:' + 'e'.repeat(64)
    const store = new Map<string, string>([[filedKey, JSON.stringify([`coupon-expiring:${row.token_id}:7d`])]])
    vi.stubGlobal('localStorage', {
      get length() { return store.size },
      key: (i: number) => [...store.keys()][i] ?? null,
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    })
    onTestFinished(() => {
      vi.unstubAllGlobals()
    })

    await replaceVoucherToken(wallet, row.token_id, NEW_TOKEN, 2500)

    expect(JSON.parse(localStorage.getItem(filedKey)!)).toContain(
      `coupon-expiring:${await tokenIdFrom(NEW_TOKEN)}:7d`,
    )
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
 * poll gave up. The gateway was right and the wallet was silent: the merchant had
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
    merchantPubkey: 'f'.repeat(64),
    merchantName: 'Hill Farm',
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

  // The one case still written in the old vocabulary, deliberately: a send left
  // in flight by a build that predates the merchant rename stored `farmerPubkey`
  // / `farmerName`, and settling it must not lose who was paid. Delete this
  // alongside `LegacyPendingSend` in lib/pay.ts.
  it('settles a pre-rename pending send without losing the counterparty', async () => {
    const { merchantPubkey, merchantName, ...rest } = pending()
    store.set(KEY, JSON.stringify([{ ...rest, farmerPubkey: merchantPubkey, farmerName: merchantName }]))
    Object.assign(stubs.api, {
      getAtomicSendStatus: async () => ({
        status: 'COMPLETED',
        keep_token: KEEP_TOKEN,
        keep_face_value: 900,
      }),
      ackKeepToken: async () => {},
      reclaimAtomicSend: async () => ({}),
    })
    const { transactions } = wallet(sourceRow)

    expect(await reconcilePendingSends(PK)).toBe(1)

    expect(transactions[0].merchantId).toBe(merchantPubkey)
    expect(transactions[0].merchantName).toBe(merchantName)
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

  it('does not settle twice when the voucher is already gone', async () => {
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

  // #552: the gateway retries these by itself, so they are still in flight, not an end. Before,
  // reconcile took DM_ERROR and SPLIT_ERROR as terminal, tried a reclaim that always failed, and
  // dropped the record, losing track of a send the gateway delivered a minute later.
  it.each(['DM_ERROR', 'DM_RETRY_PENDING', 'SPLIT_ERROR'])(
    'keeps waiting on a send the gateway is retrying (%s), and never reclaims it',
    async (state) => {
      store.set(KEY, JSON.stringify([pending()]))
      const reclaims: string[] = []
      Object.assign(stubs.api, {
        getAtomicSendStatus: async () => ({ status: state, keep_token: KEEP_TOKEN, keep_face_value: 900 }),
        ackKeepToken: async () => {},
        reclaimAtomicSend: async (id: string) => void reclaims.push(id),
      })
      const { saved, transactions, removed } = wallet(sourceRow)

      expect(await reconcilePendingSends(PK)).toBe(0)

      expect([saved, transactions, removed, reclaims]).toEqual([[], [], [], []])
      expect(loadPendingSends(PK)).toHaveLength(1)
    },
  )

  // #552: a send the gateway gave back has its change applied and acked, with no reclaim call
  // and no row for the returned part (that arrives as a DM and dm-poll files it).
  it.each(['RECLAIM_READY', 'RECLAIMED'])(
    'applies the change of a send the gateway gave back (%s), and forgets it',
    async (state) => {
      store.set(KEY, JSON.stringify([pending()]))
      const reclaims: string[] = []
      const acked: string[] = []
      Object.assign(stubs.api, {
        getAtomicSendStatus: async () => ({
          status: state,
          keep_token: KEEP_TOKEN,
          keep_face_value: 900,
          is_full_send: false,
        }),
        ackKeepToken: async (id: string) => void acked.push(id),
        reclaimAtomicSend: async (id: string) => void reclaims.push(id),
      })
      const { saved, transactions, removed } = wallet(sourceRow)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

      expect(await reconcilePendingSends(PK)).toBe(0)

      expect(saved).toHaveLength(1)
      expect(saved[0]).toMatchObject({ token: KEEP_TOKEN, face_value: 900, issuer_id: sourceRow.issuer_id })
      expect(removed).toEqual([sourceRow.token_id])
      expect(transactions).toEqual([])
      expect(reclaims).toEqual([])
      expect(acked).toEqual(['as_fc6bd90785a74a9e'])
      expect(loadPendingSends(PK)).toEqual([])
      warn.mockRestore()
    },
  )

  it('removes the source of a returned full send, and writes nothing for the part', async () => {
    store.set(KEY, JSON.stringify([pending({ amount: 1200 })]))
    Object.assign(stubs.api, {
      getAtomicSendStatus: async () => ({ status: 'RECLAIMED', is_full_send: true }),
      ackKeepToken: async () => {},
    })
    const { saved, transactions, removed } = wallet(sourceRow)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await reconcilePendingSends(PK)

    expect(removed).toEqual([sourceRow.token_id])
    expect(saved).toEqual([])
    expect(transactions).toEqual([])
    warn.mockRestore()
  })

  // Nothing says what the source is worth now, so it stays: a coupon shown but spent is refused
  // by the mint on its next use, one deleted while it holds value is money the customer loses.
  it('leaves the source alone when a returned partial send carries no change', async () => {
    store.set(KEY, JSON.stringify([pending()]))
    const acked: string[] = []
    Object.assign(stubs.api, {
      getAtomicSendStatus: async () => ({ status: 'RECLAIMED' }),
      ackKeepToken: async (id: string) => void acked.push(id),
    })
    const { saved, removed } = wallet(sourceRow)
    const quiet = [vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')].map((s) => s.mockImplementation(() => {}))

    await reconcilePendingSends(PK)

    expect([saved, removed, acked]).toEqual([[], [], []])
    quiet.forEach((s) => s.mockRestore())
  })
})

describe('payRequest and expiry', () => {
  const merchant = { pubkey: 'f'.repeat(64), name: 'Shop', groups: [], voucherCount: 0 }
  const payer = 'c'.repeat(64)

  it('refuses a request that has already lapsed', async () => {
    const lapsed = request(500, { expiresAt: Math.floor(Date.now() / 1000) - 1 })

    await expect(
      payRequest({ request: lapsed, raw: 'vreqA…', merchant, payer }),
    ).rejects.toThrow(/expired/i)
  })

  it('does not refuse one that is still live', async () => {
    // Reaches the gateway client and fails there instead — which is the point:
    // the guard let it through. A live request must not be stopped by expiry.
    const live = request(500, { expiresAt: Math.floor(Date.now() / 1000) + 3600 })

    await expect(
      payRequest({ request: live, raw: 'vreqA…', merchant, payer }),
    ).rejects.toThrow(/Gateway API client is not loaded/)
  })
})


describe('sendVouchers and payRequest', () => {
  const PAYER = 'c'.repeat(64)
  const FRIEND = 'd'.repeat(64)
  const ISSUER = 'f'.repeat(64)

  const merchant = { pubkey: ISSUER, name: 'Hill Farm', groups: [], voucherCount: 0 }

  const row = (over: Record<string, unknown> = {}) =>
    ({
      token_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      token: `cashuB${'o'.repeat(30)}`,
      voucher_id: 'v-1',
      face_value: 1000,
      face_unit: 'EUR',
      face_decimals: 2,
      token_amount: 1000,
      amount: 1000,
      issuer_id: ISSUER,
      status: 'active',
      ...over,
    }) as unknown as VoucherRow

  /** @returns what the fake store ended up holding. */
  function wallet(rows: VoucherRow[]) {
    const transactions: Record<string, unknown>[] = []
    const removed: string[] = []
    Object.assign(stubs.wallet, {
      getVoucher: async (id: string) => rows.find((r) => r.token_id === id) ?? null,
      removeVoucher: async (id: string) => {
        removed.push(id)
        return rows.some((r) => r.token_id === id)
      },
      saveVoucher: async () => {},
      addTransaction: async (tx: Record<string, unknown>) => void transactions.push(tx),
    })
    return { transactions, removed }
  }

  /** A gateway that accepts everything and reports the send already complete. */
  function gateway() {
    const sent: Array<Record<string, unknown>> = []
    Object.assign(stubs.api, {
      initiateAtomicSend: async (params: Record<string, unknown>) => {
        sent.push(params)
        return { send_id: `as_${sent.length}`, status: 'COMPLETED' }
      },
      getAtomicSendStatus: async () => ({ status: 'COMPLETED' }),
      ackKeepToken: async () => {},
      reclaimAtomicSend: async () => ({}),
    })
    return sent
  }

  beforeEach(() => {
    stubs.rows = []
    stubs.notified.count = 0
    stubs.merchants.clear()
    stubs.unreachable.clear()
    // A send left in flight by an earlier test would hold its coupon out of this one (#128).
    localStorage.removeItem(`imani-wallet:pending-sends:${PAYER}`)
    // #461: and the settled ledger, or a send id reused by a later test reads as a replay.
    localStorage.removeItem(`imani-wallet:settled-sends:${PAYER}`)
  })

  // Review of #340: every send is counted by the spend gate, and refused once a
  // logout (here or in another tab) has closed it, before the gateway is asked.
  it('a send and a payment are refused while logout has spends closed, and nothing moves', async () => {
    const gate = await import('../receiveGate')
    stubs.rows = [row()]
    const sent = gateway()
    wallet([row()])
    gate.closeSpends()
    try {
      await expect(
        sendVouchers({ payer: PAYER, recipient: { pubkey: FRIEND }, merchant, unit: 'EUR', amount: 250 }),
      ).rejects.toThrow(gate.SPEND_PAUSED_MESSAGE)
      await expect(
        payRequest({ request: request(250, { issuerId: ISSUER, unit: 'EUR' }), raw: 'vreqA', merchant, payer: PAYER }),
      ).rejects.toThrow(gate.SPEND_PAUSED_MESSAGE)
      expect(sent).toEqual([])
    } finally {
      gate.openSpends()
    }
  })

  it('a send is counted by the spend gate while it runs', async () => {
    const gate = await import('../receiveGate')
    stubs.rows = [row()]
    let during = -1
    gateway()
    const initiate = stubs.api.initiateAtomicSend as (p: Record<string, unknown>) => Promise<unknown>
    stubs.api.initiateAtomicSend = async (p: Record<string, unknown>) => {
      during = gate.spendsInFlight()
      return initiate(p)
    }
    wallet([row()])
    await sendVouchers({ payer: PAYER, recipient: { pubkey: FRIEND }, merchant, unit: 'EUR', amount: 250 })
    expect(during).toBe(1)
    expect(gate.spendsInFlight()).toBe(0)
  })

  it('refuses to send to yourself', async () => {
    // Not a no-op: the saga burns the source voucher and hands back an equal
    // one, costing a round trip and a mint fee to end up where you started.
    await expect(
      sendVouchers({
        payer: PAYER,
        recipient: { pubkey: PAYER.toUpperCase() },
        merchant,
        unit: 'EUR',
        amount: 500,
      }),
    ).rejects.toThrow(/yourself/i)
  })

  it("refuses another merchant's voucher to a merchant, before anything moves", async () => {
    // A coupon is a claim on ONE stall. This one is Hill Farm's, and the
    // recipient runs a different one — they could not honour it if it arrived.
    const OTHER_STALL = 'e'.repeat(64)
    stubs.merchants.add(OTHER_STALL)
    stubs.rows = [row()]
    const sent = gateway()
    wallet([row()])

    await expect(
      sendVouchers({
        payer: PAYER,
        recipient: { pubkey: OTHER_STALL },
        merchant,
        unit: 'EUR',
        amount: 250,
      }),
    ).rejects.toThrow(/only accepts vouchers they issued/i)

    // The refusal has to land before the first part, or the mint has already
    // burned proofs for a coupon that was never allowed to go.
    expect(sent).toHaveLength(0)
  })

  it('lets a merchant have their own voucher back', async () => {
    stubs.merchants.add(ISSUER)
    stubs.rows = [row()]
    const sent = gateway()
    wallet([row()])

    await sendVouchers({
      payer: PAYER,
      recipient: { pubkey: ISSUER.toUpperCase() }, // Case must not decide this.
      merchant,
      unit: 'EUR',
      amount: 250,
    })

    expect(sent).toHaveLength(1)
  })

  it('refuses a stranger when it cannot find out who they are', async () => {
    // Fail-closed. The relay is unreachable, so nothing is known about this
    // key — and a coupon that lands on a stall that cannot honour it is money
    // the customer no longer holds. A blocked send is retried in a minute.
    const STRANGER = 'd'.repeat(64)
    stubs.unreachable.add(STRANGER)
    stubs.rows = [row()]
    const sent = gateway()
    wallet([row()])

    await expect(
      sendVouchers({
        payer: PAYER,
        recipient: { pubkey: STRANGER },
        merchant,
        unit: 'EUR',
        amount: 250,
      }),
    ).rejects.toThrow(/could not check who you are sending to/i)

    expect(sent).toHaveLength(0)
  })

  it('#540 F5: asks nothing about a gift link key (never a stall)', async () => {
    // The lookup would fail closed here; for a link it is not made at all.
    const LINK = 'e'.repeat(64)
    stubs.unreachable.add(LINK)
    stubs.rows = [row()]
    const sent = gateway()
    wallet([row()])

    await sendVouchers({
      payer: PAYER,
      recipient: { pubkey: LINK, name: 'Link' },
      merchant,
      unit: 'EUR',
      amount: 250,
      link: { k: 'k', x: 1_900_000_000, status: 'outstanding' },
    })

    expect(sent).toHaveLength(1)
  })

  it('still redeems at the issuer while the relay is down', async () => {
    // What stops fail-closed from being a wallet that cannot send: paying the
    // issuer their own coupon is the case a market stall lives on, and it is
    // settled before anything is asked of the network.
    stubs.unreachable.add(ISSUER)
    stubs.rows = [row()]
    const sent = gateway()
    wallet([row()])

    await sendVouchers({
      payer: PAYER,
      recipient: { pubkey: ISSUER },
      merchant,
      unit: 'EUR',
      amount: 250,
    })

    expect(sent).toHaveLength(1)
  })

  it('lets a customer have anything', async () => {
    // FRIEND has published no merchant record, so there is nothing to check
    // against — a customer may be sent any stall's coupon.
    stubs.rows = [row()]
    const sent = gateway()
    wallet([row()])

    await sendVouchers({
      payer: PAYER,
      recipient: { pubkey: FRIEND },
      merchant,
      unit: 'EUR',
      amount: 250,
    })

    expect(sent).toHaveLength(1)
  })

  it('sends the amount asked for, to the person, with no payment request', async () => {
    stubs.rows = [row()]
    const sent = gateway()
    wallet([row()])

    await sendVouchers({
      payer: PAYER,
      recipient: { pubkey: FRIEND, name: 'Ama' },
      merchant,
      unit: 'EUR',
      amount: 250,
    })

    // The same invariant `buildSendParams` protects: gateway-core splits for
    // `faceValue ?? amount`, so the source voucher's 1000 here would send the
    // whole voucher and return no change.
    expect(sent[0].faceValue).toBe(250)
    expect(sent[0].amount).toBe(250)
    expect(sent[0].recipientPubkey).toBe(FRIEND)
    // The one thing that makes this a person-to-person send rather than a
    // redemption.
    expect(sent[0].paymentRequestId).toBeUndefined()
  })

  it('records the issuer as the merchant and the recipient as the counterparty', async () => {
    stubs.rows = [row()]
    gateway()
    const { transactions } = wallet([row()])

    await sendVouchers({
      payer: PAYER,
      recipient: { pubkey: FRIEND, name: 'Ama' },
      merchant,
      unit: 'EUR',
      amount: 250,
    })

    const tx = transactions[0]
    expect(tx.type).toBe('sent')
    expect(tx.direction).toBe('out')
    // The split that keeps a friend off the home deck: `withPastMerchants` turns
    // a transaction counterparty into a merchant card, so the ISSUER goes in
    // `merchantId` and the friend in `counterparty`.
    expect(tx.merchantId).toBe(ISSUER)
    expect(tx.counterparty).toBe(FRIEND)
    expect(tx.recipientName).toBe('Ama')
  })

  it('will not spend a voucher in another currency', async () => {
    // A voucher cannot be split across units, so a merchant selling in two of
    // them holds two separate balances. Without the filter, "5.00" typed against
    // the EUR balance goes out as 5 SAT from whichever voucher sorts first.
    stubs.rows = [row({ face_unit: 'SAT', face_decimals: 0, face_value: 5000 })]
    const sent = gateway()
    wallet([])

    await expect(
      sendVouchers({
        payer: PAYER,
        recipient: { pubkey: FRIEND },
        merchant,
        unit: 'EUR',
        amount: 250,
      }),
    ).rejects.toThrow(/no EUR voucher/)
    expect(sent).toEqual([])
  })

  it('walks past a voucher whose previous send is still in flight', async () => {
    // On this stack that state is permanent for any send that failed at DM
    // delivery, since reclaim is unavailable — one stuck voucher must not block
    // a wallet holding good ones.
    const busy = row({ token_id: 'b'.repeat(32), voucher_id: 'v-busy', face_value: 400 })
    const good = row({ token_id: 'g'.repeat(32), voucher_id: 'v-good', face_value: 600 })
    stubs.rows = [busy, good]
    const tried: string[] = []
    Object.assign(stubs.api, {
      initiateAtomicSend: async (params: Record<string, unknown>) => {
        tried.push(String(params.voucherId))
        if (params.voucherId === 'v-busy') {
          throw new Error('An active send already exists for voucher v-busy')
        }
        return { send_id: 'as_2', status: 'COMPLETED' }
      },
      getAtomicSendStatus: async () => ({ status: 'COMPLETED' }),
      ackKeepToken: async () => {},
      reclaimAtomicSend: async () => ({}),
    })
    const { transactions } = wallet([busy, good])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await sendVouchers({
      payer: PAYER,
      recipient: { pubkey: FRIEND },
      merchant,
      unit: 'EUR',
      amount: 250,
    })

    // Smallest first, so the busy one is reached before the good one.
    expect(tried).toEqual(['v-busy', 'v-good'])
    expect(transactions[0].voucherId).toBe('v-good')
    warn.mockRestore()
  })

  it('walks past a voucher the gateway refuses as expired (#157)', async () => {
    // A coupon whose stored expiry nobody can read is spent FIRST, in case it
    // is about to lapse. If it already has, the gateway says so, and that must
    // cost one refused attempt, not the payment: the next coupon pays.
    const odd = row({ token_id: 'o'.repeat(32), voucher_id: 'v-odd', face_value: 600, expires_at: 'garbled' as never })
    const good = row({ token_id: 'g'.repeat(32), voucher_id: 'v-good', face_value: 600 })
    stubs.rows = [odd, good]
    const tried: string[] = []
    Object.assign(stubs.api, {
      initiateAtomicSend: async (params: Record<string, unknown>) => {
        tried.push(String(params.voucherId))
        if (params.voucherId === 'v-odd') throw new Error('Voucher has expired')
        return { send_id: 'as_3', status: 'COMPLETED' }
      },
      getAtomicSendStatus: async () => ({ status: 'COMPLETED' }),
      ackKeepToken: async () => {},
      reclaimAtomicSend: async () => ({}),
    })
    const { transactions } = wallet([odd, good])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await sendVouchers({
      payer: PAYER,
      recipient: { pubkey: FRIEND },
      merchant,
      unit: 'EUR',
      amount: 250,
    })

    expect(tried).toEqual(['v-odd', 'v-good'])
    expect(transactions[0].voucherId).toBe('v-good')
    warn.mockRestore()
  })

  /** Three coupons no one of which covers 1000 — the reason bundles exist. */
  const trio = () => [
    row({ token_id: '1'.repeat(32), voucher_id: 'v-1', face_value: 400, token_amount: 400 }),
    row({ token_id: '2'.repeat(32), voucher_id: 'v-2', face_value: 400, token_amount: 400 }),
    row({ token_id: '3'.repeat(32), voucher_id: 'v-3', face_value: 400, token_amount: 400 }),
  ]

  it('sends one coupon, with no bundle metadata, when one will do', async () => {
    // The gateway rejects a half-filled metadata set (`bundle_metadata_incomplete`)
    // and glues consecutive sends into a synthetic bundle of its own when it sees
    // none — so a single send has to carry nothing at all, not empty fields.
    stubs.rows = [row()]
    const sent = gateway()
    wallet([row()])

    const result = await sendVouchers({
      payer: PAYER,
      recipient: { pubkey: FRIEND },
      merchant,
      unit: 'EUR',
      amount: 250,
    })

    expect(result).toMatchObject({ requested: 250, delivered: 250, parts: 1 })
    expect(result.shortfall).toBeUndefined()
    expect(sent).toHaveLength(1)
    expect(sent[0].bundleId).toBeUndefined()
    expect(sent[0].bundlePartId).toBeUndefined()
  })

  /**
   * Owner report 2026-11-17, at the send door with stored rows (`expires_at` epoch seconds, a
   * number, as perf/snapshots/coupons-20.json holds it). Before: the 10.00 coupon covered 5.00 on its
   * own and was spent whole while the 2.00 coupon expiring in three days was left to lapse.
   */
  it('spends a smaller coupon expiring sooner first, the rest from the next', async () => {
    const now = Math.floor(Date.now() / 1000)
    const rows = () => [
      row({ token_id: '7'.repeat(32), voucher_id: 'v-late', face_value: 1000, token_amount: 1000, expires_at: now + 300 * 86_400 } as Partial<VoucherRow>),
      row({ token_id: '8'.repeat(32), voucher_id: 'v-soon', face_value: 200, token_amount: 200, expires_at: now + 3 * 86_400 } as Partial<VoucherRow>),
    ]
    stubs.rows = rows()
    const sent = gateway()
    wallet(rows())

    const result = await sendVouchers({ payer: PAYER, recipient: { pubkey: FRIEND }, merchant, unit: 'EUR', amount: 500 })

    expect(result).toMatchObject({ requested: 500, delivered: 500, parts: 2 })
    expect(sent.map((s) => [s.voucherId, s.amount])).toEqual([
      ['v-soon', 200],
      ['v-late', 300],
    ])
  })

  it('draws across several coupons and tags every part of the bundle', async () => {
    stubs.rows = trio()
    const sent = gateway()
    wallet(trio())

    const result = await sendVouchers({
      payer: PAYER,
      recipient: { pubkey: FRIEND },
      merchant,
      unit: 'EUR',
      amount: 1000,
    })

    expect(result).toMatchObject({ requested: 1000, delivered: 1000, parts: 3 })
    expect(sent.map((s) => s.amount)).toEqual([400, 400, 200])

    // 32 lowercase hex, because dm-poll's TokenParser matches
    // `Bundle-Id: /([0-9a-f]{32})/` — any other shape and the recipient sees
    // three unexplained vouchers instead of one arrival of 10.00.
    expect(result.id).toMatch(/^[0-9a-f]{32}$/)
    expect(new Set(sent.map((s) => s.bundleId))).toEqual(new Set([result.id]))

    sent.forEach((part, index) => {
      expect(part.bundleTotal).toBe(1000)
      expect(part.bundlePartIndex).toBe(index)
      expect(part.bundlePartCount).toBe(3)
      // AtomicSendService.validateBundleMetadata refuses anything else with
      // `invalid_bundle_part_id`; the format is the gateway's, not ours.
      expect(part.bundlePartId).toBe(`${result.id}:${index}`)
    })
  })

  it('reports what landed when a later part fails, instead of throwing', async () => {
    // The first two parts are gone: proofs burnt at the mint, NIP-17 DMs
    // published. An exception here reads as "nothing happened" on the confirm
    // screen and invites a second send on top of money that already left.
    stubs.rows = trio()
    const tried: string[] = []
    Object.assign(stubs.api, {
      initiateAtomicSend: async (params: Record<string, unknown>) => {
        tried.push(String(params.voucherId))
        if (tried.length === 3) throw new Error('mint refused the split')
        return { send_id: `as_${tried.length}`, status: 'COMPLETED' }
      },
      getAtomicSendStatus: async () => ({ status: 'COMPLETED' }),
      ackKeepToken: async () => {},
      reclaimAtomicSend: async () => ({}),
    })
    const { transactions } = wallet(trio())

    const result = await sendVouchers({
      payer: PAYER,
      recipient: { pubkey: FRIEND },
      merchant,
      unit: 'EUR',
      amount: 1000,
    })

    expect(result).toMatchObject({ requested: 1000, delivered: 800, parts: 2 })
    expect(result.shortfall).toMatch(/mint refused/)
    // Two parts delivered means two rows in the history, both filed under the
    // same bundle so the screens can present them as one send.
    expect(transactions).toHaveLength(2)
    expect(transactions.map((t) => t.bundleId)).toEqual([result.id, result.id])
  })

  // #125: one failed status read while the last part settles must not report that part as
  // unsent. The gateway completed it; "send the difference again" would pay it twice.
  it('counts a part delivered when a status read fails once on the way', async () => {
    stubs.rows = trio()
    const FAILING_READ = 3
    let reads = 0
    Object.assign(stubs.api, {
      initiateAtomicSend: async (params: Record<string, unknown>) => ({
        send_id: `as_${String(params.bundlePartIndex)}`,
        status: 'PENDING',
      }),
      getAtomicSendStatus: async () => {
        reads += 1
        if (reads === FAILING_READ) throw new TypeError('Failed to fetch')
        return { status: 'COMPLETED' }
      },
      ackKeepToken: async () => {},
      reclaimAtomicSend: async () => ({}),
    })
    wallet(trio())
    const quietWarnings = vi.spyOn(console, 'warn').mockImplementation(() => {})
    onTestFinished(() => quietWarnings.mockRestore())

    const result = await sendVouchers({
      payer: PAYER,
      recipient: { pubkey: FRIEND },
      merchant,
      unit: 'EUR',
      amount: 1000,
    })

    expect(result).toMatchObject({ requested: 1000, delivered: 1000, parts: 3 })
    expect(result.shortfall).toBeUndefined()
    expect(result.inFlight).toBeUndefined()
  })

  // #125: a bundle part whose status cannot be read for the whole wait is IN FLIGHT: it may
  // have arrived, so it is reported apart from what was delivered and the bundle stops there.
  it('reports a bundle part it could not confirm as in flight, not as unsent', async () => {
    stubs.rows = trio()
    const tried: number[] = []
    Object.assign(stubs.api, {
      initiateAtomicSend: async (params: Record<string, unknown>) => {
        tried.push(Number(params.bundlePartIndex))
        return { send_id: `as_${String(params.bundlePartIndex)}`, status: 'PENDING' }
      },
      getAtomicSendStatus: async (sendId: string) => {
        if (sendId === 'as_1') throw new TypeError('Failed to fetch')
        return { status: 'COMPLETED' }
      },
      ackKeepToken: async () => {},
      reclaimAtomicSend: async () => ({}),
    })
    wallet(trio())
    const quietWarnings = vi.spyOn(console, 'warn').mockImplementation(() => {})
    onTestFinished(() => quietWarnings.mockRestore())
    vi.useFakeTimers()
    try {
      const sending = sendVouchers({
        payer: PAYER,
        recipient: { pubkey: FRIEND },
        merchant,
        unit: 'EUR',
        amount: 1000,
      })
      await vi.runAllTimersAsync()
      const result = await sending

      expect(result).toMatchObject({ requested: 1000, delivered: 400, inFlight: 400, parts: 2 })
      expect(result.shortfall).toMatch(/still going through.*could not confirm/s)
      expect(tried).toEqual([0, 1])
    } finally {
      vi.useRealTimers()
    }
  })

  // #552, the 2026-11-07 staging incident: one part's relay publish failed (DM_ERROR) and the
  // gateway delivered it by itself 57 s later. The wallet used to call DM_ERROR the end, stop
  // the bundle and leave the stall paid in part. It now waits the retry out and sends the rest.
  it('waits out a part the gateway is retrying and delivers the whole bundle', async () => {
    stubs.rows = trio()
    const tried: number[] = []
    const reclaims: string[] = []
    let retryingUntil = 0
    Object.assign(stubs.api, {
      initiateAtomicSend: async (params: Record<string, unknown>) => {
        const index = Number(params.bundlePartIndex)
        tried.push(index)
        if (index === 1) retryingUntil = Date.now() + 57_000
        return { send_id: `as_${index}`, status: 'PENDING' }
      },
      getAtomicSendStatus: async (sendId: string) =>
        sendId === 'as_1' && Date.now() < retryingUntil
          ? { status: 'DM_ERROR', error_code: 'RELAY_PUBLISH_FAILED' }
          : { status: 'COMPLETED' },
      ackKeepToken: async () => {},
      reclaimAtomicSend: async (id: string) => void reclaims.push(id),
    })
    wallet(trio())
    vi.useFakeTimers()
    try {
      const sending = sendVouchers({ payer: PAYER, recipient: { pubkey: FRIEND }, merchant, unit: 'EUR', amount: 1000 })
      await vi.runAllTimersAsync()
      const result = await sending

      expect(result).toMatchObject({ requested: 1000, delivered: 1000, parts: 3 })
      expect(result.shortfall).toBeUndefined()
      expect(tried).toEqual([0, 1, 2])
      expect(reclaims).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  // #552: a retry that outlasts even the longer wait is reported as in flight, never as a
  // failure, and nothing after it is tried: it may still arrive.
  it('reports a part still retrying after the longer wait as in flight, not as unsent', async () => {
    stubs.rows = trio()
    const tried: number[] = []
    Object.assign(stubs.api, {
      initiateAtomicSend: async (params: Record<string, unknown>) => {
        tried.push(Number(params.bundlePartIndex))
        return { send_id: `as_${String(params.bundlePartIndex)}`, status: 'PENDING' }
      },
      getAtomicSendStatus: async (sendId: string) =>
        sendId === 'as_1' ? { status: 'DM_RETRY_PENDING' } : { status: 'COMPLETED' },
      ackKeepToken: async () => {},
    })
    wallet(trio())
    vi.useFakeTimers()
    try {
      const startedAt = Date.now()
      const sending = sendVouchers({ payer: PAYER, recipient: { pubkey: FRIEND }, merchant, unit: 'EUR', amount: 1000 })
      await vi.runAllTimersAsync()
      const result = await sending

      expect(result).toMatchObject({ requested: 1000, delivered: 400, inFlight: 400, parts: 2 })
      expect(result.shortfall).toMatch(/still going through.*retrying the delivery by itself/s)
      expect(tried).toEqual([0, 1])
      // Bounded: the screen is not held past the retry window.
      expect(Date.now() - startedAt).toBeLessThanOrEqual(RETRY_WAIT_MS + POLL_ATTEMPTS * POLL_INTERVAL_MS)
    } finally {
      vi.useRealTimers()
    }
    expect(loadPendingSends(PAYER).map((p) => p.sendId)).toContain('as_1')
  })

  // #552: the screen is told which voucher is going and when the gateway is retrying one, so a
  // send that takes minutes does not sit under "This takes a few seconds".
  it('reports each part, and the retry, to the screen', async () => {
    stubs.rows = trio()
    let retryingUntil = 0
    Object.assign(stubs.api, {
      initiateAtomicSend: async (params: Record<string, unknown>) => {
        const index = Number(params.bundlePartIndex)
        if (index === 1) retryingUntil = Date.now() + 30_000
        return { send_id: `as_${index}`, status: 'PENDING' }
      },
      getAtomicSendStatus: async (sendId: string) =>
        sendId === 'as_1' && Date.now() < retryingUntil ? { status: 'DM_ERROR' } : { status: 'COMPLETED' },
      ackKeepToken: async () => {},
    })
    wallet(trio())
    const seen: Array<{ part: number; parts: number; retrying: boolean }> = []
    vi.useFakeTimers()
    try {
      const sending = sendVouchers({
        payer: PAYER, recipient: { pubkey: FRIEND }, merchant, unit: 'EUR', amount: 1000,
        onProgress: (p) => {
          seen.push(p)
          if (seen.length === 1) throw new Error('a broken screen must not stop the send')
        },
      })
      await vi.runAllTimersAsync()
      expect(await sending).toMatchObject({ delivered: 1000, parts: 3 })
    } finally {
      vi.useRealTimers()
    }
    expect(seen).toEqual([
      { part: 1, parts: 3, retrying: false },
      { part: 2, parts: 3, retrying: false },
      { part: 2, parts: 3, retrying: true },
      { part: 3, parts: 3, retrying: false },
    ])
  })

  // #125: a gateway that cannot be read at all leaves the outcome UNKNOWN. That is the
  // "still going through" answer, which keeps the send in the ledger, never a failure.
  it('says a send is still going through when its status cannot be read at all', async () => {
    stubs.rows = [row()]
    let sendId = ''
    Object.assign(stubs.api, {
      initiateAtomicSend: async () => {
        sendId = 'as_unreadable'
        return { send_id: sendId, status: 'PENDING' }
      },
      getAtomicSendStatus: async () => {
        throw new TypeError('Failed to fetch')
      },
      ackKeepToken: async () => {},
      reclaimAtomicSend: async () => ({}),
    })
    wallet([row()])
    const quietWarnings = vi.spyOn(console, 'warn').mockImplementation(() => {})
    onTestFinished(() => quietWarnings.mockRestore())
    vi.useFakeTimers()
    try {
      const sending = sendVouchers({
        payer: PAYER,
        recipient: { pubkey: FRIEND },
        merchant,
        unit: 'EUR',
        amount: 250,
      })
      const outcome = expect(sending).rejects.toThrow(SendOutcomeUnknownError)
      await vi.runAllTimersAsync()
      await outcome
    } finally {
      vi.useRealTimers()
    }
    expect(loadPendingSends(PAYER).map((p) => p.sendId)).toContain(sendId)
  })

  // A 4xx on the status read will say the same thing next time, so the wallet stops asking at
  // once, and still reports the outcome as unknown rather than failed.
  it('stops polling on a status read the gateway refuses outright', async () => {
    stubs.rows = [row()]
    let reads = 0
    Object.assign(stubs.api, {
      initiateAtomicSend: async () => ({ send_id: 'as_refused', status: 'PENDING' }),
      getAtomicSendStatus: async () => {
        reads += 1
        throw Object.assign(new Error('Not found'), { status: 404 })
      },
      ackKeepToken: async () => {},
      reclaimAtomicSend: async () => ({}),
    })
    wallet([row()])
    const quietWarnings = vi.spyOn(console, 'warn').mockImplementation(() => {})
    onTestFinished(() => quietWarnings.mockRestore())

    await expect(
      sendVouchers({
        payer: PAYER,
        recipient: { pubkey: FRIEND },
        merchant,
        unit: 'EUR',
        amount: 250,
      }),
    ).rejects.toThrow(/still going through.*could not confirm it with the gateway \(Not found\)/s)
    expect(reads).toBe(1)
  })

  // #110: a 429 says how long to wait; polling sooner only burns the same rate window.
  it('waits as long as a rate-limited status read asks before reading again', async () => {
    stubs.rows = [row()]
    const RETRY_AFTER_MS = 3000
    const readAt: number[] = []
    Object.assign(stubs.api, {
      initiateAtomicSend: async () => ({ send_id: 'as_limited', status: 'PENDING' }),
      getAtomicSendStatus: async () => {
        readAt.push(Date.now())
        if (readAt.length === 1) throw Object.assign(new Error('Too many requests'), { status: 429, retryAfterMs: RETRY_AFTER_MS })
        return { status: 'COMPLETED' }
      },
      ackKeepToken: async () => {},
      reclaimAtomicSend: async () => ({}),
    })
    wallet([row()])
    const quietWarnings = vi.spyOn(console, 'warn').mockImplementation(() => {})
    onTestFinished(() => quietWarnings.mockRestore())
    vi.useFakeTimers()
    try {
      const sending = sendVouchers({
        payer: PAYER,
        recipient: { pubkey: FRIEND },
        merchant,
        unit: 'EUR',
        amount: 250,
      })
      await vi.runAllTimersAsync()
      await sending
    } finally {
      vi.useRealTimers()
    }
    expect(readAt[1]! - readAt[0]!).toBeGreaterThanOrEqual(RETRY_AFTER_MS)
  })

  // A 429 asking for longer than the whole wait ends it at once: the outcome is unknown, and the
  // screen must not sit on "Sending" for a minute.
  it('stops waiting when a rate-limited read asks for longer than the wait has left', async () => {
    stubs.rows = [row()]
    const RETRY_AFTER_MS = 60_000
    let reads = 0
    Object.assign(stubs.api, {
      initiateAtomicSend: async () => ({ send_id: 'as_long_limit', status: 'PENDING' }),
      getAtomicSendStatus: async () => {
        reads += 1
        throw Object.assign(new Error('Too many requests'), { status: 429, retryAfterMs: RETRY_AFTER_MS })
      },
      ackKeepToken: async () => {},
      reclaimAtomicSend: async () => ({}),
    })
    wallet([row()])
    const quietWarnings = vi.spyOn(console, 'warn').mockImplementation(() => {})
    onTestFinished(() => quietWarnings.mockRestore())
    vi.useFakeTimers()
    try {
      const startedAt = Date.now()
      const sending = sendVouchers({
        payer: PAYER,
        recipient: { pubkey: FRIEND },
        merchant,
        unit: 'EUR',
        amount: 250,
      })
      const outcome = expect(sending).rejects.toThrow(SendOutcomeUnknownError)
      await vi.runAllTimersAsync()
      await outcome
      expect(Date.now() - startedAt).toBeLessThan(RETRY_AFTER_MS)
    } finally {
      vi.useRealTimers()
    }
    expect(reads).toBe(1)
  })

  const SOMEONE_ELSE = '9'.repeat(64)
  const EIGHT_DAYS_MS = 8 * 24 * 60 * 60 * 1000

  /** Records a send still in flight whose source is the coupon `tokenId`, and clears it afterwards. */
  function pendingSendHolding(tokenId: string, over: Record<string, unknown> = {}) {
    const key = `imani-wallet:pending-sends:${PAYER}`
    localStorage.setItem(key, JSON.stringify([{
      sendId: `as_in_flight_${tokenId.slice(0, 4)}`, tokenId, amount: 500, unit: 'EUR', decimals: 2,
      merchantPubkey: ISSUER, recipientPubkey: SOMEONE_ELSE, sourceFaceValue: 500, at: Date.now(),
      ...over,
    }]))
    onTestFinished(() => localStorage.removeItem(key))
  }

  /** The gateway still has the earlier send mid-flight, so asking about it changes nothing. */
  function stillInFlightAtTheGateway() {
    stubs.api.getAtomicSendStatus = async () => ({ status: 'DM_SENT' })
  }

  // #128: a coupon whose send is still in flight may already have reached the recipient. Paying
  // again must never draw on it, so a second tap cannot pay twice with the "same" money.
  it('never draws on a coupon whose earlier send is still in flight', async () => {
    const heldBySend = row({ token_id: '1'.repeat(32), voucher_id: 'v-held', face_value: 500, token_amount: 500 })
    const free = row({ token_id: '2'.repeat(32), voucher_id: 'v-free', face_value: 500, token_amount: 500 })
    stubs.rows = [heldBySend, free]
    pendingSendHolding(heldBySend.token_id as string)
    const sent = gateway()
    wallet([heldBySend, free])

    await sendVouchers({ payer: PAYER, recipient: { pubkey: FRIEND }, merchant, unit: 'EUR', amount: 500 })
    // And the other way round, so the result cannot come from the selector's own order.
    pendingSendHolding(free.token_id as string)
    await sendVouchers({ payer: PAYER, recipient: { pubkey: FRIEND }, merchant, unit: 'EUR', amount: 500 })

    expect(sent.map((s) => s.voucherId)).toEqual(['v-free', 'v-held'])
  })

  // #128: with only the in-flight coupon left, the wallet says so rather than paying from it.
  it('refuses to pay when the only coupon is held by a send still in flight', async () => {
    const heldBySend = row({ token_id: '1'.repeat(32), voucher_id: 'v-held', face_value: 500, token_amount: 500 })
    stubs.rows = [heldBySend]
    pendingSendHolding(heldBySend.token_id as string)
    const sent = gateway()
    wallet([heldBySend])

    await expect(
      sendVouchers({ payer: PAYER, recipient: { pubkey: FRIEND }, merchant, unit: 'EUR', amount: 500 }),
    ).rejects.toThrow(/no EUR voucher from this merchant/)
    expect(sent).toEqual([])
  })

  // A send that finished at the gateway after the wallet stopped waiting no longer blocks the
  // next payment to that person: the wallet asks the gateway before refusing (#129 review).
  it('asks the gateway first, and pays once the earlier send has completed', async () => {
    const earlier = row({ token_id: '1'.repeat(32), voucher_id: 'v-earlier', face_value: 500, token_amount: 500 })
    const free = row({ token_id: '2'.repeat(32), voucher_id: 'v-free', face_value: 500, token_amount: 500 })
    stubs.rows = [earlier, free]
    pendingSendHolding(earlier.token_id as string, { recipientPubkey: FRIEND, sendId: 'as_done_since' })
    const sent = gateway()
    wallet([earlier, free])

    await sendVouchers({ payer: PAYER, recipient: { pubkey: FRIEND }, merchant, unit: 'EUR', amount: 500 })

    expect(sent).toHaveLength(1)
    expect(loadPendingSends(PAYER).map((p) => p.sendId)).not.toContain('as_done_since')
  })

  // End to end: a payment whose outcome is unknown records its request, so paying that request
  // again is refused, while a different request from the same stall still goes through.
  it('records the request of an unconfirmed payment, and refuses only that request again', async () => {
    const coupons = trio()
    stubs.rows = coupons
    const sent = gateway()
    let sendId = ''
    stubs.api.initiateAtomicSend = async (params: Record<string, unknown>) => {
      sent.push(params)
      sendId = `as_${sent.length}`
      return { send_id: sendId, status: 'PENDING' }
    }
    stillInFlightAtTheGateway()
    wallet(coupons)
    const pay = (paymentId: string) =>
      payRequest({
        request: { paymentId, amount: 400, unit: 'EUR', issuerId: ISSUER } as unknown as NUT18VRequest,
        raw: '',
        merchant,
        payer: PAYER,
      })
    const quietWarnings = vi.spyOn(console, 'warn').mockImplementation(() => {})
    onTestFinished(() => quietWarnings.mockRestore())
    vi.useFakeTimers()
    try {
      const first = expect(pay('req-1')).rejects.toBeInstanceOf(SendOutcomeUnknownError)
      await vi.runAllTimersAsync()
      await first
    } finally {
      vi.useRealTimers()
    }
    expect(loadPendingSends(PAYER).map((p) => p.paymentRequestId)).toEqual(['req-1'])

    await expect(pay('req-1')).rejects.toBeInstanceOf(SendOutcomeUnknownError)
    expect(sent).toHaveLength(1)

    stubs.api.getAtomicSendStatus = async (id: string) => ({ status: id === 'as_1' ? 'DM_SENT' : 'COMPLETED' })
    await pay('req-2')
    expect(sent).toHaveLength(2)
  })

  // #128: a second send to the same person, while the first is unconfirmed, is refused outright.
  // Moving it onto another coupon would still pay them twice; the screen's lock is easy to get
  // past (Back, or leaving and coming back), so the refusal lives here.
  it('refuses a second send to someone whose first send is still unconfirmed', async () => {
    const inFlight = row({ token_id: '1'.repeat(32), voucher_id: 'v-held', face_value: 500, token_amount: 500 })
    const free = row({ token_id: '2'.repeat(32), voucher_id: 'v-free', face_value: 500, token_amount: 500 })
    stubs.rows = [inFlight, free]
    pendingSendHolding(inFlight.token_id as string, { recipientPubkey: FRIEND })
    const sent = gateway()
    stillInFlightAtTheGateway()
    wallet([inFlight, free])

    await expect(
      sendVouchers({ payer: PAYER, recipient: { pubkey: FRIEND }, merchant, unit: 'EUR', amount: 500 }),
    ).rejects.toBeInstanceOf(SendOutcomeUnknownError)
    expect(sent).toEqual([])
  })

  // The same for a payment request: a second payment of one request is refused while the first
  // is unconfirmed, whichever coupon it would draw on.
  it('refuses to pay a request again while its first payment is unconfirmed', async () => {
    const inFlight = row({ token_id: '1'.repeat(32), voucher_id: 'v-held', face_value: 500, token_amount: 500 })
    const free = row({ token_id: '2'.repeat(32), voucher_id: 'v-free', face_value: 500, token_amount: 500 })
    stubs.rows = [inFlight, free]
    pendingSendHolding(inFlight.token_id as string, { recipientPubkey: undefined, paymentRequestId: 'req-1' })
    const sent = gateway()
    stillInFlightAtTheGateway()
    wallet([inFlight, free])

    await expect(
      payRequest({
        request: { paymentId: 'req-1', amount: 500, unit: 'EUR', issuerId: ISSUER } as unknown as NUT18VRequest,
        raw: '',
        merchant,
        payer: PAYER,
      }),
    ).rejects.toBeInstanceOf(SendOutcomeUnknownError)
    expect(sent).toEqual([])
  })

  // A send the wallet has waited on for over a week will not answer (#127): it no longer holds
  // its coupon back, nor blocks a new send to the same person.
  it('stops holding a coupon, or a recipient, for a send over a week old', async () => {
    const stale = row({ token_id: '1'.repeat(32), voucher_id: 'v-stale', face_value: 500, token_amount: 500 })
    stubs.rows = [stale]
    pendingSendHolding(stale.token_id as string, { recipientPubkey: FRIEND, at: Date.now() - EIGHT_DAYS_MS })
    const sent = gateway()
    wallet([stale])

    await sendVouchers({ payer: PAYER, recipient: { pubkey: FRIEND }, merchant, unit: 'EUR', amount: 500 })

    expect(sent.map((s) => s.voucherId)).toEqual(['v-stale'])
  })

  it('throws when the first part fails, because nothing has moved', async () => {
    stubs.rows = trio()
    Object.assign(stubs.api, {
      initiateAtomicSend: async () => {
        throw new Error('mint refused the split')
      },
      getAtomicSendStatus: async () => ({ status: 'COMPLETED' }),
      ackKeepToken: async () => {},
      reclaimAtomicSend: async () => ({}),
    })
    const { transactions } = wallet(trio())

    await expect(
      sendVouchers({
        payer: PAYER,
        recipient: { pubkey: FRIEND },
        merchant,
        unit: 'EUR',
        amount: 1000,
      }),
    ).rejects.toThrow(/mint refused/)
    expect(transactions).toEqual([])
  })

  it('records the send before waiting for it, and forgets it once settled', async () => {
    // The window this closes: a send the gateway has accepted, abandoned during
    // the wait — app closed, or killed in the background by Android. Written
    // afterwards, as it was, that send left no record anywhere, so the next
    // login saw a coupon at full face value whose proofs the mint had burnt.
    // A bundle multiplies the window by its part count.
    stubs.rows = [row()]
    let duringWait: unknown[] = []
    Object.assign(stubs.api, {
      initiateAtomicSend: async () => ({ send_id: 'as_1' }),
      getAtomicSendStatus: async () => {
        duringWait = loadPendingSends(PAYER)
        return { status: 'COMPLETED' }
      },
      ackKeepToken: async () => {},
      reclaimAtomicSend: async () => ({}),
    })
    wallet([row()])

    await sendVouchers({
      payer: PAYER,
      recipient: { pubkey: FRIEND },
      merchant,
      unit: 'EUR',
      amount: 250,
    })

    expect(duringWait.map((p) => (p as { sendId: string }).sendId)).toContain('as_1')
    // ...and dropped on the way out, or the next login would settle it twice:
    // `settleSend` bails safely when the coupon is gone but still re-acks the
    // keep token, reporting work that finished seconds after the tap.
    expect(loadPendingSends(PAYER).map((p) => p.sendId)).not.toContain('as_1')
  })

  it('refuses an amount the coupons cannot reach, before sending any of them', async () => {
    // The obstacle is reported instead of two parts going out against a total
    // that was never achievable.
    stubs.rows = trio()
    const sent = gateway()
    wallet(trio())

    await expect(
      sendVouchers({
        payer: PAYER,
        recipient: { pubkey: FRIEND },
        merchant,
        unit: 'EUR',
        amount: 1500,
      }),
    ).rejects.toThrow(/no EUR voucher/)
    expect(sent).toEqual([])
  })

  it('pays a scanned request across several coupons', async () => {
    // The gap this whole change exists to close: two €4 coupons against a €7
    // request. `payRequest` used to look for one coupon covering the amount,
    // find none, and tell a customer holding €12 that they had "no voucher for
    // that amount".
    stubs.rows = trio()
    const sent = gateway()
    wallet(trio())

    const result = await payRequest({
      request: request(700, { issuerId: ISSUER, unit: 'EUR' }),
      raw: 'vreqA…',
      merchant,
      payer: PAYER,
    })

    expect(result.delivered).toBe(700)
    expect(result.parts).toBe(2)
    expect(sent.map((p) => p.amount)).toEqual([400, 300])
    // Every part names the request, which is what lets the merchant's till add
    // them up and settle it — see `groupArrivals` in lib/vreq.ts.
    expect(sent.every((p) => p.paymentRequestId === 'pay-1')).toBe(true)
    // ...and shares one bundle id, in the shape the recipient's parser matches.
    expect(new Set(sent.map((p) => p.bundleId)).size).toBe(1)
    expect(String(sent[0].bundleId)).toMatch(/^[0-9a-f]{32}$/)
    expect(sent.map((p) => p.bundlePartId)).toEqual([
      `${sent[0].bundleId}:0`,
      `${sent[0].bundleId}:1`,
    ])
  })

  it('records a redemption as a payment, not as a send to the merchant', async () => {
    // The recipient of a redemption IS the merchant, so the obvious thing to do
    // is to fill `recipientPubkey` — which `settleSend` reads to choose between
    // a 'sent' row and a 'payment' one. Filing money paid to a shop as a
    // transfer to a friend also puts that shop on the home deck twice.
    stubs.rows = [row()]
    gateway()
    const { transactions } = wallet([row()])

    await payRequest({
      request: request(250, { issuerId: ISSUER, unit: 'EUR' }),
      raw: 'vreqA…',
      merchant,
      payer: PAYER,
    })

    const row0 = transactions.find((t) => String(t.type) === 'payment')
    expect(row0).toBeDefined()
    expect(transactions.some((t) => String(t.type) === 'sent')).toBe(false)
  })

  it('will not add up coupons of two currencies to reach the asking price', async () => {
    // 400 EUR + 400 XAF is not 700 of anything. Without the unit filter the
    // request settles for a fraction of what was asked, in a currency nobody
    // agreed to.
    const mixed = [
      row({ token_id: '1'.repeat(32), voucher_id: 'v-1', face_value: 400, token_amount: 400 }),
      row({
        token_id: '2'.repeat(32),
        voucher_id: 'v-2',
        face_value: 400,
        token_amount: 400,
        face_unit: 'XAF',
        face_decimals: 0,
      }),
    ]
    stubs.rows = mixed
    const sent = gateway()
    wallet(mixed)

    await expect(
      payRequest({
        request: request(700, { issuerId: ISSUER, unit: 'EUR' }),
        raw: 'vreqA…',
        merchant,
        payer: PAYER,
      }),
    ).rejects.toThrow(/no EUR voucher/)
    expect(sent).toEqual([])
  })

  describe('the NGN overcharge: a send records what left the coupon', () => {
    // 10 000.00 NGN on 7429 sats, about 134.6 kobo a sat. 1500.00 takes 1115 sats, worth
    // 1500.87, and leaves a change worth 8499.13 (the gateway-parity vector in sendFace.test.ts).
    const ngnToken = () =>
      buildVoucherToken(
        { unit: 'NGN', faceValue: 1_000_000, faceDecimals: 2, issuanceRatio: 1_000_000 / 7429 },
        [4096, 2048, 1024, 256, 4, 1],
      ).token
    const ngnRow = (token: string) =>
      row({ token, face_value: 1_000_000, face_unit: 'NGN', face_decimals: 2, token_amount: 7429, amount: 7429 })

    function completing(status: Record<string, unknown>) {
      gateway()
      stubs.api.getAtomicSendStatus = async () => status
      stubs.api.initiateAtomicSend = async () => ({ send_id: 'as_1', status: 'PENDING' })
    }

    it('records 1500.87 when the gateway reports the change its sats can back', async () => {
      // Arrange
      const source = ngnRow(ngnToken())
      stubs.rows = [source]
      completing({ status: 'COMPLETED', keep_token: `cashuB${'k'.repeat(30)}`, keep_face_value: 849_913, is_full_send: false })
      const { transactions } = wallet([source])

      // Act
      const result = await sendVouchers({ payer: PAYER, recipient: { pubkey: FRIEND }, merchant, unit: 'NGN', amount: 150_000 })

      // Assert
      expect(transactions[0]).toMatchObject({ type: 'sent', amount: 150_087, unit: 'NGN' })
      // #635: the done screen gets the same confirmed figure, and the send is whole, not partial.
      expect(result).toMatchObject({ requested: 150_000, delivered: 150_000, sent: 150_087 })
    })

    it('records the request when the gateway still reports parent minus request (not yet upgraded)', async () => {
      // Arrange: what every gateway answered before the fix.
      const source = ngnRow(ngnToken())
      stubs.rows = [source]
      completing({ status: 'COMPLETED', keep_token: `cashuB${'k'.repeat(30)}`, keep_face_value: 850_000, is_full_send: false })
      const { transactions } = wallet([source])

      // Act
      const result = await sendVouchers({ payer: PAYER, recipient: { pubkey: FRIEND }, merchant, unit: 'NGN', amount: 150_000 })

      // Assert
      expect(transactions[0]).toMatchObject({ type: 'sent', amount: 150_000 })
      expect(result.sent).toBe(150_000)
    })

    it('debitFor says 1500.87 before the tap, and the exact amount on a EUR coupon', () => {
      // Arrange
      const ngnCoupon = coupon({ token: ngnToken(), face_value: 1_000_000, token_amount: 7429, face_unit: 'NGN' })
      const eurCoupon = coupon({ token: buildVoucherToken({ unit: 'EUR', faceValue: 1000, issuanceRatio: 1000 / 13304 }, [8192, 4096, 1016]).token, face_value: 1000, token_amount: 13304, face_unit: 'EUR' })

      // Act + Assert
      expect(debitFor([ngnCoupon], 150_000)).toBe(150_087)
      expect(debitFor([eurCoupon], 250)).toBe(250)
      expect(debitFor([ngnCoupon], 0)).toBe(0)
    })

    it('recordedAmount never records less than the request and never trusts an unconfirmed figure', () => {
      // Arrange
      const token = ngnToken()

      // Act + Assert
      expect(recordedAmount(token, 150_000, { keep_token: 'k', keep_face_value: 849_913 })).toBe(150_087)
      expect(recordedAmount(token, 150_000, { keep_token: 'k', keep_face_value: 849_000 })).toBe(150_000)
      expect(recordedAmount(token, 150_000, { keep_token: 'k' })).toBe(150_000)
      expect(recordedAmount(token, 150_000, { is_full_send: true })).toBe(150_000)
      expect(recordedAmount(token, 999_950, { is_full_send: true })).toBe(1_000_000)
      expect(recordedAmount(undefined, 150_000, { keep_token: 'k', keep_face_value: 849_913 })).toBe(150_000)
    })
  })

  /**
   * Owner report 2026-11-17, one fixture through every send and pay door. Stored rows: `expires_at`
   * in epoch seconds, a number. NGN, so `debitFor` shows which coupons it planned (a part split from
   * the 10,000.00 coupon costs up to a sat more than asked, a whole 200.00 coupon costs exactly 200.00).
   */
  describe('every door spends the soonest-expiring coupon first (owner report 2026-11-17)', () => {
    const nowS = () => Math.floor(Date.now() / 1000)
    const ngn = (faceValue: number, sats: number[]) =>
      buildVoucherToken({ unit: 'NGN', faceValue, faceDecimals: 2, issuanceRatio: faceValue / sats.reduce((a, b) => a + b, 0) }, sats).token
    const holding = () => {
      const at = nowS()
      const r = (id: string, n: string, face: number, sats: number[], expires?: number) =>
        row({
          token_id: n.repeat(32),
          voucher_id: id,
          token: ngn(face, sats),
          face_value: face,
          face_unit: 'NGN',
          face_decimals: 2,
          token_amount: sats.reduce((a, b) => a + b, 0),
          amount: sats.reduce((a, b) => a + b, 0),
          ...(expires === undefined ? {} : { expires_at: expires }),
        })
      return [
        r('v-forever', '1', 1_000_000, [4096, 2048, 1024, 256, 4, 1]),
        r('v-late', '2', 1_000_000, [4096, 2048, 1024, 256, 4, 1], at + 300 * 86_400),
        r('v-soon', '3', 20_000, [128, 16, 4, 1], at + 3 * 86_400),
      ]
    }
    const AMOUNT = 50_000
    const EXPECTED = [
      ['v-soon', 20_000],
      ['v-late', 30_000],
    ]

    const doors: Array<[string, () => Promise<unknown>]> = [
      ['sendVouchers (P2P)', () => sendVouchers({ payer: PAYER, recipient: { pubkey: FRIEND }, merchant, unit: 'NGN', amount: AMOUNT })],
      ['payRequest (NUT-18, stall pay)', () => payRequest({ request: request(AMOUNT, { issuerId: ISSUER, unit: 'NGN' }), raw: 'vreqA', merchant, payer: PAYER })],
      [
        'gift link / cashlink (sendGift legacy path)',
        () =>
          sendVouchers({
            payer: PAYER,
            recipient: { pubkey: 'e'.repeat(64), name: 'Link' },
            merchant,
            unit: 'NGN',
            amount: AMOUNT,
            link: { k: 'k', x: 1_900_000_000, status: 'outstanding' },
          }),
      ],
    ]

    it.each(doors)('%s draws the soonest coupon first, then the next, never the no-expiry one', async (_door, pay) => {
      stubs.rows = holding()
      const sent = gateway()
      wallet(holding())

      await pay()

      expect(sent.map((s) => [s.voucherId, s.amount])).toEqual(EXPECTED)
    })

    it('debitFor (the confirm screen) plans the same coupons deliver draws', async () => {
      const vouchers = holding().map(toVoucher)
      const debit = debitFor(vouchers, AMOUNT)

      stubs.rows = holding()
      const sent = gateway()
      wallet(holding())
      await sendVouchers({ payer: PAYER, recipient: { pubkey: FRIEND }, merchant, unit: 'NGN', amount: AMOUNT })
      const tokenOf = new Map(vouchers.map((v) => [v.voucher_id, v.token]))
      const drawn = sent.map((s) => sendFaceOf(tokenOf.get(s.voucherId as string), s.amount as number)!.sendFace)

      // 200.00 whole, then 300.00 split from the later coupon (+0.17 overcharge): 500.17.
      expect(debit).toBe(50_017)
      expect(debit).toBe(drawn.reduce((a, b) => a + b, 0))
    })
  })

  describe('the sender signature (#91)', () => {
    const SENT_ID = 'ab'.repeat(16)
    /** The signature waits on a `merchantStatus` lookup and is not awaited by the send. */
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

    function completingWith(status: Record<string, unknown>) {
      const sent = gateway()
      stubs.api.getAtomicSendStatus = async () => status
      stubs.api.initiateAtomicSend = async (params: Record<string, unknown>) => {
        sent.push(params)
        return { send_id: 'as_1', status: 'PENDING' }
      }
      return sent
    }

    beforeEach(() => {
      signatures.calls.length = 0
      signatures.rejects = false
    })

    it('signs a person-to-person send over the id the recipient can compute', async () => {
      stubs.rows = [row()]
      completingWith({ status: 'COMPLETED', sent_voucher_id: SENT_ID })
      const { transactions } = wallet([row()])

      await sendVouchers({ payer: PAYER, recipient: { pubkey: FRIEND }, merchant, unit: 'EUR', amount: 250 })
      await flush()

      expect(signatures.calls).toEqual([
        { transfer: SENT_ID, recipient: FRIEND, amount: 250, unit: 'EUR', decimals: 2 },
      ])
      // D3: the id is kept on the sent row, which is all a wiped sender needs
      // to rebuild the signature (its nonce derives from their key and this).
      expect(transactions[0]).toMatchObject({ type: 'sent', transferId: SENT_ID })
    })

    it('a link send never draws a locked voucher or licence, even when the screen did not filter it (spec 4.2)', async () => {
      // `sendGift` hands over only merchant + unit + amount: this filter is the door, not the picker.
      const meta = JSON.stringify({ kind: 'imani_licence', v: 1, lock_key: 'b'.repeat(64), product: 'annual' })
      const { token: locked } = buildLicenceVoucherToken({ merchantMetadata: meta, unit: 'EUR' })
      const rows = [row({ token: locked })]
      stubs.rows = rows
      const sent = completingWith({ status: 'COMPLETED', sent_voucher_id: SENT_ID })
      wallet(rows)
      const link = { k: 'A'.repeat(42) + 'E', x: 1_900_000_000, status: 'outstanding' as const, i: 3 }
      await expect(
        sendVouchers({ payer: PAYER, recipient: { pubkey: FRIEND }, merchant, unit: 'EUR', amount: 250, link }),
      ).rejects.toThrow()
      expect(sent).toEqual([])
    })

    it("a link send of the sender's own stall's coupons is refused before anything moves (Q6)", async () => {
      stubs.rows = [row({ issuer_id: PAYER })]
      const sent = completingWith({ status: 'COMPLETED', sent_voucher_id: SENT_ID })
      wallet([row({ issuer_id: PAYER })])
      const link = { k: 'A'.repeat(42) + 'E', x: 1_900_000_000, status: 'outstanding' as const, i: 3 }
      await expect(
        sendVouchers({ payer: PAYER, recipient: { pubkey: FRIEND }, merchant: { ...merchant, pubkey: PAYER }, unit: 'EUR', amount: 250, link }),
      ).rejects.toThrow(/create a Cashlink from Sell/)
      expect(sent).toEqual([])
    })

    it('does NOT sign a send to a gift link key (spec 3.3, Q7, pre-check build item 1)', async () => {
      stubs.rows = [row()]
      completingWith({ status: 'COMPLETED', sent_voucher_id: SENT_ID })
      const { transactions } = wallet([row()])
      const link = { k: 'A'.repeat(42) + 'E', x: 1_900_000_000, status: 'outstanding' as const, i: 3 }

      await sendVouchers({ payer: PAYER, recipient: { pubkey: FRIEND }, merchant, unit: 'EUR', amount: 250, link })
      await flush()

      expect(signatures.calls).toHaveLength(0)
      // The row carries the link, so History can show it and take it back.
      expect(transactions[0]).toMatchObject({ type: 'sent', link })
    })

    it('does NOT sign a plain send to a stall key, which attests with a 7377 instead (L4)', async () => {
      // Sending a stall its own coupon is allowed without a payment request.
      stubs.rows = [row()]
      stubs.merchants.add(ISSUER)
      completingWith({ status: 'COMPLETED', sent_voucher_id: SENT_ID })
      wallet([row()])

      await sendVouchers({ payer: PAYER, recipient: { pubkey: ISSUER }, merchant, unit: 'EUR', amount: 250 })
      await flush()

      expect(signatures.calls).toHaveLength(0)
    })

    it('fetches the transfer id once when an idempotent initiate says COMPLETED straight away (D4)', async () => {
      stubs.rows = [row()]
      wallet([row()])
      let statusReads = 0
      Object.assign(stubs.api, {
        initiateAtomicSend: async () => ({ send_id: 'as_1', status: 'COMPLETED' }),
        getAtomicSendStatus: async () => {
          statusReads += 1
          return { status: 'COMPLETED', sent_voucher_id: SENT_ID }
        },
        ackKeepToken: async () => {},
      })

      await sendVouchers({ payer: PAYER, recipient: { pubkey: FRIEND }, merchant, unit: 'EUR', amount: 250 })
      await flush()

      expect(statusReads).toBe(1)
      expect(signatures.calls).toEqual([
        { transfer: SENT_ID, recipient: FRIEND, amount: 250, unit: 'EUR', decimals: 2 },
      ])
    })

    it('still completes the send when that extra status read fails', async () => {
      stubs.rows = [row()]
      const { transactions } = wallet([row()])
      Object.assign(stubs.api, {
        initiateAtomicSend: async () => ({ send_id: 'as_1', status: 'COMPLETED' }),
        getAtomicSendStatus: async () => {
          throw new Error('gateway down')
        },
        ackKeepToken: async () => {},
      })

      const result = await sendVouchers({
        payer: PAYER, recipient: { pubkey: FRIEND }, merchant, unit: 'EUR', amount: 250,
      })
      await flush()

      expect(result.delivered).toBe(250)
      expect(transactions).toHaveLength(1)
      // Nothing to sign without the id: the signature would be unpairable.
      expect(signatures.calls).toEqual([])
    })

    it('writes the local row before that extra status read answers (N-b)', async () => {
      stubs.rows = [row()]
      const { transactions } = wallet([row()])
      let answer!: (s: Record<string, unknown>) => void
      const patched: Array<[string, Record<string, unknown>]> = []
      Object.assign(stubs.wallet, {
        updateTransaction: async (id: string, patch: Record<string, unknown>) => {
          patched.push([id, patch])
          return { id, ...patch }
        },
      })
      Object.assign(stubs.api, {
        initiateAtomicSend: async () => ({ send_id: 'as_1', status: 'COMPLETED' }),
        // A slow gateway: the status read does not answer until told to.
        getAtomicSendStatus: () => new Promise((resolve) => (answer = resolve)),
        ackKeepToken: async () => {},
      })

      const result = await sendVouchers({
        payer: PAYER, recipient: { pubkey: FRIEND }, merchant, unit: 'EUR', amount: 250,
      })
      // The send has settled, and its row is written, with the read still open.
      expect(result.delivered).toBe(250)
      expect(transactions).toHaveLength(1)
      expect(signatures.calls).toHaveLength(0)

      answer({ status: 'COMPLETED', sent_voucher_id: SENT_ID })
      await flush()
      await flush()
      expect(signatures.calls).toEqual([
        { transfer: SENT_ID, recipient: FRIEND, amount: 250, unit: 'EUR', decimals: 2 },
      ])
      // And the id reaches the row after all, for recovery after a wipe (D3).
      expect(patched).toEqual([[transactions[0]!.id, { transferId: SENT_ID }]])
    })

    it('signs what the receiver will credit on a fractional ratio, in the signed decimals (N-c)', async () => {
      // A real signed voucher: 200 sats at 25 XAF a sat, face 5000 with 0
      // decimals signed, while the wallet row says 2 decimals.
      const RATIO = 25
      const ls = new Map<string, string>()
      vi.stubGlobal('localStorage', {
        getItem: (k: string) => ls.get(k) ?? null,
        setItem: (k: string, v: string) => void ls.set(k, v),
        removeItem: (k: string) => void ls.delete(k),
      })
      const { token } = buildVoucherToken(
        { issuanceRatio: RATIO, faceValue: 5000, faceDecimals: 0, unit: 'XAF' },
        [200],
      )
      const source = row({ token, face_value: 5000, face_unit: 'XAF', face_decimals: 2, token_amount: 200 })
      stubs.rows = [source]
      completingWith({
        status: 'COMPLETED',
        sent_voucher_id: SENT_ID,
        keep_token: `cashuB${'k'.repeat(30)}`,
        keep_face_value: 4475,
      })
      wallet([source])

      await sendVouchers({ payer: PAYER, recipient: { pubkey: FRIEND }, merchant, unit: 'XAF', amount: 510 })
      await flush()

      // A PROPORTIONAL coupon's part is rounded UP by the gateway (#114): the fewest sats worth
      // 510 are ceil(510 / 25) = 21, which the receiver credits as round(21 x 25) = 525. This
      // read floor(510 / 25) = 20 sats, 500, and the signature fell a sat short of the credit.
      const sentSats = Math.ceil(510 / RATIO)
      const received = parseVoucherToken(
        buildVoucherToken({ issuanceRatio: RATIO, faceValue: 5000, faceDecimals: 0, unit: 'XAF' }, [sentSats]).token,
      )
      const credited = creditableFaceValue(received).faceValue
      expect(credited).toBe(525)
      // Exactly the figures the receiver's `withCommitment` compares, so the
      // receipt carries its commitment instead of dropping to the bare form.
      expect(signatures.calls).toEqual([
        { transfer: SENT_ID, recipient: FRIEND, amount: credited, unit: 'XAF', decimals: received.voucher.faceDecimals },
      ])
    })

    it('signs the whole token on a full send, however the ratio rounds (N-c)', () => {
      const { token } = buildVoucherToken({ issuanceRatio: 25, faceValue: 5000, faceDecimals: 0, unit: 'XAF' }, [200])
      expect(signedPartOf(token, 5000, true)).toEqual({ amount: 5000, unit: 'XAF', decimals: 0 })
      expect(signedPartOf(`cashuB${'o'.repeat(30)}`, 250, false)).toBeUndefined()
    })

    it('does NOT sign a payment to a stall, which the stall attests instead', async () => {
      stubs.rows = [row()]
      completingWith({ status: 'COMPLETED', sent_voucher_id: SENT_ID })
      wallet([row()])

      await payRequest({ request: request(250), raw: 'vreqA', merchant, payer: PAYER })

      expect(signatures.calls).toHaveLength(0)
    })

    it('does not sign a send that did not complete', async () => {
      stubs.rows = [row()]
      completingWith({ status: 'FAILED' })
      stubs.api.reclaimAtomicSend = async () => ({ status: 'RECLAIMED' })
      wallet([row()])

      await expect(
        sendVouchers({ payer: PAYER, recipient: { pubkey: FRIEND }, merchant, unit: 'EUR', amount: 250 }),
      ).rejects.toThrow()
      expect(signatures.calls).toHaveLength(0)
    })

    it('never fails or blocks the send when signing fails', async () => {
      signatures.rejects = true
      stubs.rows = [row()]
      completingWith({ status: 'COMPLETED', sent_voucher_id: SENT_ID })
      const { transactions } = wallet([row()])

      const result = await sendVouchers({
        payer: PAYER, recipient: { pubkey: FRIEND }, merchant, unit: 'EUR', amount: 250,
      })

      expect(result.delivered).toBe(250)
      expect(transactions).toHaveLength(1)
      expect(transactions[0]).toMatchObject({ type: 'sent', direction: 'out' })
    })
  })

  describe('failed-send wording keyed on error_code (#117)', () => {
    function ending(status: Record<string, unknown>) {
      const reclaims: string[] = []
      gateway()
      stubs.api.getAtomicSendStatus = async () => status
      stubs.api.initiateAtomicSend = async () => ({ send_id: 'as_1', status: 'PENDING' })
      stubs.api.reclaimAtomicSend = async (id: string) => {
        reclaims.push(id)
        throw new Error('Reclaim requires HTTP receive endpoint')
      }
      return reclaims
    }
    const send = () =>
      sendVouchers({ payer: PAYER, recipient: { pubkey: FRIEND }, merchant, unit: 'EUR', amount: 250 })

    it('SPLIT_NEVER_SIGNED: no reclaim, voucher still in the wallet', async () => {
      stubs.rows = [row()]
      const reclaims = ending({ status: 'FAILED', error_code: 'SPLIT_NEVER_SIGNED' })
      wallet([row()])
      const err = await send().catch((e: Error) => e)
      expect(String(err)).toMatch(/did not go through\. Your voucher is still in your wallet/)
      expect(String(err)).not.toMatch(/held by the gateway/)
      expect(reclaims).toEqual([])
    })

    it('SOURCE_PROOFS_NOT_UNSPENT: no reclaim, no held-by-gateway claim', async () => {
      stubs.rows = [row()]
      const reclaims = ending({ status: 'FAILED', error_code: 'SOURCE_PROOFS_NOT_UNSPENT' })
      wallet([row()])
      const err = await send().catch((e: Error) => e)
      expect(String(err)).toMatch(/already spent/)
      expect(String(err)).not.toMatch(/held by the gateway/)
      expect(reclaims).toEqual([])
    })

    it.each(['PHANTOM_SPEND', 'SPLIT_PROOFS_SPENT'])('%s: no reclaim, says an earlier attempt spent it', async (code) => {
      stubs.rows = [row()]
      const reclaims = ending({ status: 'FAILED', error_code: code })
      wallet([row()])
      const err = await send().catch((e: Error) => e)
      expect(String(err)).toMatch(/earlier attempt already spent this voucher/)
      expect(String(err)).not.toMatch(/held by the gateway/)
      expect(reclaims).toEqual([])
    })

    // SPLIT_ERROR left this list in #552: the gateway retries it, see the DM_ERROR case below.
    it.each(['FAILED', 'EXPIRED', 'CANCELLED'])('%s without a code: no reclaim attempted', async (state) => {
      stubs.rows = [row()]
      const reclaims = ending({ status: state })
      wallet([row()])
      const err = await send().catch((e: Error) => e)
      expect(String(err)).not.toMatch(/held by the gateway/)
      expect(reclaims).toEqual([])
    })

    // #552: the wallet never asks the gateway to reclaim. RECLAIM_READY means the gateway is
    // returning the voucher by DM by itself; the wallet applies the change and says so.
    it.each(['RECLAIM_READY', 'RECLAIMED'])(
      '%s: no wallet reclaim, says the voucher is coming back, never "held by the gateway"',
      async (state) => {
        stubs.rows = [row()]
        const reclaims = ending({ status: state, keep_token: 'cashuBchange', keep_face_value: 250, is_full_send: false })
        wallet([row()])
        const err = await send().catch((e: Error) => e)
        expect(reclaims).toEqual([])
        expect(String(err)).toMatch(/gateway is returning the voucher to your wallet/)
        expect(String(err)).not.toMatch(/held by the gateway/)
      },
    )

    // #552: DM_ERROR is a retry at the gateway, not an end. A wait that runs out on it is
    // "still going through", the send stays in the ledger, and nothing is reclaimed.
    it.each(['DM_ERROR', 'DM_RETRY_PENDING', 'SPLIT_ERROR'])('%s to the end of the wait: still going through, kept in the ledger, no reclaim', async (state) => {
      stubs.rows = [row()]
      const reclaims = ending({ status: state, error_code: 'RELAY_PUBLISH_FAILED' })
      wallet([row()])
      vi.useFakeTimers()
      try {
        const sending = send()
        const outcome = expect(sending).rejects.toThrow(SendOutcomeUnknownError)
        await vi.runAllTimersAsync()
        await outcome
        await sending.catch((e: Error) => {
          expect(e.message).toMatch(/retrying the delivery by itself/)
          expect(e.message).not.toMatch(/held by the gateway/)
        })
      } finally {
        vi.useRealTimers()
      }
      expect(reclaims).toEqual([])
      expect(loadPendingSends(PAYER).map((p) => p.sendId)).toContain('as_1')
    })

    it('unreclaimableNote is empty for an unknown code', () => {
      expect(unreclaimableNote({ status: 'FAILED', error_code: 'X' }, 's')).toBe('')
    })
  })

})

/**
 * #179: one Idempotency-Key per send INTENT, stable across retries and reloads.
 *
 * The fake gateway below dedupes exactly as gateway-core's AtomicSendService does: the same key
 * with the same (recipient, amount, voucher, memo) replays the first send, the same key with any
 * other of those is refused 409 SEND_IDEMPOTENCY_MISMATCH, and every new key is a new send that
 * moves money. `moved` counts sends that really happened.
 */
describe('a send keeps one Idempotency-Key across retries (#179)', () => {
  const PAYER = 'c'.repeat(64)
  const FRIEND = 'd'.repeat(64)
  const ISSUER = 'f'.repeat(64)
  const merchant = { pubkey: ISSUER, name: 'Hill Farm', groups: [], voucherCount: 0 }
  const row = () =>
    ({
      token_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      token: `cashuB${'o'.repeat(30)}`,
      voucher_id: 'v-1',
      face_value: 1000,
      face_unit: 'EUR',
      face_decimals: 2,
      token_amount: 1000,
      amount: 1000,
      issuer_id: ISSUER,
      status: 'active',
    }) as unknown as VoucherRow

  function idempotentGateway({ loseFirstAnswer = false } = {}) {
    const byKey = new Map<string, { hash: string; sendId: string }>()
    const keys: Array<string | null | undefined> = []
    const state = { moved: 0, lose: loseFirstAnswer }
    Object.assign(stubs.api, {
      initiateAtomicSend: async (p: Record<string, unknown>, key?: string | null) => {
        keys.push(key)
        const hash = [p.recipientPubkey, p.amount, p.voucherId, p.memo ?? ''].join('|')
        const seen = key ? byKey.get(key) : undefined
        if (seen && seen.hash !== hash) {
          throw Object.assign(new Error('Idempotency key already used with different request parameters'), {
            status: 409,
            code: 'SEND_IDEMPOTENCY_MISMATCH',
          })
        }
        let sendId = seen?.sendId
        if (!sendId) {
          state.moved += 1
          sendId = `as_${state.moved}`
          if (key) byKey.set(key, { hash, sendId })
        }
        if (state.lose) {
          // The send happened at the gateway; only the answer is lost on the way back.
          state.lose = false
          throw new TypeError('Failed to fetch')
        }
        return { send_id: sendId, status: 'COMPLETED' }
      },
      getAtomicSendStatus: async () => ({ status: 'COMPLETED' }),
      ackKeepToken: async () => {},
      reclaimAtomicSend: async () => ({}),
    })
    return { keys, state }
  }

  function wallet() {
    Object.assign(stubs.wallet, {
      getVoucher: async (id: string) => (id === row().token_id ? row() : null),
      removeVoucher: async () => true,
      saveVoucher: async () => {},
      addTransaction: async () => {},
    })
  }

  const send = (amount = 250, memo?: string, pay: typeof sendVouchers = sendVouchers) =>
    pay({ payer: PAYER, recipient: { pubkey: FRIEND }, merchant, unit: 'EUR', amount, memo })

  /** Moves the clock on, as the time it takes to read an error and press "Send" again does. */
  function later(ms: number) {
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + ms)
  }

  beforeEach(() => {
    vi.restoreAllMocks()
    // The device's storage: it survives a reload (vi.resetModules), module state does not.
    const ls = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => ls.get(k) ?? null,
      setItem: (k: string, v: string) => void ls.set(k, v),
      removeItem: (k: string) => void ls.delete(k),
    })
    stubs.rows = [row()]
    stubs.merchants.clear()
    stubs.unreachable.clear()
    wallet()
  })

  it('a retry after a lost answer replays the first send instead of sending twice', async () => {
    // The gateway sends, then the answer is lost. Thirty seconds later the user presses Send
    // again. Before #179 the key was rebuilt from a 10-second clock window, so the retry
    // carried a NEW key and the gateway paid the friend a second time.
    const { keys, state } = idempotentGateway({ loseFirstAnswer: true })
    await expect(send()).rejects.toThrow(/Failed to fetch/)

    later(30_000)
    await send()

    expect(keys).toHaveLength(2)
    expect(keys[1]).toBe(keys[0])
    expect(state.moved).toBe(1)
  })

  it('a reload keeps the key: the retry from a fresh page load is the same send', async () => {
    // The answer is lost and the app is closed. On the next start the module state is gone and
    // only localStorage remains; the key must come back from there, not be made up again.
    const { keys, state } = idempotentGateway({ loseFirstAnswer: true })
    await expect(send()).rejects.toThrow(/Failed to fetch/)

    later(5 * 60_000)
    vi.resetModules()
    const reloaded = await import('../pay')
    await send(250, undefined, reloaded.sendVouchers)

    expect(keys[1]).toBe(keys[0])
    expect(state.moved).toBe(1)
  })

  it('a different send never reuses the key, so the gateway does not refuse it as a reuse', async () => {
    // Two different sends (another memo) inside the same 10 seconds shared one key before #179,
    // so the gateway refused the second as "same key, different body" and the user could not
    // send it. Each send intent now has its own key, and a finished send frees its key.
    const { keys, state } = idempotentGateway()
    await send(250, 'apples')
    await send(250, 'pears')

    expect(keys[1]).not.toBe(keys[0])
    expect(state.moved).toBe(2)
  })

  it('concurrent duplicates of one send carry one key and send once, across a clock boundary', async () => {
    // A slow gateway holds the first request open; the user taps again 2 ms later, which happens
    // to be in the next 10-second window. Before #179 the second tap got a new key and the
    // gateway ran a second send beside the first. Now both attempts of the one intent share the
    // stored key, and the gateway replays the first.
    const { keys, state } = idempotentGateway()
    const initiate = stubs.api.initiateAtomicSend as (p: Record<string, unknown>, k?: string | null) => Promise<unknown>
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    stubs.api.initiateAtomicSend = async (p: Record<string, unknown>, k?: string | null) => {
      const answer = initiate(p, k)
      await held
      return answer
    }
    const boundary = Math.ceil(Date.now() / 10_000) * 10_000 + 10_000
    const clock = vi.spyOn(Date, 'now').mockReturnValue(boundary - 1)

    const first = send()
    await vi.waitFor(() => expect(keys).toHaveLength(1))
    clock.mockReturnValue(boundary + 1)
    const second = send()
    await vi.waitFor(() => expect(keys).toHaveLength(2))
    release()
    await Promise.allSettled([first, second])

    expect(keys[1]).toBe(keys[0])
    expect(state.moved).toBe(1)
  })

  it('the key is in the pending ledger logout reads while the answer is unknown', async () => {
    const { moneyInFlight } = await import('../inFlightMoney')
    idempotentGateway({ loseFirstAnswer: true })
    await expect(send()).rejects.toThrow(/Failed to fetch/)
    expect(moneyInFlight(PAYER).sends).toBeGreaterThan(0)
  })
})

/**
 * cashu-mint#540 phase 2: the mint's redemption cap refused the coupon (90025), which gateway-core
 * reports as a FAILED send with `error_code = VOUCHER_FULLY_REDEEMED`. Terminal: the holder is told
 * the coupon is redeemed in full (design §2.13), it is NOT reclaimed (nothing moved), it is never
 * offered again, and the screen can offer "Swap back to sats" for its row.
 */
describe('a coupon the mint refuses as redeemed in full (cashu-mint#540)', () => {
  const PAYER = 'c'.repeat(64)
  const ISSUER = 'f'.repeat(64)
  const VOUCHER = '1b6f3e2a-9c44-4f0b-8a21-3d5e6f7a8b9c'
  const merchant = { pubkey: ISSUER, name: 'Hill Farm', groups: [], voucherCount: 0 }
  const source = {
    token_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    token: `cashuB${'o'.repeat(30)}`,
    voucher_id: VOUCHER,
    face_value: 1000,
    face_unit: 'EUR',
    face_decimals: 2,
    token_amount: 1000,
    amount: 1000,
    issuer_id: ISSUER,
    status: 'active',
  } as unknown as VoucherRow

  function refusingGateway() {
    const calls = { initiate: 0, reclaim: 0 }
    Object.assign(stubs.api, {
      initiateAtomicSend: async () => {
        calls.initiate += 1
        return { send_id: 'as_refused', status: 'PENDING' }
      },
      getAtomicSendStatus: async () => ({
        status: 'FAILED',
        error_code: 'VOUCHER_FULLY_REDEEMED',
        error_message: 'This coupon has already been redeemed in full.',
      }),
      ackKeepToken: async () => {},
      reclaimAtomicSend: async () => {
        calls.reclaim += 1
        return {}
      },
    })
    return calls
  }

  function wallet() {
    const saved: Record<string, unknown>[] = []
    Object.assign(stubs.wallet, {
      getVoucher: async (id: string) => (id === source.token_id ? source : null),
      removeVoucher: async () => true,
      saveVoucher: async (row: Record<string, unknown>) => void saved.push(row),
      addTransaction: async () => {},
    })
    return saved
  }

  beforeEach(() => {
    stubs.rows = [source]
    localStorage.removeItem(`imani-wallet:pending-sends:${PAYER}`)
    // #461: and the settled ledger, or a send id reused by a later test reads as a replay.
    localStorage.removeItem(`imani-wallet:settled-sends:${PAYER}`)
  })

  it('tells the holder, with the stall and reference, and never retries or reclaims', async () => {
    const calls = refusingGateway()
    const saved = wallet()

    const failure = await payRequest({ request: request(250), raw: 'vreqA', merchant, payer: PAYER }).catch(
      (e: unknown) => e,
    )

    expect(failure).toBeInstanceOf(VoucherFullyRedeemedError)
    expect((failure as Error).message).toBe(
      'This coupon has already been redeemed in full. If you believe this is wrong, contact Hill Farm, ' +
        'quoting reference 1b6f3e2a.',
    )
    expect((failure as VoucherFullyRedeemedError).tokenId).toBe(source.token_id)
    expect(calls).toEqual({ initiate: 1, reclaim: 0 })
    expect(saved).toEqual([expect.objectContaining({ token_id: source.token_id, status: 'fully_redeemed' })])
    expect(loadPendingSends(PAYER)).toEqual([])
  })

  it('never offers the refused coupon for a payment again', () => {
    expect(spendable([{ ...source, status: 'fully_redeemed' } as VoucherRow])).toEqual([])
    expect(fullyRedeemedRows([{ ...source, status: 'fully_redeemed' } as VoucherRow])).toHaveLength(1)
  })

  it('marks it on the next login when the refusal arrived after the wallet stopped waiting', async () => {
    refusingGateway()
    const saved = wallet()
    localStorage.setItem(
      `imani-wallet:pending-sends:${PAYER}`,
      JSON.stringify([
        {
          sendId: 'as_refused', tokenId: source.token_id, amount: 250, unit: 'EUR', decimals: 2,
          merchantPubkey: ISSUER, voucherId: VOUCHER, sourceFaceValue: 1000, at: Date.now(),
          paymentRequestId: 'pay-1',
        },
      ]),
    )

    expect(await reconcilePendingSends(PAYER)).toBe(0)
    expect(saved).toEqual([expect.objectContaining({ status: 'fully_redeemed' })])
    expect(loadPendingSends(PAYER)).toEqual([])
  })
})

describe('a settled payment request is never paid, or settled, twice (#461)', () => {
  const PAYER = 'c'.repeat(64)
  const ISSUER = 'f'.repeat(64)
  const merchant = { pubkey: ISSUER, name: 'Hill Farm', groups: [], voucherCount: 0 }
  const CHANGE_TOKEN = `cashuB${'k'.repeat(30)}`
  const source = {
    token_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    token: `cashuB${'o'.repeat(30)}`,
    voucher_id: 'v-1',
    face_value: 500,
    face_unit: 'EUR',
    face_decimals: 2,
    token_amount: 500,
    amount: 500,
    issuer_id: ISSUER,
    status: 'active',
  } as unknown as VoucherRow

  /** A wallet whose rows really change, so the change coupon can be paid from. */
  function liveWallet(initial: VoucherRow[]) {
    const rows = [...initial]
    const removed: string[] = []
    const transactions: Record<string, unknown>[] = []
    stubs.rows = rows
    Object.assign(stubs.wallet, {
      getVoucher: async (id: string) => rows.find((r) => r.token_id === id) ?? null,
      removeVoucher: async (id: string) => {
        removed.push(id)
        const at = rows.findIndex((r) => r.token_id === id)
        if (at >= 0) rows.splice(at, 1)
        return at >= 0
      },
      saveVoucher: async (next: VoucherRow) => void rows.push(next),
      addTransaction: async (tx: Record<string, unknown>) => void transactions.push(tx),
    })
    return { rows, removed, transactions }
  }

  /**
   * gateway-core before the fix: the request hash covers sender|recipient|amount|voucherId|memo
   * only, so the same key with a different token REPLAYS the stored send. The replay answers
   * COMPLETED with no keep_token: the original's change was acked and cleared.
   */
  function oldGateway() {
    const byKey = new Map<string, { hash: string; sendId: string }>()
    const keys: string[] = []
    const calls = { initiate: 0 }
    Object.assign(stubs.api, {
      initiateAtomicSend: async (p: Record<string, unknown>, key?: string | null) => {
        calls.initiate += 1
        keys.push(String(key))
        const hash = [p.recipientPubkey, p.amount, p.voucherId, p.memo ?? ''].join('|')
        const seen = key ? byKey.get(key) : undefined
        if (seen && seen.hash === hash) return { send_id: seen.sendId, status: 'COMPLETED' }
        const sendId = `as_${byKey.size + 1}`
        if (key) byKey.set(key, { hash, sendId })
        return { send_id: sendId, status: 'PENDING' }
      },
      getAtomicSendStatus: async () => ({
        status: 'COMPLETED',
        keep_token: CHANGE_TOKEN,
        keep_face_value: 375,
        is_full_send: false,
      }),
      ackKeepToken: async () => {},
      reclaimAtomicSend: async () => ({}),
    })
    return { keys, calls }
  }

  beforeEach(() => {
    stubs.notified.count = 0
    stubs.merchants.clear()
    stubs.unreachable.clear()
    localStorage.removeItem(`imani-wallet:pending-sends:${PAYER}`)
    localStorage.removeItem(`imani-wallet:settled-sends:${PAYER}`)
  })

  it('refuses to pay the request again from the change, before any call, and keeps the coupon', async () => {
    const { rows, removed, transactions } = liveWallet([source])
    const { calls, keys } = oldGateway()
    const req = request(125, { paymentId: '41bcaa6ab3d4fb90', issuerId: ISSUER, unit: 'EUR' })

    const first = await payRequest({ request: req, raw: 'vreqA…', merchant, payer: PAYER })
    expect(first.delivered).toBe(125)
    // The split kept the change, under the SAME voucher_id, re-keyed to its own token.
    const change = rows.find((r) => r.token === CHANGE_TOKEN)!
    expect(change).toBeDefined()
    expect(change.voucher_id).toBe('v-1')
    expect(keys[0]).toBe(`pay_41bcaa6ab3d4fb90_${source.token_id}`)

    const removedBefore = [...removed]
    await expect(
      payRequest({ request: req, raw: 'vreqA…', merchant, payer: PAYER }),
    ).rejects.toBeInstanceOf(RequestAlreadyPaidError)

    expect(calls.initiate).toBe(1)
    expect(removed).toEqual(removedBefore)
    expect(rows.map((r) => r.token)).toEqual([CHANGE_TOKEN])
    expect(transactions).toHaveLength(1)
  })

  it('keys a payment on the source token, so the change never reuses the first key', async () => {
    const { rows } = liveWallet([source])
    const { keys } = oldGateway()
    await payRequest({ request: request(125, { paymentId: 'r-1', issuerId: ISSUER }), raw: 'v', merchant, payer: PAYER })
    const change = rows.find((r) => r.token === CHANGE_TOKEN)!
    await payRequest({ request: request(125, { paymentId: 'r-1b', issuerId: ISSUER }), raw: 'v', merchant, payer: PAYER })
    expect(keys).toEqual([`pay_r-1_${source.token_id}`, `pay_r-1b_${change.token_id}`])
    expect(change.token_id).not.toBe(source.token_id)
  })

  it('never deletes a coupon on a gateway replay answer, even with no local record of the request', async () => {
    // A wiped wallet, or another device: the ledger cannot refuse, so the answer must.
    const { rows, removed, transactions } = liveWallet([source])
    let acked = 0
    Object.assign(stubs.api, {
      initiateAtomicSend: async () => ({ send_id: 'as_old', status: 'COMPLETED', idempotent_replay: true }),
      getAtomicSendStatus: async () => ({ status: 'COMPLETED' }),
      ackKeepToken: async () => void (acked += 1),
      reclaimAtomicSend: async () => ({}),
    })

    await expect(
      payRequest({ request: request(125, { paymentId: 'r-2', issuerId: ISSUER }), raw: 'v', merchant, payer: PAYER }),
    ).rejects.toBeInstanceOf(RequestAlreadyPaidError)

    expect(removed).toEqual([])
    expect(rows).toEqual([source])
    expect(transactions).toEqual([])
    expect(acked).toBe(0)
    expect(loadPendingSends(PAYER)).toEqual([])
  })

  it('never settles an answer naming a send this wallet already settled', async () => {
    const { rows, removed } = liveWallet([source])
    oldGateway()
    await payRequest({ request: request(125, { paymentId: 'r-3', issuerId: ISSUER }), raw: 'v', merchant, payer: PAYER })
    const after = rows.map((r) => r.token_id)
    const removedBefore = [...removed]
    // A different request, but the gateway answers with the settled as_1 and no change.
    Object.assign(stubs.api, {
      initiateAtomicSend: async () => ({ send_id: 'as_1', status: 'COMPLETED' }),
      getAtomicSendStatus: async () => ({ status: 'COMPLETED' }),
    })
    await expect(
      payRequest({ request: request(125, { paymentId: 'r-4', issuerId: ISSUER }), raw: 'v', merchant, payer: PAYER }),
    ).rejects.toBeInstanceOf(RequestAlreadyPaidError)
    expect(rows.map((r) => r.token_id)).toEqual(after)
    expect(removed).toEqual(removedBefore)
  })

  it('never settles an answer about a different source token', async () => {
    const { rows, removed } = liveWallet([source])
    Object.assign(stubs.api, {
      initiateAtomicSend: async () => ({ send_id: 'as_x', status: 'PENDING' }),
      getAtomicSendStatus: async () => ({ status: 'COMPLETED', token_fingerprint: 'b'.repeat(32) }),
      ackKeepToken: async () => {},
      reclaimAtomicSend: async () => ({}),
    })
    await expect(
      sendVouchers({ payer: PAYER, recipient: { pubkey: 'd'.repeat(64) }, merchant, unit: 'EUR', amount: 500 }),
    ).rejects.toThrow(/earlier send/)
    expect(removed).toEqual([])
    expect(rows).toEqual([source])
  })

  it('maps the gateway refusal request_already_paid to the typed error, coupon untouched', async () => {
    const { rows, removed } = liveWallet([source])
    Object.assign(stubs.api, {
      initiateAtomicSend: async () => {
        throw Object.assign(new Error('Payment request already paid'), { status: 409, code: 'request_already_paid' })
      },
    })
    await expect(
      payRequest({ request: request(125, { paymentId: 'r-5', issuerId: ISSUER }), raw: 'v', merchant, payer: PAYER }),
    ).rejects.toBeInstanceOf(RequestAlreadyPaidError)
    expect(removed).toEqual([])
    expect(rows).toEqual([source])
  })

  it('still settles a real full send and a real reconcile', async () => {
    const { rows, removed } = liveWallet([source])
    Object.assign(stubs.api, {
      initiateAtomicSend: async () => ({ send_id: 'as_full', status: 'PENDING' }),
      getAtomicSendStatus: async () => ({ status: 'COMPLETED', is_full_send: true, token_fingerprint: source.token_id }),
      ackKeepToken: async () => {},
      reclaimAtomicSend: async () => ({}),
    })
    const result = await payRequest({ request: request(500, { paymentId: 'r-6', issuerId: ISSUER }), raw: 'v', merchant, payer: PAYER })
    expect(result.delivered).toBe(500)
    expect(removed).toEqual([source.token_id])
    expect(rows).toEqual([])
    expect(await reconcilePendingSends(PAYER)).toBe(0)
  })
})

describe('paying a request again after it FAILED starts a new send (local SPLIT_ERROR retry)', () => {
  const PAYER = 'c'.repeat(64)
  const ISSUER = 'f'.repeat(64)
  const merchant = { pubkey: ISSUER, name: 'John Radcliffe', groups: [], voucherCount: 0 }
  const source = {
    token_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    token: `cashuB${'o'.repeat(30)}`,
    voucher_id: 'v-1',
    face_value: 500,
    face_unit: 'EUR',
    face_decimals: 2,
    token_amount: 500,
    amount: 500,
    issuer_id: ISSUER,
    status: 'active',
  } as unknown as VoucherRow

  beforeEach(() => {
    stubs.merchants.clear()
    stubs.unreachable.clear()
    const ls = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => ls.get(k) ?? null,
      setItem: (k: string, v: string) => void ls.set(k, v),
      removeItem: (k: string) => void ls.delete(k),
    })
    const rows = [source]
    stubs.rows = rows
    Object.assign(stubs.wallet, {
      getVoucher: async (id: string) => rows.find((r) => r.token_id === id) ?? null,
      removeVoucher: async (id: string) => {
        const at = rows.findIndex((r) => r.token_id === id)
        if (at >= 0) rows.splice(at, 1)
        return at >= 0
      },
      saveVoucher: async (next: VoucherRow) => void rows.push(next),
      addTransaction: async () => {},
    })
  })

  /** The gateway's idempotency table: a key seen before answers with ITS send, as it stood. */
  function gatewayWithDeadSend(deadKey: string, dead: Record<string, unknown>) {
    const keys: string[] = []
    Object.assign(stubs.api, {
      initiateAtomicSend: async (_p: Record<string, unknown>, key?: string | null) => {
        keys.push(String(key))
        if (key === deadKey) return { send_id: 'as_dead', ...dead }
        return { send_id: 'as_new', status: 'INITIATED' }
      },
      getAtomicSendStatus: async (id: string) =>
        id === 'as_new' ? { status: 'COMPLETED', is_full_send: true, token_fingerprint: source.token_id } : dead,
      ackKeepToken: async () => {},
      reclaimAtomicSend: async () => ({}),
    })
    return keys
  }

  it('walks past the dead send to a fresh key and completes', async () => {
    const base = `pay_r-9_${source.token_id}`
    const keys = gatewayWithDeadSend(base, { status: 'FAILED', error_code: 'SPLIT_ERROR' })
    const result = await payRequest({ request: request(500, { paymentId: 'r-9', issuerId: ISSUER }), raw: 'v', merchant, payer: PAYER })
    expect(result.delivered).toBe(500)
    expect(keys).toEqual([base, `${base}~1`])
  })

  it('does not walk past a send that says the coupon itself is spent', async () => {
    const base = `pay_r-10_${source.token_id}`
    const keys = gatewayWithDeadSend(base, { status: 'FAILED', error_code: 'SOURCE_PROOFS_NOT_UNSPENT' })
    await expect(
      payRequest({ request: request(500, { paymentId: 'r-10', issuerId: ISSUER }), raw: 'v', merchant, payer: PAYER }),
    ).rejects.toThrow(/did not complete \(FAILED\)/)
    expect(keys).toEqual([base])
  })

  it('classifies replays', () => {
    expect(isDeadReplay({ status: 'FAILED', error_code: 'SPLIT_ERROR' })).toBe(true)
    expect(isDeadReplay({ status: 'SPLIT_ERROR' })).toBe(true)
    expect(isDeadReplay({ status: 'INITIATED' })).toBe(false)
    expect(isDeadReplay({ status: 'COMPLETED' })).toBe(false)
    expect(isDeadReplay({ status: 'FAILED', error_code: 'PHANTOM_SPEND' })).toBe(false)
  })
})
