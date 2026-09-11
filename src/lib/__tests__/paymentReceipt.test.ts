import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

import { computeReceiptId, postPaymentReceipt } from '../paymentReceipt'

/**
 * Telling the sender their coupon was claimed.
 *
 * Everything server-side for this already existed and had never once run: the
 * endpoint, the Artemis queue, the "Voucher Claimed" Web Push, VAPID keys and
 * four registered subscriptions — with `push_notification_log` holding zero
 * rows, because nothing in this wallet posted a receipt. The word
 * `payment-receipts` appeared in the client exactly once, in a comment.
 *
 * These tests are mostly about the ways it must NOT behave: it runs after the
 * proofs are burnt, so every failure has to cost the notification and never the
 * redemption.
 */

const SENDER = '35f7a28b6adc9a923686a4506a02cae0fcf634cb32f42675872a5bd07d67af47'
const RECIPIENT = '315042c05c30c54877e48a3fdfa64ece0a44b860e8afba2831163b6dd336ac73'
const EVENT_ID = 'dca74270326812668b9d0fe06aafef530dd92ca0acc2394d91a2daa55e798900'

const nip44Encrypt = vi.fn(() => 'ciphertext==')
const signedFetch = vi.fn(async () => new Response(null, { status: 202 }))

vi.mock('../nap', () => ({
  getSigner: () => ({ pubkey: RECIPIENT, nip44Encrypt }),
}))
vi.mock('../nip98', () => ({
  signedFetch: (...args: unknown[]) => signedFetch(...(args as [])),
}))

describe('computeReceiptId', () => {
  /**
   * Deterministic on purpose: a retry must collide with the first attempt so
   * the gateway answers 409 rather than pushing the sender twice for one claim.
   */
  it('is stable for the same settlement', () => {
    expect(computeReceiptId(EVENT_ID, SENDER)).toBe(computeReceiptId(EVENT_ID, SENDER))
  })

  it('differs per delivery, so two claims are two receipts', () => {
    expect(computeReceiptId(EVENT_ID, SENDER)).not.toBe(
      computeReceiptId(EVENT_ID.replace('dca', 'aaa'), SENDER),
    )
  })

  it('is the 64-hex shape the gateway validates', () => {
    expect(computeReceiptId(EVENT_ID, SENDER)).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('postPaymentReceipt', () => {
  beforeEach(() => {
    nip44Encrypt.mockClear()
    signedFetch.mockClear()
    signedFetch.mockResolvedValue(new Response(null, { status: 202 }))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  it('posts an encrypted receipt naming the sender', async () => {
    await postPaymentReceipt({
      senderPubkeyHex: SENDER,
      deliveryEventId: EVENT_ID,
      voucherId: 'v-1',
      faceValue: 150,
      faceUnit: 'GBP',
    })

    expect(signedFetch).toHaveBeenCalledTimes(1)
    const [path, method, body] = signedFetch.mock.calls[0] as [string, string, Record<string, unknown>]
    expect(path).toBe('/api/v1/payment-receipts')
    expect(method).toBe('POST')
    expect(body.senderPubkeyHex).toBe(SENDER)
    expect(body.recipientPubkeyHex).toBe(RECIPIENT)
    expect(body.ciphertextBase64).toBe('ciphertext==')
    expect(body.receiptId).toBe(computeReceiptId(EVENT_ID, SENDER))
  })

  /**
   * The gateway relays a blob it cannot read. Encrypting to our own key instead
   * would leave the sender unable to open their own receipt.
   */
  it('encrypts to the SENDER, not to ourselves', async () => {
    await postPaymentReceipt({ senderPubkeyHex: SENDER, deliveryEventId: EVENT_ID })
    expect(nip44Encrypt).toHaveBeenCalledWith(SENDER, expect.any(String))
  })

  it('carries the cleartext hints the push body renders', async () => {
    await postPaymentReceipt({
      senderPubkeyHex: SENDER,
      deliveryEventId: EVENT_ID,
      faceValue: 150,
      faceUnit: 'GBP',
      recipientName: 'cocoa',
    })
    const [, , body] = signedFetch.mock.calls[0] as [string, string, Record<string, unknown>]
    expect(body.faceValue).toBe(150)
    expect(body.faceUnit).toBe('GBP')
    expect(body.recipientName).toBe('cocoa')
  })

  describe('refuses to post something the gateway would reject', () => {
    it('skips a missing sender', async () => {
      await postPaymentReceipt({ senderPubkeyHex: '', deliveryEventId: EVENT_ID })
      expect(signedFetch).not.toHaveBeenCalled()
    })

    it('skips a malformed sender', async () => {
      await postPaymentReceipt({ senderPubkeyHex: 'not-a-pubkey', deliveryEventId: EVENT_ID })
      expect(signedFetch).not.toHaveBeenCalled()
    })

    it('skips a missing delivery event', async () => {
      await postPaymentReceipt({ senderPubkeyHex: SENDER, deliveryEventId: '' })
      expect(signedFetch).not.toHaveBeenCalled()
    })
  })

  describe('never turns a completed redemption into a failure', () => {
    /** The property that matters: the proofs are already burnt by this point. */
    it('swallows a network failure', async () => {
      signedFetch.mockRejectedValue(new Error('offline'))
      await expect(
        postPaymentReceipt({ senderPubkeyHex: SENDER, deliveryEventId: EVENT_ID }),
      ).resolves.toBeUndefined()
    })

    it('swallows a gateway error', async () => {
      signedFetch.mockResolvedValue(new Response(null, { status: 500 }))
      await expect(
        postPaymentReceipt({ senderPubkeyHex: SENDER, deliveryEventId: EVENT_ID }),
      ).resolves.toBeUndefined()
    })

    it('treats a duplicate as success, since the sender was already told', async () => {
      signedFetch.mockResolvedValue(new Response(null, { status: 409 }))
      await expect(
        postPaymentReceipt({ senderPubkeyHex: SENDER, deliveryEventId: EVENT_ID }),
      ).resolves.toBeUndefined()
      expect(console.warn).not.toHaveBeenCalled()
    })
  })
})
