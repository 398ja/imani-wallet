import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

import { runReceiptDrainTick, startPaymentReceipts, stopPaymentReceipts } from '../paymentReceiptDrain'

/**
 * Collecting the receipts that say a coupon we sent has been claimed.
 *
 * The sender's half of the settlement. The gateway also pushes this the moment
 * the receipt is posted, so the tests below care most about the two ways the
 * pair can go wrong together: losing a receipt outright, or reporting one claim
 * twice.
 */

const SENDER = '35f7a28b6adc9a923686a4506a02cae0fcf634cb32f42675872a5bd07d67af47'
const REDEEMER = '315042c05c30c54877e48a3fdfa64ece0a44b860e8afba2831163b6dd336ac73'

const nip44Decrypt = vi.fn(() => JSON.stringify({ v: 1, faceValue: 150, faceUnit: 'GBP', redeemedAt: 1789152856 }))
// Both typed with the REAL parameter lists of the functions they stand in for,
// so `mock.calls[0]` is a tuple instead of `[]`. A bare `vi.fn()` makes every
// destructuring below need an `as` cast, which tsc rejects — and a cast that
// compiled would assert the call's shape rather than check it.
const signedFetch = vi.fn<
  (path: string, method: string, payload?: unknown, signer?: unknown) => Promise<Response>
>(async () => new Response(null, { status: 200 }))
const recordNotification = vi.fn<(pubkey: string, item: Record<string, unknown>) => boolean>(() => true)

vi.mock('../nap', () => ({
  getSigner: () => ({ pubkey: SENDER, nip44Decrypt }),
}))
const attestationsFiled: Array<{ voucherId: string; attestation: string }> = []
vi.mock('../wallet', () => ({
  recordCashAttestation: (voucherId: string, attestation: string) => {
    attestationsFiled.push({ voucherId, attestation })
    return Promise.resolve()
  },
}))
vi.mock('../nip98', () => ({
  signedFetch: (...args: Parameters<typeof signedFetch>) => signedFetch(...args),
}))
vi.mock('../notifications/inbox', () => ({
  recordNotification: (...args: Parameters<typeof recordNotification>) => recordNotification(...args),
  // The bundle path (#94) has its own suite with the real inbox.
  upsertNotification: () => true,
}))

/**
 * Real sonner inserts a stylesheet at import time and this file runs without a
 * DOM, so importing it for real fails the suite before a test runs — the same
 * reason arrivalToast.test.ts mocks it.
 */
const toasts: Array<{ message: unknown; options?: Record<string, unknown> }> = []
vi.mock('sonner', () => ({
  toast: {
    success: (message: unknown, options?: Record<string, unknown>) => {
      toasts.push({ message, options })
      return 'id'
    },
  },
}))

/** What the settings screen says, without standing up localStorage. */
let wanted = true
vi.mock('../notifications/wants', () => ({
  wantsInApp: () => wanted,
}))

function drainResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const ONE_RECEIPT = {
  receipts: [
    {
      receiptId: 'r1',
      ciphertextBase64: 'cipher==',
      recipientPubkeyHex: REDEEMER,
      enqueuedAt: 1789152856,
      consumeToken: 'tok-1',
    },
  ],
  nonce: 'nonce-1',
  moreAvailable: false,
}

describe('payment receipt drain', () => {
  beforeEach(() => {
    signedFetch.mockReset()
    recordNotification.mockClear()
    recordNotification.mockImplementation(() => true)
    toasts.length = 0
    wanted = true
    nip44Decrypt.mockClear()
    nip44Decrypt.mockReturnValue(
      JSON.stringify({ v: 1, faceValue: 150, faceUnit: 'GBP', redeemedAt: 1789152856 }),
    )
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    stopPaymentReceipts()
  })
  afterEach(() => {
    stopPaymentReceipts()
    vi.restoreAllMocks()
  })

  it('does nothing until started', async () => {
    await runReceiptDrainTick()
    expect(signedFetch).not.toHaveBeenCalled()
  })

  it('files a claim into the inbox and acknowledges it', async () => {
    signedFetch
      .mockResolvedValueOnce(drainResponse(ONE_RECEIPT))
      .mockResolvedValueOnce(drainResponse({ acknowledged: 1, ignored: 0 }))

    startPaymentReceipts(SENDER)
    await vi.waitFor(() => expect(recordNotification).toHaveBeenCalled())

    const [pubkey, item] = recordNotification.mock.calls[0] as [string, Record<string, unknown>]
    expect(pubkey).toBe(SENDER)
    expect(item.type).toBe('voucher_claimed')
    expect(item.title).toBe('Voucher Claimed')
    // Formatted, not interpolated raw. 150 minor units is £1.50, and the
    // reported bug was a 0.72 claim rendering as "72".
    expect(item.body).toContain('1.50')
    expect(item.body).not.toContain('150 GBP')
    // The gateway's own id, so a claim arriving by push AND by drain collapses.
    expect(item.id).toBe('r1')

    await vi.waitFor(() => expect(signedFetch).toHaveBeenCalledTimes(2))
    const [ackPath, , ackBody] = signedFetch.mock.calls[1] as [string, string, Record<string, unknown>]
    expect(ackPath).toBe('/api/v1/payment-receipts/ack')
    expect(ackBody.nonce).toBe('nonce-1')
    expect(ackBody.consumeTokens).toEqual(['tok-1'])
  })

  /**
   * Decrypted with the REDEEMER's key: the receipt was encrypted by them, to
   * us. Using our own would fail to open a receipt meant for us.
   */
  it('decrypts with the redeemer key', async () => {
    signedFetch
      .mockResolvedValueOnce(drainResponse(ONE_RECEIPT))
      .mockResolvedValueOnce(drainResponse({ acknowledged: 1, ignored: 0 }))

    startPaymentReceipts(SENDER)
    await vi.waitFor(() => expect(nip44Decrypt).toHaveBeenCalled())
    expect(nip44Decrypt).toHaveBeenCalledWith(REDEEMER, 'cipher==')
  })

  /**
   * The ordering that matters. Consuming before filing would remove the receipt
   * from the queue AND leave it out of the inbox — the one sequence that loses
   * the record outright.
   */
  it('files before it consumes', async () => {
    const order: string[] = []
    recordNotification.mockImplementation(() => {
      order.push('file')
      return true
    })
    signedFetch.mockImplementation(async (path: string) => {
      if (String(path).endsWith('/ack')) order.push('ack')
      return drainResponse(String(path).endsWith('/ack') ? { acknowledged: 1 } : ONE_RECEIPT)
    })

    startPaymentReceipts(SENDER)
    await vi.waitFor(() => expect(order).toContain('ack'))
    expect(order.indexOf('file')).toBeLessThan(order.indexOf('ack'))
  })

  /**
   * An undecryptable blob will never become readable. Leaving it on the queue
   * would redeliver it every ten seconds forever.
   */
  it('consumes a receipt it cannot decrypt, rather than looping on it', async () => {
    nip44Decrypt.mockImplementation(() => {
      throw new Error('bad key')
    })
    signedFetch
      .mockResolvedValueOnce(drainResponse(ONE_RECEIPT))
      .mockResolvedValueOnce(drainResponse({ acknowledged: 1, ignored: 0 }))

    startPaymentReceipts(SENDER)
    await vi.waitFor(() => expect(signedFetch).toHaveBeenCalledTimes(2))

    expect(recordNotification).not.toHaveBeenCalled()
    const [, , ackBody] = signedFetch.mock.calls[1] as [string, string, Record<string, unknown>]
    expect(ackBody.consumeTokens).toEqual(['tok-1'])
  })

  it('an empty queue acknowledges nothing', async () => {
    signedFetch.mockResolvedValue(drainResponse({ receipts: [], nonce: 'n', moreAvailable: false }))

    startPaymentReceipts(SENDER)
    await vi.waitFor(() => expect(signedFetch).toHaveBeenCalled())
    expect(recordNotification).not.toHaveBeenCalled()
    expect(signedFetch).toHaveBeenCalledTimes(1)
  })

  /**
   * The sender's confirmation, on screen.
   *
   * "A gets a notification to confirm the settlement." A had a bell row and a
   * Web Push and no toast, so a sender watching the app at the moment their
   * payment was claimed — the likeliest moment for them to be watching, having
   * just sent it — saw nothing happen at all.
   */
  describe('the confirmation the sender sees', () => {
    it('toasts the claim, not only files it', async () => {
      signedFetch
        .mockResolvedValueOnce(drainResponse(ONE_RECEIPT))
        .mockResolvedValueOnce(drainResponse({ acknowledged: 1 }))

      startPaymentReceipts(SENDER)
      await vi.waitFor(() => expect(toasts).toHaveLength(1))

      // The same formatted figure as the inbox row: £1.50, never "150".
      expect(String(toasts[0]!.message)).toContain('1.50')
      expect(toasts[0]!.options?.id).toBe('claimed-r1')
    })

    it('does not toast a claim already filed, so a redelivery is silent', async () => {
      // recordNotification dedupes on receiptId and returns false. The toast
      // rides on that answer rather than repeating the announcement.
      recordNotification.mockImplementation(() => false)
      signedFetch
        .mockResolvedValueOnce(drainResponse(ONE_RECEIPT))
        .mockResolvedValueOnce(drainResponse({ acknowledged: 1 }))

      startPaymentReceipts(SENDER)
      await vi.waitFor(() => expect(signedFetch).toHaveBeenCalledTimes(2))
      expect(toasts).toHaveLength(0)
    })

    it('honours a sender who switched coupon-claimed off, and still consumes', async () => {
      // Suppressed, but acked: leaving it queued would re-announce a long-since
      // settled payment the moment the preference came back on.
      wanted = false
      signedFetch
        .mockResolvedValueOnce(drainResponse(ONE_RECEIPT))
        .mockResolvedValueOnce(drainResponse({ acknowledged: 1 }))

      startPaymentReceipts(SENDER)
      await vi.waitFor(() => expect(signedFetch).toHaveBeenCalledTimes(2))

      expect(toasts).toHaveLength(0)
      expect(recordNotification).not.toHaveBeenCalled()
      const [, , ackBody] = signedFetch.mock.calls[1] as [string, string, Record<string, unknown>]
      expect(ackBody.consumeTokens).toEqual(['tok-1'])
    })
  })

  describe('never surfaces as an error', () => {
    it('swallows a refused drain', async () => {
      signedFetch.mockResolvedValue(new Response(null, { status: 500 }))
      startPaymentReceipts(SENDER)
      await expect(runReceiptDrainTick()).resolves.toBeUndefined()
    })

    it('swallows a network failure', async () => {
      signedFetch.mockRejectedValue(new Error('offline'))
      startPaymentReceipts(SENDER)
      await expect(runReceiptDrainTick()).resolves.toBeUndefined()
    })

    /** Routine during a lock/reunlock cycle, so it must not shout. */
    it('is quiet about a 401', async () => {
      signedFetch.mockResolvedValue(new Response(null, { status: 401 }))
      startPaymentReceipts(SENDER)
      await runReceiptDrainTick()
      expect(console.warn).not.toHaveBeenCalled()
    })
  })

  it('stops cleanly, so a logged-out session files nothing', async () => {
    signedFetch.mockResolvedValue(drainResponse(ONE_RECEIPT))
    startPaymentReceipts(SENDER)
    stopPaymentReceipts()
    signedFetch.mockClear()

    await runReceiptDrainTick()
    expect(signedFetch).not.toHaveBeenCalled()
  })
})


describe('the customer attestation rides in on the receipt', () => {
  // The whole point of attesting at receipt time rather than at a counter:
  // this path already runs, so the evidence arrives with no ceremony at all.
  //
  // Driven through the real drain rather than by calling the filer directly,
  // because the thing worth proving is that an attestation on the wire reaches
  // the row - every hop of that was a place the previous review found a
  // silently dropped field.
  beforeEach(() => {
    attestationsFiled.length = 0
    signedFetch.mockReset()
    recordNotification.mockClear()
    recordNotification.mockImplementation(() => true)
    wanted = true
    nip44Decrypt.mockClear()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    stopPaymentReceipts()
  })
  afterEach(() => {
    stopPaymentReceipts()
    vi.restoreAllMocks()
  })

  async function drain(payload: Record<string, unknown>) {
    nip44Decrypt.mockReturnValue(JSON.stringify({ v: 1, redeemedAt: 1, ...payload }))
    signedFetch.mockImplementation(async (path: string) =>
      drainResponse(String(path).endsWith('/ack') ? { acknowledged: 1 } : ONE_RECEIPT),
    )
    startPaymentReceipts(SENDER)
    await vi.waitFor(() => expect(nip44Decrypt).toHaveBeenCalled())
  }

  it('files the attestation against the sale it names', async () => {
    const attestation = JSON.stringify({ customer: 'cc', stall: 'dd', paid: 2500 })

    await drain({ voucherId: 'v-1', cashAttestation: attestation })

    expect(attestationsFiled).toEqual([{ voucherId: 'v-1', attestation }])
  })

  it('files nothing when the receipt carries no attestation', async () => {
    // Every coupon issued before warrants, and every terminal sale.
    await drain({ voucherId: 'v-1' })

    expect(attestationsFiled).toHaveLength(0)
  })

  it('files nothing when the receipt names no voucher', async () => {
    // Nothing to attach it to, and filing against a guessed row would be worse
    // than filing nothing.
    await drain({ cashAttestation: '{"customer":"cc"}' })

    expect(attestationsFiled).toHaveLength(0)
  })

  it('files the attestation even when claim notifications are switched off', async () => {
    // A merchant who turned OFF "voucher claimed" has said they do not want to
    // be TOLD, not that they do not want the evidence. Filing after that gate
    // would let a notification preference silently decide whether sales can be
    // reconciled.
    wanted = false

    await drain({ voucherId: 'v-2', cashAttestation: '{"a":1}' })

    expect(attestationsFiled).toEqual([{ voucherId: 'v-2', attestation: '{"a":1}' }])
  })
})
