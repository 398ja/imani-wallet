/**
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest'

import { BUCKETS, createEventSizeRecorder, DEFAULT_LIMITS_SPEC, kindLabel, parseLimits } from '../nostrEventSizeMetrics'

const limits = parseLimits(DEFAULT_LIMITS_SPEC)

describe('nostrEventSizeMetrics (#532)', () => {
  it('has the contract buckets', () => {
    expect(BUCKETS).toHaveLength(39)
    expect(BUCKETS.slice(0, 4)).toEqual([1024, 2048, 4096, 8192])
    expect(BUCKETS).toContain(55121)
    expect(BUCKETS).toContain(65536)
    expect(BUCKETS.slice(-5)).toEqual([131072, 196608, 262144, 524288, 1048576])
    expect([...BUCKETS].sort((a, b) => a - b)).toEqual(BUCKETS)
  })

  it('renders valid text exposition', () => {
    const r = createEventSizeRecorder('subscription', limits)
    r.record(1059, 1000)
    const text = r.render()
    const sample = /^[a-z_]+(\{([a-z_]+="[^"]*",?)*\})? -?[0-9.e+]+$/
    for (const line of text.trimEnd().split('\n')) {
      if (line.startsWith('#')) expect(line).toMatch(/^# (HELP|TYPE) imani_nostr_event_[a-z_]+ .+$/)
      else expect(line).toMatch(sample)
    }
    expect(text).toContain('# TYPE imani_nostr_event_bytes histogram')
    expect(text).toContain('imani_nostr_event_bytes_bucket{source="subscription",kind="1059",path="relay",le="+Inf"} 1')
    expect(text).toContain('imani_nostr_event_bytes_sum{source="subscription",kind="1059",path="relay"} 1000')
    expect(text).toContain('imani_nostr_event_limit_bytes{limit="strfry_max_event"} 65536')
    expect(text).toContain('imani_nostr_event_limit_bytes{limit="wrap_budget"} 55121')
    expect(text.endsWith('\n')).toBe(true)
  })

  it('puts boundary sizes in the le bucket that equals them (le is inclusive)', () => {
    const r = createEventSizeRecorder('subscription', limits)
    r.record(1059, 55121)
    r.record(1059, 65536)
    const t = r.render()
    const b = (le: number | string) => Number(new RegExp(`kind="1059",path="relay",le="${le}"\\} (\\d+)`).exec(t)![1])
    expect(b(53248)).toBe(0)
    expect(b(55121)).toBe(1)
    expect(b(61440)).toBe(1)
    expect(b(65536)).toBe(2)
  })

  it('counts over-limit only when strictly greater', () => {
    const r = createEventSizeRecorder('subscription', limits)
    r.record(1059, 55121)
    expect(r.render()).not.toContain('imani_nostr_event_over_limit_total{')
    r.record(1059, 65536)
    expect(r.render()).not.toContain('path="relay",limit="strfry_max_event"}')
    r.record(1059, 66045)
    const t = r.render()
    expect(t).toContain('imani_nostr_event_over_limit_total{source="subscription",kind="1059",path="relay",limit="wrap_budget"} 2')
    expect(t).toContain('imani_nostr_event_over_limit_total{source="subscription",kind="1059",path="relay",limit="strfry_max_event"} 1')
  })

  it('maps kinds to the closed set', () => {
    expect(kindLabel(30078)).toBe('30078')
    expect(kindLabel(12345)).toBe('other')
    expect(kindLabel(1.5)).toBe('other')
  })

  it('measures UTF-8 JSON bytes of an event', () => {
    const r = createEventSizeRecorder('subscription', limits)
    const e = { kind: 1, content: '\u20ac\u{1F600}' }
    expect(r.recordEvent(e)).toBe(new TextEncoder().encode(JSON.stringify(e)).length)
  })

  it('parses limits, defaulting and logging on invalid', () => {
    expect(parseLimits(undefined)).toEqual([
      { name: 'strfry_max_event', bytes: 65536 },
      { name: 'wrap_budget', bytes: 55121 },
    ])
    expect(parseLimits('a=1, b_2=200')).toEqual([
      { name: 'a', bytes: 1 },
      { name: 'b_2', bytes: 200 },
    ])
    for (const bad of ['A=1', 'a=0', 'a=-1', 'a=x', 'a', 'a=1,a=2', Array.from({ length: 9 }, (_, i) => `l${i}=1`).join(','), `${'x'.repeat(33)}=1`]) {
      const log = vi.fn()
      expect(parseLimits(bad, log)).toEqual(parseLimits(undefined))
      expect(log).toHaveBeenCalledTimes(1)
    }
  })
})
