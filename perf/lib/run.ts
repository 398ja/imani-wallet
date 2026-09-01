/**
 * What a run is called, and what it leaves behind.
 *
 * Naming and artifact shape live here rather than in each scenario, so that
 * every run agrees without each one having to remember the conventions.
 */

/**
 * A run's name: the date it happened, and what it was about.
 *
 * Deliberately not a sequence. The retired imani-apps project numbered runs
 * globally and the numbering fractured into `007b`, `009c`, `010b` as variants
 * multiplied, because a global sequence implies runs are comparable when they
 * are not. A date and a subject claim only what is true.
 */
export function runName(subject: string, when: Date = new Date()): string {
  const day = when.toISOString().slice(0, 10)
  const slug = subject
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  if (!slug) throw new Error('a run needs a subject, so its name says what it was about')
  return `${day}-${slug}`
}

/** One measurement at one point on a scaling ladder. */
export interface Measurement {
  /** How many coupons the wallet held. */
  coupons: number
  /** Milliseconds. */
  ms: number
}

/** What one scenario observed in one run. */
export interface ScenarioResult {
  scenario: string
  measurements: Measurement[]
}

/** The machine-readable half of a run's output. */
export interface RunSummary {
  run: string
  /** Which build this ran against, so the result stays interpretable later. */
  commit: string
  /** Where it ran, because a laptop number is not a capacity number. */
  host: string
  startedAt: string
  scenarios: ScenarioResult[]
}

/** How a measurement compared to its baseline. */
export type Verdict = 'unchanged' | 'improved' | 'regressed' | 'ceiling-breach' | 'new'

export interface Comparison {
  scenario: string
  verdict: Verdict
  /** Absent when the scenario is new and has no baseline yet. */
  baselineMs?: number
  measuredMs: number
  /** Positive means slower. Absent when there is nothing to compare to. */
  deltaPercent?: number
  /** Why this verdict, in a sentence a human can act on. */
  note?: string
}

/** True when a comparison should fail the run. */
export function isFailure(c: Comparison): boolean {
  return c.verdict === 'regressed' || c.verdict === 'ceiling-breach'
}

/**
 * A run's report, shaped by its delta.
 *
 * A run that changed nothing is a few lines; a run that regressed is a full
 * account of what moved. The length carries the signal, so a regression is
 * visibly larger in the diff than a green run.
 *
 * Everything below the appendable marker is left alone when a report is
 * regenerated: the retired project's most valuable artifact was a report a
 * human wrote after an investigation, and that must survive the next run.
 */
export const APPEND_MARKER = '<!-- Append notes below. Regeneration preserves them. -->'

export function renderReport(summary: RunSummary, comparisons: Comparison[]): string {
  const failures = comparisons.filter(isFailure)
  const lines: string[] = [`# ${summary.run}`, '']

  lines.push(
    `${summary.commit} on ${summary.host}, ${summary.startedAt}.`,
    '',
  )

  if (failures.length === 0) {
    const n = comparisons.length
    lines.push(`No regression. ${n} scenario${n === 1 ? '' : 's'} within baseline.`, '')
  } else {
    lines.push(
      `## ${failures.length} regressed`,
      '',
      '| Scenario | Baseline | Measured | Delta | Why |',
      '| --- | --- | --- | --- | --- |',
    )
    for (const c of failures) {
      const base = c.baselineMs === undefined ? '-' : `${c.baselineMs}ms`
      const delta = c.deltaPercent === undefined ? '-' : `${c.deltaPercent > 0 ? '+' : ''}${c.deltaPercent.toFixed(1)}%`
      lines.push(`| ${c.scenario} | ${base} | ${c.measuredMs}ms | ${delta} | ${c.note ?? c.verdict} |`)
    }
    lines.push('')

    // The full picture, but only when something moved: on a green run this
    // table is noise, and printing it every time is how a report stops being
    // read at all.
    lines.push('## All scenarios', '', '| Scenario | Verdict | Measured |', '| --- | --- | --- |')
    for (const c of comparisons) {
      lines.push(`| ${c.scenario} | ${c.verdict} | ${c.measuredMs}ms |`)
    }
    lines.push('')
  }

  lines.push(APPEND_MARKER, '')
  return lines.join('\n')
}

/**
 * Regenerate a report while keeping whatever a human appended to the old one.
 */
export function regenerateReport(
  existing: string | undefined,
  summary: RunSummary,
  comparisons: Comparison[],
): string {
  const fresh = renderReport(summary, comparisons)
  if (!existing) return fresh
  const at = existing.indexOf(APPEND_MARKER)
  if (at === -1) return fresh
  const appended = existing.slice(at + APPEND_MARKER.length)
  if (!appended.trim()) return fresh
  return fresh.replace(APPEND_MARKER + '\n', APPEND_MARKER + appended)
}
