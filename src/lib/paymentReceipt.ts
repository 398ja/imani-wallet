import { sha256 } from '@noble/hashes/sha256'

import { getSigner } from './nap'
import { signedFetch } from './nip98'

/**
 * Tell the gateway a coupon has been redeemed, so the SENDER learns it landed.
 *
 * The sender has no other way to find out. They handed over a gift wrap and the
 * money left their balance; whether the recipient ever claimed it is invisible
 * to them. `POST /api/v1/payment-receipts` is the answer the gateway already
 * built for this — it enqueues the encrypted receipt for the sender to drain,
 * and fires their "Voucher Claimed" Web Push on the way through
 * (`PaymentReceiptController.fireSettlementPush`, spec 033).
 *
 * <p>None of that had ever run. The endpoint existed, the queue was deployed,
 * the push service was initialised with VAPID keys and four subscriptions were
 * registered — and `push_notification_log` held **zero rows**, because nothing
 * in this wallet ever posted a receipt. The word `payment-receipts` appeared in
 * the client exactly once, in a comment.
 *
 * <p><strong>The receipt body is encrypted to the sender</strong>, NIP-44, so
 * the gateway relays a blob it cannot read. The cleartext hints alongside it
 * exist only to render the push body and are deliberately coarse: an amount and
 * a name, never the token.
 */

/** What the sender decrypts: enough to reconcile, nothing more. */
export interface ReceiptPayload {
  v: 1
  voucherId?: string
  /** MINOR units, as everywhere else in this wallet: 72 is £0.72, not £72. */
  faceValue?: number
  faceUnit?: string
  /**
   * Where the decimal point goes. Carried rather than assumed, because it
   * varies per merchant group and zero-decimal currencies exist — a reader
   * that defaults to 2 renders a 5000 XAF coupon as "50.00".
   */
  faceDecimals?: number
  redeemedAt: number
  /**
   * The customer's own signature that they paid for this sale.
   *
   * Rides on the receipt the wallet was sending anyway, which is the whole
   * design: the customer's key is on the customer's device, and this is
   * already a message to exactly the right recipient at a moment when they are
   * looking at their own phone rather than holding up a queue at a counter.
   *
   * See `imani-docs/wallet/attestation-ui-gap.md` for why this is here and not in a prompt
   * during the sale, and `cashAttestation.ts` for what it does and does not
   * establish — chiefly that it attests RECEIPT rather than payment.
   *
   * Absent whenever the coupon carries no warrant to bind to, which is every
   * coupon issued before warrants shipped.
   *
   * **Inside the encrypted payload, never beside it.** The cleartext hints on
   * the request exist only to render a push body; a signature naming both
   * parties and an amount is not a hint.
   */
  cashAttestation?: string
  /**
   * The bundle this coupon was one part of, as the SENDER declared it in the
   * DM (#94). Echoed back so the sender's claim receipts for one multi-coupon
   * payment collapse into one notification. Inside the ciphertext for the same
   * reason as everything else here: it links parts of one payment.
   *
   * The sender wrote these figures in the first place, so they are the
   * sender's own words returned to them — a display grouping, not a claim
   * about money.
   */
  bundleId?: string
  bundlePartIndex?: number
  bundlePartCount?: number
  bundleTotal?: number
}

export interface PostReceiptParams {
  /** Who sent the coupon — the party being told, hex. */
  senderPubkeyHex: string
  /** The gift wrap this settles, used to derive a stable receipt id. */
  deliveryEventId: string
  voucherId?: string
  /** MINOR units. */
  faceValue?: number
  faceUnit?: string
  faceDecimals?: number
  /** Rendered in the sender's push body. Coarse by design. */
  recipientName?: string
  merchantName?: string
  merchantNip05?: string
  /** The customer's signed attestation, if the coupon carried a warrant. */
  cashAttestation?: string
  /** See `ReceiptPayload.bundleId`. All four or none. */
  bundle?: { bundleId: string; index: number; count: number; total: number }
}

const RECEIPTS_ENDPOINT = '/api/v1/payment-receipts'
const HEX_64 = /^[0-9a-f]{64}$/

/**
 * Stable per-settlement id: sha256 over the delivery event and the sender.
 *
 * Deterministic on purpose. A retry must collide with the first attempt so the
 * gateway answers 409 `duplicate` rather than enqueuing a second receipt and
 * pushing the sender twice for one claim.
 */
export function computeReceiptId(deliveryEventId: string, senderPubkeyHex: string): string {
  const digest = sha256(new TextEncoder().encode(deliveryEventId + senderPubkeyHex))
  let hex = ''
  for (let i = 0; i < digest.length; i++) hex += digest[i]!.toString(16).padStart(2, '0')
  return hex
}

/**
 * Post the receipt. **Never throws.**
 *
 * By the time this runs the proofs are burnt and the balance has moved. A
 * gateway that refuses the receipt has not undone any of that, so the cost of
 * failing here is the sender's notification — never the redemption. Same
 * posture as `attestRedemption`, which it runs beside.
 */
export async function postPaymentReceipt(params: PostReceiptParams): Promise<void> {
  try {
    const signer = getSigner()
    const sender = params.senderPubkeyHex?.toLowerCase()

    // A receipt with no sender has nobody to inform, and the gateway would
    // reject it on the pattern anyway. Leave quietly rather than post garbage.
    if (!sender || !HEX_64.test(sender)) return
    if (!params.deliveryEventId) return

    const payload: ReceiptPayload = {
      v: 1,
      voucherId: params.voucherId,
      faceValue: params.faceValue,
      faceUnit: params.faceUnit,
      faceDecimals: params.faceDecimals,
      redeemedAt: Math.floor(Date.now() / 1000),
      cashAttestation: params.cashAttestation,
      ...(params.bundle
        ? {
            bundleId: params.bundle.bundleId,
            bundlePartIndex: params.bundle.index,
            bundlePartCount: params.bundle.count,
            bundleTotal: params.bundle.total,
          }
        : {}),
    }

    // To the SENDER's key, not our own: they are the one who reads this. The
    // gateway only ever holds the ciphertext.
    const ciphertextBase64 = signer.nip44Encrypt(sender, JSON.stringify(payload))

    const response = await signedFetch(RECEIPTS_ENDPOINT, 'POST', {
      receiptId: computeReceiptId(params.deliveryEventId, sender),
      senderPubkeyHex: sender,
      recipientPubkeyHex: signer.pubkey.toLowerCase(),
      ciphertextBase64,
      // Cleartext hints — push body only. Absent ones degrade to a generic
      // "Voucher Claimed" rather than failing.
      faceValue: params.faceValue,
      faceUnit: params.faceUnit,
      merchantName: params.merchantName,
      merchantNip05: params.merchantNip05,
      recipientName: params.recipientName,
    })

    if (response.status === 409) {
      // Already recorded. Expected on a retry, and the whole reason the id is
      // deterministic.
      return
    }
    if (!response.ok) {
      console.warn('[receipt] gateway refused the receipt', response.status)
    }
  } catch (error) {
    // Deliberately swallowed: see the doc comment. The redemption stands.
    console.warn('[receipt] could not post settlement receipt', error)
  }
}
