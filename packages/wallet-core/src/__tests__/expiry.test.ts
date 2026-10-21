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

// Review of PR #169 (MEDIUM): storing an expiry must be a fixed point. Store it,
// read it back, store it again: nothing may move. Before this, 1.7e15 (read as
// milliseconds, year ~55840) was stored as 1.7e12 seconds, and the next read
// took 1.7e12 for milliseconds in 2023, so the migration that runs on every
// open would write a past date over a live coupon.
describe('canonicalExpiresAt is idempotent at every boundary (#169 review)', () => {
  const boundaries: unknown[] = [
    1e9, 1e10, 1e11, 1e12 - 1, 1e12, 1e12 + 1, 1e15 - 1, 1e15, 1e15 + 1, 8.64e15, 8.64e15 + 1,
    0, -1, -1e12, Number.NaN, 0.5, 1e9 + 0.5, 1e12 + 0.5,
    '1e9', '1e12', '1000000000000', '1e15', '1700000000000000', '0.5', '-5', 'NaN', 'garbage',
    '2026-12-30T00:00:00Z', '2026-12-30T00:00:00', '2026-02-30', null,
  ]

  // Applying the canonical form twice gives the same answer as applying it once.
  it.each(boundaries.map((v) => [v]))('canonical(canonical(%j)) === canonical(%j)', (value) => {
    const once = canonicalExpiresAt(value)
    expect(canonicalExpiresAt(once)).toEqual(once)
  })

  // The reported case: 1.7e15 must never be stored as something that reads back
  // as 2023. It is beyond any real expiry, so it is unreadable, and unreadable
  // values are kept as they are (and repaired from the signed tag upstream).
  it('does not turn 1.7e15 into a date in the past', () => {
    expect(readExpiry(1.7e15).kind).toBe('unreadable')
    expect(canonicalExpiresAt(1.7e15)).toBe(1.7e15)
    expect(readExpiry('1700000000000000').kind).toBe('unreadable')
  })

  // The line is "a stored seconds value must stay below 1e12". So 1e15 is
  // unreadable, and so is 1e15 - 1, because rounding it up to whole seconds gives
  // exactly 1e12. The largest readable millisecond value is (1e12 - 1) * 1000.
  it('draws the line where the stored seconds would reach 1e12', () => {
    expect(readExpiry(1e15).kind).toBe('unreadable')
    expect(readExpiry(1e15 - 1).kind).toBe('unreadable')
    expect(readExpiry(999_999_999_999_001).kind).toBe('unreadable')
    expect(readExpiry(999_999_999_999_000)).toEqual({ kind: 'at', seconds: 999_999_999_999 })
  })

  // Property-style: walk a log-spaced range from 1 to 1e16, with jitter, and
  // check idempotence and that a stored value never reads back EARLIER than the
  // value it came from.
  it('is a fixed point and never moves an expiry earlier, across the whole range', () => {
    for (let exp = 0; exp <= 16; exp += 0.01) {
      for (const jitter of [-1, 0, 1]) {
        const value = Math.round(10 ** exp) + jitter
        const once = canonicalExpiresAt(value)
        expect(canonicalExpiresAt(once)).toEqual(once)
        const before = toEpochMs(value)
        if (before !== undefined) expect(toEpochMs(once)).toBeGreaterThanOrEqual(before)
      }
    }
  })
})

// Review of PR #169 (LOW-2): values no producer writes must be unreadable, not
// guessed into a real-looking date.
describe('readExpiry rejects values no producer writes (#169 review)', () => {
  // A fraction below 1e9 seconds is not an expiry anyone issued (it is 1970),
  // so it is unreadable rather than rounded up into a date.
  it.each([0.5, '0.5', '.5', 12.25, '999999999.5'])('reads fractional %j as unreadable', (value) => {
    expect(readExpiry(value).kind).toBe('unreadable')
  })

  // A calendar date that does not exist must not roll over into March.
  it.each(['2026-02-30', '2026-02-30T00:00:00Z', '2026-04-31', '2026-13-01', '2026-00-10', '2026-01-01T24:30:00Z'])(
    'reads impossible date %j as unreadable',
    (value) => {
      expect(readExpiry(value).kind).toBe('unreadable')
    },
  )

  // Real dates still read, including a leap day.
  it('still reads real dates, including 29 February in a leap year', () => {
    expect(readExpiry('2028-02-29').kind).toBe('at')
    expect(readExpiry('2027-02-29').kind).toBe('unreadable')
    expect(toEpochSeconds('2026-12-30T00:00:00Z')).toBe(SECONDS)
  })
})
