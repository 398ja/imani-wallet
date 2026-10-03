/**
 * One reading of a coupon's `expires_at`, whatever shape it arrived in (#157).
 *
 * Stored expiry is epoch SECONDS. These pin what every producer has been seen
 * to send, and that a value nobody can read is reported as such rather than
 * mistaken for "never expires" or erased.
 */
import { describe, expect, it } from 'vitest'

import { canonicalExpiresAt, readExpiry, toEpochMs, toEpochSeconds } from '../expiry'

const SECONDS = 1_798_588_800 // 2026-12-30T00:00:00Z
const MS = SECONDS * 1000

describe('readExpiry', () => {
  it.each([
    ['seconds number (DM payload, signed tag, txRecords)', SECONDS],
    ['milliseconds number', MS],
    ['seconds numeric string (pre-v0.6.1 /inspect)', String(SECONDS)],
    ['milliseconds numeric string', String(MS)],
    ['padded numeric string', ` ${SECONDS} `],
    ['ISO instant (/inspect today, gateway create-voucher)', '2026-12-30T00:00:00Z'],
    ['ISO with millis (toVoucher, Date#toISOString)', '2026-12-30T00:00:00.000Z'],
    ['RFC 2822 (Date#toUTCString)', 'Wed, 30 Dec 2026 00:00:00 GMT'],
    ['Date object', new Date(MS)],
  ])('reads a %s as the instant it names', (_label, value) => {
    expect(readExpiry(value)).toEqual({ kind: 'at', seconds: SECONDS })
  })

  it('tells seconds from milliseconds by magnitude, both ways', () => {
    // A seconds value read as ms lands in 1970 and looks long expired; an ms
    // value read as seconds lands in the year 58000 and looks eternal.
    expect(toEpochMs(SECONDS)).toBe(MS)
    expect(toEpochMs(MS)).toBe(MS)
    expect(toEpochSeconds(MS)).toBe(SECONDS)
    expect(toEpochSeconds(SECONDS)).toBe(SECONDS)
  })

  it('floors a fractional value to whole seconds', () => {
    expect(toEpochSeconds(MS + 999)).toBe(SECONDS)
    expect(toEpochSeconds(`${SECONDS}.7`)).toBe(SECONDS)
  })

  it.each([
    ['exponent string', '1.7988888e9', 1_798_888_800],
    ['exponent number', 1.7988888e9, 1_798_888_800],
    ['seconds with a plus sign', `+${SECONDS}`, SECONDS],
    ['tab and newline padding', `\t${SECONDS}\n`, SECONDS],
    ['ISO with an offset', '2026-12-30T01:00:00+01:00', SECONDS],
    ['ISO with a space for T', '2026-12-30 00:00:00Z', SECONDS],
    ['date only (UTC by the spec)', '2026-12-30', SECONDS],
    ['Date#toString', 'Wed Dec 30 2026 01:00:00 GMT+0100 (Central European Standard Time)', SECONDS],
  ])('reads a %s', (_label, value, seconds) => {
    expect(readExpiry(value)).toEqual({ kind: 'at', seconds })
  })

  it('reads a zone-less ISO date-time as UTC, not as the device local time', () => {
    // ECMAScript would read these as LOCAL time: the same stored value would
    // name a different instant on a phone in Nairobi than in London.
    expect(toEpochSeconds('2026-12-30T00:00:00')).toBe(SECONDS)
    expect(toEpochSeconds('2026-12-30 00:00:00')).toBe(SECONDS)
    expect(toEpochSeconds('2026-12-30T00:00:00.000')).toBe(SECONDS)
  })

  it('reads a bare "2026" as 2026 epoch seconds, never as the year 2026 (Date.parse would)', () => {
    expect(toEpochSeconds('2026')).toBe(2026)
  })

  it('puts the seconds/milliseconds boundary at 1e11', () => {
    expect(toEpochMs(1e11 - 1)).toBe((1e11 - 1) * 1000) // seconds: year 5138
    expect(toEpochMs(1e11)).toBe(1e11) // milliseconds: 1973
  })

  it.each([undefined, null, '', '   ', 0, '0'])('reads %j as no expiry', (value) => {
    expect(readExpiry(value)).toEqual({ kind: 'none' })
  })

  it.each([
    'next tuesday',
    '2026-13-45',
    // Date.parse accepts "-5" as a year-2001 date. It is not one.
    '-5',
    -5,
    // V8 reads every one of these as a date in 2001. None is an expiry.
    '12/31',
    'Section 5',
    'version 3.2',
    'May 5',
    '1 2',
    // Nanoseconds: past the largest Date, where toISOString throws.
    1_798_588_800 * 1e9,
    String(1_798_588_800 * 1e9),
    Number.NaN,
    Number.POSITIVE_INFINITY,
    { when: 'soon' },
    true,
  ])('reports %j as unreadable, keeping the raw value', (value) => {
    expect(readExpiry(value)).toEqual({ kind: 'unreadable', raw: value })
    expect(toEpochMs(value)).toBeUndefined()
  })
})

describe('canonicalExpiresAt', () => {
  it('stores every readable format as epoch seconds', () => {
    for (const value of [SECONDS, MS, String(SECONDS), String(MS), '2026-12-30T00:00:00Z']) {
      expect(canonicalExpiresAt(value)).toBe(SECONDS)
    }
  })

  it('leaves an omitted field omitted, so a partial write cannot erase an expiry', () => {
    expect(canonicalExpiresAt(undefined)).toBeUndefined()
  })

  it('stores every spelling of "no expiry" as null', () => {
    for (const value of [null, '', 0, '0']) expect(canonicalExpiresAt(value)).toBeNull()
  })

  it('keeps a corrupt value exactly as it was', () => {
    expect(canonicalExpiresAt('next tuesday')).toBe('next tuesday')
  })

  it('is idempotent', () => {
    for (const value of [SECONDS, MS, String(SECONDS), '2026-12-30T00:00:00Z', null, 'garbage']) {
      const once = canonicalExpiresAt(value)
      expect(canonicalExpiresAt(once)).toBe(once)
    }
  })
})
