import { describe, it, expect } from 'vitest'
import {
  runName,
  renderReport,
  regenerateReport,
  isFailure,
  APPEND_MARKER,
  type RunSummary,
  type Comparison,
} from '../run'

const summary: RunSummary = {
  run: '2026-09-01-cold-boot',
  commit: 'abc1234',
  host: 'laptop',
  startedAt: '2026-09-01T12:00:00.000Z',
  scenarios: [],
}

const green: Comparison[] = [
  { scenario: 'cold-boot', verdict: 'unchanged', baselineMs: 100, measuredMs: 102, deltaPercent: 2 },
]

const red: Comparison[] = [
  { scenario: 'cold-boot', verdict: 'unchanged', baselineMs: 100, measuredMs: 102, deltaPercent: 2 },
  {
    scenario: 'balance',
    verdict: 'regressed',
    baselineMs: 50,
    measuredMs: 400,
    deltaPercent: 700,
    note: 'beyond baseline band',
  },
]

describe('runName', () => {
  it('names a run by date and subject', () => {
    expect(runName('cold boot', new Date('2026-09-01T10:00:00Z'))).toBe('2026-09-01-cold-boot')
  })

  it('has no sequence to fracture into lettered suffixes', () => {
    const a = runName('cold boot', new Date('2026-09-01T10:00:00Z'))
    const b = runName('cold boot', new Date('2026-09-01T18:00:00Z'))
    // Two runs on one day collide by name rather than implying an order.
    expect(a).toBe(b)
  })

  it('refuses a run with no subject, since the name must say what it was about', () => {
    expect(() => runName('  ')).toThrow(/subject/)
  })
})

describe('report shape', () => {
  it('is short when nothing moved', () => {
    const out = renderReport(summary, green)
    expect(out).toContain('No regression')
    expect(out).not.toContain('| Scenario |')
    expect(out.split('\n').length).toBeLessThan(12)
  })

  it('is long when something regressed, so the diff shows it', () => {
    const shortReport = renderReport(summary, green)
    const longReport = renderReport(summary, red)
    expect(longReport.length).toBeGreaterThan(shortReport.length * 2)
  })

  it('names what regressed and by how much', () => {
    const out = renderReport(summary, red)
    expect(out).toContain('1 regressed')
    expect(out).toContain('balance')
    expect(out).toContain('+700.0%')
    expect(out).toContain('beyond baseline band')
  })

  it('shows every scenario only once something moved', () => {
    expect(renderReport(summary, red)).toContain('All scenarios')
    expect(renderReport(summary, green)).not.toContain('All scenarios')
  })

  it('records which build and host produced it', () => {
    const out = renderReport(summary, green)
    expect(out).toContain('abc1234')
    expect(out).toContain('laptop')
  })
})

describe('regeneration', () => {
  it('keeps prose a human appended', () => {
    const first = renderReport(summary, green)
    const annotated = first + '\nFound the cause: a stale cache in the balance path.\n'
    const again = regenerateReport(annotated, summary, red)
    expect(again).toContain('Found the cause: a stale cache')
    expect(again).toContain('1 regressed')
  })

  it('leaves an un-annotated report clean', () => {
    const first = renderReport(summary, green)
    const again = regenerateReport(first, summary, green)
    expect(again.trimEnd().endsWith(APPEND_MARKER)).toBe(true)
  })
})

describe('what fails a run', () => {
  it('fails on a regression or a ceiling breach, not on an improvement', () => {
    expect(isFailure({ scenario: 's', verdict: 'regressed', measuredMs: 1 })).toBe(true)
    expect(isFailure({ scenario: 's', verdict: 'ceiling-breach', measuredMs: 1 })).toBe(true)
    expect(isFailure({ scenario: 's', verdict: 'improved', measuredMs: 1 })).toBe(false)
    expect(isFailure({ scenario: 's', verdict: 'unchanged', measuredMs: 1 })).toBe(false)
    expect(isFailure({ scenario: 's', verdict: 'new', measuredMs: 1 })).toBe(false)
  })
})
