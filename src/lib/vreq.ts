import { issuingStall, type Actor } from './actor'
import { toTransaction } from './transactions'
import { listTransactions } from './wallet'

/**
 * The merchant half of NUT-18V: asking a customer to pay.
 *
 * The customer half already exists — `ScanPage` reads the QR and `PayPage` pays
 * it — so this is only the request side. The generator is ALREADY IN THE PAGE:
 * `src/main.tsx` loads imani-apps' `shared/nut18v.js` as a classic script, which
 * installs `window.NUT18V` with `generate`, `parse`, `generatePaymentId` and
 * `isExpired` on it.
 *
 * So possa-merchant's `src/lib/vreq/nut18v.ts` is deliberately NOT ported, and
 * neither is `cborg`. Two CBOR encoders for one wire format is exactly the kind
 * of duplication that drifts: the field order in that encoder matches
 * `VoucherPaymentRequest.java`'s `@JsonPropertyOrder`, and a second
 * implementation would have to keep matching it forever.
 *
 * HOW FULFILMENT IS DETECTED, and why there is no polling here: paying a vreq
 * goes through `POST /api/v1/atomic-send`, whose saga DMs the token to
 * `recipientPubkey` — which `lib/pay.ts` sets to the request's `issuerId`, i.e.
 * this merchant. A merchant running this wallet already has `startDmPoll` going,
 * so the payment arrives through the ordinary receive pipeline and shows up as a
 * wallet change. possa-merchant polls `/merchant/payment-requests/check` every
 * 30s instead, but that endpoint does not exist on this stack.
 */

/** possa-merchant's default, and the shim's: one day. */
export const DEFAULT_EXPIRY_SECONDS = 86_400

/**
 * Moved to `@imani/payment-requests` (API ticket 05), so the wallet API can
 * apply the same rules to state a caller supplies. Re-exported because every
 * screen already imports from this path.
 */
import {
  expireRequests,
  matchPayment,
  groupArrivals,
  partialFor,
  type VoucherPaymentRequest,
  type Arrival,
} from '@imani/payment-requests'

export type { VoucherPaymentRequest, Arrival }
export { expireRequests, matchPayment, groupArrivals, partialFor }

/** The shape `window.NUT18V` exposes. Only what this module uses. */
interface Nut18vShim {
  generate(options: {
    amount: number
    unit: string
    issuerId: string
    description?: string | null
    singleUse?: boolean
    expiresAt?: number | null
  }): { paymentId: string; requestString: string; clickableUri: string }
}

function shim(): Nut18vShim {
  const nut18v = (window as unknown as { NUT18V?: Nut18vShim }).NUT18V
  // Loud rather than a TypeError three frames deeper. The script is loaded by
  // main.tsx as a side effect, so absence means the bundle changed, not that the
  // caller did something wrong.
  if (!nut18v?.generate) throw new Error('The payment request encoder is not loaded.')
  return nut18v
}

/**
 * Build a payment request for this stall.
 *
 * `issuerId` MUST be the STALL's own pubkey, and terminals ticket 03 is about
 * the word "stall" there rather than "whoever is signed in".
 *
 * Takings are gift-wrapped to the recipient's key: `lib/pay.ts` sets
 * `recipientPubkey` to the request's `issuerId`, and the atomic-send saga DMs
 * the token there. So a device that named ITSELF would collect coupons its
 * owner cannot decrypt — money stranded on a till, and revoking that till would
 * destroy funds rather than only access. A terminal is an instrument for asking
 * for payment and never a place money rests.
 *
 * Hence an `Actor` rather than a pubkey, exactly as issuance takes one: the
 * recipient is read from `issuingStall` and a caller has no field in which to
 * put a different key. The old signature took `issuerPubkey: string`, and every
 * caller passed its session pubkey — which is correct on the owner's device and
 * silently wrong on a terminal.
 *
 * The shim rejects an empty issuer but not a wrong one, and a request carrying
 * someone else's issuer id sends the customer's payment to that someone else.
 * possa-merchant validates this explicitly (`paymentRequest.ts:116`) and so do
 * we — now structurally.
 */
export function createRequest({
  amount,
  unit,
  actor,
  description,
  expirySeconds = DEFAULT_EXPIRY_SECONDS,
}: {
  amount: number
  unit: string
  /** WHO is being paid. The stall, whichever device is displaying the QR. */
  actor: Actor
  description?: string
  expirySeconds?: number
}): VoucherPaymentRequest {
  const issuerPubkey = issuingStall(actor)
  if (!issuerPubkey || issuerPubkey.length !== 64) {
    throw new Error('Invalid stall pubkey: a payment request must name its issuer.')
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('The amount must be more than zero.')
  }

  const expiresAt = Math.floor(Date.now() / 1000) + expirySeconds
  const generated = shim().generate({
    amount,
    unit,
    issuerId: issuerPubkey,
    description: description?.trim() || null,
    singleUse: true,
    expiresAt,
  })

  return {
    paymentId: generated.paymentId,
    requestString: generated.requestString,
    clickableUri: generated.clickableUri,
    amount,
    unit,
    description: description?.trim() || undefined,
    expiresAt,
    createdAt: Date.now(),
    status: 'pending',
  }
}

// Same `imani-wallet:` prefix and pubkey scoping as the profile and merchant
// records. possa-merchant stores the equivalent under `possa:payment-requests`.
const key = (pubkey: string) => `imani-wallet:payment-requests:${pubkey}`

export function loadRequests(pubkey: string): VoucherPaymentRequest[] {
  try {
    const raw = localStorage.getItem(key(pubkey))
    if (!raw) return []
    const parsed = JSON.parse(raw) as VoucherPaymentRequest[]
    return Array.isArray(parsed) ? parsed.filter((r) => typeof r?.paymentId === 'string') : []
  } catch {
    return []
  }
}

export function saveRequests(pubkey: string, requests: VoucherPaymentRequest[]): void {
  localStorage.setItem(key(pubkey), JSON.stringify(requests))
}

export async function reconcileRequests(pubkey: string): Promise<{
  requests: VoucherPaymentRequest[]
  arrivals: Arrival[]
  settled: number
}> {
  // Grouped, not raw: a payment drawn across several coupons lands as one row
  // per coupon, and each on its own is an underpayment `matchPayment` rejects.
  const arrivals = groupArrivals((await listTransactions()).map(toTransaction))
  const stored = loadRequests(pubkey)

  let requests = stored
  let settled = 0
  for (const arrival of arrivals) {
    // The whole list, never one request: `matchPayment`'s dedup and its
    // "exactly one pending match" fallback are both judgements about the set,
    // and feeding it the accumulated list is what stops one arrival settling
    // two requests.
    const match = matchPayment(requests, arrival)
    if (!match) continue
    requests = requests.map((r) => (r.paymentId === match.paymentId ? match : r))
    settled += 1
  }

  const next = expireRequests(requests)
  // Only when something actually moved — this runs on every wallet change, and
  // rewriting an unchanged list on each one is a write for nothing.
  if (next.some((r, i) => r !== stored[i])) saveRequests(pubkey, next)

  return { requests: next, arrivals, settled }
}
