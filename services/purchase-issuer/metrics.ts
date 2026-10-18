/**
 * Prometheus counters for the purchase issuer (imani-deploy#210).
 *
 * Deliberately dependency free: two counters rendered in the text exposition
 * format. Every label is a closed set below. Never an event id, voucher id,
 * stall pubkey or amount: those are unbounded and identify a sale.
 *
 * The card payment itself (`imani_payments_total{source="card"}`) is counted
 * by payment-adapter, which owns `issued`/`issue_failed`. These counters are
 * the worker's own view: what each attempt came to, and how passes went.
 */

export const OUTCOMES = [
  'discharged',
  'discharge_rejected',
  'undelivered',
  'blocked',
  'owed',
  'manual',
  'skipped',
  'claim_lost',
  'claim_unreachable',
  // imani-wallet#274 (U8)
  'unrecorded',
  'outbox_write_failed',
  'delivered_late',
  'delivery_retried',
  'delivery_exhausted',
  // imani-wallet#287/#289: the DM went out, the gateway did not confirm it recorded it.
  'delivered_unconfirmed',
  // imani-wallet#290/#298: a PAID purchase for a stall with no enrolled issuer. Was 'skipped'.
  'no_credential',
] as const
export type Outcome = (typeof OUTCOMES)[number]

export const PASS_RESULTS = ['ok', 'failed', 'halted'] as const
export type PassResultLabel = (typeof PASS_RESULTS)[number]

const attempts = new Map<Outcome, number>(OUTCOMES.map((o) => [o, 0]))
const passes = new Map<PassResultLabel, number>(PASS_RESULTS.map((r) => [r, 0]))

/**
 * Credentials held, by their standing at the gateway (imani-wallet#296). A gauge, set by the
 * confirmer. `expired` above zero means a stall must re-enrol before its card sales can mint.
 */
export const STANDINGS = ['confirmed', 'expired', 'unconfirmed'] as const
export type Standing = (typeof STANDINGS)[number]
const standings = new Map<Standing, number>(STANDINGS.map((s) => [s, 0]))

export function setCredentialStandings(counts: Record<Standing, number>): void {
  for (const s of STANDINGS) standings.set(s, counts[s])
}

/**
 * Paid purchases owed by stalls with no enrolled issuer, as of the last pass (imani-wallet#298).
 * A gauge, so an alert can say "money taken that nothing will issue" without a rate window:
 * above zero for long means a buyer has paid and holds nothing.
 */
let owedUnenrolled = 0
export function setOwedUnenrolled(count: number): void {
  owedUnenrolled = count
}

/** Self-service enrolments by result (imani-wallet#298). */
export const ENROLMENT_RESULTS = ['enrolled', 'refused', 'unauthenticated'] as const
export type EnrolmentResult = (typeof ENROLMENT_RESULTS)[number]
const enrolments = new Map<EnrolmentResult, number>(ENROLMENT_RESULTS.map((r) => [r, 0]))
export function countEnrolment(result: EnrolmentResult): void {
  enrolments.set(result, (enrolments.get(result) ?? 0) + 1)
}

export function countAttempt(outcome: Outcome): void {
  attempts.set(outcome, (attempts.get(outcome) ?? 0) + 1)
}

export function countPass(result: PassResultLabel): void {
  passes.set(result, (passes.get(result) ?? 0) + 1)
}

export function attemptCount(outcome: Outcome): number {
  return attempts.get(outcome) ?? 0
}

export function resetMetricsForTest(): void {
  for (const o of OUTCOMES) attempts.set(o, 0)
  for (const r of PASS_RESULTS) passes.set(r, 0)
  for (const s of STANDINGS) standings.set(s, 0)
  for (const r of ENROLMENT_RESULTS) enrolments.set(r, 0)
  owedUnenrolled = 0
}

export function renderMetrics(): string {
  const lines: string[] = [
    '# HELP imani_purchase_issuer_attempts_total Purchase issuer attempts by outcome.',
    '# TYPE imani_purchase_issuer_attempts_total counter',
  ]
  for (const o of OUTCOMES) lines.push(`imani_purchase_issuer_attempts_total{outcome="${o}"} ${attempts.get(o)}`)
  lines.push(
    '# HELP imani_purchase_issuer_passes_total Purchase issuer queue passes by result.',
    '# TYPE imani_purchase_issuer_passes_total counter',
  )
  for (const r of PASS_RESULTS) lines.push(`imani_purchase_issuer_passes_total{result="${r}"} ${passes.get(r)}`)
  lines.push(
    '# HELP imani_purchase_issuer_credentials Stall credentials held, by standing at the gateway.',
    '# TYPE imani_purchase_issuer_credentials gauge',
  )
  for (const s of STANDINGS) lines.push(`imani_purchase_issuer_credentials{standing="${s}"} ${standings.get(s)}`)
  lines.push(
    '# HELP imani_purchase_issuer_owed_unenrolled Paid purchases owed by stalls with no enrolled issuer, last pass.',
    '# TYPE imani_purchase_issuer_owed_unenrolled gauge',
    `imani_purchase_issuer_owed_unenrolled ${owedUnenrolled}`,
    '# HELP imani_purchase_issuer_enrolments_total Self-service card-sales enrolments by result.',
    '# TYPE imani_purchase_issuer_enrolments_total counter',
  )
  for (const r of ENROLMENT_RESULTS) lines.push(`imani_purchase_issuer_enrolments_total{result="${r}"} ${enrolments.get(r)}`)
  return lines.join('\n') + '\n'
}
