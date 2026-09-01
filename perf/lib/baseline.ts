/**
 * Comparing a measurement to what it was last time.
 *
 * Baselines are committed to the repository, so accepting a slowdown means
 * editing a tracked file and having someone see it in review. An external
 * time-series store would put the number where no reviewer will ever look.
 */

import type { Comparison, Verdict } from './run'

export interface Baseline {
  /** Milliseconds, from the run that established this reference. */
  ms: number
  /**
   * How far a measurement may drift before it counts as a regression.
   *
   * A band exists because these numbers move on their own: a laptop under
   * different thermal load produces different figures for identical code. Too
   * tight and the suite cries wolf until it is ignored; too loose and a real
   * regression hides inside it.
   */
  tolerancePercent: number
  /**
   * An absolute limit, for scenarios where drift alone is not enough.
   *
   * Relative bands ratchet: a few percent per commit never trips a band, and a
   * year later the wallet takes seconds to open with every run still green.
   * Only the numbers a customer directly experiences need this.
   */
  ceilingMs?: number
  /** Why this number is what it is, for whoever next proposes changing it. */
  note?: string
}

export type Baselines = Record<string, Baseline>

export function compare(scenario: string, measuredMs: number, baseline?: Baseline): Comparison {
  if (!baseline) {
    return {
      scenario,
      verdict: 'new' as Verdict,
      measuredMs,
      note: 'no baseline yet, so nothing to compare against',
    }
  }

  const deltaPercent = ((measuredMs - baseline.ms) / baseline.ms) * 100

  // The ceiling is checked first and reported separately, because "slower than
  // last week" and "slower than a customer will tolerate" are different
  // problems with different urgency, and a run that breaches both should say
  // so with the more serious one.
  if (baseline.ceilingMs !== undefined && measuredMs > baseline.ceilingMs) {
    return {
      scenario,
      verdict: 'ceiling-breach',
      baselineMs: baseline.ms,
      measuredMs,
      deltaPercent,
      note: `over the ${baseline.ceilingMs}ms ceiling, which is absolute`,
    }
  }

  if (deltaPercent > baseline.tolerancePercent) {
    return {
      scenario,
      verdict: 'regressed',
      baselineMs: baseline.ms,
      measuredMs,
      deltaPercent,
      note: `beyond the ${baseline.tolerancePercent}% band`,
    }
  }

  // Faster is reported rather than silently accepted: a large improvement is
  // usually good news, but it is occasionally a scenario that stopped
  // measuring anything, and that deserves a second look.
  if (deltaPercent < -baseline.tolerancePercent) {
    return {
      scenario,
      verdict: 'improved',
      baselineMs: baseline.ms,
      measuredMs,
      deltaPercent,
      note: 'faster than baseline; worth confirming the scenario still measures what it claims',
    }
  }

  return { scenario, verdict: 'unchanged', baselineMs: baseline.ms, measuredMs, deltaPercent }
}
