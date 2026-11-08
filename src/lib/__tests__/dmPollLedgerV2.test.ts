import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * dmPoll wiring for voucher ledger v2 (#310): the stall's REDEEMED publish runs at the same step as
 * the kind-7377 attestation, only on a stall, and can never fail a redemption. The harness is
 * `dmPollAnnounce.test.ts`'s, with `publishRedeemed` captured at the boundary; its own gates
 * (flag, signature, issuer, terminal) are covered in `voucherLedgerV2Publish.test.ts`.
 */

const ledgerCalls: Array<Record<string, unknown>> = []
let ledgerMode: 'ok' | 'reject' | 'throw' = 'ok'

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
// sonner touches the DOM at import; the held-coupon toast is its own module for that reason (#133 review).
vi.mock('../heldToast', () => ({ announceHeld: () => {} }))
// The non-money notices (#160 owner report): captured, as the money toast is above.
const notices: Array<Record<string, unknown>> = []
vi.mock('../notMoneyNotice', () => ({
  licenceNotice: (voucherId: string, licence: { tier?: string }, opts?: { renewal?: boolean }) => ({
    id: `licence:${voucherId}`,
    type: 'licence_received',
    title: `Imani ${licence.tier ?? ''} plan ${opts?.renewal ? 'renewed' : 'activated'}`,
    body: '',
    url: '/settings/subscription',
  }),
  showNotice: (n: Record<string, unknown>) => void notices.push(n),
}))
vi.mock('../refusalToast', () => ({ announceRefusal: vi.fn() }))
vi.mock('../unsavedReceipt', () => ({ announceUnsaved: () => {}, resumeUnsavedReceipts: () => {}, listUnsavedReceipts: () => [], dropAcknowledgedReceipts: async () => 0 }))
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
  publishRedeemed: (p: Record<string, unknown>) => {
    ledgerCalls.push(p)
    if (ledgerMode === 'throw') throw new Error('sync boom')
    return ledgerMode === 'reject' ? Promise.reject(new Error('async boom')) : Promise.resolve('id')
  },
}))

// The redemption path reaches the legacy layer for the actual mint swap; the
// question here is only what happens around it.
const redeem = vi.fn()
vi.mock('../legacyBridge', () => ({
  legacyApi: async () => {},
  withCorrelation: async (_c: Record<string, unknown>, fn: () => unknown) => fn(),
}))

const notifyWalletChanged = vi.fn()
vi.mock('../wallet', () => ({
  getWallet: () => ({}),
  notifyWalletChanged: () => notifyWalletChanged(),
  listVouchers: async () => [],
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
  notices.length = 0
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

const VERIFIED = { signatureValid: true, legacyCanonical: true, signedFaceValue: 4, cappedAtFaceValue: false }

describe('the voucher ledger v2 REDEEMED publish', () => {
  beforeEach(() => {
    ledgerCalls.length = 0
    ledgerMode = 'ok'
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('is handed the redeemed TOKEN and the verification verdict, on a stall', async () => {
    redeem.mockResolvedValue(VOUCHER)
    startDmPoll('f'.repeat(64))
    await captured.redemptionAdapter!.redeem('cashuA-stall', { metadata: { validation: VERIFIED } })
    expect(ledgerCalls).toEqual([{ token: 'cashuA-stall', signatureValid: true }])
    expect(attested).toHaveLength(1)
  })

  it('passes signatureValid false through for an unverified coupon (publishRedeemed then refuses)', async () => {
    redeem.mockResolvedValue(VOUCHER)
    startDmPoll('f'.repeat(64))
    await captured.redemptionAdapter!.redeem('cashuA-plain', { metadata: {} })
    expect(ledgerCalls).toEqual([{ token: 'cashuA-plain', signatureValid: false }])
  })

  it('is never called on a customer wallet', async () => {
    hasStall = false
    redeem.mockResolvedValue(VOUCHER)
    startDmPoll('f'.repeat(64))
    await captured.redemptionAdapter!.redeem('cashuA-customer', { metadata: { validation: VERIFIED } })
    expect(ledgerCalls).toHaveLength(0)
  })

  it('is never called when the redemption failed', async () => {
    redeem.mockRejectedValue(new Error('mint unavailable'))
    startDmPoll('f'.repeat(64))
    await expect(captured.redemptionAdapter!.redeem('cashuA', { metadata: { validation: VERIFIED } })).rejects.toThrow()
    expect(ledgerCalls).toHaveLength(0)
  })

  it.each(['reject', 'throw'] as const)('a publish that %ss never fails the redemption', async (mode) => {
    ledgerMode = mode
    redeem.mockResolvedValue(VOUCHER)
    startDmPoll('f'.repeat(64))
    await expect(captured.redemptionAdapter!.redeem('cashuA-x', { metadata: { validation: VERIFIED } })).resolves.toBeDefined()
    expect(ledgerCalls).toHaveLength(1)
    expect(announced).toHaveLength(1)
  })
})
