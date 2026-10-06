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

  // A fraction of a second rounds UP to the next whole second, so the stored
  // expiry is never earlier than the one the issuer gave.
  it('rounds a fractional value up to whole seconds', () => {
    expect(toEpochSeconds(MS)).toBe(SECONDS)
    expect(toEpochSeconds(MS + 1)).toBe(SECONDS + 1)
    expect(toEpochSeconds(MS + 999)).toBe(SECONDS + 1)
    expect(toEpochSeconds(`${SECONDS}.7`)).toBe(SECONDS + 1)
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

  // The boundary sits at 1e12: below it a number is seconds (up to the year
  // 33658), at or above it milliseconds (September 2001 onwards).
  it('puts the seconds/milliseconds boundary at 1e12', () => {
    expect(toEpochMs(1e12 - 1)).toBe((1e12 - 1) * 1000) // seconds: year 33658
    expect(toEpochMs(1e12)).toBe(1e12) // milliseconds: 2001
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

  // A "never really expires" date such as 9999-12-31 is 253402300799 in
  // seconds, which is above 1e11. It must stay in the year 9999 when stored and
  // when stored again, never collapse to a date in the 1970s that hides a live
  // coupon as expired.
  it.each([
    ['9999-12-31 in seconds', NINES_SECONDS],
    ['9999-12-31 in milliseconds', NINES_SECONDS * 1000],
    ['9999-12-31 as a seconds string', String(NINES_SECONDS)],
    ['9999-12-31 as an ISO string', '9999-12-31T23:59:59Z'],
  ])('keeps a far-future %s in the far future, twice over', (_label, value) => {
    const once = canonicalExpiresAt(value)
    const twice = canonicalExpiresAt(once)
    expect(twice).toBe(once)
    expect(toEpochMs(once)).toBe(NINES_SECONDS * 1000)
  })

  // Storing must never move an expiry earlier, not even by the milliseconds a
  // whole-second value drops: an earlier expiry can only make a live coupon look
  // lapsed, while a later one is still refused by the mint at its real time.
  it('never stores an expiry earlier than the one given', () => {
    for (const ms of [MS + 1, MS + 999, Date.UTC(2027, 0, 1, 12, 0, 0, 500)]) {
      const stored = canonicalExpiresAt(ms)
      expect(toEpochMs(stored)).toBeGreaterThanOrEqual(ms)
      expect(canonicalExpiresAt(stored)).toBe(stored)
    }
  })
})

const NINES_SECONDS = 253_402_300_799 // 9999-12-31T23:59:59Z

describe('readExpiry, ambiguous magnitudes', () => {
  // Between 1e11 and 1e12 a number is either milliseconds in 1973-2001, before
  // any coupon existed, or seconds after the year 5138. Reading it as seconds
  // is the reading that cannot wrongly expire a live coupon.
  it('reads a seconds value above 1e11 as far future, not as a 1970s date', () => {
    expect(toEpochMs(NINES_SECONDS)).toBe(NINES_SECONDS * 1000)
    expect(toEpochMs(String(NINES_SECONDS))).toBe(NINES_SECONDS * 1000)
  })

  // Real millisecond expiries (2001 onwards) are at or above 1e12 and must
  // still read as milliseconds.
  it('still reads real millisecond expiries as milliseconds', () => {
    expect(toEpochMs(1e12)).toBe(1e12)
    expect(toEpochMs(MS)).toBe(MS)
  })
})
