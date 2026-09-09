import { issuingStall, type Actor } from './actor'
import { toTransaction, type WalletTransaction } from './transactions'
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

export interface VoucherPaymentRequest {
  paymentId: string
  /** The `vreqA…` string itself. */
  requestString: string
  /** `cashu:vreqA…` — what the QR encodes, so a scanner can route it. */
  clickableUri: string
  /** Minor units. */
  amount: number
  unit: string
  description?: string
  /** Epoch SECONDS, matching the wire format. */
  expiresAt: number
  createdAt: number
  status: 'pending' | 'fulfilled' | 'expired'
  /** Set once paid: which wallet transaction settled it. */
  settledBy?: string
  receivedAmount?: number
}

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

/**
 * Mark every lapsed pending request expired.
 *
 * Run on load, as possa-merchant does in its `useState` initialiser: a request
 * whose deadline passed while the app was closed is not pending, and showing it
 * as such invites a merchant to wait for a payment that can no longer arrive.
 */
export function expireRequests(
  requests: VoucherPaymentRequest[],
  now = Date.now(),
): VoucherPaymentRequest[] {
  return requests.map((request) =>
    request.status === 'pending' && request.expiresAt * 1000 <= now
      ? { ...request, status: 'expired' as const }
      : request,
  )
}

/**
 * Which pending request, if any, does this incoming payment settle?
 *
 * The matching discipline is ported from possa-merchant's `fulfillPaymentRequest`
 * — it is the valuable part of that file, and each rule is there for a reason:
 *
 * 0. Only money coming IN, and only what arrived after the request was made.
 *    `RedeemPage` sweeps the entire transaction history the moment a request is
 *    shown, so every rule below was being applied to coupons this merchant
 *    received or issued days ago: the amount fallback matched one instantly and
 *    the screen jumped from the form to "Paid" without ever drawing the QR.
 *    A transaction with no readable timestamp (`at` 0) fails this rule too, and
 *    that is the safe direction — a request left pending makes the merchant
 *    wait, a request wrongly marked paid makes them hand over the goods.
 * 1. Already-settled transactions never match again. Without the dedup a single
 *    payment re-settles a second request every time the wallet re-notifies.
 * 2. Exact `paymentId` first. `lib/pay.ts` threads the request's payment id
 *    through `buildSendParams`, the gateway echoes it back as `request_id` on
 *    the DM, and `withCorrelation` (lib/legacyBridge.ts) now stamps it onto
 *    the receive row — so this rule fires on a real payment rather than being
 *    aspirational. `_buildReceiveTransactionRow` in shared/tokenRedemption.js
 *    still writes no request reference of its own, which is why the stamping
 *    seam exists. Rule 3 stays for coupons that arrive without one.
 * 3. Amount + unit only as a FALLBACK, and only when EXACTLY ONE pending request
 *    matches. Two requests for the same amount are genuinely ambiguous, and
 *    guessing would mark the wrong sale paid.
 * 4. Underpayment is rejected; overpayment is accepted and recorded. A customer
 *    paying more than asked has still paid.
 *
 * Returns null when nothing matches, which is the common case — most wallet
 * changes are unrelated to any open request.
 */
export function matchPayment(
  requests: VoucherPaymentRequest[],
  transaction: Pick<WalletTransaction, 'id' | 'amount' | 'unit' | 'at' | 'direction'> & {
    paymentId?: string
  },
): VoucherPaymentRequest | null {
  if (transaction.direction !== 'in') return null

  const settled = new Set(requests.map((r) => r.settledBy).filter(Boolean))
  if (settled.has(transaction.id)) return null

  const pending = requests.filter(
    (r) => r.status === 'pending' && transaction.at >= r.createdAt,
  )

  const byId = transaction.paymentId
    ? pending.find((r) => r.paymentId === transaction.paymentId)
    : undefined

  const candidate =
    byId ??
    (() => {
      const sameValue = pending.filter(
        (r) => r.unit === transaction.unit && transaction.amount >= r.amount,
      )
      return sameValue.length === 1 ? sameValue[0] : undefined
    })()

  if (!candidate) return null
  if (transaction.amount < candidate.amount) return null

  return {
    ...candidate,
    status: 'fulfilled',
    settledBy: transaction.id,
    receivedAmount: transaction.amount,
  }
}


/**
 * An incoming payment as the till should see it: one bundle is one arrival.
 *
 * A customer paying €7 from two €5 coupons sends two DMs and the wallet writes
 * two rows of €5. Fed to `matchPayment` one at a time, each is an underpayment
 * and rule 4 rejects both — the merchant sees two unexplained coupons and a
 * request that stays pending forever, which is the worst possible outcome
 * since they HAVE the money. Summing the parts first is what makes the split
 * invisible to the matching rules.
 *
 * Rows with no `bundleId` pass through untouched, so an ordinary single-coupon
 * payment behaves exactly as before.
 */
export interface Arrival {
  id: string
  amount: number
  unit: string
  /** Epoch ms of the EARLIEST part — see below. */
  at: number
  direction: 'in'
  paymentId?: string
  /** How many transaction rows this arrival covers. 1 for an ordinary receive. */
  parts: number
}

export function groupArrivals(transactions: WalletTransaction[]): Arrival[] {
  const incoming = transactions.filter((t) => t.direction === 'in')
  const bundles = new Map<string, Arrival>()
  const out: Arrival[] = []

  for (const t of incoming) {
    const one: Arrival = {
      id: t.id,
      amount: t.amount,
      unit: t.unit,
      at: t.at,
      direction: 'in',
      paymentId: t.paymentId,
      parts: 1,
    }
    if (!t.bundleId) {
      out.push(one)
      continue
    }

    const seen = bundles.get(t.bundleId)
    if (!seen) {
      // Keyed on the bundle id rather than any part's row id, so the arrival
      // keeps the same identity as later parts land — `settledBy` points at it,
      // and a shifting id would let one payment settle a second request.
      bundles.set(t.bundleId, { ...one, id: `bundle:${t.bundleId}` })
      out.push(bundles.get(t.bundleId)!)
      continue
    }

    // Mixed units cannot be added. Nothing should produce one — a bundle is
    // drawn from one merchant's coupons — but adding 500 XAF to 500 EUR would
    // settle a request that was never paid, so the parts stay separate and the
    // request stays pending, which is the direction that costs nobody goods.
    if (seen.unit !== t.unit) {
      out.push(one)
      continue
    }

    seen.amount += t.amount
    seen.parts += 1
    // The EARLIEST part, deliberately: rule 0 rejects anything that arrived
    // before the request was made, and taking the latest would let a bundle
    // whose first half predates the request slip through.
    seen.at = Math.min(seen.at, t.at)
    seen.paymentId ??= t.paymentId
  }

  return out
}

/**
 * How much has arrived against this request so far, settled or not.
 *
 * By `paymentId` ONLY. The amount fallback that `matchPayment` uses for a whole
 * payment is not safe here: a part is by definition smaller than the request,
 * so "one pending request of at least this amount" would match nearly anything
 * and show the merchant progress on a sale nobody is paying for.
 */
export function partialFor(request: VoucherPaymentRequest, arrivals: Arrival[]): number {
  return arrivals
    .filter((a) => a.paymentId === request.paymentId && a.at >= request.createdAt)
    .reduce((sum, a) => sum + a.amount, 0)
}

/**
 * Settle every stored request whose money is already in the wallet.
 *
 * Settlement used to live only inside `RedeemPage`'s "Waiting for payment"
 * screen, so it ran only while the merchant was looking at that screen. The page
 * always mounts on the amount form and nothing resumes an open request — so a
 * merchant who walked away, or reloaded, could never mark that sale paid however
 * much of the money was sitting in the till. That is the one wrong state that
 * costs a merchant a sale: the coupons are here and the request says nobody
 * paid. Reconciling on unlock and on every wallet change makes settlement a
 * property of the wallet rather than of a screen.
 *
 * Matched BEFORE expiring, deliberately. A request paid ten minutes in but only
 * reconciled a day later was paid, not missed; expiring first would bury the
 * payment under a status `matchPayment` refuses to consider.
 *
 * Returns the arrivals too, because the screen that draws progress needs them
 * for `partialFor` and a second read of the wallet is a second answer.
 */
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
