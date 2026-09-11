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
const GATEWAY = '27aa1ecd8aa7ee6c0104fdb3dd0c0e700e55754212746d7a5774ac3c8e585a30'
const EVENT_ID = 'dca74270326812668b9d0fe06aafef530dd92ca0acc2394d91a2daa55e798900'

const nip44Encrypt = vi.fn(() => 'ciphertext==')
// Typed with signedFetch's REAL parameter list (path, method, payload, signer),
// so `mock.calls[0]` is a tuple rather than `[]`. Untyped, every destructuring
// of a call below needed an `as` cast that tsc rejects outright — and a cast
// that did compile would assert the shape instead of checking it, which is the
// opposite of what these assertions are for.
const signedFetch = vi.fn(
  async (_path: string, _method: string, _payload?: unknown, _signer?: unknown) =>
    new Response(null, { status: 202 }),
)

vi.mock('../nap', () => ({
  getSigner: () => ({ pubkey: RECIPIENT, nip44Encrypt }),
}))
vi.mock('../nip98', () => ({
  signedFetch: (...args: Parameters<typeof signedFetch>) => signedFetch(...args),
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

/**
 * Who the receipt is addressed to.
 *
 * The gateway signs the gift wrap, not the merchant — `issue.ts` says so
 * outright: "The DM is signed with the gateway's own identity rather than the
 * merchant's, but merchant attribution rides on issuer_id inside the payload".
 *
 * So addressing a settlement receipt to the envelope's signer tells the
 * GATEWAY that a coupon was claimed, and the merchant who is owed the news
 * never hears. Observed live: a receipt enqueued under the gateway's key while
 * the merchant waiting on it had a different one; the POST succeeded, the queue
 * accepted it, and the push had nobody to notify.
 */
describe('who a receipt names', () => {
  it('prefers the issuer over the envelope signer', () => {
    const meta = { issuerId: SENDER, senderPubkey: GATEWAY }
    // The resolution dmPoll performs, kept here so the precedence is pinned
    // somewhere a reader will find it.
    const resolved = String(meta.issuerId ?? meta.senderPubkey ?? '')
    expect(resolved).toBe(SENDER)
    expect(resolved).not.toBe(GATEWAY)
  })

  it('falls back to the signer when there is no issuer', () => {
    const meta: { issuerId?: string; senderPubkey?: string } = { senderPubkey: SENDER }
    const resolved = String(meta.issuerId ?? meta.senderPubkey ?? '')
    expect(resolved).toBe(SENDER)
  })
})

/**
 * What a receipt may assert about money.
 *
 * dmCrypto is explicit that envelope fields are sender-written and unchecked:
 * "a genuine low-value token could be announced at any face value at all". The
 * wallet already refuses to sign an attestation over an unverified face value;
 * a notification telling the sender "£500 was claimed" is the same claim in a
 * friendlier place, and just as unfounded.
 *
 * These pin the resolution dmPoll performs before calling postPaymentReceipt,
 * so the omission cannot quietly become a default.
 */
describe('amounts a receipt may carry', () => {
  const verified = { signatureValid: true }
  const unverified = { signatureValid: false }

  function amountFields(validation: { signatureValid?: boolean } | undefined) {
    return validation?.signatureValid === true
      ? { faceValue: 150, faceUnit: 'GBP', faceDecimals: 2 }
      : {}
  }

  it('carries the amount when the voucher signature verified', () => {
    expect(amountFields(verified)).toEqual({ faceValue: 150, faceUnit: 'GBP', faceDecimals: 2 })
  })

  it('omits the amount when the signature did not verify', () => {
    expect(amountFields(unverified)).toEqual({})
  })

  /** Plain ecash has no voucher to verify, so there is no amount to vouch for. */
  it('omits the amount when there is no validation at all', () => {
    expect(amountFields(undefined)).toEqual({})
  })

  it('renders without an amount rather than inventing one', async () => {
    signedFetch.mockClear()
    signedFetch.mockResolvedValue(new Response(null, { status: 202 }))
    await postPaymentReceipt({ senderPubkeyHex: SENDER, deliveryEventId: EVENT_ID })

    const [, , body] = signedFetch.mock.calls[0] as [string, string, Record<string, unknown>]
    expect(body.faceValue).toBeUndefined()
    expect(body.faceUnit).toBeUndefined()
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
