import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The wiring, not the toast: does a coupon redeemed through dm-poll actually
 * announce itself?
 *
 * arrivalToast.test.ts proves the announcement is correct once called. This
 * proves it is called — which is the whole of bug 3, where a real receipt was
 * silent because nothing on the ordinary NIP-17 delivery path ever raised
 * anything.
 */

const announced: unknown[] = []
const declarations: unknown[] = []
vi.mock('../arrivalToast', () => ({
  announceArrival: (v: unknown) => void announced.push(v),
  // The bundle path is its own module's business (arrivalToast.test.ts);
  // here it is captured, since it is now the call dm-poll makes.
  announceBundleArrival: async (v: unknown, declared: unknown) => {
    announced.push(v)
    declarations.push(declared)
  },
  resumeBundleArrivals: () => {},
  stopBundleArrivals: () => {},
}))

// Mocked for the same reason as arrivalToast: this file runs without a DOM,
// and sonner inserts a stylesheet at import time. Importing it for real fails
// the whole suite before a single test runs.
// Third toast module on this path, and mocked for the same reason as the two
// beside it: `sonner` touches the DOM at import and this suite runs headless.
vi.mock('../refusalToast', () => ({ announceRefusal: vi.fn() }))
vi.mock('../unsavedReceipt', () => ({ announceUnsaved: () => {}, resumeUnsavedReceipts: () => {} }))
vi.mock('../queuedToast', () => ({
  announceQueued: () => {},
  settleQueued: () => {},
}))

// The attestation is mocked at the boundary so this file can assert WHAT the
// redemption path hands it. attestation.test.ts covers the crypto; the bug
// class this guards is the wiring — passing the wrong identifier here is
// invisible to every test in that file, because the function hashes whatever
// it is given.
const attested: Array<Record<string, unknown>> = []
let attestThrows = false
// Whether this wallet has a stall record. dmPoll runs in EVERY wallet, so the
// attestation is gated on this: a customer must never publish a record of a
// coupon they merely received.
let hasStall = true

vi.mock('../merchant', () => ({
  loadMerchant: () => (hasStall ? { pubkey: 'f'.repeat(64), categories: [] } : null),
}))

vi.mock('../attestation', () => ({
  attestRedemption: async (p: Record<string, unknown>) => {
    if (attestThrows) throw new Error('relay down')
    attested.push(p)
  },
  nullifierFor: (t: string) => `nullifier-of:${t}`,
}))

// The redemption path reaches the legacy layer for the actual mint swap; the
// question here is only what happens around it.
const redeem = vi.fn()
let correlation: Record<string, unknown> | undefined
vi.mock('../legacyBridge', () => ({
  legacyApi: async () => {},
  withCorrelation: async (c: Record<string, unknown>, fn: () => unknown) => {
    correlation = c
    return fn()
  },
}))

const notifyWalletChanged = vi.fn()
vi.mock('../wallet', () => ({
  getWallet: () => ({}),
  notifyWalletChanged: () => notifyWalletChanged(),
}))

/**
 * The settlement receipt, captured at the boundary.
 *
 * Mocked rather than left to fail against an absent signer: it swallows its own
 * errors by design, so the real thing "passes" every test while telling the
 * wrong party. WHO it is addressed to is exactly the bug being pinned here, and
 * that is only observable by looking at the call.
 */
const receipts: Array<Record<string, unknown>> = []
vi.mock('../paymentReceipt', () => ({
  postPaymentReceipt: async (p: Record<string, unknown>) => void receipts.push(p),
}))

vi.mock('../redemptionLedger', () => ({
  checkRedemption: async () => ({ allowed: true, alreadyRedeemed: 0, signedFaceValue: 0 }),
  redeemLockName: (voucherId: string) => `imani-redeem:${voucherId}`,
}))

vi.mock('../dmCrypto', () => ({
  createDmCryptoAdapter: () => ({}),
  toLegacyMetadata: (m: unknown) => m,
}))

/**
 * `createDmPollService` is where the wallet hands its adapters to the package.
 * Capturing the config is how the redemption adapter is reachable from a test
 * without standing up the whole poller.
 */
let captured: { redemptionAdapter?: { redeem: (t: string, o?: unknown) => Promise<unknown> } } = {}
vi.mock('@imani/dm-poll', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  createDmPollService: (config: typeof captured) => {
    captured = config
    return { start: async () => {}, stop: () => {}, fetchRecentDms: async () => [] }
  },
}))

// `startDmPoll` attaches visibilitychange/online listeners at module scope of
// the call, so these have to exist BEFORE it runs, not inside a beforeEach that
// the import has already outrun.
vi.stubGlobal('document', { addEventListener: () => {}, removeEventListener: () => {} })
vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {} })

const { startDmPoll, stopDmPoll } = await import('../dmPoll')

const VOUCHER = {
  voucher_id: 'v-4-xaf',
  face_value: 4,
  face_unit: 'XAF',
  face_decimals: 0,
  sender_pubkey: '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
}

beforeEach(() => {
  stopDmPoll()
  announced.length = 0
  declarations.length = 0
  attested.length = 0
  receipts.length = 0
  attestThrows = false
  // Reset, or the customer test leaks into every test after it.
  hasStall = true
  notifyWalletChanged.mockClear()
  redeem.mockReset()
  // The redemption path reads `window.TokenRedemption`, so the stub has to keep
  // the listener methods the poller also needs.
  vi.stubGlobal('window', {
    TokenRedemption: { redeem },
    addEventListener: () => {},
    removeEventListener: () => {},
  })
})

describe('a coupon arriving through dm-poll', () => {
  it('announces itself once redeemed', async () => {
    redeem.mockResolvedValue(VOUCHER)
    startDmPoll('f'.repeat(64))

    await captured.redemptionAdapter!.redeem('cashuAtoken', { metadata: {} })

    expect(announced).toHaveLength(1)
    expect(announced[0]).toMatchObject({ voucher_id: 'v-4-xaf', face_value: 4 })
  })

  it('announces only after the balance has been updated', async () => {
    // Order matters: the toast sends the user to look at their balance, and it
    // should already be the new one when they do.
    const order: string[] = []
    notifyWalletChanged.mockImplementation(() => void order.push('wallet'))
    redeem.mockImplementation(async () => {
      order.push('redeem')
      return VOUCHER
    })
    startDmPoll('f'.repeat(64))

    await captured.redemptionAdapter!.redeem('cashuAtoken', { metadata: {} })
    order.push('announced')

    expect(order).toEqual(['redeem', 'wallet', 'announced'])
  })

  it('hands the declared bundle over as display hints (#94)', async () => {
    redeem.mockResolvedValue(VOUCHER)
    startDmPoll('f'.repeat(64))

    await captured.redemptionAdapter!.redeem('cashuAtoken', {
      metadata: { bundleId: 'b'.repeat(32), bundleTotal: 600, bundlePartIndex: 1, bundlePartCount: 2 },
    })

    expect(declarations).toEqual([{ bundleId: 'b'.repeat(32), total: 600, index: 1, count: 2 }])
    // The row is booked from the coupon, never from the declaration: the
    // correlation stamped on it carries the bundle id and nothing declared.
    expect(correlation).toMatchObject({ bundleId: 'b'.repeat(32) })
    expect(correlation).not.toHaveProperty('bundleTotal')
    expect(correlation).not.toHaveProperty('bundlePartCount')
  })

  it('says nothing when the redemption failed', async () => {
    // No money moved, so there is nothing to announce — and the error has to
    // keep propagating to dm-poll's own retry handling.
    redeem.mockRejectedValue(new Error('mint unavailable'))
    startDmPoll('f'.repeat(64))

    await expect(
      captured.redemptionAdapter!.redeem('cashuAtoken', { metadata: {} }),
    ).rejects.toThrow('mint unavailable')
    expect(announced).toHaveLength(0)
  })
})

/**
 * The attestation wiring.
 *
 * These exist because a code review showed the crypto tests could not catch a
 * wiring mistake: swapping `token` for `meta.voucherId` at the call site left
 * all 660 tests green, because `nullifierFor` hashes whatever it is handed and
 * the unit tests only ever compare two of its own outputs.
 */
describe('the attestation a redemption publishes', () => {
  const VERIFIED = { signatureValid: true, legacyCanonical: true, signedFaceValue: 4, cappedAtFaceValue: false }

  it('commits to the TOKEN, not the voucher id', async () => {
    // The distinction that matters: a £10 voucher legitimately returns as £4
    // then £6 under ONE voucher_id, so a voucher-keyed nullifier collides on an
    // honest partial redemption and reports a double-spend that never happened.
    redeem.mockResolvedValue(VOUCHER)
    startDmPoll('f'.repeat(64))

    await captured.redemptionAdapter!.redeem('cashuA-the-real-token', {
      metadata: { faceValue: 4, faceUnit: 'XAF', voucherId: 'v-4-xaf', validation: VERIFIED },
    })

    expect(attested).toHaveLength(1)
    expect(attested[0].token).toBe('cashuA-the-real-token')
    expect(attested[0].token).not.toBe('v-4-xaf')
  })

  it('passes the verified face value and unit', async () => {
    redeem.mockResolvedValue(VOUCHER)
    startDmPoll('f'.repeat(64))

    await captured.redemptionAdapter!.redeem('cashuAt', {
      metadata: { faceValue: 4, faceUnit: 'XAF', validation: VERIFIED },
    })

    expect(attested[0]).toMatchObject({ faceValue: 4, unit: 'XAF', signatureValid: true })
  })

  it('does NOT attest plain ecash, which carries no issuer claim', async () => {
    // The face value of an unverified coupon is whatever the SENDER wrote in
    // the envelope. Committing to it would have the merchant signing "I
    // credited N" for a number nobody established — the same shape as the
    // fabricated child voucher the design explicitly forbids.
    redeem.mockResolvedValue(VOUCHER)
    startDmPoll('f'.repeat(64))

    await captured.redemptionAdapter!.redeem('cashuA-plain', {
      metadata: { faceValue: 999999, faceUnit: 'XAF' }, // no validation
    })

    expect(attested[0].signatureValid).toBe(false)
  })

  it('stamps the nullifier onto the row, because it cannot be recomputed later', async () => {
    // redeem() SWAPS the token at the mint, so afterwards the bytes the
    // nullifier hashes exist nowhere. Without this the merchant can re-derive
    // their ledger key and fetch their own attestations but has nothing to
    // match them against — self-audit after a device wipe is unreachable.
    redeem.mockResolvedValue(VOUCHER)
    startDmPoll('f'.repeat(64))

    await captured.redemptionAdapter!.redeem('cashuA-swapped-away', {
      metadata: { faceValue: 4, faceUnit: 'XAF', validation: VERIFIED },
    })

    expect(correlation?.attestationNullifier).toBe('nullifier-of:cashuA-swapped-away')
  })

  it('publishes NOTHING when the wallet has no stall — a customer is not a merchant', async () => {
    // The privacy leak this gate exists to stop. dmPoll runs unconditionally in
    // every wallet, so without it a customer receiving a gift-wrapped coupon
    // would emit a permanent public event about it — in a feature whose whole
    // point is privacy, and claiming something ("I honoured this") that is not
    // even true of them.
    hasStall = false
    redeem.mockResolvedValue(VOUCHER)
    startDmPoll('f'.repeat(64))

    await captured.redemptionAdapter!.redeem('cashuA-customer', {
      metadata: { faceValue: 2500, faceUnit: 'XAF', validation: VERIFIED },
    })

    expect(attested).toHaveLength(0)
  })

  it('stamps the attested figures too, so a sweep cannot republish a different number', async () => {
    // The sweep rebuilds the commitment from the row. It must use the value the
    // attestation actually committed (meta.faceValue), not the row's own
    // `amount`, which comes off the voucher and can differ — otherwise a
    // republish contradicts the original for the same redemption.
    redeem.mockResolvedValue(VOUCHER)
    startDmPoll('f'.repeat(64))

    await captured.redemptionAdapter!.redeem('cashuA-figures', {
      metadata: { faceValue: 2500, faceUnit: 'XAF', validation: VERIFIED },
    })

    expect(correlation?.attestedValue).toBe(2500)
    expect(correlation?.attestedUnit).toBe('XAF')
  })

  it('never lets a failed attestation break the redemption', async () => {
    // The proofs are burnt and the row written by this point.
    attestThrows = true
    redeem.mockResolvedValue(VOUCHER)
    startDmPoll('f'.repeat(64))

    await expect(
      captured.redemptionAdapter!.redeem('cashuAt', {
        metadata: { faceValue: 4, faceUnit: 'XAF', validation: VERIFIED },
      }),
    ).resolves.toBeDefined()
  })
})

/**
 * Who is told that a coupon was claimed.
 *
 * As reported: "the merchant gets the settlement notification, which is not
 * desirable." A paid B with a coupon A had bought from a merchant, and B's
 * redemption posted the receipt to `meta.issuerId` — the STALL that minted the
 * coupon, not the person who handed it over. A learned nothing.
 *
 * The merchant's legitimate interest in a redemption is `attestRedemption`,
 * which is a different mechanism with a different meaning ("I honoured this")
 * and is tested above. This is about the payer.
 */
describe('who the settlement receipt is addressed to', () => {
  const PAYER = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
  const STALL = 'c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5'
  const GATEWAY = '5cbdf0646e5db4eaa398f365f2ea7a0e3d419b7e0330e39ce92bddedcac4f9bc'

  it('tells the PAYER, not the stall that minted the coupon', async () => {
    redeem.mockResolvedValue(VOUCHER)
    startDmPoll('f'.repeat(64))

    await captured.redemptionAdapter!.redeem('cashuA-spent', {
      // The shape of a merchant-issued coupon spent wallet-to-wallet: the
      // payload names the payer, the voucher names the issuer, and the gift
      // wrap is signed by the gateway. All three are different keys.
      senderPubkey: GATEWAY,
      deliveryEventId: 'evt-1',
      metadata: { senderPubkey: PAYER, issuerId: STALL, faceValue: 4, faceUnit: 'XAF' },
    })

    expect(receipts).toHaveLength(1)
    expect(receipts[0]!.senderPubkeyHex).toBe(PAYER)
    expect(receipts[0]!.senderPubkeyHex).not.toBe(STALL)
  })

  it('hands the sender their own bundle declaration back, so their claims collapse (#94)', async () => {
    redeem.mockResolvedValue(VOUCHER)
    startDmPoll('f'.repeat(64))

    await captured.redemptionAdapter!.redeem('cashuA-part', {
      deliveryEventId: 'evt-1',
      metadata: {
        senderPubkey: PAYER,
        bundleId: 'b'.repeat(32),
        bundleTotal: 600,
        bundlePartIndex: 0,
        bundlePartCount: 2,
      },
    })

    expect(receipts[0]!.bundle).toEqual({ bundleId: 'b'.repeat(32), index: 0, count: 2, total: 600 })
  })

  it('sends no bundle on a single coupon', async () => {
    redeem.mockResolvedValue(VOUCHER)
    startDmPoll('f'.repeat(64))

    await captured.redemptionAdapter!.redeem('cashuA-solo', {
      deliveryEventId: 'evt-1',
      metadata: { senderPubkey: PAYER, bundleId: 'b'.repeat(32) },
    })

    expect(receipts[0]!.bundle).toBeUndefined()
  })

  it('falls back to the envelope signer for a bare wallet-to-wallet wrap', async () => {
    // No payload `sender_pubkey` — a direct NIP-17 wrap, where the signer
    // genuinely is the payer.
    redeem.mockResolvedValue(VOUCHER)
    startDmPoll('f'.repeat(64))

    await captured.redemptionAdapter!.redeem('cashuA-direct', {
      senderPubkey: PAYER,
      deliveryEventId: 'evt-2',
      metadata: { faceValue: 4, faceUnit: 'XAF' },
    })

    expect(receipts[0]!.senderPubkeyHex).toBe(PAYER)
  })

  it('still reaches the stall when the stall IS the sender', async () => {
    // A merchant issuing straight to a customer: issuer and payer are one
    // party, and the last-resort fallback is correct precisely here.
    redeem.mockResolvedValue(VOUCHER)
    startDmPoll('f'.repeat(64))

    await captured.redemptionAdapter!.redeem('cashuA-issued', {
      deliveryEventId: 'evt-3',
      metadata: { issuerId: STALL, faceValue: 4, faceUnit: 'XAF' },
    })

    expect(receipts[0]!.senderPubkeyHex).toBe(STALL)
  })
})
