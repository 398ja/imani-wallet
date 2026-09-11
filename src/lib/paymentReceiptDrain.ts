import { displayDecimals, formatFace } from './format'
import { getSigner } from './nap'
import { signedFetch } from './nip98'
import { recordNotification } from './notifications/inbox'
import type { ReceiptPayload } from './paymentReceipt'

/**
 * Collect the receipts that say "your coupon was claimed".
 *
 * The other half of `paymentReceipt.ts`. A recipient posts an encrypted receipt
 * when they redeem; this is the sender picking theirs up, so the claim lands in
 * the in-app inbox and not only as a Web Push the user may have dismissed,
 * denied, or never been asked for.
 *
 * <p>The push and this loop are independent on purpose. The push fires
 * server-side the moment the receipt is POSTed
 * (`PaymentReceiptController.fireSettlementPush`) and needs no client running;
 * this needs the tab open but survives a browser that refuses notifications
 * entirely. Either alone leaves a gap, which is why both exist — and why
 * `recordNotification` dedupes by id, so a claim that arrives down both routes
 * is one inbox row rather than two.
 *
 * <p>Modelled on `incomingNotifications.ts`, deliberately: same 10s cadence,
 * same visibility handling, same never-throw posture. A receipt is a record of
 * money that has already moved, so failing to collect one must never surface as
 * an error.
 */

const DRAIN_ENDPOINT = '/api/v1/payment-receipts/drain'
const ACK_ENDPOINT = '/api/v1/payment-receipts/ack'
const DRAIN_INTERVAL_MS = 10 * 1000
const DRAIN_LIMIT = 50
const LOG_PREFIX = '[receipt-drain]'

/** One receipt as the gateway hands it over. */
interface ReceiptDelivery {
  receiptId?: string
  ciphertextBase64?: string
  recipientPubkeyHex?: string
  enqueuedAt?: number
  consumeToken?: string
}

interface DrainResponse {
  receipts?: ReceiptDelivery[]
  nonce?: string
  moreAvailable?: boolean
}

let drainTimerId: ReturnType<typeof setInterval> | null = null
let drainInFlight = false
let activePubkey: string | null = null

/**
 * Decrypt one receipt and file it.
 *
 * Returns whether an inbox row was added, which is false for a receipt already
 * seen — the dedupe that keeps the push and this loop from double-reporting one
 * claim.
 */
function fileReceipt(pubkey: string, delivery: ReceiptDelivery): boolean {
  const signer = getSigner()
  const counterparty = delivery.recipientPubkeyHex
  if (!counterparty || !delivery.ciphertextBase64 || !delivery.receiptId) return false

  let payload: ReceiptPayload
  try {
    // Encrypted BY the redeemer TO us, so the conversation key is theirs.
    payload = JSON.parse(
      signer.nip44Decrypt(counterparty, delivery.ciphertextBase64),
    ) as ReceiptPayload
  } catch (error) {
    // A receipt we cannot open is still consumed below: leaving it on the queue
    // would redeliver it every ten seconds forever, and no retry will make an
    // undecryptable blob readable.
    console.warn(LOG_PREFIX, 'could not decrypt receipt', delivery.receiptId, error)
    return false
  }

  // Face values are MINOR units. Interpolating one raw renders a 72p claim as
  // "72 GBP" — off by two decimal places, in the direction that reads as a far
  // larger payment than it was.
  //
  // formatFace is the wallet's own answer and is used by the arrival toast, so
  // the two notifications for one coupon agree. It takes the decimals rather
  // than assuming 2, because zero-decimal currencies exist and a 5000 XAF
  // coupon must not render as "50.00".
  const amount =
    payload.faceValue != null && payload.faceUnit
      ? formatFace(payload.faceValue, {
          unit: payload.faceUnit,
          decimals: displayDecimals(payload.faceUnit, payload.faceDecimals),
        })
      : 'Your voucher'

  return recordNotification(pubkey, {
    // The gateway's receiptId, so the same claim arriving by push and by drain
    // collapses to one row.
    id: delivery.receiptId,
    type: 'voucher_claimed',
    title: 'Voucher Claimed',
    body: `${amount} was claimed.`,
    url: '/records',
    receivedAt: payload.redeemedAt ? payload.redeemedAt * 1000 : undefined,
  })
}

/**
 * One drain pass. Never throws.
 */
export async function runReceiptDrainTick(): Promise<void> {
  if (drainInFlight || activePubkey === null) return
  drainInFlight = true
  const pubkey = activePubkey

  try {
    const response = await signedFetch(DRAIN_ENDPOINT, 'POST', { limit: DRAIN_LIMIT })
    if (!response.ok) {
      // 401 during a lock/reunlock cycle is routine; anything else is worth a
      // line but not an escalation.
      if (response.status !== 401) {
        console.warn(LOG_PREFIX, 'drain refused', response.status)
      }
      return
    }

    const body = (await response.json()) as DrainResponse
    const receipts = Array.isArray(body.receipts) ? body.receipts : []
    if (receipts.length === 0) return

    const consumeTokens: string[] = []
    for (const delivery of receipts) {
      // File first, consume second. A receipt consumed before it is filed is
      // gone from the queue AND absent from the inbox — the one ordering that
      // loses the record outright.
      try {
        fileReceipt(pubkey, delivery)
      } catch (error) {
        console.warn(LOG_PREFIX, 'could not file receipt', delivery.receiptId, error)
      }
      if (delivery.consumeToken) consumeTokens.push(delivery.consumeToken)
    }

    // Consume even the ones that failed to decrypt or file: they will never
    // succeed on a retry, and leaving them re-delivers the same blob forever.
    if (body.nonce && consumeTokens.length > 0) {
      const ack = await signedFetch(ACK_ENDPOINT, 'POST', {
        nonce: body.nonce,
        consumeTokens,
      })
      if (!ack.ok) {
        // Unacked receipts come back on the next tick. recordNotification
        // dedupes by receiptId, so the cost is a wasted round trip rather than
        // a duplicated inbox row.
        console.warn(LOG_PREFIX, 'ack refused', ack.status)
      }
    }

    if (body.moreAvailable) void runReceiptDrainTick()
  } catch (error) {
    console.warn(LOG_PREFIX, 'drain tick failed', error)
  } finally {
    drainInFlight = false
  }
}

/** Begin collecting receipts for this account. Safe to call repeatedly. */
export function startPaymentReceipts(pubkey: string): void {
  if (drainTimerId !== null && activePubkey === pubkey) return
  if (drainTimerId !== null) stopPaymentReceipts()

  activePubkey = pubkey

  // Boot tick: a claim that happened while the tab was closed is the common
  // case, not the edge case.
  void runReceiptDrainTick()

  drainTimerId = setInterval(() => {
    // Guarded rather than assumed: this module is unit-tested under node, where
    // a bare `document` reference would throw inside the interval with nothing
    // to catch it.
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    void runReceiptDrainTick()
  }, DRAIN_INTERVAL_MS)

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange)
  }
}

function onVisibilityChange(): void {
  if (document.visibilityState === 'visible' && activePubkey !== null) {
    void runReceiptDrainTick()
  }
}

/** Stop collecting. Safe to call when not running. */
export function stopPaymentReceipts(): void {
  if (drainTimerId !== null) {
    clearInterval(drainTimerId)
    drainTimerId = null
  }
  // Detached with the timer: a listener outliving the loop would sign with a
  // session being torn down, for an account that is no longer the user's.
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', onVisibilityChange)
  }
  activePubkey = null
  drainInFlight = false
}
