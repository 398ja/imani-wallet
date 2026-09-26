import { readFileSync } from 'node:fs'

import type { TransactionRow } from '@imani/wallet-storage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * #90: a redeemed voucher must move the merchant's claimed figure.
 *
 * Driven end to end through the pieces that actually write the row: dm-poll's
 * redemption adapter, the REAL legacy bridge (`withCorrelation` and
 * `installTokenIdFill`) and the REAL vendored row builder. Only the mint swap
 * is faked, and it is faked the way `tokenRedemption._persistRedeemed` behaves:
 * a voucher whose `voucher_id` came off the gateway's receive response, which
 * carries none (`ReceiveResponse` in imani-gateway-api has no id field), so
 * `buildVoucher` falls through to `crypto.randomUUID()`. That id is what every
 * redeemed row carried, which is why `issuedVoucher` summed an empty set and
 * the ceiling check in `refuseIfOverRedeemed` never saw a prior redemption.
 *
 * Every other suite passed with this broken because each one either mocked the
 * bridge or handed `issuedVoucher` rows with the right id already on them.
 */

const STALL = 'f'.repeat(64)
const VOUCHER_ID = '1d4410af-70f5-4c14-8606-519404684ea7'

const store = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }))

vi.mock('../arrivalToast', () => ({ announceArrival: () => {} }))
vi.mock('../refusalToast', () => ({ announceRefusal: () => {} }))
vi.mock('../queuedToast', () => ({ announceQueued: () => {}, settleQueued: () => {} }))
vi.mock('../merchant', () => ({ loadMerchant: () => ({ pubkey: STALL, categories: [] }) }))
vi.mock('../attestation', () => ({
  attestRedemption: async () => null,
  nullifierFor: (t: string) => `nullifier-of:${t}`,
}))
vi.mock('../paymentReceipt', () => ({ postPaymentReceipt: async () => {} }))
vi.mock('../nap', () => ({ getSigner: () => ({ pubkey: STALL }) }))
vi.mock('../dmCrypto', () => ({
  createDmCryptoAdapter: () => ({}),
  toLegacyMetadata: (m: unknown) => m,
}))
vi.mock('../wallet', () => ({
  getWallet: () => ({}),
  notifyWalletChanged: () => {},
  recordReceiptByNullifier: async () => {},
  // What redemptionLedger reads for the ceiling: exactly what was written.
  listTransactions: async () => store.rows,
}))
// The real bridge, minus the script loading `legacyApi` does.
vi.mock('../legacyBridge', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  legacyApi: async () => {},
}))

let captured: { redemptionAdapter?: { redeem: (t: string, o?: unknown) => Promise<unknown> } } = {}
vi.mock('@imani/dm-poll', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  createDmPollService: (config: typeof captured) => {
    captured = config
    return { start: async () => {}, stop: () => {}, fetchRecentDms: async () => [] }
  },
}))

vi.stubGlobal('document', { addEventListener: () => {}, removeEventListener: () => {} })
vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {} })

const { startDmPoll, stopDmPoll, refuseIfOverRedeemed } = await import('../dmPoll')
const { installTokenIdFill } = await import('../legacyBridge')
const { toTransaction, buildIssueTransaction } = await import('../transactions')
const { issuedVoucher } = await import('../issuedVoucher')
const { merchantClaimFor } = await import('../merchantClaim')

const buildRow = new Function(
  readFileSync('shared/tokenRedemption.js', 'utf8') + '; return _buildReceiveTransactionRow;',
)() as (v: Record<string, unknown>, m?: Record<string, unknown>) => Record<string, unknown> | null

/** The stall's own issuance: 1000 XAF under the voucher's real id. */
const issued = () =>
  buildIssueTransaction({
    voucherId: VOUCHER_ID,
    amount: 1000,
    unit: 'XAF',
    decimals: 0,
    recipientPubkey: 'c'.repeat(64),
    at: 1_700_000_000_000,
  }) as unknown as Record<string, unknown>

/** What dmCrypto hands the adapter for a verified coupon worth `value`. */
const verified = (value: number) => ({
  voucherId: VOUCHER_ID,
  issuerId: STALL,
  faceValue: value,
  faceUnit: 'XAF',
  faceDecimals: 0,
  validation: { signatureValid: true, legacyCanonical: false, signedFaceValue: 1000, cappedAtFaceValue: false },
})

let swaps = 0
/** tokenRedemption's persist step, as it really behaves: no voucher id, no row. */
const redeem = vi.fn(async (_token: string, opts: { metadata?: Record<string, unknown> }) => {
  swaps += 1
  const voucher = {
    token_id: `tok-after-swap-${swaps}`,
    token: `cashuBfresh${swaps}`,
    voucher_id: crypto.randomUUID(),
    face_value: Number(opts.metadata?.faceValue ?? 0),
    face_unit: 'XAF',
    face_decimals: 0,
    issuer_id: STALL,
  }
  await window.walletStorageIntegration!.atomicallyWrite({ vouchers: [voucher], transactions: [] })
  return voucher
})

const record = () =>
  issuedVoucher(store.rows.map((r) => toTransaction(r as unknown as TransactionRow)), VOUCHER_ID, {
    now: 1_700_000_000_000,
    stallPubkey: STALL,
  })!

beforeEach(() => {
  stopDmPoll()
  swaps = 0
  store.rows = [issued()]
  ;(globalThis as unknown as Record<string, unknown>)._buildReceiveTransactionRow = buildRow
  vi.stubGlobal('window', {
    TokenRedemption: { redeem },
    walletStorageIntegration: {
      init: vi.fn(),
      atomicallyWrite: async (input: { transactions?: unknown[] }) => {
        store.rows.push(...((input.transactions ?? []) as Record<string, unknown>[]))
      },
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  })
  installTokenIdFill()
  startDmPoll(STALL)
})

describe("a voucher coming home to the stall that issued it (#90)", () => {
  it('moves claimed up and outstanding down by the amount redeemed', async () => {
    expect(record().claimedMinor).toBe(0)

    await captured.redemptionAdapter!.redeem('cashuA-full', { metadata: verified(1000) })

    expect(record().claimedMinor).toBe(1000)
    expect(record().outstandingMinor).toBe(0)
  })

  it('records a partial redemption as the partial amount, not the whole face', async () => {
    await captured.redemptionAdapter!.redeem('cashuA-part', { metadata: verified(400) })

    expect(record().claimedMinor).toBe(400)
    expect(record().outstandingMinor).toBe(600)
    expect(record().claims).toHaveLength(1)

    await captured.redemptionAdapter!.redeem('cashuA-rest', { metadata: verified(600) })
    expect(record().claimedMinor).toBe(1000)
    expect(record().outstandingMinor).toBe(0)
  })

  it('lets the ceiling see earlier redemptions, so the same face cannot be taken twice', async () => {
    await captured.redemptionAdapter!.redeem('cashuA-first', { metadata: verified(700) })

    await expect(refuseIfOverRedeemed(verified(700))).rejects.toThrow(/already paid out 700 of 1000/)
    await expect(refuseIfOverRedeemed(verified(300))).resolves.toBeUndefined()
  })

  it('never files an UNVERIFIED coupon against a voucher, whatever the envelope says', async () => {
    // Envelope fields are sender-written. A coupon whose signature did not
    // verify naming our voucher id must not eat into (or pad) its figures.
    const unverified = { ...verified(400), validation: undefined }
    await captured.redemptionAdapter!.redeem('cashuA-plain', { metadata: unverified })

    expect(record().claimedMinor).toBe(0)
    expect(record().outstandingMinor).toBe(1000)
  })
})

describe('merchantClaimFor', () => {
  it('files nothing for a coupon this wallet did not issue', () => {
    // A customer passing someone else's voucher on. Stamping the id here would
    // switch the ceiling on for them and refuse an honest transfer back.
    expect(merchantClaimFor({ ...verified(400), issuerId: 'a'.repeat(64) }, STALL)).toBeUndefined()
  })

  it('files nothing without a verified signature', () => {
    expect(merchantClaimFor({ ...verified(400), validation: undefined }, STALL)).toBeUndefined()
    expect(
      merchantClaimFor(
        { ...verified(400), validation: { ...verified(400).validation, signatureValid: false } },
        STALL,
      ),
    ).toBeUndefined()
  })

  it('carries the signed id and the value of THIS token', () => {
    expect(merchantClaimFor(verified(400), STALL.toUpperCase())).toEqual({
      voucherId: VOUCHER_ID,
      amount: 400,
      unit: 'XAF',
      decimals: 0,
    })
  })
})
