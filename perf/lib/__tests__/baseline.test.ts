import { describe, it, expect } from 'vitest'
import { compare, type Baseline } from '../baseline'

const base: Baseline = { ms: 100, tolerancePercent: 20 }

describe('comparing against a baseline', () => {
  it('passes a measurement inside the band', () => {
    expect(compare('s', 110, base).verdict).toBe('unchanged')
  })

  it('fails a measurement beyond the band', () => {
    const c = compare('s', 200, base)
    expect(c.verdict).toBe('regressed')
    expect(c.deltaPercent).toBe(100)
    expect(c.note).toContain('20%')
  })

  it('reports a large improvement rather than silently accepting it', () => {
    // A scenario that stopped measuring anything also looks like an
    // improvement, so this is worth surfacing.
    expect(compare('s', 10, base).verdict).toBe('improved')
  })

  it('says so plainly when there is no baseline yet', () => {
    const c = compare('s', 100, undefined)
    expect(c.verdict).toBe('new')
    expect(c.baselineMs).toBeUndefined()
  })
})

describe('the absolute ceiling', () => {
  const ceilinged: Baseline = { ms: 100, tolerancePercent: 20, ceilingMs: 150 }

  it('fails a breach even when the drift is within the band', () => {
    // This is the ratchet the ceiling exists to stop: a baseline that has
    // crept up over time makes an intolerable number look acceptable.
    const crept: Baseline = { ms: 140, tolerancePercent: 20, ceilingMs: 150 }
    const c = compare('cold-boot', 160, crept)
    expect(c.verdict).toBe('ceiling-breach')
    // Within the band on drift, and still a failure.
    expect(c.deltaPercent).toBeLessThan(crept.tolerancePercent)
  })

  it('reports a ceiling breach distinctly from a band regression', () => {
    expect(compare('s', 500, ceilinged).verdict).toBe('ceiling-breach')
    expect(compare('s', 115, ceilinged).verdict).toBe('unchanged')
  })

  it('leaves scenarios without a ceiling judged on drift alone', () => {
    expect(compare('s', 5000, base).verdict).toBe('regressed')
  })
})
