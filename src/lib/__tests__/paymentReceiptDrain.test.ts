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
const signedFetch = vi.fn()
const recordNotification = vi.fn(() => true)

vi.mock('../nap', () => ({
  getSigner: () => ({ pubkey: SENDER, nip44Decrypt }),
}))
vi.mock('../nip98', () => ({
  signedFetch: (...args: unknown[]) => signedFetch(...(args as [])),
}))
vi.mock('../notifications/inbox', () => ({
  recordNotification: (...args: unknown[]) => recordNotification(...(args as [])),
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
