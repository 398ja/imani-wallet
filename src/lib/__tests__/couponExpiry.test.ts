import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { VoucherRow } from '@imani/wallet-storage'

import {
  DAY_MS,
  HOUR_MS,
  expiryState,
  expiryLabel,
  reminderCandidates,
  reminderId,
  sortCoupons,
  expiredFor,
  expiredCount,
  soonestExpiring,
  bannerText,
} from '../couponExpiry'

const ME = 'e'.repeat(64)
const STALL = 'a'.repeat(64)
const OTHER_STALL = 'b'.repeat(64)
const NOW = Date.UTC(2026, 9, 15, 10, 0, 0)

let seq = 0
function row(over: Partial<VoucherRow> = {}): VoucherRow {
  seq += 1
  return {
    token_id: `token-${seq}`,
    token: `cashuB${seq}`,
    amount: 250,
    face_value: 250,
    face_unit: 'EUR',
    face_decimals: 2,
    token_amount: 250,
    issuer_id: STALL,
    status: 'active',
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    ...over,
  }
}
/** A real TokenV4, built with the app's own CBOR encoder (as witness.test.ts does). */
function tokenWith(secrets: string[]): string {
  const scope = globalThis as unknown as { window?: unknown; NUT18V?: { _CBOR: { encode(v: unknown): Uint8Array } } }
  scope.window = scope
  new Function(readFileSync(new URL('../../../shared/nut18v.js', import.meta.url), 'utf8'))()
  const bytes = scope.NUT18V!._CBOR.encode({ t: [{ p: secrets.map((s) => ({ s, a: 1 })) }], m: 'https://mint.example', u: 'sat' })
  return `cashuB${btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`
}
const locked = (key: string, pubkeys: string[] = []) =>
  JSON.stringify(['P2PK_VOUCHER', { nonce: 'aa', data: key, tags: pubkeys.length ? [['pubkeys', ...pubkeys]] : [] }])

/** Epoch SECONDS, as storage canonicalises them. */
const at = (msFromNow: number) => Math.floor((NOW + msFromNow) / 1000)

describe('expiryLabel: rounds DOWN, never promises more time than there is', () => {
  it.each([
    [10 * DAY_MS, 'Expires in 10 days'],
    [7 * DAY_MS, 'Expires in 7 days'],
    [7 * DAY_MS - 1, 'Expires in 6 days'],
    [2 * DAY_MS, 'Expires in 2 days'],
    [2 * DAY_MS - 1, 'Expires in 1 day'],
    [DAY_MS, 'Expires in 1 day'],
    [DAY_MS - 1, 'Expires in 23 hours'],
    [20 * HOUR_MS, 'Expires in 20 hours'],
    [HOUR_MS, 'Expires in 1 hour'],
    [HOUR_MS - 1, 'Expires in under an hour'],
    [1, 'Expires in under an hour'],
  ])('%d ms -> %s', (ms, label) => {
    expect(expiryLabel(ms)).toBe(label)
  })
})

describe('expiryState', () => {
  it('a coupon with no expiry has none, whether absent, null or 0', () => {
    expect(expiryState(row({ expires_at: undefined }), NOW).kind).toBe('none')
    expect(expiryState(row({ expires_at: null as unknown as number }), NOW).kind).toBe('none')
    expect(expiryState(row({ expires_at: 0 }), NOW).kind).toBe('none')
  })

  it('tones: none beyond 7 days, soon (amber) inside 7 days, urgent (red) inside 1 day', () => {
    expect(expiryState(row({ expires_at: at(8 * DAY_MS) }), NOW)).toMatchObject({ kind: 'live', tone: 'calm' })
    expect(expiryState(row({ expires_at: at(7 * DAY_MS) }), NOW)).toMatchObject({ kind: 'live', tone: 'soon' })
    expect(expiryState(row({ expires_at: at(6 * DAY_MS) }), NOW)).toMatchObject({ kind: 'live', tone: 'soon' })
    expect(expiryState(row({ expires_at: at(DAY_MS + 1000) }), NOW)).toMatchObject({ tone: 'soon' })
    expect(expiryState(row({ expires_at: at(DAY_MS) }), NOW)).toMatchObject({ kind: 'live', tone: 'urgent' })
    expect(expiryState(row({ expires_at: at(12 * HOUR_MS) }), NOW)).toMatchObject({ tone: 'urgent' })
  })

  it('expired at or after the instant itself', () => {
    expect(expiryState(row({ expires_at: at(0) }), NOW).kind).toBe('expired')
    expect(expiryState(row({ expires_at: at(-HOUR_MS) }), NOW).kind).toBe('expired')
  })

  it('reads an ISO expiry the same as epoch seconds', () => {
    const iso = new Date(NOW + 3 * DAY_MS).toISOString()
    expect(expiryState(row({ expires_at: iso as unknown as number }), NOW)).toMatchObject({
      kind: 'live',
      tone: 'soon',
      label: 'Expires in 3 days',
    })
  })

  it('carries an accessible label with the absolute date, so colour is never the only signal', () => {
    const state = expiryState(row({ expires_at: at(3 * DAY_MS) }), NOW)
    if (state.kind !== 'live') throw new Error('expected live')
    expect(state.ariaLabel).toMatch(/^Expires in 3 days, on .+2026/)
  })
})

describe('reminderCandidates', () => {
  it('files only the tightest threshold crossed: 7d inside a week, 1d inside a day, nothing beyond', () => {
    const week = row({ expires_at: at(6 * DAY_MS) })
    const day = row({ expires_at: at(12 * HOUR_MS) })
    const far = row({ expires_at: at(30 * DAY_MS) })
    const never = row({ expires_at: undefined })
    const got = reminderCandidates([week, day, far, never], ME, NOW)
    expect(got.map((c) => [c.row.token_id, c.threshold])).toEqual([
      [day.token_id, '1d'],
      [week.token_id, '7d'],
    ])
  })

  it('boundaries: exactly 7 days and exactly 1 day count as crossed', () => {
    expect(reminderCandidates([row({ expires_at: at(7 * DAY_MS) })], ME, NOW)[0]?.threshold).toBe('7d')
    expect(reminderCandidates([row({ expires_at: at(7 * DAY_MS + 1000) })], ME, NOW)).toEqual([])
    expect(reminderCandidates([row({ expires_at: at(DAY_MS) })], ME, NOW)[0]?.threshold).toBe('1d')
  })

  it('nothing for an expired coupon: it cannot be acted on', () => {
    expect(reminderCandidates([row({ expires_at: at(-1000) })], ME, NOW)).toEqual([])
  })

  it('nothing for spent, redeemed, swapped back or fully redeemed coupons', () => {
    const rows = ['redeemed', 'spent', 'swapped_to_sats', 'fully_redeemed'].map((status) =>
      row({ status, expires_at: at(DAY_MS / 2) }),
    )
    expect(reminderCandidates(rows, ME, NOW)).toEqual([])
  })

  it('nothing for a coupon this account issued itself', () => {
    expect(reminderCandidates([row({ issuer_id: ME, expires_at: at(DAY_MS / 2) })], ME, NOW)).toEqual([])
    expect(
      reminderCandidates([row({ issuer_id: ME.toUpperCase(), expires_at: at(DAY_MS / 2) })], ME, NOW),
    ).toEqual([])
  })

  it('nothing for a coupon locked (P2PK) to somebody else; a coupon locked to me still counts', () => {
    const soon = at(DAY_MS / 2)
    const notMine = row({ token: tokenWith([locked('02' + 'c'.repeat(64))]), expires_at: soon })
    const mine = row({ token: tokenWith([locked('03' + ME)]), expires_at: soon })
    const viaTag = row({ token: tokenWith([locked('02' + 'c'.repeat(64), ['02' + ME])]), expires_at: soon })
    const bearer = row({ token: tokenWith(['plain-secret']), expires_at: soon })
    expect(reminderCandidates([notMine, mine, viaTag, bearer], ME, NOW).map((c) => c.row.token_id).sort()).toEqual(
      [mine.token_id, viaTag.token_id, bearer.token_id].sort(),
    )
  })

  it('reminder ids are stable per coupon and threshold', () => {
    expect(reminderId('tok-1', '7d')).toBe('coupon-expiring:tok-1:7d')
    expect(reminderId('tok-1', '1d')).toBe('coupon-expiring:tok-1:1d')
  })
})

describe('sortCoupons', () => {
  const soon = row({ expires_at: at(2 * DAY_MS), created_at: '2026-10-01T00:00:00Z' })
  const later = row({ expires_at: at(20 * DAY_MS), created_at: '2026-10-10T00:00:00Z' })
  const never = row({ expires_at: undefined, created_at: '2026-10-12T00:00:00Z' })
  const junk = row({ expires_at: 'Section 5' as unknown as number, created_at: '2026-09-01T00:00:00Z' })

  it('expiry: soonest first, never-expiring last, unreadable FIRST (the spend order, #157)', () => {
    expect(sortCoupons([never, later, soon, junk], 'expiry').map((r) => r.token_id)).toEqual([
      junk.token_id,
      soon.token_id,
      later.token_id,
      never.token_id,
    ])
  })

  it('newest: the received-date order the list always had', () => {
    expect(sortCoupons([soon, junk, later, never], 'newest').map((r) => r.token_id)).toEqual([
      never.token_id,
      later.token_id,
      soon.token_id,
      junk.token_id,
    ])
  })

  it('does not mutate its input', () => {
    const input = [later, soon]
    sortCoupons(input, 'expiry')
    expect(input).toEqual([later, soon])
  })
})

describe('the expired group', () => {
  it("holds a stall's unspent coupons past their expiry, newest expiry first", () => {
    const a = row({ expires_at: at(-3 * DAY_MS) })
    const b = row({ expires_at: at(-HOUR_MS) })
    const live = row({ expires_at: at(DAY_MS) })
    const spent = row({ status: 'redeemed', expires_at: at(-DAY_MS) })
    const elsewhere = row({ issuer_id: OTHER_STALL, expires_at: at(-DAY_MS) })
    expect(expiredFor([a, b, live, spent, elsewhere], STALL, NOW).map((r) => r.token_id)).toEqual([
      b.token_id,
      a.token_id,
    ])
  })

  it('expiredCount counts every stall, for the balance note', () => {
    const rows = [
      row({ expires_at: at(-DAY_MS) }),
      row({ issuer_id: OTHER_STALL, expires_at: at(-DAY_MS) }),
      row({ expires_at: at(DAY_MS) }),
      row({ status: 'spent', expires_at: at(-DAY_MS) }),
    ]
    expect(expiredCount(rows, NOW)).toBe(2)
  })
})

describe('soonestExpiring (the deck and merchant page cue)', () => {
  it("is the stall's soonest live coupon inside 7 days", () => {
    const a = row({ expires_at: at(5 * DAY_MS) })
    const b = row({ expires_at: at(2 * DAY_MS) })
    const far = row({ expires_at: at(20 * DAY_MS) })
    const other = row({ issuer_id: OTHER_STALL, expires_at: at(HOUR_MS) })
    expect(soonestExpiring([a, b, far, other], STALL, NOW)?.row.token_id).toBe(b.token_id)
  })

  it('is undefined when nothing is inside 7 days', () => {
    expect(soonestExpiring([row({ expires_at: at(20 * DAY_MS) })], STALL, NOW)).toBeUndefined()
  })
})

describe('bannerText', () => {
  it('singular and plural', () => {
    expect(bannerText(1)).toBe('1 voucher expires this week')
    expect(bannerText(2)).toBe('2 vouchers expire this week')
  })
})
