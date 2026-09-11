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
