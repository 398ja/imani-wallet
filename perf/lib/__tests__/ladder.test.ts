/**
 * The ladder's own tests.
 *
 * Two of #22's acceptance criteria are about what the assertion REFUSES, and
 * those cannot be checked by running it against a healthy wallet: a check that
 * has never failed is not known to work. So the quadratic case is constructed
 * here, from numbers that state plainly what shape they are.
 */

import { describe, it, expect } from 'vitest'

import {
  assessShape,
  formatLadder,
  runLadder,
  MAX_SLOPE_GROWTH,
  type LadderScenario,
  type Rung,
} from '../ladder'
import type { Snapshot } from '../snapshot'
import { isFailure, renderReport, type Comparison, type RunSummary } from '../run'

/** Linear: a fixed cost to open, plus a constant cost per coupon. */
function linear(counts: number[], fixed: number, perCoupon: number): Rung[] {
  return counts.map((coupons) => ({ coupons, ms: fixed + perCoupon * coupons }))
}

/** Quadratic: each coupon costs more when there are more of them. */
function quadratic(counts: number[], fixed: number, factor: number): Rung[] {
  return counts.map((coupons) => ({ coupons, ms: fixed + factor * coupons * coupons }))
}

const COUNTS = [5, 50, 500]

describe('assessShape', () => {
  it('passes a linear curve', () => {
    const verdict = assessShape(linear(COUNTS, 100, 0.5))

    expect(verdict.flat).toBe(true)
    expect(verdict.ratio).toBeCloseTo(1, 1)
    expect(verdict.explanation).toContain('flat')
  })

  it('fails a quadratic curve', () => {
    const verdict = assessShape(quadratic(COUNTS, 100, 0.01))

    expect(verdict.flat).toBe(false)
    // Each coupon really does cost about 10x more at the large end.
    expect(verdict.ratio).toBeGreaterThan(MAX_SLOPE_GROWTH)
    expect(verdict.explanation).toContain('CLIMBING')
  })

  it('passes a curve that is uniformly slower but still flat', () => {
    // The distinction the whole check exists to draw. This machine is ten
    // times slower than the one above and every absolute number is dreadful,
    // but the work still costs the same per coupon at 500 as at 5.
    const slow = linear(COUNTS, 1000, 5)
    const fast = linear(COUNTS, 100, 0.5)

    const slowVerdict = assessShape(slow)
    const fastVerdict = assessShape(fast)

    expect(slowVerdict.flat).toBe(true)
    // Ten times the cost, the same shape: which is the point of asserting
    // shape rather than duration.
    expect(slowVerdict.lateSlope).toBeCloseTo(fastVerdict.lateSlope * 10, 5)
    expect(slowVerdict.ratio).toBeCloseTo(fastVerdict.ratio, 5)
  })

  it('refuses a ladder too short to have a shape', () => {
    // Two points always look flat, so a two-rung ladder would pass without
    // having checked anything.
    expect(() => assessShape(linear([5, 50], 100, 0.5))).toThrow(/at least 3 rungs/)
  })

  it('treats immeasurably small per-coupon cost as flat', () => {
    // A larger wallet measuring no slower than a smaller one is the healthiest
    // result there is. It must not divide into a misleading ratio.
    const noise: Rung[] = [
      { coupons: 5, ms: 320 },
      { coupons: 50, ms: 310 },
      { coupons: 500, ms: 315 },
    ]

    const verdict = assessShape(noise)

    expect(verdict.flat).toBe(true)
    expect(verdict.explanation).toContain('not measurable above noise')
  })

  it('does not depend on the order the rungs are given in', () => {
    const rungs = quadratic(COUNTS, 100, 0.01)
    const shuffled = [rungs[2], rungs[0], rungs[1]]

    expect(assessShape(shuffled).ratio).toBeCloseTo(assessShape(rungs).ratio, 10)
  })

  it('catches a quadratic even when every measurement looks fast', () => {
    // The failure this exists to catch. Half a second at 500 coupons is
    // perfectly comfortable, and a threshold on absolute duration would pass
    // it — while the same code at 5000 coupons would take a minute.
    const rungs = quadratic(COUNTS, 50, 0.002)

    expect(rungs[2].ms).toBeLessThan(600)
    expect(assessShape(rungs).flat).toBe(false)
  })
})

describe('formatLadder', () => {
  it('shows marginal cost climbing, so it is visible rather than inferred', () => {
    const table = formatLadder(quadratic(COUNTS, 100, 0.01))
    const rows = table.split('\n').slice(2)

    expect(rows).toHaveLength(3)
    // The first rung has no predecessor to be marginal against.
    expect(rows[0]).toContain('—')
    // 0.55ms per coupon between 5 and 50, 5.5ms between 50 and 500.
    expect(rows[1]).toContain('0.550')
    expect(rows[2]).toContain('5.500')
  })

  it('sorts by coupon count regardless of input order', () => {
    const rungs = linear(COUNTS, 100, 0.5)
    const table = formatLadder([rungs[2], rungs[0], rungs[1]])
    const counts = table
      .split('\n')
      .slice(2)
      .map((r) => Number(r.split('|')[1].trim()))

    expect(counts).toEqual([5, 50, 500])
  })
})

describe('a climbing shape reaching the run', () => {
  /**
   * The maths is covered above. This covers the WIRING: a verdict that
   * assessShape calls unflat has to become a failure the run acts on, and
   * appear in the report. A shape check that computes the right answer and
   * then reports green is worse than none.
   */
  function verdictFor(rungs: Rung[]): { failed: boolean; report: string } {
    const shape = assessShape(rungs)
    const comparisons: Comparison[] = shape.flat
      ? []
      : [
          {
            scenario: 'cold-boot cost shape',
            measuredMs: shape.lateSlope,
            verdict: 'regressed',
            note: shape.explanation,
          },
        ]
    const summary: RunSummary = {
      run: 'test',
      commit: 'test',
      host: 'test',
      startedAt: 'test',
      scenarios: [],
      ladders: [
        {
          scenario: 'cold-boot',
          table: formatLadder(rungs),
          flat: shape.flat,
          explanation: shape.explanation,
        },
      ],
    }
    return {
      failed: comparisons.some(isFailure),
      report: renderReport(summary, comparisons),
    }
  }

  it('fails the run and says so in the report', () => {
    const quadratic = [5, 20, 50].map((coupons) => ({
      coupons,
      ms: 100 + 0.05 * coupons * coupons,
    }))

    const { failed, report } = verdictFor(quadratic)

    expect(failed).toBe(true)
    expect(report).toContain('regressed')
    expect(report).toContain('CLIMBING')
  })

  it('shows the ladder even when nothing regressed', () => {
    // The rest of the report is delta-shaped, so an unchanged run is quiet.
    // The ladder is deliberately not: a shape that only appears once it has
    // already failed cannot be watched.
    const flat = [5, 20, 50].map((coupons) => ({ coupons, ms: 300 + 0.1 * coupons }))

    const { failed, report } = verdictFor(flat)

    expect(failed).toBe(false)
    expect(report).toContain('No regression')
    expect(report).toContain('cold-boot cost shape')
    expect(report).toContain('| coupons | ms |')
  })
})

describe('runLadder', () => {
  /**
   * The shared driver every scenario uses. #23-#26 all measure across the same
   * rungs, so this is the part that keeps them comparable: one freshness
   * check, one idea of how few rungs is too few, one table.
   */
  const fixture = { databases: [], localStorage: {}, sessionStorage: {}, cookies: [], sourceHash: 'x' } as unknown as Snapshot

  function scenario(ms: (coupons: number) => number): LadderScenario {
    return {
      name: 'test',
      measure: async (coupons) => ({ ms: ms(coupons), all: [ms(coupons)], held: coupons }),
    }
  }

  it('measures every rung and assesses the shape', async () => {
    const result = await runLadder(scenario((c) => 100 + 0.5 * c), {
      counts: [5, 20, 50],
      loadFixture: () => fixture,
    })

    expect(result.rungs.map((r) => r.coupons)).toEqual([5, 20, 50])
    expect(result.shape?.flat).toBe(true)
    expect(result.table).toContain('| coupons | ms |')
  })

  it('reports a climbing scenario as not flat', async () => {
    const result = await runLadder(scenario((c) => 100 + 0.05 * c * c), {
      counts: [5, 20, 50],
      loadFixture: () => fixture,
    })

    expect(result.shape?.flat).toBe(false)
  })

  it('measures rungs in ascending order whatever order they are given', async () => {
    const seen: number[] = []
    await runLadder(
      {
        name: 'test',
        measure: async (coupons) => {
          seen.push(coupons)
          return { ms: 100, all: [100], held: coupons }
        },
      },
      { counts: [50, 5, 20], loadFixture: () => fixture },
    )

    // Marginal cost is computed between adjacent rungs, so the order the
    // ladder reports has to be the order of the counts, not of the input.
    expect(seen).toEqual([5, 20, 50])
  })

  it('returns rungs but no shape when the ladder is too short', async () => {
    const result = await runLadder(scenario(() => 100), {
      counts: [5, 20],
      loadFixture: () => fixture,
    })

    // Deliberately not a throw: too few rungs is a caller's decision to make,
    // and the run treats it differently on a laptop than under CI.
    expect(result.rungs).toHaveLength(2)
    expect(result.shape).toBeUndefined()
  })

  it('loads a fixture for every rung, so staleness is checked per rung', async () => {
    const loaded: number[] = []
    await runLadder(scenario(() => 100), {
      counts: [5, 20, 50],
      loadFixture: (coupons) => {
        loaded.push(coupons)
        return fixture
      },
    })

    expect(loaded).toEqual([5, 20, 50])
  })
})
