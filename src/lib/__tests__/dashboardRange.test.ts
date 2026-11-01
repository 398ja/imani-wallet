/**
 * The dashboard's range filters: Today, 7 days, 30 days, all counted in the
 * merchant's own calendar days.
 *
 * TZ is pinned per test so 'local midnight' means something checkable, and
 * Europe/London is used for the DST cases because its clocks change on known
 * dates (29 March and 25 October 2026).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_RANGE_DAYS,
  RANGES,
  rangeDays,
  rangeFrom,
} from '../dashboardRange'
import { merchantStats } from '../stats'

let savedTz: string | undefined
beforeEach(() => {
  savedTz = process.env.TZ
  process.env.TZ = 'Europe/London'
})
afterEach(() => {
  process.env.TZ = savedTz
})

/** A local wall-clock time in the pinned zone, as epoch ms. */
const local = (
  y: number,
  m: number,
  d: number,
  h = 0,
  min = 0,
  s = 0,
  ms = 0,
) => new Date(y, m - 1, d, h, min, s, ms).getTime()

describe('RANGES', () => {
  it('offers Today, 7 days and 30 days, and nothing else', () => {
    expect(RANGES.map((r) => r.label)).toEqual(['Today', '7 days', '30 days'])
    expect(RANGES.map((r) => r.days)).toEqual([1, 7, 30])
  })

  it('defaults to 30 days', () => {
    expect(DEFAULT_RANGE_DAYS).toBe(30)
  })
})

describe('rangeDays', () => {
  it('keeps a range that is still offered', () => {
    expect(rangeDays(1)).toBe(1)
    expect(rangeDays(7)).toBe(7)
    expect(rangeDays('30')).toBe(30)
  })

  it('falls back to the default for 90 days, which is no longer offered', () => {
    expect(rangeDays(90)).toBe(DEFAULT_RANGE_DAYS)
    expect(rangeDays('90')).toBe(DEFAULT_RANGE_DAYS)
  })

  it('falls back to the default for anything unreadable', () => {
    expect(rangeDays(null)).toBe(DEFAULT_RANGE_DAYS)
    expect(rangeDays(undefined)).toBe(DEFAULT_RANGE_DAYS)
    expect(rangeDays('soon')).toBe(DEFAULT_RANGE_DAYS)
  })
})

describe('rangeFrom: Today', () => {
  it('starts at local midnight, not at now', () => {
    const now = local(2026, 6, 10, 14, 30)
    expect(rangeFrom(1, now)).toBe(local(2026, 6, 10))
  })

  it('one minute after midnight is still a window of just today', () => {
    const now = local(2026, 6, 10, 0, 1)
    expect(rangeFrom(1, now)).toBe(local(2026, 6, 10))
  })

  it('one millisecond before midnight is still the same day', () => {
    const now = local(2026, 6, 10, 23, 59, 59, 999)
    expect(rangeFrom(1, now)).toBe(local(2026, 6, 10))
  })

  it('is local midnight even when that is not UTC midnight', () => {
    process.env.TZ = 'Asia/Tokyo' // UTC+9, no DST
    const now = local(2026, 6, 10, 3, 0) // 18:00 UTC the day before
    const from = rangeFrom(1, now)
    expect(from).toBe(local(2026, 6, 10))
    expect(new Date(from).getHours()).toBe(0)
    expect(now - from).toBe(3 * 3_600_000)
  })

  it('starts at midnight on the day the clocks go forward (a 23-hour day)', () => {
    const now = local(2026, 3, 29, 12, 0)
    const from = rangeFrom(1, now)
    expect(from).toBe(local(2026, 3, 29))
    // 00:00 GMT to 12:00 BST is 11 real hours, not 12.
    expect(now - from).toBe(11 * 3_600_000)
  })

  it('starts at midnight on the day the clocks go back (a 25-hour day)', () => {
    const now = local(2026, 10, 25, 12, 0)
    const from = rangeFrom(1, now)
    expect(from).toBe(local(2026, 10, 25))
    expect(now - from).toBe(13 * 3_600_000)
  })
})

describe('rangeFrom: 7 and 30 days', () => {
  it('7 days is today plus the six days before, from local midnight', () => {
    const now = local(2026, 6, 10, 14, 30)
    expect(rangeFrom(7, now)).toBe(local(2026, 6, 4))
  })

  it('30 days is today plus the 29 days before, from local midnight', () => {
    const now = local(2026, 6, 10, 14, 30)
    expect(rangeFrom(30, now)).toBe(local(2026, 5, 12))
  })

  it('counts calendar days across the clocks going back, not 24-hour blocks', () => {
    const now = local(2026, 10, 28, 9, 0)
    const from = rangeFrom(7, now)
    expect(from).toBe(local(2026, 10, 22))
    expect(new Date(from).getHours()).toBe(0)
  })

  it('counts calendar days across the clocks going forward', () => {
    const now = local(2026, 4, 2, 0, 30)
    expect(rangeFrom(30, now)).toBe(local(2026, 3, 4))
  })
})

describe('the activity chart buckets', () => {
  const ME = 'a'.repeat(64)
  const row = (at: number) => ({
    id: String(at),
    type: 'issued' as const,
    direction: 'out' as const,
    at,
    amount: 100,
    unit: 'EUR',
    decimals: 2,
  })
  const stats = (rows: ReturnType<typeof row>[], days: number, now: number) =>
    merchantStats(rows, {
      pubkey: ME,
      unit: 'EUR',
      decimals: 2,
      from: rangeFrom(days, now),
      now,
    })

  it('has exactly one column per local day, across a DST change', () => {
    const now = local(2026, 10, 28, 9, 0)
    const s = stats([], 7, now)
    expect(s.activity).toHaveLength(7)
    expect(s.activity.map((d) => new Date(d.day).getDate())).toEqual([
      22, 23, 24, 25, 26, 27, 28,
    ])
    expect(s.activity.every((d) => new Date(d.day).getHours() === 0)).toBe(
      true,
    )
  })

  it('has 30 columns for 30 days', () => {
    expect(stats([], 30, local(2026, 4, 2, 0, 30)).activity).toHaveLength(30)
  })

  it('puts a sale just after local midnight on today, not yesterday', () => {
    process.env.TZ = 'Asia/Tokyo'
    const now = local(2026, 6, 10, 8, 0)
    const sale = local(2026, 6, 10, 0, 30) // 15:30 UTC on the 9th
    const s = stats([row(sale)], 7, now)
    expect(s.activity.at(-1)).toMatchObject({ issued: 1 })
    expect(s.activity.slice(0, -1).every((d) => d.issued === 0)).toBe(true)
  })

  it('Today counts a sale from earlier today and ignores one from last night', () => {
    const now = local(2026, 6, 10, 9, 0)
    const s = stats(
      [row(local(2026, 6, 10, 0, 5)), row(local(2026, 6, 9, 23, 55))],
      1,
      now,
    )
    expect(s.issuedCount).toBe(1)
    expect(s.activity).toHaveLength(1)
  })
})
