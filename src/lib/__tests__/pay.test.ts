import { describe, it, expect, vi, beforeEach, onTestFinished } from 'vitest'
import type { Voucher } from '@imani/voucher-send'
import type { VoucherRow } from '@imani/wallet-storage'

import {
  buildSendParams,
  sendVouchers,
  loadPendingSends,
  payRequest,
  reconcilePendingSends,
  replaceVoucherToken,
  SendOutcomeUnknownError,
  signedPartOf,
} from '../pay'

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
import { buildVoucherToken } from './voucherFixtures'

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
        keep_face_value: 4500,
      })
      wallet([source])

      await sendVouchers({ payer: PAYER, recipient: { pubkey: FRIEND }, merchant, unit: 'XAF', amount: 510 })
      await flush()

      // The gateway sends floor(510 / 25) = 20 sats, which the receiver
      // credits as round(20 x 25) = 500, not the 510 asked for.
      const sentSats = Math.floor(510 / RATIO)
      const received = parseVoucherToken(
        buildVoucherToken({ issuanceRatio: RATIO, faceValue: 5000, faceDecimals: 0, unit: 'XAF' }, [sentSats]).token,
      )
      const credited = creditableFaceValue(received).faceValue
      expect(credited).toBe(500)
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
})
