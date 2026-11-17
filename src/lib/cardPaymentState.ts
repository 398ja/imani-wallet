/**
 * Whether a card voucher's payment still backs it (imani-wallet#277).
 *
 * A merchant can refund a card purchase in their Stripe dashboard. A delivered voucher is
 * self-custodial, so nothing can take it back; instead the gateway refuses to receive it for more
 * than its payment still backs (422 `VOUCHER_PAYMENT_REFUNDED`). This module is the wallet's side:
 * the state each screen shows, where it comes from, and the copy.
 *
 * Three sources, one shape:
 *
 * - **The stall's own sales**: payment-adapter `GET /api/v1/purchase-state/stall/{pubkey}`, NIP-98
 *   signed by that stall key. Feeds the merchant voucher record and the sales list.
 * - **A holder's voucher**: payment-adapter `GET /api/v1/purchase-state/holder/{pi_}`. The `pi_`
 *   is the capability: it is inside the issuer-signed warrant, and the answer is status and
 *   amounts only.
 * - **A refusal**: the gateway's 422 `VOUCHER_PAYMENT_REFUNDED`, `details` = `<state>:<remaining>`.
 *
 * Every lookup failure reads as "unknown", never as refunded: a badge that cries wolf on a
 * network blip is worse than none. The gateway is what enforces; this only explains.
 */
import { signedFetch, type RequestSigner } from './nip98'

export const VOUCHER_PAYMENT_REFUNDED = 'VOUCHER_PAYMENT_REFUNDED'

/** The four states the badge distinguishes. `paid` shows no badge. */
export type CardPaymentStatus = 'paid' | 'partly_refunded' | 'refunded' | 'disputed'

export interface CardPaymentState {
  status: CardPaymentStatus
  paidMinor: number
  refundedMinor: number
  /** paid - refunded, 0 while disputed. */
  backedMinor: number
  currency?: string
  /** When the latest refund or dispute was recorded (ISO-8601), if known. */
  reversedAt?: string
  /** The voucher this purchase issued, on the stall's own read. */
  voucherId?: string
  /** The Stripe payment intent, on the stall's own read. */
  ref?: string
}

const STATE_PATH = '/api/v1/purchase-state'
const PI_SHAPE = /^pi_[A-Za-z0-9_]{1,250}$/
const TTL_MS = 2 * 60 * 1000

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0
}

/** One purchase from payment-adapter's JSON, or undefined when it is not readable. */
export function parsePurchaseState(raw: unknown): CardPaymentState | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const paid = num(r.paid_minor)
  const refunded = Math.min(paid, num(r.refunded_amount_minor))
  const disputed = r.disputed === true
  const status: CardPaymentStatus | undefined =
    r.status === 'PAID'
      ? 'paid'
      : r.status === 'PARTLY_REFUNDED'
        ? 'partly_refunded'
        : r.status === 'REFUNDED'
          ? 'refunded'
          : r.status === 'DISPUTED'
            ? 'disputed'
            : undefined
  if (!status) return undefined
  return {
    status,
    paidMinor: paid,
    refundedMinor: refunded,
    backedMinor: disputed ? 0 : Math.max(0, num(r.backed_minor) || paid - refunded),
    ...(typeof r.currency === 'string' && r.currency ? { currency: r.currency } : {}),
    ...(typeof r.reversed_at === 'string' ? { reversedAt: r.reversed_at } : {}),
    ...(typeof r.voucher_id === 'string' ? { voucherId: r.voucher_id } : {}),
    ...(typeof r.ref === 'string' ? { ref: r.ref } : {}),
  }
}

/** Whether nothing of the voucher can be spent. */
export function isUnspendable(state: CardPaymentState | undefined): boolean {
  return state?.status === 'refunded' || state?.status === 'disputed'
}

/** Whether to show a badge at all. */
export function isReversed(state: CardPaymentState | undefined): state is CardPaymentState {
  return state !== undefined && state.status !== 'paid'
}

/**
 * The badge's words. `money` formats minor units in the voucher's own currency.
 * "Partly refunded £3.00 of £10.00" names the refund, as the issue asks.
 */
export function cardPaymentLabel(state: CardPaymentState, money: (minor: number) => string): string {
  switch (state.status) {
    case 'refunded':
      return 'Refunded'
    case 'disputed':
      return 'Disputed'
    case 'partly_refunded':
      return `Partly refunded ${money(state.refundedMinor)} of ${money(state.paidMinor)}`
    default:
      return 'Paid'
  }
}

/** The one-line explanation beside the badge, for the holder. */
export function cardPaymentExplanation(state: CardPaymentState, money: (minor: number) => string): string {
  switch (state.status) {
    case 'refunded':
      return 'Can’t be spent: the card payment for this voucher was refunded.'
    case 'disputed':
      return 'Can’t be spent while the card payment for this voucher is disputed.'
    case 'partly_refunded':
      return `The card payment was partly refunded, so at most ${money(state.backedMinor)} of it can be spent.`
    default:
      return ''
  }
}

/** The stall-side explanation on its voucher record. */
export function cardPaymentMerchantNote(state: CardPaymentState, money: (minor: number) => string): string {
  switch (state.status) {
    case 'refunded':
      return 'You refunded this card payment. The voucher can no longer be redeemed or passed on.'
    case 'disputed':
      return 'The buyer disputed this card payment. The voucher can’t be redeemed while the dispute is open; it can be again if you win it.'
    case 'partly_refunded':
      return `You refunded ${money(state.refundedMinor)}. At most ${money(state.backedMinor)} of this voucher can still be redeemed, across all its pieces.`
    default:
      return ''
  }
}

// ---------------------------------------------------------------- the gateway's refusal

/** Whether a gateway answer (an error, a response body, a send status) is the card refusal. */
export function isVoucherPaymentRefunded(answer: unknown): boolean {
  return refusalOf(answer) !== undefined
}

/**
 * The state a 422 `VOUCHER_PAYMENT_REFUNDED` names, from its `details` (`<state>:<remaining>`).
 * Undefined for any other answer.
 */
export function refusalOf(answer: unknown): { status: Exclude<CardPaymentStatus, 'paid'>; remainingMinor: number } | undefined {
  if (!answer || typeof answer !== 'object') return undefined
  const a = answer as Record<string, unknown> & {
    data?: { code?: unknown; details?: unknown; error?: { code?: unknown; details?: unknown } }
    error?: { code?: unknown; details?: unknown }
  }
  const candidates: Array<{ code?: unknown; details?: unknown }> = [
    { code: a.code ?? a.error_code, details: a.details },
    a.error ?? {},
    a.data ?? {},
    a.data?.error ?? {},
  ]
  const matching = candidates.filter((c) => c.code === VOUCHER_PAYMENT_REFUNDED)
  if (matching.length === 0) return undefined
  // `shared/api.js` copies the code onto the error but leaves `details` in the body, so the one
  // that carries details wins.
  const c = matching.find((m) => typeof m.details === 'string') ?? matching[0]!
  const [state, remaining] = typeof c.details === 'string' ? c.details.split(':') : []
  const status = state === 'disputed' || state === 'partly_refunded' ? state : 'refunded'
  return { status, remainingMinor: Number.isFinite(Number(remaining)) ? Math.max(0, Number(remaining)) : 0 }
}

/** Thrown by send when the voucher's card payment is known to be refunded or disputed (UX only). */
export class VoucherPaymentRefundedError extends Error {
  readonly code = VOUCHER_PAYMENT_REFUNDED
  readonly terminal = true

  constructor(readonly status: Exclude<CardPaymentStatus, 'paid'>) {
    super(
      status === 'disputed'
        ? 'This voucher can’t be sent while its card payment is disputed.'
        : status === 'partly_refunded'
          ? 'Part of this voucher’s card payment was refunded, so it can’t be sent for that much.'
          : 'This voucher can’t be sent: its card payment was refunded.',
    )
    this.name = 'VoucherPaymentRefundedError'
  }
}

// ---------------------------------------------------------------- lookups

type Cached<T> = { value: Promise<T>; expiresAt: number }
const holderCache = new Map<string, Cached<CardPaymentState | undefined>>()
const stallCache = new Map<string, Cached<CardPaymentState[] | undefined>>()

/** For tests. */
export function __resetCardPaymentStateCache() {
  holderCache.clear()
  stallCache.clear()
}

function cached<T>(cache: Map<string, Cached<T>>, key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key)
  if (hit && Date.now() < hit.expiresAt) return hit.value
  const entry: Cached<T> = { value: load(), expiresAt: Infinity }
  cache.set(key, entry)
  void entry.value.then((v) => {
    if (cache.get(key) !== entry) return
    if (v === undefined) cache.delete(key)
    else entry.expiresAt = Date.now() + TTL_MS
  })
  return entry.value
}

/** A holder's voucher, by the `pi_` its warrant carries. Undefined when it cannot be read. */
export function holderCardPaymentState(ref: string | undefined): Promise<CardPaymentState | undefined> {
  if (!ref || !PI_SHAPE.test(ref)) return Promise.resolve(undefined)
  return cached(holderCache, ref, async () => {
    try {
      const response = await fetch(`${STATE_PATH}/holder/${encodeURIComponent(ref)}`, {
        headers: { Accept: 'application/json' },
      })
      if (!response.ok) return undefined
      return parsePurchaseState(await response.json())
    } catch {
      return undefined
    }
  })
}

/** The stall's own card sales, NIP-98 signed by the stall key. Undefined when they cannot be read. */
export function stallCardPaymentStates(
  stallPubkey: string | undefined,
  signer?: RequestSigner,
): Promise<CardPaymentState[] | undefined> {
  if (!stallPubkey || !/^[0-9a-f]{64}$/i.test(stallPubkey)) return Promise.resolve(undefined)
  const key = stallPubkey.toLowerCase()
  return cached(stallCache, key, async () => {
    try {
      const response = await signedFetch(`${STATE_PATH}/stall/${key}`, 'GET', undefined, signer)
      if (!response.ok) return undefined
      const body: unknown = await response.json()
      if (!Array.isArray(body)) return undefined
      return body.map(parsePurchaseState).filter((s): s is CardPaymentState => s !== undefined)
    } catch {
      return undefined
    }
  })
}

/** The stall's state for one sale, matched by reference first, then voucher id. */
export function stateFor(
  states: CardPaymentState[] | undefined,
  match: { ref?: string; voucherId?: string },
): CardPaymentState | undefined {
  if (!states) return undefined
  return (
    (match.ref ? states.find((s) => s.ref === match.ref) : undefined) ??
    (match.voucherId ? states.find((s) => s.voucherId === match.voucherId) : undefined)
  )
}
