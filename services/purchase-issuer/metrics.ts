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
] as const
export type Outcome = (typeof OUTCOMES)[number]

export const PASS_RESULTS = ['ok', 'failed', 'halted'] as const
export type PassResultLabel = (typeof PASS_RESULTS)[number]

const attempts = new Map<Outcome, number>(OUTCOMES.map((o) => [o, 0]))
const passes = new Map<PassResultLabel, number>(PASS_RESULTS.map((r) => [r, 0]))

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
  return lines.join('\n') + '\n'
}
