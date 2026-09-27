import { toast } from 'sonner'

import { displayDecimals, formatFace } from './format'
import { getSigner } from './nap'
import { signedFetch } from './nip98'
import { recordCashAttestation } from './wallet'
import { recordNotification, upsertNotification } from './notifications/inbox'
import { wantsInApp } from './notifications/wants'
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

  // File the customer's attestation before the notification gating below.
  //
  // Deliberately ahead of `wantsInApp`: a merchant who has turned OFF the
  // "voucher claimed" notification has said they do not want to be TOLD, not
  // that they do not want the evidence. Filing it after that gate would make a
  // notification preference silently determine whether sales can be
  // reconciled.
  if (payload.cashAttestation && payload.voucherId) {
    void recordCashAttestation(payload.voucherId, payload.cashAttestation)
  }

  // The sender's own switch for "a coupon you sent was claimed". Consumed
  // either way by the caller, so a receipt the user does not want to see is
  // not redelivered forever.
  if (!wantsInApp(pubkey, 'voucher_claimed')) return false

  // One part of a multi-coupon payment: fold it into that payment's one row
  // and one toast instead of filing "€3.00 was claimed" twice (#94).
  const bundle = bundleOf(payload)
  if (bundle) {
    const filedInBundle = fileBundleClaim(pubkey, delivery.receiptId, payload, bundle)
    // `undefined`: this claim cannot be folded in (another currency, or a
    // second receipt for a part already claimed). It is still a claim, so it
    // gets its own row below rather than vanishing.
    if (filedInBundle !== undefined) return filedInBundle
  }

  const filed = recordNotification(pubkey, {
    // The gateway's receiptId, so the same claim arriving by push and by drain
    // collapses to one row.
    id: delivery.receiptId,
    type: 'voucher_claimed',
    title: 'Voucher Claimed',
    body: `${amount} was claimed.`,
    url: '/records',
    receivedAt: payload.redeemedAt ? payload.redeemedAt * 1000 : undefined,
  })

  /*
   * Say it on screen too, when the sender is actually looking.
   *
   * The settlement confirmation had a bell row and a Web Push and no toast, so
   * a sender watching the app at the moment their payment was claimed — the
   * single most likely moment for them to be watching, since they had just sent
   * it — saw nothing happen. The recipient gets a toast on arrival; the sender
   * gets one on settlement, and the pair is symmetric.
   *
   * Gated on `filed` so it fires exactly once per claim: the row is deduped by
   * receiptId, so a redelivery that files nothing must not toast either. Push
   * covers the closed-app case, and `recordNotification` dedupes across both.
   *
   * Never throws, for the same reason nothing else on this path does: a receipt
   * is a record of money that has already moved.
   */
  if (filed) {
    try {
      toast.success(`${amount} was claimed.`, {
        // Namespaced and keyed on the receipt so a re-render collapses rather
        // than stacking, exactly as the arrival toasts do.
        id: 'claimed-' + delivery.receiptId,
        duration: 6000,
      })
    } catch (error) {
      console.warn(LOG_PREFIX, 'could not toast a claim', error)
    }
  }

  return filed
}

/* ------------------------------------------------------------------------ */
/* One payment in several coupons (#94), the sender's side                   */
/* ------------------------------------------------------------------------ */

interface BundleDeclaration {
  bundleId: string
  index: number
  count: number
  total: number
}

/** The claims collected so far for one bundle this account sent. */
interface BundleClaims {
  bundleId: string
  /** The declaration as the first receipt echoed it. First write wins. */
  count: number
  total: number
  unit?: string
  decimals?: number
  /** receiptId → the part it settled. Keyed on the receipt so a redelivery is one claim. */
  parts: Record<string, { index: number; faceValue?: number }>
  updatedAt: number
}

const BUNDLE_HEX = /^[0-9a-f]{32}$/
const MAX_BUNDLES = 50
const claimsKey = (pubkey: string) => `imani-wallet:bundle-claims:${pubkey}`

function bundleOf(payload: ReceiptPayload): BundleDeclaration | undefined {
  const { bundleId, bundlePartIndex, bundlePartCount, bundleTotal } = payload
  if (typeof bundleId !== 'string' || !BUNDLE_HEX.test(bundleId)) return undefined
  const whole = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0
  if (!whole(bundlePartIndex) || !whole(bundlePartCount) || !whole(bundleTotal)) return undefined
  // A one-part bundle is one coupon: the plain row says it perfectly well.
  if (bundlePartCount < 2) return undefined
  return { bundleId, index: bundlePartIndex, count: bundlePartCount, total: bundleTotal }
}

function readClaims(pubkey: string): Record<string, BundleClaims> {
  try {
    const raw = localStorage.getItem(claimsKey(pubkey))
    const parsed: unknown = raw ? JSON.parse(raw) : {}
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, BundleClaims>)
      : {}
  } catch {
    return {}
  }
}

function writeClaims(pubkey: string, all: Record<string, BundleClaims>): void {
  const kept = Object.values(all)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_BUNDLES)
  try {
    localStorage.setItem(claimsKey(pubkey), JSON.stringify(Object.fromEntries(kept.map((c) => [c.bundleId, c]))))
  } catch (error) {
    // Display grouping only; the receipt itself is already consumed either way.
    console.warn(LOG_PREFIX, 'could not persist bundle claims', error)
  }
}

/**
 * Fold one claim into its bundle's row. Returns whether anything new was
 * said, or `undefined` when this claim does not belong in the bundle's figure
 * and should be filed on its own.
 */
function fileBundleClaim(
  pubkey: string,
  receiptId: string,
  payload: ReceiptPayload,
  declared: BundleDeclaration,
): boolean | undefined {
  const all = readClaims(pubkey)
  const claims: BundleClaims = all[declared.bundleId] ?? {
    bundleId: declared.bundleId,
    count: declared.count,
    total: declared.total,
    unit: payload.faceUnit,
    decimals: payload.faceDecimals,
    parts: {},
    updatedAt: Date.now(),
  }
  // A redelivered receipt is the same claim: nothing new to say.
  if (claims.parts[receiptId]) return false
  // A second receipt for a part already claimed, or one in another currency,
  // cannot be summed into this bundle's figure honestly.
  if (Object.values(claims.parts).some((p) => p.index === declared.index)) return undefined
  if (claims.unit && payload.faceUnit && claims.unit !== payload.faceUnit) return undefined

  claims.parts[receiptId] = { index: declared.index, faceValue: payload.faceValue }
  claims.unit ??= payload.faceUnit
  claims.decimals ??= payload.faceDecimals
  claims.updatedAt = Date.now()
  all[declared.bundleId] = claims
  writeClaims(pubkey, all)

  const parts = Object.values(claims.parts)
  const claimed = parts.length
  const done = claimed >= claims.count
  const fmt = (n: number) =>
    claims.unit
      ? formatFace(n, { unit: claims.unit, decimals: displayDecimals(claims.unit, claims.decimals) })
      : undefined
  // Summed only when every claimed part came with a verified amount (the
  // redeemer omits it otherwise). A sum with a hole in it would understate
  // what was claimed; counting parts is true either way.
  const everyAmount = parts.every((p) => typeof p.faceValue === 'number')
  const sum = everyAmount ? parts.reduce((s, p) => s + (p.faceValue ?? 0), 0) : undefined
  const summed = sum !== undefined ? fmt(sum) : undefined
  const declaredTotal = fmt(claims.total)
  const vouchers = `${claimed} of ${claims.count} vouchers`

  const body = done
    ? summed
      ? `${summed} was claimed (${vouchers}).`
      : `Your payment was claimed (${vouchers}).`
    : summed && declaredTotal
      ? `${summed} of ${declaredTotal} claimed so far (${vouchers}).`
      : `${vouchers} claimed so far.`

  upsertNotification(
    pubkey,
    {
      id: 'claimed:bundle:' + declared.bundleId,
      type: 'voucher_claimed',
      title: 'Voucher Claimed',
      body,
      url: '/records',
      receivedAt: payload.redeemedAt ? payload.redeemedAt * 1000 : undefined,
    },
    // Back to unread when the whole payment is claimed: the outcome the
    // sender is waiting for, even if they already opened the bell at "1 of 2".
    { reopen: done },
  )

  try {
    toast.success(body, {
      // One id per bundle, so each claim redraws the same toast.
      id: 'claimed-bundle-' + declared.bundleId,
      duration: 6000,
    })
  } catch (error) {
    console.warn(LOG_PREFIX, 'could not toast a claim', error)
  }
  return true
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

    // NOT recursed here. `drainInFlight` is still true until the finally
    // below, so calling runReceiptDrainTick now would hit the re-entry guard
    // and return immediately — a continuation that looks like one and does
    // nothing. The 10s tick picks up the remainder, which is what
    // incomingNotifications.ts already relies on for the same case.
    if (body.moreAvailable) {
      console.log(LOG_PREFIX, 'more receipts queued, continuing on the next tick')
    }
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
