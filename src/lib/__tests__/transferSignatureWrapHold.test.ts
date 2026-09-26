import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getPublicKey, nip17, type Event } from 'nostr-tools'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import type { GiftWrapEvent, NostrdbAdapter, StorageAdapter } from '@imani/dm-poll'

import { TRANSFER_RECEIPT_KIND } from '../attestationKind'

/**
 * A first-time sender's signature survives a flood (#99, the #91 re-review's
 * R4 residual).
 *
 * The held-signature store is local and capped, and keys are free, so 200
 * validly self-signed payloads from fresh keys used to push a genuine
 * signature out before its coupon arrived: 0 receipts. The signature's gift
 * wrap is still on the relay, though, so a wrap that does not pair is now left
 * UNPROCESSED and read again once its coupon is here.
 *
 * Driven through the real `DmPollService` and the real dmCrypto adapter over
 * an in-memory relay, so the processed set is dm-poll's own.
 */

const SENDER_SK = '1'.repeat(64)
const RECEIVER_SK = '2'.repeat(64)
const SENDER = getPublicKey(hexToBytes(SENDER_SK))
const RECEIVER = getPublicKey(hexToBytes(RECEIVER_SK))

vi.mock('../nap', () => ({
  getSigner: () => ({
    pubkey: getPublicKey(hexToBytes('2'.repeat(64))),
    withPrivkey: <T,>(borrow: (key: Uint8Array) => T): T => borrow(hexToBytes('2'.repeat(64))),
  }),
}))

const published: Event[] = []
vi.mock('../relay', () => ({
  publish: async (event: Event) => {
    published.push(event)
    return { ok: 1, total: 1, errors: [] }
  },
}))
vi.mock('../nip98', () => ({ signedFetch: async () => ({ ok: true, status: 200 }) }))
vi.mock('../merchant', () => ({ loadMerchant: () => null }))
vi.mock('../wallet', () => ({
  recordTransferSignature: async () => {},
  backUpTransferSignature: async () => {},
  listTransactions: async () => [],
}))

const { createDmCryptoAdapter } = await import('../dmCrypto')
const { createDmPollService } = await import('@imani/dm-poll')
const {
  signTransfer,
  noteTransferReceived,
  resetHeldTransfers,
  transferIdFor,
  awaitsHeldWrap,
  RECEIPT_DELAY_MAX_MS,
  WRAP_HOLD_TTL_MS,
} = await import('../transferSignature')

const TOKEN = 'cashuB-the-gift-token'

function signatureWrap(sk: string, transfer = transferIdFor(TOKEN)): GiftWrapEvent {
  const p = signTransfer(hexToBytes(sk), { transfer, recipient: RECEIVER, amount: 250, unit: 'EUR', decimals: 2 })
  return nip17.wrapEvent(hexToBytes(sk), { publicKey: RECEIVER }, JSON.stringify(p)) as unknown as GiftWrapEvent
}

/** 200 one-shot keys, one validly self-signed payload each, as in the re-review. */
function flood(): GiftWrapEvent[] {
  return Array.from({ length: 200 }, (_, i) =>
    signatureWrap(bytesToHex(schnorr.utils.randomSecretKey()), (i + 1).toString(16).padStart(32, 'f')),
  )
}

/** The relay: every wrap ever published to this recipient. */
let relay: GiftWrapEvent[] = []
let processed: string[] = []
let unwraps: Array<{ id: string; opened: boolean; hold: boolean }> = []

function service(recentDmsSince = 7 * 24 * 60 * 60) {
  const nostrdb = {
    isAvailable: () => true,
    queryEvents: async (f: { since?: number; until?: number; limit?: number }) =>
      relay
        .filter((e) => (f.since === undefined || e.created_at >= f.since) && (f.until === undefined || e.created_at <= f.until))
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, f.limit ?? 1000),
    subscribeEvents: () => ({ stop: () => {} }),
  } as unknown as NostrdbAdapter
  const storage = {
    saveVoucher: async () => {},
    hasTokenBeenReceived: async () => false,
    markTokenAsReceived: async () => {},
    getProcessedEventIds: async () => processed,
    saveProcessedEventIds: async (ids: string[]) => void (processed = [...ids]),
  } as unknown as StorageAdapter
  const crypto = createDmCryptoAdapter()
  const unwrap = crypto.unwrapNip17Dm.bind(crypto)
  crypto.unwrapNip17Dm = async (event, key) => {
    const dm = await unwrap(event, key)
    // An empty `content` is the id-only answer: nothing was decrypted.
    unwraps.push({ id: event.id, opened: Boolean(dm?.content), hold: Boolean(dm?.hold) })
    return dm
  }
  return createDmPollService({
    recipientPubkey: RECEIVER,
    recipientPrivkey: '',
    recentDmsSince,
    maxProcessedEvents: 5000,
    fetchRecentOnStart: false,
    nostrdbAdapter: nostrdb,
    cryptoAdapter: crypto,
    storageAdapter: storage,
  })
}

/** The coupon was redeemed, as dmPoll reports it, then everything comes due. */
async function couponRedeemed() {
  return noteTransferReceived({ token: TOKEN, sender: SENDER, credited: 250, unit: 'EUR', decimals: 2 })
}

const receipts = () => published.filter((e) => e.kind === TRANSFER_RECEIPT_KIND)

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-26T12:00:00Z'))
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  published.length = 0
  relay = []
  processed = []
  unwraps = []
  resetHeldTransfers()
})

afterEach(() => {
  resetHeldTransfers()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('an unpaired signature wrap is held at the relay, not only in local storage (#99)', () => {
  it("a 200 fresh-key flood no longer loses a first-time sender's signature (the R4 repro)", async () => {
    const poller = service()
    const genuine = signatureWrap(SENDER_SK)
    relay.push(genuine)
    await poller.fetchRecentDms()
    relay.push(...flood())
    await poller.fetchRecentDms()

    // The coupon arrives. The cached signature was evicted by the flood, so
    // this alone does not pair, which is the whole of the old failure.
    const paired = await couponRedeemed()
    expect(paired).toBe(false)
    // The next catch-up (dmPoll runs one at once when `awaitsHeldWrap` says
    // so) reads the genuine wrap again and pairs it.
    await poller.fetchRecentDms()
    await vi.advanceTimersByTimeAsync(RECEIPT_DELAY_MAX_MS + 1)

    expect(receipts()).toHaveLength(1)
  }, 120_000)

  it('the redemption path is told to catch up when a held wrap awaits its coupon', async () => {
    const poller = service()
    relay.push(signatureWrap(SENDER_SK))
    await poller.fetchRecentDms()
    expect(awaitsHeldWrap(TOKEN)).toBe(true)
    expect(awaitsHeldWrap('cashuB-some-other-token')).toBe(false)
  })

  it('a held wrap is not decrypted again on later catch-ups (no re-processing storm), and is released once it pairs', async () => {
    const poller = service()
    const genuine = signatureWrap(SENDER_SK)
    relay.push(genuine, ...flood())
    await poller.fetchRecentDms()
    const firstPass = unwraps.length
    expect(firstPass).toBe(201)
    // Unpaired, so held: none is marked processed.
    expect(processed).not.toContain(genuine.id)

    unwraps = []
    await poller.fetchRecentDms()
    await poller.fetchRecentDms()
    // Offered again (they are unprocessed) but answered from the id alone.
    expect(unwraps.filter((u) => u.opened)).toEqual([])
    expect(unwraps.every((u) => u.hold)).toBe(true)

    await couponRedeemed()
    await poller.fetchRecentDms() // re-read: pairs
    await poller.fetchRecentDms() // released: marked processed
    expect(processed).toContain(genuine.id)
    unwraps = []
    await poller.fetchRecentDms()
    expect(unwraps.map((u) => u.id)).not.toContain(genuine.id)
    await vi.advanceTimersByTimeAsync(RECEIPT_DELAY_MAX_MS + 1)
    expect(receipts()).toHaveLength(1)
  }, 120_000)

  it('a held wrap whose coupon never comes is released after WRAP_HOLD_TTL_MS', async () => {
    // A fetch window wider than the hold, so it is the TTL that releases it.
    const poller = service(30 * 24 * 60 * 60)
    const genuine = signatureWrap(SENDER_SK)
    relay.push(genuine)
    await poller.fetchRecentDms()
    expect(processed).not.toContain(genuine.id)
    // NIP-59 backdates a wrap up to two days, and the hold counts from the
    // earlier of that and first sight, so this stays inside it.
    await vi.advanceTimersByTimeAsync(WRAP_HOLD_TTL_MS / 4)
    await poller.fetchRecentDms()
    expect(processed).not.toContain(genuine.id)

    await vi.advanceTimersByTimeAsync(WRAP_HOLD_TTL_MS)
    await poller.fetchRecentDms()
    expect(processed).toContain(genuine.id)
    unwraps = []
    await poller.fetchRecentDms()
    expect(unwraps).toEqual([])
  }, 60_000)

  it('a signature that pairs on arrival is not held', async () => {
    const poller = service()
    await couponRedeemed()
    const genuine = signatureWrap(SENDER_SK)
    relay.push(genuine)
    await poller.fetchRecentDms()
    expect(processed).toContain(genuine.id)
    await vi.advanceTimersByTimeAsync(RECEIPT_DELAY_MAX_MS + 1)
    expect(receipts()).toHaveLength(1)
  })

  it('a signature whose coupon came from someone else is not held', async () => {
    // The coupon is here, from SENDER, and a stranger signs the same transfer:
    // it can never pair, so holding it would only re-open it every poll.
    const poller = service()
    await couponRedeemed()
    const stranger = signatureWrap('3'.repeat(64))
    relay.push(stranger)
    await poller.fetchRecentDms()
    expect(processed).toContain(stranger.id)
  })
})
