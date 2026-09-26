import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { finalizeEvent, nip17, type Event } from 'nostr-tools'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'

import { ATTESTATION_KIND, TRANSFER_RECEIPT_KIND } from '../attestationKind'
import { commitTo } from '../audit'

/**
 * Both signatures over a customer-to-customer transfer (#91), and what they
 * must never leak. ADR 0014 is the design these pin.
 */

const SENDER_SK = '1'.repeat(64)
const RECEIVER_SK = '2'.repeat(64)
const STRANGER_SK = '3'.repeat(64)
const pub = (sk: string) => bytesToHex(schnorr.getPublicKey(hexToBytes(sk)))
const SENDER = pub(SENDER_SK)
const RECEIVER = pub(RECEIVER_SK)
const STRANGER = pub(STRANGER_SK)

/** Whose wallet is "open". Swapped between sender and receiver per test. */
let currentSk = SENDER_SK
let signerThrows = false
vi.mock('../nap', () => ({
  getSigner: () => {
    if (signerThrows) throw new Error('No signer - the wallet is locked.')
    return {
      pubkey: pub(currentSk),
      withPrivkey: <T,>(borrow: (key: Uint8Array) => T) => borrow(hexToBytes(currentSk)),
    }
  },
}))

const published: Event[] = []
let publishOk = 1
let publishThrows = false
vi.mock('../relay', () => ({
  publish: async (event: Event) => {
    if (publishThrows) throw new Error('relay down')
    if (publishOk > 0) published.push(event)
    return { ok: publishOk, total: 1, errors: publishOk === 0 ? ['refused'] : [] }
  },
}))

let hasStall = false
vi.mock('../merchant', () => ({
  loadMerchant: () => (hasStall ? { pubkey: RECEIVER, categories: [] } : null),
}))

const filed: Array<[string, string]> = []
const backedUp: string[] = []
/** Rows `listTransactions` returns, for the counterparties the flood cap protects. */
const history: Array<Record<string, unknown>> = []
vi.mock('../wallet', () => ({
  recordTransferSignature: async (transfer: string, payload: string, opts?: { backUp?: boolean }) => {
    filed.push([transfer, payload])
    if (opts?.backUp !== false) backedUp.push(transfer)
  },
  backUpTransferSignature: async (transfer: string) => {
    backedUp.push(transfer)
  },
  listTransactions: async () => history,
}))

const {
  signTransfer,
  parseTransferSignature,
  verifyTransferSignature,
  verifyTransferReceipt,
  openTransferReceipt,
  transferIdFor,
  transferTag,
  transferBlind,
  transferNonce,
  transferPubkeyFor,
  transferSecretFor,
  sendTransferSignature,
  offerTransferSignature,
  noteTransferReceived,
  resetHeldTransfers,
  stopTransferReceipts,
  resumeTransferReceipts,
  sealAuthorOf,
  RECEIPT_DELAY_MIN_MS,
  RECEIPT_DELAY_MAX_MS,
  RECEIPT_JITTER_MAX_S,
  RESUME_DELAY_MIN_MS,
  RESUME_DELAY_MAX_MS,
  publishDue,
} = await import('../transferSignature')

const TOKEN = 'cashuB-the-send-token'
const TRANSFER = transferIdFor(TOKEN)
const G = schnorr.Point.BASE

function signed(over: Partial<Parameters<typeof signTransfer>[1]> = {}, sk = SENDER_SK) {
  return signTransfer(hexToBytes(sk), {
    transfer: TRANSFER,
    recipient: RECEIVER,
    amount: 250,
    unit: 'EUR',
    decimals: 2,
    ...over,
  })
}

/** What the coupon's envelope says, as dmPoll hands it over. */
const received = (over: Partial<Parameters<typeof noteTransferReceived>[0]> = {}) =>
  noteTransferReceived({ token: TOKEN, sender: SENDER, credited: 250, unit: 'EUR', decimals: 2, ...over })

/** Let every queued receipt come due. */
const elapse = () => vi.advanceTimersByTimeAsync(RECEIPT_DELAY_MAX_MS + 1)

/** Pin the CSPRNG to its maximum, so the delay and the jitter are both the largest allowed. */
function pinRandomToMax() {
  const real = crypto.getRandomValues.bind(crypto)
  vi.spyOn(crypto, 'getRandomValues').mockImplementation(((array: ArrayBufferView) => {
    if (array instanceof Uint32Array) return array.fill(0xffffffff)
    return real(array as Uint8Array)
  }) as typeof crypto.getRandomValues)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-26T12:00:00Z'))
  published.length = 0
  filed.length = 0
  backedUp.length = 0
  history.length = 0
  publishOk = 1
  publishThrows = false
  signerThrows = false
  hasStall = false
  currentSk = SENDER_SK
  resetHeldTransfers()
})

afterEach(() => {
  resetHeldTransfers()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('the sender signature', () => {
  it('verifies at the receiver', () => {
    const p = signed()
    expect(
      verifyTransferSignature(p, { recipient: RECEIVER, transfer: TRANSFER, authorPubkey: SENDER, sender: SENDER }),
    ).toEqual({ ok: true })
  })

  it('survives the trip through the gift-wrap payload', () => {
    const p = signed()
    const parsed = parseTransferSignature(JSON.stringify(p))
    expect(parsed).toEqual(p)
    expect(verifyTransferSignature(parsed!, { recipient: RECEIVER })).toEqual({ ok: true })
  })

  it.each([
    ['amount', { amount: 25_000 }],
    ['recipient', { recipient: STRANGER }],
    ['unit', { unit: 'XAF' }],
    ['decimals', { decimals: 0 }],
    ['transfer', { transfer: 'f'.repeat(32) }],
    ['nonce', { nonce: 'a'.repeat(64) }],
    ['transferKey', { transferKey: STRANGER }],
    ['bareSig', { bareSig: 'b'.repeat(128) }],
  ])('does NOT verify once %s is tampered with', (_field, patch) => {
    const tampered = { ...signed(), ...patch }
    const recipient = 'recipient' in patch ? STRANGER : RECEIVER
    expect(verifyTransferSignature(tampered, { recipient }).ok).toBe(false)
  })

  it('does NOT verify when someone else wrapped it', () => {
    expect(verifyTransferSignature(signed(), { recipient: RECEIVER, authorPubkey: STRANGER }).ok)
      .toBe(false)
  })

  it('does NOT verify when it was not signed by whoever sent the coupon', () => {
    // A stranger's own, perfectly valid, self-signed payload for this transfer.
    const theirs = signed({}, STRANGER_SK)
    expect(verifyTransferSignature(theirs, { recipient: RECEIVER }).ok).toBe(true)
    expect(verifyTransferSignature(theirs, { recipient: RECEIVER, sender: SENDER })).toEqual({
      ok: false,
      reason: 'signed by someone other than the coupon sender',
    })
  })

  it('does NOT verify for the wrong transfer', () => {
    expect(verifyTransferSignature(signed(), { recipient: RECEIVER, transfer: 'e'.repeat(32) }).ok)
      .toBe(false)
  })

  it.each([1, 3])('refuses version %i, so #94 can extend it safely and v1 stays dead', (v) => {
    const p = { ...signed(), v }
    expect(parseTransferSignature(JSON.stringify(p))).toBeUndefined()
    expect(verifyTransferSignature(p, { recipient: RECEIVER }).ok).toBe(false)
  })

  it('refuses an oversized payload before parsing it', () => {
    const p = { ...signed(), padding: 'x'.repeat(4000) }
    expect(parseTransferSignature(JSON.stringify(p))).toBeUndefined()
  })

  it.each([['cashuBxyz'], ['EUR\u001f1'], ['eur'], [''], ['TOOLONGUNIT']])(
    'refuses a unit outside the wallet alphabet on the wire: %j',
    (unit) => {
      expect(parseTransferSignature(JSON.stringify({ ...signed(), unit }))).toBeUndefined()
    },
  )

  it('refuses to sign a unit outside the alphabet, and normalises case', () => {
    expect(() => signed({ unit: 'EUR\u001f' })).toThrow(/alphabet/)
    expect(signed({ unit: 'eur' }).unit).toBe('EUR')
  })

  it('derives the nonce from the sender key, so a wiped sender rebuilds the same keys and commitment', () => {
    // D3: nothing about the payload has to be stored by the sender. Their key
    // and the transfer id on their `sent` row are enough. (The signatures
    // themselves differ, because BIP-340 mixes in fresh aux randomness, and
    // both verify.)
    const a = signed()
    const b = signed()
    expect(a.nonce).toBe(transferNonce(hexToBytes(SENDER_SK), TRANSFER, RECEIVER))
    expect(b.nonce).toBe(a.nonce)
    expect(b.transferKey).toBe(a.transferKey)
    expect(verifyTransferSignature(b, { recipient: RECEIVER })).toEqual({ ok: true })
  })

  it('uses a different nonce per transfer and per recipient, and one nobody else can compute', () => {
    const a = signed()
    expect(signed({ transfer: 'c'.repeat(32) }).nonce).not.toBe(a.nonce)
    expect(signed({ recipient: STRANGER }).nonce).not.toBe(a.nonce)
    // The gateway knows transfer and both parties; without the key it gets
    // a different answer.
    expect(transferNonce(hexToBytes(STRANGER_SK), TRANSFER, RECEIVER)).not.toBe(a.nonce)
  })

  it('makes the per-transfer key the sender identity tweaked by the secret nonce', () => {
    const p = signed()
    const tag = transferTag(p.transfer, p.nonce)
    expect(p.transferKey).not.toBe(SENDER)
    expect(p.transferKey).toBe(transferPubkeyFor(SENDER, 'sender', tag, p.nonce))
    // Only the key holder can sign with it: the matching secret needs theirs.
    const sk = transferSecretFor(hexToBytes(SENDER_SK), 'sender', tag, p.nonce)
    expect(bytesToHex(schnorr.getPublicKey(sk))).toBe(p.transferKey)
  })

  it('handles an identity key whose point has an odd y', () => {
    // BIP-340 negates such a key; the tweak must be added to the negated one.
    let odd = 1n
    while (G.multiply(odd).toAffine().y % 2n === 0n) odd += 1n
    const sk = hexToBytes(odd.toString(16).padStart(64, '0'))
    const p = signTransfer(sk, { transfer: TRANSFER, recipient: RECEIVER, amount: 1, unit: 'EUR', decimals: 2 })
    expect(verifyTransferSignature(p, { recipient: RECEIVER })).toEqual({ ok: true })
  })
})

describe('sending the signature', () => {
  it('gift-wraps it to the recipient, who can open and verify it', async () => {
    const ok = await sendTransferSignature({
      transfer: TRANSFER, recipient: RECEIVER, amount: 250, unit: 'EUR', decimals: 2,
    })
    expect(ok).toBe(true)
    expect(published).toHaveLength(1)
    expect(published[0]!.kind).toBe(1059)
    expect(published[0]!.pubkey).not.toBe(SENDER)
    // Not the bare digits: 2 KB of random base64 contains "250" about one run in 130.
    expect(published[0]!.content).not.toContain('"amount"')

    const rumor = nip17.unwrapEvent(published[0]! as never, hexToBytes(RECEIVER_SK))
    expect(sealAuthorOf(published[0]!, hexToBytes(RECEIVER_SK))).toBe(SENDER)
    const p = parseTransferSignature(rumor.content)!
    expect(verifyTransferSignature(p, { recipient: RECEIVER, transfer: TRANSFER, authorPubkey: rumor.pubkey }))
      .toEqual({ ok: true })
  })

  it('never throws, and reports false, when the relay refuses', async () => {
    publishThrows = true
    await expect(
      sendTransferSignature({ transfer: TRANSFER, recipient: RECEIVER, amount: 1, unit: 'EUR', decimals: 2 }),
    ).resolves.toBe(false)
  })

  it('never throws on a locked wallet', async () => {
    signerThrows = true
    await expect(
      sendTransferSignature({ transfer: TRANSFER, recipient: RECEIVER, amount: 1, unit: 'EUR', decimals: 2 }),
    ).resolves.toBe(false)
  })

  it('sends nothing when an older gateway returned no transfer id', async () => {
    await expect(
      sendTransferSignature({ transfer: undefined, recipient: RECEIVER, amount: 1, unit: 'EUR', decimals: 2 }),
    ).resolves.toBe(false)
    expect(published).toHaveLength(0)
  })

  it('sends nothing for a unit it will not sign', async () => {
    await expect(
      sendTransferSignature({ transfer: TRANSFER, recipient: RECEIVER, amount: 1, unit: 'cashuB', decimals: 2 }),
    ).resolves.toBe(false)
    expect(published).toHaveLength(0)
  })
})

describe('the receiver attestation', () => {
  beforeEach(() => {
    currentSk = RECEIVER_SK
  })

  it('publishes a kind-7378, never a 7377, once both halves are here and the delay has passed', async () => {
    await offerTransferSignature(signed(), SENDER)
    expect(published).toHaveLength(0) // Not yet redeemed.

    await expect(received()).resolves.toBe(true)
    expect(published).toHaveLength(0) // Queued, not published.

    await elapse()
    expect(published).toHaveLength(1)
    expect(published[0]!.kind).toBe(TRANSFER_RECEIPT_KIND)
    expect(published.some((e) => e.kind === ATTESTATION_KIND)).toBe(false)
    expect(verifyTransferReceipt(published[0]!)).toBe(true)
  })

  it('pairs in either order', async () => {
    await received()
    await offerTransferSignature(signed(), SENDER)
    await elapse()
    expect(published).toHaveLength(1)
  })

  it('waits a random, bounded delay, and never blocks the redemption on it', async () => {
    // Pin the CSPRNG to its maximum: delay = MAX, jitter = MAX.
    pinRandomToMax()
    await offerTransferSignature(signed(), SENDER)
    const start = Date.now()
    await received()

    await vi.advanceTimersByTimeAsync(RECEIPT_DELAY_MIN_MS)
    expect(published).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(RECEIPT_DELAY_MAX_MS - RECEIPT_DELAY_MIN_MS - 1000)
    expect(published).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1000)
    expect(published).toHaveLength(1)

    // `created_at` is jittered backward from the publish time, never forward.
    const publishAt = Math.floor((start + RECEIPT_DELAY_MAX_MS) / 1000)
    expect(published[0]!.created_at).toBeLessThanOrEqual(publishAt)
    expect(published[0]!.created_at).toBeGreaterThanOrEqual(publishAt - RECEIPT_JITTER_MAX_S)
    expect(published[0]!.created_at).toBeLessThan(publishAt - RECEIPT_JITTER_MAX_S / 2)
  })

  it('survives a closed tab: queued in storage, published on the next start', async () => {
    await offerTransferSignature(signed(), SENDER)
    await received()
    stopTransferReceipts() // The tab closes; the timer dies with it.
    await elapse()
    expect(published).toHaveLength(0)

    resumeTransferReceipts(RECEIVER) // The next session's poller starts.
    await vi.advanceTimersByTimeAsync(RESUME_DELAY_MAX_MS + 1)
    expect(published).toHaveLength(1)
    expect(verifyTransferReceipt(published[0]!)).toBe(true)
  })

  it('reads an erased queue as empty, not from memory, while the module lives on (N-a)', async () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    })
    try {
      await offerTransferSignature(signed(), SENDER)
      await received()
      expect(store.size).toBeGreaterThan(0)
      // Logout's sweep removes every `imani-wallet:` key, with no reload after.
      stopTransferReceipts()
      store.clear()
      resumeTransferReceipts(RECEIVER)
      await elapse()
      await elapse()
      expect(published).toHaveLength(0)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('does not publish overdue receipts beside the login, but on a fresh delay (R5)', async () => {
    await offerTransferSignature(signed(), SENDER)
    await received()
    stopTransferReceipts()
    await elapse() // Overdue while the app was closed.

    resumeTransferReceipts(RECEIVER)
    await vi.advanceTimersByTimeAsync(RESUME_DELAY_MIN_MS - 1000)
    expect(published).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(RESUME_DELAY_MAX_MS - RESUME_DELAY_MIN_MS + 2000)
    expect(published).toHaveLength(1)
  })

  it('backs the payload up to the relay later, not at pairing (R6)', async () => {
    // Pinned so each delay is the maximum and each `elapse` is exactly one step.
    pinRandomToMax()
    await offerTransferSignature(signed(), SENDER)
    await received()
    // Filed on the local row at once, but that row is not re-published yet.
    expect(filed).toHaveLength(1)
    expect(backedUp).toHaveLength(0)
    await elapse() // The 7378.
    expect(published).toHaveLength(1)
    expect(backedUp).toHaveLength(0)
    await elapse() // Then the backup, on a delay of its own.
    expect(backedUp).toEqual([TRANSFER])
  })

  it('does not lose a receipt queued while another is being published (R2)', async () => {
    // Hold the relay open on the first publish, and pair a second transfer
    // while it is held.
    const tokenB = 'cashuB-queued-mid-publish'
    await offerTransferSignature(signed(), SENDER)
    await received()
    let release!: () => void
    const relay = await import('../relay')
    const spy = vi.spyOn(relay, 'publish').mockImplementationOnce(async (event) => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      published.push(event)
      return { ok: 1, total: 1, errors: [] }
    })
    await vi.advanceTimersByTimeAsync(RECEIPT_DELAY_MAX_MS + 1)
    expect(spy).toHaveBeenCalledTimes(1) // Held.

    await offerTransferSignature(signed({ transfer: transferIdFor(tokenB) }), SENDER)
    await received({ token: tokenB })
    release()
    spy.mockRestore()
    await elapse()
    expect(published).toHaveLength(2)
  })

  it('publishes a receipt once, even when two tabs drain the same queue (R3)', async () => {
    await offerTransferSignature(signed(), SENDER)
    await received()
    stopTransferReceipts()
    vi.advanceTimersByTime(RECEIPT_DELAY_MAX_MS + 1)
    // Two passes at once, as two tabs' timers would fire. No Locks API here,
    // so it is the claim-before-publish that makes the second find nothing.
    const [a, b] = await Promise.all([publishDue(RECEIVER), publishDue(RECEIVER)])
    expect(a + b).toBe(1)
    expect(published).toHaveLength(1)
  })

  it('serialises a pass per account through navigator.locks when there is one (R3)', async () => {
    const names: string[] = []
    let chain = Promise.resolve<unknown>(undefined)
    vi.stubGlobal('navigator', {
      locks: {
        request: (name: string, fn: () => Promise<unknown>) => {
          names.push(name)
          const run = chain.then(fn)
          chain = run.catch(() => {})
          return run
        },
      },
    })
    try {
      await offerTransferSignature(signed(), SENDER)
      await received()
      stopTransferReceipts()
      vi.advanceTimersByTime(RECEIPT_DELAY_MAX_MS + 1)
      await Promise.all([publishDue(RECEIVER), publishDue(RECEIVER)])
      expect(published).toHaveLength(1)
      expect(names).toEqual([`imani-transfer-receipts:${RECEIVER}`, `imani-transfer-receipts:${RECEIVER}`])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('names neither party, the amount, the voucher, or the transfer id', async () => {
    const p = signed()
    await offerTransferSignature(p, SENDER)
    await received()
    await elapse()
    const event = published[0]!
    const wire = JSON.stringify(event)
    expect(event.pubkey).not.toBe(RECEIVER)
    for (const secret of [SENDER, RECEIVER, TRANSFER, p.nonce, p.sig, TOKEN]) {
      expect(wire).not.toContain(secret)
    }
    expect(JSON.parse(event.content)).not.toHaveProperty('amount')
  })

  it('is signed by the receiver identity tweaked, which the sender predicted and signed', async () => {
    const p = signed()
    await offerTransferSignature(p, SENDER)
    await received()
    await elapse()
    const tag = transferTag(TRANSFER, p.nonce)
    expect(published[0]!.pubkey).toBe(transferPubkeyFor(RECEIVER, 'receiver', tag, p.nonce))
    const content = JSON.parse(published[0]!.content)
    expect(content.senderKey).toBe(p.transferKey)
    expect(content.senderSig).toBe(p.transferSig)
    expect(content.tag).toBe(tag)
  })

  it('commits to the amount, unit and decimals so either party can open it', async () => {
    const p = signed()
    await offerTransferSignature(p, SENDER)
    await received()
    await elapse()
    const content = JSON.parse(published[0]!.content)
    expect(content).toMatchObject({ unit: 'EUR', decimals: 2 })
    expect(content.commitment).toBe(commitTo(250, transferBlind(p.nonce)))
    expect(openTransferReceipt(published[0]!, p)).toEqual({ ok: true, amount: 250, unit: 'EUR', decimals: 2 })
  })

  it.each([
    ['amount', { credited: 200 }],
    ['unit', { unit: 'XAF' }],
    ['decimals', { decimals: 0 }],
    ['verification (unverified voucher)', { credited: undefined, unit: undefined, decimals: undefined }],
  ])('publishes the signed "no commitment" form when the parties disagree on %s', async (_what, over) => {
    const p = signed()
    await offerTransferSignature(p, SENDER)
    await received(over)
    await elapse()
    const content = JSON.parse(published[0]!.content)
    expect(content).not.toHaveProperty('commitment')
    expect(content).not.toHaveProperty('unit')
    expect(content.senderSig).toBe(p.bareSig)
    expect(verifyTransferReceipt(published[0]!)).toBe(true)
    expect(openTransferReceipt(published[0]!, p)).toEqual({ ok: true })
  })

  it('publishes NOTHING without a sender signature', async () => {
    await expect(received()).resolves.toBe(false)
    await elapse()
    expect(published).toHaveLength(0)
  })

  it('publishes NOTHING when the coupon names no sender', async () => {
    await offerTransferSignature(signed(), SENDER)
    await expect(received({ sender: undefined })).resolves.toBe(false)
    await elapse()
    expect(published).toHaveLength(0)
  })

  it('ignores a tampered signature instead of publishing it', async () => {
    await offerTransferSignature({ ...signed(), amount: 99_999 }, SENDER)
    await received()
    await elapse()
    expect(published).toHaveLength(0)
  })

  it('ignores a signature addressed to someone else', async () => {
    await offerTransferSignature(signed({ recipient: STRANGER }), SENDER)
    await received()
    await elapse()
    expect(published).toHaveLength(0)
  })

  describe('a signature from someone other than the coupon sender (D2)', () => {
    it('cannot replace the real one, whichever arrives first', async () => {
      const real = signed()
      const theirs = signed({}, STRANGER_SK)
      await offerTransferSignature(theirs, STRANGER)
      await offerTransferSignature(real, SENDER)
      await offerTransferSignature(theirs, STRANGER)
      await received()
      await elapse()
      expect(published).toHaveLength(1)
      expect(JSON.parse(published[0]!.content).senderKey).toBe(real.transferKey)
    })

    it('is never published on its own', async () => {
      await offerTransferSignature(signed({}, STRANGER_SK), STRANGER)
      await received()
      await elapse()
      expect(published).toHaveLength(0)
    })

    it('a later payload from the same signer does not overwrite the first', async () => {
      const first = signed()
      await offerTransferSignature(first, SENDER)
      // Validly signed by the sender, for another amount.
      await offerTransferSignature(signed({ amount: 1 }), SENDER)
      await received()
      await elapse()
      expect(JSON.parse(published[0]!.content).commitment).toBe(commitTo(250, transferBlind(first.nonce)))
    })

    it('a flood from ONE key cannot push a genuine one out of the store (L5)', async () => {
      // More than the 200-entry global cap, all from one validly-signing key.
      await offerTransferSignature(signed(), SENDER)
      for (let i = 0; i < 205; i += 1) {
        const transfer = i.toString(16).padStart(32, '0')
        await offerTransferSignature(signed({ transfer }, STRANGER_SK), STRANGER)
      }
      await received()
      await elapse()
      expect(published).toHaveLength(1)
    }, 60_000)

    /** 200 one-shot keys, one validly self-signed payload each. Keys are free. */
    async function floodFromFreshKeys() {
      for (let i = 0; i < 200; i += 1) {
        const sk = bytesToHex(schnorr.utils.randomSecretKey())
        const transfer = (i + 1).toString(16).padStart(32, 'f')
        await offerTransferSignature(signed({ transfer }, sk), pub(sk))
      }
    }

    it('a flood from fresh keys cannot push out a signature from a known counterparty (R4)', async () => {
      // The sender is someone this wallet has dealt with before.
      history.push({ id: 'received:earlier', type: 'received', counterparty: SENDER, amount: 1 })
      await offerTransferSignature(signed(), SENDER)
      await floodFromFreshKeys()
      await received()
      await elapse()
      expect(published).toHaveLength(1)
    }, 60_000)

    it('a flood from fresh keys cannot push out a signature already paired and queued (R4)', async () => {
      await offerTransferSignature(signed(), SENDER)
      await received() // Paired and queued before the flood.
      await floodFromFreshKeys()
      await elapse()
      expect(published).toHaveLength(1)
    }, 60_000)
  })

  it('files the payload on the received row, so the receipt can be opened after a wipe (D3)', async () => {
    const p = signed()
    await offerTransferSignature(p, SENDER)
    await received()
    expect(filed).toEqual([[TRANSFER, JSON.stringify(p)]])
    await elapse()
    expect(openTransferReceipt(published[0]!, parseTransferSignature(filed[0]![1])!).ok).toBe(true)
  })

  it('retries a refused publish on a fresh delay, then gives up, never throwing', async () => {
    // Pinned to the maximum delay, so each `elapse` is exactly one attempt.
    pinRandomToMax()
    await offerTransferSignature(signed(), SENDER)
    publishOk = 0
    await received()
    await elapse()
    await elapse()
    publishOk = 1
    await elapse() // Third attempt succeeds.
    expect(published).toHaveLength(1)

    published.length = 0
    resetHeldTransfers()
    publishThrows = true
    await offerTransferSignature(signed(), SENDER)
    await received()
    for (let i = 0; i < 5; i += 1) await elapse()
    publishThrows = false
    await elapse()
    expect(published).toHaveLength(0) // Dropped after three attempts.
  })

  it('never throws on a locked wallet', async () => {
    signerThrows = true
    await expect(received()).resolves.toBe(false)
    await expect(offerTransferSignature(signed(), SENDER)).resolves.toBe(false)
  })

  it('a stall never queues or publishes one, even if it opened after noting a receipt (L3)', async () => {
    await received()
    hasStall = true
    await expect(offerTransferSignature(signed(), SENDER)).resolves.toBe(false)
    await elapse()
    expect(published).toHaveLength(0)

    // And a receipt already queued as a customer is not published by a stall.
    hasStall = false
    resetHeldTransfers()
    await offerTransferSignature(signed(), SENDER)
    await received()
    hasStall = true
    await elapse()
    expect(published).toHaveLength(0)
  })

  it('forgets a coupon whose signature never came, after a month (N2)', async () => {
    await received()
    await vi.advanceTimersByTimeAsync(31 * 24 * 60 * 60 * 1000)
    await received({ token: 'cashuB-some-other' }) // Prunes on write.
    await offerTransferSignature(signed(), SENDER)
    await elapse()
    expect(published).toHaveLength(0)
  })

  it('a per-transfer receiver key: two receipts share no author', async () => {
    const tokenB = 'cashuB-another'
    await offerTransferSignature(signed(), SENDER)
    await offerTransferSignature(signed({ transfer: transferIdFor(tokenB) }), SENDER)
    await received()
    await received({ token: tokenB })
    await elapse()
    expect(published).toHaveLength(2)
    expect(published[0]!.pubkey).not.toBe(published[1]!.pubkey)
  })
})

describe('a published receipt cannot be re-used (D1)', () => {
  async function genuine(over: Partial<Parameters<typeof noteTransferReceived>[0]> = {}) {
    currentSk = RECEIVER_SK
    const p = signed()
    await offerTransferSignature(p, SENDER)
    await received(over)
    await elapse()
    return { p, event: published[0]! }
  }

  /** Re-sign `content` under a fresh author, as anyone could. */
  function republish(event: Event, content: Record<string, unknown>) {
    return finalizeEvent(
      { kind: event.kind, created_at: event.created_at, tags: event.tags, content: JSON.stringify(content) },
      hexToBytes('4'.repeat(64)),
    )
  }

  it('a copied {tag, senderKey, senderSig} under a new author does not verify', async () => {
    const { event } = await genuine()
    const copy = republish(event, JSON.parse(event.content))
    expect(verifyTransferReceipt(event)).toBe(true)
    expect(verifyTransferReceipt(copy)).toBe(false)
  })

  it('the same holds for the no-commitment form', async () => {
    const { event } = await genuine({ credited: 1 })
    expect(verifyTransferReceipt(republish(event, JSON.parse(event.content)))).toBe(false)
  })

  it('a shifted commitment C + kG does not verify, even from the genuine author', async () => {
    const { p, event } = await genuine()
    const content = JSON.parse(event.content)
    const shifted = schnorr.Point.fromHex(content.commitment).add(G.multiply(1000n)).toHex(true)
    // It WOULD open to 250 + 1000 with the same blind, which is the attack.
    expect(shifted).toBe(commitTo(1250, transferBlind(p.nonce)))

    const receiverSk = transferSecretFor(hexToBytes(RECEIVER_SK), 'receiver', content.tag, p.nonce)
    const forged = finalizeEvent(
      { kind: event.kind, created_at: event.created_at, tags: event.tags, content: JSON.stringify({ ...content, commitment: shifted }) },
      receiverSk,
    )
    expect(verifyTransferReceipt(forged)).toBe(false)
  })

  it('neither dropping nor adding a commitment verifies', async () => {
    const { p, event } = await genuine()
    const content = JSON.parse(event.content)
    const receiverSk = transferSecretFor(hexToBytes(RECEIVER_SK), 'receiver', content.tag, p.nonce)
    const resign = (c: Record<string, unknown>) =>
      finalizeEvent({ kind: event.kind, created_at: event.created_at, tags: event.tags, content: JSON.stringify(c) }, receiverSk)
    const bare = { ...content }
    delete bare.commitment
    delete bare.unit
    delete bare.decimals
    expect(verifyTransferReceipt(resign(bare))).toBe(false)
    expect(verifyTransferReceipt(resign({ ...content, unit: 'XAF' }))).toBe(false)
    expect(verifyTransferReceipt(resign({ ...content, decimals: 0 }))).toBe(false)
  })

  it('a forged sender half does not verify', async () => {
    const { event } = await genuine()
    const forged = { ...event, content: JSON.stringify({ ...JSON.parse(event.content), senderKey: STRANGER }) }
    expect(verifyTransferReceipt(forged)).toBe(false)
  })

  it('opening against another transfer, sender or amount fails', async () => {
    const { p, event } = await genuine()
    expect(openTransferReceipt(event, signed({ amount: 251 })).ok).toBe(false)
    expect(openTransferReceipt(event, signed({ transfer: 'c'.repeat(32) })).ok).toBe(false)
    expect(openTransferReceipt(event, signed({}, STRANGER_SK)).ok).toBe(false)
    expect(openTransferReceipt(event, p).ok).toBe(true)
  })
})
