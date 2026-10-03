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

  it.each([undefined, null, '', '   ', 0, '0'])('reads %j as no expiry', (value) => {
    expect(readExpiry(value)).toEqual({ kind: 'none' })
  })

  it.each([
    'next tuesday',
    '2026-13-45',
    // Date.parse accepts "-5" as a year-2001 date. It is not one.
    '-5',
    -5,
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
