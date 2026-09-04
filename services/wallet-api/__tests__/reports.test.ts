import { describe, it, expect } from 'vitest'

import { parseReportRequest } from '../reports.js'

/**
 * The boundary where a caller's history becomes numbers a merchant acts on.
 *
 * A bad row that slips through does not fail — it produces a total that is
 * quietly incorrect, which is worse than a rejection. So these are mostly
 * negatives, and each asserts the FIELD named, because "invalid request" over a
 * hundred rows is not something a caller can act on.
 */

const NOW = 1_800_000_000_000
const STALL = 'a'.repeat(64)

const row = (over: Record<string, unknown> = {}) => ({
  id: 'tx-1',
  type: 'issued',
  at: NOW - 86_400_000,
  amount: 1000,
  unit: 'EUR',
  decimals: 2,
  ...over,
})

const body = (over: Record<string, unknown> = {}) => ({
  transactions: [row()],
  pubkey: STALL,
  unit: 'EUR',
  decimals: 2,
  ...over,
})

describe('a report request', () => {
  it('is accepted when it is well formed', () => {
    const r = parseReportRequest(body(), NOW)
    expect(r.ok).toBe(true)
  })

  it('accepts an empty history, because a stall that has traded nothing is normal', () => {
    // A 400 here would make "you have no transactions" indistinguishable from
    // "your request was wrong".
    const r = parseReportRequest(body({ transactions: [] }), NOW)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.transactions).toEqual([])
  })

  it('defaults the window to thirty days, matching the app', () => {
    const r = parseReportRequest(body(), NOW)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.now - r.value.from).toBe(30 * 86_400_000)
  })

  it('reads `timestamp` as well as `at`, so a caller need not know which we prefer', () => {
    // The app's storage uses `timestamp` and its derived type uses `at`.
    const r = parseReportRequest(
      body({ transactions: [{ ...row(), at: undefined, timestamp: NOW - 1000 }] }),
      NOW,
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.transactions[0].at).toBe(NOW - 1000)
  })

  it('ignores fields it does not read rather than refusing them', () => {
    // The state is the caller's. Refusing a row for carrying an extra field
    // would make every addition to their schema a breaking change here.
    const r = parseReportRequest(body({ transactions: [{ ...row(), somethingNew: 'x' }] }), NOW)
    expect(r.ok).toBe(true)
  })
})

describe('what it refuses, and what it says', () => {
  const refusal = (over: Record<string, unknown>) => {
    const r = parseReportRequest(body(over), NOW)
    expect(r.ok).toBe(false)
    return r.ok ? { field: '', detail: '' } : r.error
  }

  it('names the stall as required, rather than guessing it', () => {
    // Guessing would silently report another stall's numbers as this one's:
    // which redemptions count as "mine" depends entirely on this key.
    expect(refusal({ pubkey: undefined }).field).toBe('pubkey')
    expect(refusal({ pubkey: 'not-a-key' }).field).toBe('pubkey')
  })

  it('requires a currency, because a report mixing them would be a lie', () => {
    expect(refusal({ unit: undefined }).detail).toMatch(/confident lie/)
  })

  it('refuses a window that ends before it starts', () => {
    expect(refusal({ from: NOW + 1000, now: NOW }).field).toBe('from')
  })

  it('names the row and the field, not just "invalid"', () => {
    // Over a hundred rows, "invalid request" is not actionable.
    const e = refusal({ transactions: [row(), { ...row(), amount: 'lots' }] })
    expect(e.field).toBe('transactions[1].amount')
  })

  it('refuses a row with no currency', () => {
    expect(refusal({ transactions: [{ ...row(), unit: undefined }] }).field).toBe(
      'transactions[0].unit',
    )
  })

  it('refuses a non-finite amount rather than letting it poison a total', () => {
    expect(refusal({ transactions: [{ ...row(), amount: 'NaN' }] }).field).toBe(
      'transactions[0].amount',
    )
  })

  it('refuses a body that is not an object, or has no transactions', () => {
    expect((parseReportRequest([], NOW) as { error: { field: string } }).error.field).toBe('body')
    expect(refusal({ transactions: 'all of them' }).field).toBe('transactions')
  })
})

describe('direction is derived, never trusted', () => {
  it('reads an issuance as outgoing however the caller labels it', () => {
    // The attack this closes: a caller marking its own issuance as incoming
    // would inflate every figure in the report.
    const r = parseReportRequest(
      body({ transactions: [{ ...row(), type: 'issued', direction: 'in' }] }),
      NOW,
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.transactions[0].direction).toBe('out')
  })

  it('reads a redemption as incoming', () => {
    const r = parseReportRequest(body({ transactions: [{ ...row(), type: 'redeemed' }] }), NOW)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.transactions[0].direction).toBe('in')
  })
})
