import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Event } from 'nostr-tools'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'

import { ATTESTATION_KIND, TRANSFER_RECEIPT_KIND } from '../attestationKind'

/**
 * What a redemption PUBLISHES, by kind, for a customer and for a stall (#91).
 *
 * `dmPollAnnounce.test.ts` mocks `attestRedemption` and asserts it was not
 * called for a customer. This one leaves both attestation modules real and
 * watches the relay, which is the claim that actually matters: a customer
 * emits no kind-7377 on receipt, and a stall emits no kind-7378.
 */

const SENDER_SK = '1'.repeat(64)
const RECEIVER_SK = '2'.repeat(64)
const STRANGER_SK = '3'.repeat(64)
const pub = (sk: string) => bytesToHex(schnorr.getPublicKey(hexToBytes(sk)))
const SENDER = pub(SENDER_SK)
const RECEIVER = pub(RECEIVER_SK)

vi.mock('../nap', () => ({
  getSigner: () => ({
    pubkey: pub(RECEIVER_SK),
    withPrivkey: <T,>(borrow: (key: Uint8Array) => T) => borrow(hexToBytes(RECEIVER_SK)),
    nip44Encrypt: () => 'ciphertext',
  }),
}))

const published: Event[] = []
let publishThrows = false
vi.mock('../relay', () => ({
  publish: async (event: Event) => {
    if (publishThrows) throw new Error('relay down')
    published.push(event)
    return { ok: 1, total: 1, errors: [] }
  },
  allEvents: async () => [],
}))

let hasStall = false
vi.mock('../merchant', () => ({
  loadMerchant: () => (hasStall ? { pubkey: RECEIVER, categories: [] } : null),
}))

vi.mock('../arrivalToast', () => ({
  announceArrival: () => {},
  announceBundleArrival: async () => {},
  resumeBundleArrivals: () => {},
  stopBundleArrivals: () => {},
}))
vi.mock('../refusalToast', () => ({ announceRefusal: vi.fn() }))
vi.mock('../unsavedReceipt', () => ({ announceUnsaved: () => {}, resumeUnsavedReceipts: () => {} }))
vi.mock('../queuedToast', () => ({ announceQueued: () => {}, settleQueued: () => {} }))
vi.mock('../paymentReceipt', () => ({ postPaymentReceipt: async () => {} }))
vi.mock('../redemptionLedger', () => ({
  checkRedemption: async () => ({ allowed: true, alreadyRedeemed: 0, signedFaceValue: 0 }),
  redeemLockName: (voucherId: string) => `imani-redeem:${voucherId}`,
}))
vi.mock('../dmCrypto', () => ({
  createDmCryptoAdapter: () => ({}),
  toLegacyMetadata: (m: unknown) => m,
}))
vi.mock('../legacyBridge', () => ({
  legacyApi: async () => {},
  withCorrelation: async (_c: unknown, fn: () => unknown) => fn(),
}))
vi.mock('../wallet', () => ({
  getWallet: () => ({}),
  notifyWalletChanged: () => {},
  recordReceiptByNullifier: async () => {},
  recordTransferSignature: async () => {},
  backUpTransferSignature: async () => {},
  listTransactions: async () => [],
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
const redeem = vi.fn()
vi.stubGlobal('window', {
  TokenRedemption: { redeem },
  addEventListener: () => {},
  removeEventListener: () => {},
})

const { startDmPoll, stopDmPoll } = await import('../dmPoll')
const {
  offerTransferSignature,
  resetHeldTransfers,
  signTransfer,
  transferIdFor,
  RECEIPT_DELAY_MAX_MS,
} = await import('../transferSignature')

const TOKEN = 'cashuB-gift-from-a-friend'
const VERIFIED = { signatureValid: true, legacyCanonical: true, signedFaceValue: 250, cappedAtFaceValue: false }
// `senderPubkey` is the envelope's `sender_pubkey`: who actually sent it.
const META = {
  faceValue: 250,
  faceUnit: 'EUR',
  faceDecimals: 2,
  issuerId: 'c'.repeat(64),
  senderPubkey: SENDER,
  validation: VERIFIED,
}

/** Let the fire-and-forget work settle, and every randomly delayed receipt come due. */
const settle = () => vi.advanceTimersByTimeAsync(RECEIPT_DELAY_MAX_MS + 1)

async function receive(metadata: Record<string, unknown> = META) {
  startDmPoll(RECEIVER)
  const voucher = await captured.redemptionAdapter!.redeem(TOKEN, { metadata })
  await settle()
  return voucher
}

beforeEach(() => {
  vi.useFakeTimers()
  stopDmPoll()
  published.length = 0
  publishThrows = false
  hasStall = false
  resetHeldTransfers()
  redeem.mockReset()
  redeem.mockResolvedValue({ voucher_id: 'v-1', face_value: 250, face_unit: 'EUR' })
})

afterEach(() => {
  stopDmPoll()
  vi.useRealTimers()
})

async function senderSigned(sk = SENDER_SK) {
  const p = signTransfer(hexToBytes(sk), {
    transfer: transferIdFor(TOKEN),
    recipient: RECEIVER,
    amount: 250,
    unit: 'EUR',
    decimals: 2,
  })
  await offerTransferSignature(p, pub(sk))
  return p
}

describe('a CUSTOMER receiving a transfer', () => {
  it('publishes NO kind-7377', async () => {
    await senderSigned()
    await receive()
    expect(published.filter((e) => e.kind === ATTESTATION_KIND)).toHaveLength(0)
  })

  it('publishes one kind-7378 receipt when the sender signed', async () => {
    await senderSigned()
    await receive()
    expect(published.map((e) => e.kind)).toEqual([TRANSFER_RECEIPT_KIND])
  })

  it('publishes it when the signature arrives after the coupon', async () => {
    await receive()
    expect(published).toHaveLength(0)
    await senderSigned()
    await settle()
    expect(published.map((e) => e.kind)).toEqual([TRANSFER_RECEIPT_KIND])
  })

  it('commits to the verified amount, unit and decimals', async () => {
    await senderSigned()
    await receive()
    expect(JSON.parse(published[0]!.content)).toMatchObject({ unit: 'EUR', decimals: 2 })
  })

  it('pairs only the signature of whoever SENT the coupon, not a stranger who signed first (D2)', async () => {
    const stranger = await senderSigned(STRANGER_SK)
    const real = await senderSigned()
    await receive()
    expect(published).toHaveLength(1)
    expect(JSON.parse(published[0]!.content).senderKey).toBe(real.transferKey)
    expect(JSON.parse(published[0]!.content).senderKey).not.toBe(stranger.transferKey)
  })

  it('falls back to the wrap author when the envelope names no sender', async () => {
    await senderSigned()
    startDmPoll(RECEIVER)
    const noSender: Record<string, unknown> = { ...META, senderPubkey: undefined }
    await captured.redemptionAdapter!.redeem(TOKEN, { metadata: noSender, senderPubkey: SENDER })
    await settle()
    expect(published.map((e) => e.kind)).toEqual([TRANSFER_RECEIPT_KIND])
  })

  it('never pairs with the ISSUER, who minted the coupon but did not send it', async () => {
    await senderSigned()
    const noSender: Record<string, unknown> = { ...META, senderPubkey: undefined }
    await receive({ ...noSender, issuerId: SENDER })
    expect(published).toHaveLength(0)
  })

  it('publishes nothing at all without a sender signature', async () => {
    await receive()
    expect(published).toHaveLength(0)
  })

  it('completes the redemption when the receipt publish fails', async () => {
    await senderSigned()
    publishThrows = true
    await expect(receive()).resolves.toMatchObject({ voucher_id: 'v-1' })
  })
})

describe('logout and account switch (N-a)', () => {
  it('stopDmPoll drops the in-memory receipt queue, so nothing held carries over', async () => {
    // No local storage in this suite, so memory is the only copy: exactly the
    // copy a logout without a reload would otherwise leave readable.
    await senderSigned()
    stopDmPoll()
    await receive()
    expect(published).toHaveLength(0)
  })
})

describe('a STALL receiving a coupon', () => {
  it('still publishes its kind-7377, and no kind-7378', async () => {
    // A stall takes back only its own coupons, so the issuer is this wallet.
    hasStall = true
    await senderSigned()
    await receive({ ...META, issuerId: RECEIVER })
    expect(published.map((e) => e.kind)).toEqual([ATTESTATION_KIND])
  })
})
