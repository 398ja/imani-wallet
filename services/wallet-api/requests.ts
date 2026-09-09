import {
  expireRequests,
  matchPayment,
  groupArrivals,
  partialFor,
  type VoucherPaymentRequest,
} from '@imani/payment-requests'
import type { ReportTransaction } from '@imani/reports'

import { nut18v } from './nut18v.js'

/**
 * Asking to be paid, over HTTP.
 *
 * Three questions a till asks and a stateless service can answer: build me a
 * request, which arrival settles which request, and what is still outstanding.
 *
 * The rules come from `@imani/payment-requests` and the encoding from
 * `shared/nut18v.js` — the same two the app uses. Nothing here decides anything
 * for itself, because a second opinion about whether a payment settled a
 * request is indistinguishable, from a merchant's chair, from money going
 * missing.
 */

type Parsed<T> = { ok: true; value: T } | { ok: false; error: { field: string; detail: string } }

const fail = (field: string, detail: string): Parsed<never> => ({ ok: false, error: { field, detail } })

function describe(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'an array'
  return typeof v
}

const HEX64 = /^[0-9a-f]{64}$/i

/** One day, matching the app's `DEFAULT_EXPIRY_SECONDS`. */
const DEFAULT_EXPIRY_SECONDS = 86_400

export interface CreateRequestInput {
  amount: number
  unit: string
  stallPubkey: string
  description?: string
  expirySeconds: number
}

export function parseCreateRequest(body: unknown, callerPubkey: string): Parsed<CreateRequestInput> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return fail('body', `expected a JSON object, got ${describe(body)}`)
  }
  const b = body as Record<string, unknown>

  const amount = Number(b.amount)
  if (!Number.isFinite(amount) || amount <= 0) {
    return fail('amount', 'expected a number greater than zero, in minor units')
  }
  if (!Number.isInteger(amount)) {
    // A fractional minor unit means cents were wanted and euros were sent.
    // Flooring it would ask the customer for the wrong money.
    return fail('amount', 'expected a whole number of minor units')
  }

  const unit = typeof b.unit === 'string' ? b.unit : ''
  if (!unit) return fail('unit', 'required')

  /**
   * The recipient is the CALLER, and cannot be overridden.
   *
   * Takings are gift-wrapped to whoever the request names, so a request naming
   * anything else would send a customer's payment to a key its owner cannot
   * decrypt — money stranded, not merely misrouted. The app enforces this
   * structurally by taking an `Actor` and reading `issuingStall`; over HTTP the
   * equivalent is refusing to read a recipient from the body at all.
   *
   * A caller that sends one is REFUSED rather than ignored, so an integrator
   * discovers this at the first request instead of after a day of takings have
   * gone somewhere unreachable.
   */
  for (const forbidden of ['stallPubkey', 'issuerId', 'recipientPubkey', 'recipient']) {
    if (b[forbidden] !== undefined && b[forbidden] !== callerPubkey) {
      return fail(
        forbidden,
        'a payment request always names the signing key as recipient — takings sent anywhere else could not be decrypted by their owner',
      )
    }
  }

  if (!HEX64.test(callerPubkey)) {
    return fail('authorization', 'the signing key is not a 64-character hex pubkey')
  }

  const description = typeof b.description === 'string' ? b.description.trim() : ''

  const expirySeconds = Number(b.expirySeconds ?? DEFAULT_EXPIRY_SECONDS)
  if (!Number.isFinite(expirySeconds) || expirySeconds <= 0) {
    return fail('expirySeconds', 'expected a number of seconds greater than zero')
  }

  return {
    ok: true,
    value: {
      amount,
      unit,
      stallPubkey: callerPubkey,
      description: description || undefined,
      expirySeconds,
    },
  }
}

/**
 * Build the request, through the app's own encoder.
 *
 * `nowSeconds` is supplied rather than read, so the expiry a caller is told is
 * the expiry that was encoded — and so this is testable to the second.
 */
export function buildRequest(
  input: CreateRequestInput,
  nowSeconds: number,
): VoucherPaymentRequest {
  const expiresAt = nowSeconds + input.expirySeconds
  const generated = nut18v().generate({
    amount: input.amount,
    unit: input.unit,
    issuerId: input.stallPubkey,
    description: input.description ?? null,
    singleUse: true,
    expiresAt,
  })

  return {
    paymentId: generated.paymentId,
    requestString: generated.requestString,
    clickableUri: generated.clickableUri,
    amount: input.amount,
    unit: input.unit,
    description: input.description,
    expiresAt,
    createdAt: nowSeconds * 1000,
    status: 'pending',
  }
}

/** A request as a caller sends it back to us, for matching or reconciling. */
function parseRequestRow(row: unknown, i: number): Parsed<VoucherPaymentRequest> {
  const at = `requests[${i}]`
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    return fail(at, `expected an object, got ${describe(row)}`)
  }
  const r = row as Record<string, unknown>

  const paymentId = typeof r.paymentId === 'string' ? r.paymentId : ''
  if (!paymentId) return fail(`${at}.paymentId`, 'required')

  const amount = Number(r.amount)
  if (!Number.isFinite(amount)) return fail(`${at}.amount`, 'expected a finite number')

  const unit = typeof r.unit === 'string' ? r.unit : ''
  if (!unit) return fail(`${at}.unit`, 'required')

  const expiresAt = Number(r.expiresAt)
  if (!Number.isFinite(expiresAt)) return fail(`${at}.expiresAt`, 'expected epoch SECONDS')

  const createdAt = Number(r.createdAt)
  if (!Number.isFinite(createdAt)) return fail(`${at}.createdAt`, 'expected epoch milliseconds')

  const status = r.status
  if (status !== 'pending' && status !== 'fulfilled' && status !== 'expired') {
    return fail(`${at}.status`, "expected 'pending', 'fulfilled' or 'expired'")
  }

  return {
    ok: true,
    value: {
      paymentId,
      requestString: typeof r.requestString === 'string' ? r.requestString : '',
      clickableUri: typeof r.clickableUri === 'string' ? r.clickableUri : '',
      amount,
      unit,
      description: typeof r.description === 'string' ? r.description : undefined,
      expiresAt,
      createdAt,
      status,
      settledBy: typeof r.settledBy === 'string' ? r.settledBy : undefined,
      receivedAmount: Number.isFinite(Number(r.receivedAmount)) ? Number(r.receivedAmount) : undefined,
    },
  }
}

export interface ReconcileInput {
  requests: VoucherPaymentRequest[]
  transactions: ReportTransaction[]
  now: number
}

const INCOMING = new Set(['received', 'redeemed'])

export function parseReconcileRequest(body: unknown, defaultNow: number): Parsed<ReconcileInput> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return fail('body', `expected a JSON object, got ${describe(body)}`)
  }
  const b = body as Record<string, unknown>

  if (!Array.isArray(b.requests)) {
    return fail('requests', `expected an array, got ${describe(b.requests)}`)
  }
  const requests: VoucherPaymentRequest[] = []
  for (let i = 0; i < b.requests.length; i++) {
    const parsed = parseRequestRow(b.requests[i], i)
    if (!parsed.ok) return parsed
    requests.push(parsed.value)
  }

  const rows = b.transactions ?? []
  if (!Array.isArray(rows)) {
    return fail('transactions', `expected an array, got ${describe(rows)}`)
  }
  const transactions: ReportTransaction[] = []
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      return fail(`transactions[${i}]`, `expected an object, got ${describe(row)}`)
    }
    const t = row as Record<string, unknown>

    const type = typeof t.type === 'string' ? t.type : ''
    if (!type) return fail(`transactions[${i}].type`, 'required')

    const amount = Number(t.amount)
    if (!Number.isFinite(amount)) return fail(`transactions[${i}].amount`, 'expected a finite number')

    const when = Number(t.at ?? t.timestamp)
    if (!Number.isFinite(when)) return fail(`transactions[${i}].at`, 'expected epoch milliseconds')

    transactions.push({
      id: typeof t.id === 'string' ? t.id : `row-${i}`,
      type,
      // Derived, never trusted — the same rule the reports endpoint follows.
      // A caller marking its own send as incoming could otherwise settle its
      // own request and mark itself paid.
      direction: INCOMING.has(type) ? 'in' : 'out',
      at: when,
      amount,
      unit: typeof t.unit === 'string' ? t.unit : '',
      decimals: Number.isFinite(Number(t.decimals)) ? Number(t.decimals) : 0,
      paymentId: typeof t.paymentId === 'string' ? t.paymentId : undefined,
      bundleId: typeof t.bundleId === 'string' ? t.bundleId : undefined,
      voucherId: typeof t.voucherId === 'string' ? t.voucherId : undefined,
    })
  }

  const now = Number(b.now ?? defaultNow)
  if (!Number.isFinite(now)) return fail('now', 'expected epoch milliseconds')

  return { ok: true, value: { requests, transactions, now } }
}

/**
 * What arrived, against what was asked for.
 *
 * Expiry is applied FIRST, so a request whose window closed is reported expired
 * rather than matched — but `matchPayment` is still asked about the original
 * list, because a payment that arrived before the deadline settles a request
 * even if it is being reconciled afterwards. That ordering is the app's, and
 * getting it backwards would lose a merchant real money at the end of a day.
 */
export function reconcile(input: ReconcileInput) {
  const { requests, transactions, now } = input

  const arrivals = groupArrivals(transactions)
  const settlements: Array<{ paymentId: string; transactionId: string; amount: number }> = []

  let working = requests
  for (const arrival of arrivals) {
    const matched = matchPayment(working, {
      id: arrival.id,
      amount: arrival.amount,
      unit: arrival.unit,
      at: arrival.at,
      direction: 'in',
      paymentId: arrival.paymentId,
    })
    if (!matched) continue

    settlements.push({
      paymentId: matched.paymentId,
      transactionId: arrival.id,
      amount: arrival.amount,
    })
    working = working.map((r) =>
      r.paymentId === matched.paymentId
        ? { ...r, status: 'fulfilled' as const, settledBy: arrival.id, receivedAmount: arrival.amount }
        : r,
    )
  }

  const settled = expireRequests(working, now)

  return {
    requests: settled,
    settlements,
    outstanding: settled
      .filter((r) => r.status === 'pending')
      .map((r) => ({
        paymentId: r.paymentId,
        amount: r.amount,
        unit: r.unit,
        // How much of this request has arrived without settling it. A partial
        // payment is not a settlement, and a merchant needs to see the
        // difference rather than a bare "unpaid".
        received: partialFor(r, arrivals),
      })),
  }
}
