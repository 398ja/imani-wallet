import type { ReportTransaction } from '@imani/reports'

/**
 * Parsing the rows a caller sends for a report.
 *
 * The service stores nothing, so a report is computed over history the caller
 * supplies. This is the boundary where a request body becomes numbers a
 * merchant will act on, and everything they could get wrong has to be caught
 * here — a bad row that slips through does not fail, it produces a total that
 * is quietly incorrect, which is worse.
 *
 * Follows `holding.ts`: one error at a time, naming the field, and unknown
 * fields ignored rather than rejected. The state is the caller's, and refusing
 * a row for carrying a field we do not read would make every addition to their
 * schema a breaking change here.
 */

type Parsed<T> = { ok: true; value: T } | { ok: false; error: { field: string; detail: string } }

const fail = (field: string, detail: string): Parsed<never> => ({ ok: false, error: { field, detail } })

function describe(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'an array'
  return typeof v
}

/**
 * Types that mean value came IN to this wallet.
 *
 * `direction` is DERIVED here, never read off the caller's row. The app does
 * the same in `toTransaction`, whose comment records why: the stored rows
 * disagree with themselves about direction. Trusting a supplied `direction`
 * would let a merchant's own issuance be counted as income and inflate every
 * figure in the report.
 */
const INCOMING = new Set(['received', 'redeemed'])

export interface ReportRequest {
  transactions: ReportTransaction[]
  pubkey: string
  unit: string
  decimals: number
  from: number
  now: number
}

function parseRow(row: unknown, i: number): Parsed<ReportTransaction> {
  const at = `transactions[${i}]`
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    return fail(at, `expected an object, got ${describe(row)}`)
  }
  const r = row as Record<string, unknown>

  const type = typeof r.type === 'string' ? r.type : ''
  if (!type) return fail(`${at}.type`, 'required')

  const amount = Number(r.amount ?? 0)
  if (!Number.isFinite(amount)) return fail(`${at}.amount`, 'expected a finite number')

  // `at` or `timestamp`: the app's storage uses the latter and its derived type
  // the former, and a caller reading rows out of either should not have to know
  // which one this service happens to prefer.
  const when = Number(r.at ?? r.timestamp ?? Number.NaN)
  if (!Number.isFinite(when)) return fail(`${at}.at`, 'expected epoch milliseconds')

  const unit = typeof r.unit === 'string' ? r.unit : ''
  if (!unit) return fail(`${at}.unit`, 'required — a row with no currency cannot be grouped')

  return {
    ok: true,
    value: {
      id: typeof r.id === 'string' ? r.id : `row-${i}`,
      type,
      direction: INCOMING.has(type) ? 'in' : 'out',
      at: when,
      amount,
      unit,
      decimals: Number.isFinite(Number(r.decimals)) ? Number(r.decimals) : 0,
      merchantId: typeof r.merchantId === 'string' ? r.merchantId : undefined,
      voucherId: typeof r.voucherId === 'string' ? r.voucherId : undefined,
      counterparty: typeof r.counterparty === 'string' ? r.counterparty : undefined,
      expiresAt: Number.isFinite(Number(r.expiresAt)) ? Number(r.expiresAt) : undefined,
    },
  }
}

/** Thirty days, matching the window the app's dashboard opens on. */
const DEFAULT_WINDOW_MS = 30 * 86_400_000

export function parseReportRequest(body: unknown, defaultNow: number): Parsed<ReportRequest> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return fail('body', `expected a JSON object with a "transactions" array, got ${describe(body)}`)
  }
  const b = body as Record<string, unknown>

  const rows = b.transactions
  if (!Array.isArray(rows)) {
    return fail('transactions', `expected an array, got ${describe(rows)}`)
  }

  const transactions: ReportTransaction[] = []
  for (let i = 0; i < rows.length; i++) {
    const parsed = parseRow(rows[i], i)
    if (!parsed.ok) return parsed
    transactions.push(parsed.value)
  }

  // Required, not defaulted to the caller's own key: these figures depend on
  // whose redemptions count as theirs, and guessing would silently report
  // another stall's numbers as this one's.
  const pubkey = typeof b.pubkey === 'string' ? b.pubkey : ''
  if (!/^[0-9a-f]{64}$/i.test(pubkey)) {
    return fail('pubkey', 'expected 64 hex characters — the stall these figures are for')
  }

  const unit = typeof b.unit === 'string' ? b.unit : ''
  if (!unit) {
    // One currency at a time, the same reason the app reports per-unit rather
    // than summing: adding XAF to EUR would be a confident lie.
    return fail('unit', 'required — a report mixing currencies would be a confident lie')
  }

  const decimals = Number(b.decimals ?? 0)
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 8) {
    return fail('decimals', 'expected a whole number between 0 and 8')
  }

  const now = Number(b.now ?? defaultNow)
  if (!Number.isFinite(now)) return fail('now', 'expected epoch milliseconds')

  const from = Number(b.from ?? now - DEFAULT_WINDOW_MS)
  if (!Number.isFinite(from)) return fail('from', 'expected epoch milliseconds')
  if (from > now) return fail('from', 'is after the end of the window')

  return { ok: true, value: { transactions, pubkey, unit, decimals, from, now } }
}
