/**
 * A coupon's expiry: the wallet's one parser for it, and the one stored shape.
 *
 * **Stored as epoch SECONDS** (a number), or null for "no expiry". Seconds
 * because that is what most of the system already speaks: `VoucherRow` declares
 * it, the signed voucher tag carries it, the DM payload (`SendTokenDmRequest`,
 * `TokenTransferMessage`) is a `Long` of it, and the NIP-60 transaction records
 * write it.
 *
 * **Read from anything** (#157), because rows arrive from producers that never
 * agreed:
 *
 * | Producer                                   | Shape seen                    |
 * |--------------------------------------------|-------------------------------|
 * | DM receive (dmPoll, signed tag)            | number, seconds               |
 * | `/inspect` today (gateway-core)            | ISO-8601 string               |
 * | `/inspect` before gateway-core v0.6.1      | NUMERIC STRING of seconds     |
 * | gateway create-voucher (Sell, cashback)    | ISO-8601 string               |
 * | NIP-60 restore / import                    | whatever the origin device had|
 *
 * The numeric string is the #157 bug: `Date.parse("1798588800")` is NaN, which
 * read as "never expires" and spent the coupon closest to lapsing LAST.
 *
 * Seconds and milliseconds are told apart by magnitude: below 1e12 is seconds
 * (1e12 s is the year 33658; 1e12 ms is September 2001, before any coupon
 * existed). Not 1e11, the boundary the older copies used: a far-future
 * "practically never" expiry such as 9999-12-31 is 253402300799 in SECONDS,
 * above 1e11, so it read as milliseconds in 1978. Stored as seconds and read
 * back, it would then collapse to a date in the past and hide a live coupon as
 * expired. Between 1e11 and 1e12 the seconds reading is the only safe one:
 * the milliseconds reading names 1973-2001, which no coupon can carry.
 *
 * Converting to whole seconds rounds UP, so storing never moves an expiry
 * earlier, not even by the milliseconds a fraction drops.
 *
 * Three outcomes, never two. A value that is present but unreadable is NOT
 * "no expiry": it is kept as it was and reported, so nothing erases a real
 * expiry nobody could parse, and spend order can still treat it as at risk.
 */

/** What an `expires_at` value says. */
export type Expiry =
  | { kind: 'at'; seconds: number }
  | { kind: 'none' }
  | { kind: 'unreadable'; raw: unknown }

/** Below this a number is seconds; at or above, milliseconds. */
const MS_THRESHOLD = 1e12

/**
 * The largest readable instant, in milliseconds: the last whole second whose
 * stored SECONDS value is still below MS_THRESHOLD, 999999999999 s (year 33658).
 *
 * Not the JS Date limit (8.64e15). Storing must be a fixed point: whatever is
 * stored has to read back as the same instant. A value at or above 1e15 ms
 * stores as at least 1e12 seconds, and 1e12 reads back as MILLISECONDS, i.e.
 * 2001-2023, so the migration that runs on every open would write a past date
 * over a live coupon (#169 review). Nothing issues expiries this far out, so
 * such a value is unreadable, and unreadable falls back to the signed tag.
 * This also stays well under the Date limit, past which `toISOString()` throws.
 */
const MAX_DATE_MS = (MS_THRESHOLD - 1) * 1000

/**
 * Below this, a number of seconds is before 2001-09-09. A FRACTION there is
 * not an expiry any producer writes (they write whole seconds, or milliseconds),
 * so '0.5' is unreadable, not rounded up into a date in 1970.
 */
const MIN_FRACTIONAL = 1e9

/** A plain decimal number, optionally signed, fractional or with an exponent ("1.7e9"). */
const NUMERIC = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i

/**
 * ISO-8601 calendar date, optionally with a time and a zone. A space is
 * accepted for the `T` (what SQL and Java's `Timestamp#toString` print).
 */
const ISO = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:?\d{2})?)?$/i

/**
 * A long-form date as `Date#toString`, `toUTCString` and RFC 2822 print it:
 * an English month name AND a four-digit year. Both, because V8's Date.parse
 * reads almost anything with a number in it as a date in 2001 ("Section 5",
 * "12/31", "version 3.2"), and a corrupt value must not become a real-looking
 * expiry 25 years in the past.
 */
const LONG_FORM = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b.*\b\d{4}\b/i

/** Milliseconds, 'none', or 'unreadable'. Full precision, for display callers. */
function msOf(value: unknown): number | 'none' | 'unreadable' {
  if (value === undefined || value === null) return 'none'
  let n: number
  if (typeof value === 'number') n = value
  else if (value instanceof Date) n = value.getTime()
  else if (typeof value === 'string') {
    const text = value.trim()
    // '0' is how a 0 that went through a string column reads. Same sentinel.
    if (text === '' || text === '0') return 'none'
    if (NUMERIC.test(text)) n = Number(text)
    else return finiteMs(parseDateString(text))
  } else return 'unreadable'

  if (!Number.isFinite(n) || n < 0) return 'unreadable'
  if (n === 0) return 'none'
  if (n < MIN_FRACTIONAL && !Number.isInteger(n)) return 'unreadable'
  return finiteMs(n < MS_THRESHOLD ? n * 1000 : n)
}

/**
 * A date string, or NaN. Only shapes a producer actually writes reach
 * Date.parse; everything else is unreadable rather than guessed at.
 *
 * An ISO date-time WITHOUT a zone is read as UTC. ECMAScript reads it as the
 * device's LOCAL time (date-only as UTC, date-time as local, a long-standing
 * trap), so the same stored value would name a different instant in Nairobi
 * and in London. Every server here runs in UTC and every zoned value it emits
 * says Z, so a missing zone is a serialiser that dropped it, not local time.
 */
function parseDateString(text: string): number {
  const iso = ISO.exec(text)
  if (iso) {
    const [, date, time, zone] = iso
    // Date.parse rolls '2026-02-30' over into 2 March. A day that does not
    // exist is a corrupt value, not a date three days later.
    if (!realCalendarDate(date) || (time && !realClockTime(time))) return Number.NaN
    if (!time) return Date.parse(date) // date-only: UTC by the spec already
    return Date.parse(`${date}T${time}${zone ?? 'Z'}`)
  }
  if (LONG_FORM.test(text)) return Date.parse(text)
  return Number.NaN
}

/** True when YYYY-MM-DD names a day that exists (no 30 February, no month 13). */
function realCalendarDate(date: string): boolean {
  const [y, m, d] = date.split('-').map(Number)
  const at = new Date(Date.UTC(y, m - 1, d))
  return at.getUTCFullYear() === y && at.getUTCMonth() === m - 1 && at.getUTCDate() === d
}

/** True when HH:MM[:SS] is a real clock time (no 24:30, no minute 61). */
function realClockTime(time: string): boolean {
  const [h, m, s = 0] = time.split(':').map(Number)
  return h < 24 && m < 60 && s < 60
}

function finiteMs(ms: number): number | 'unreadable' {
  return Number.isFinite(ms) && ms > 0 && ms <= MAX_DATE_MS ? ms : 'unreadable'
}

/** Read an `expires_at` value of any shape. */
export function readExpiry(value: unknown): Expiry {
  const ms = msOf(value)
  if (ms === 'none') return { kind: 'none' }
  if (ms === 'unreadable') return { kind: 'unreadable', raw: value }
  // Up, never down: a stored expiry must not be earlier than the one given.
  return { kind: 'at', seconds: Math.ceil(ms / 1000) }
}

/** Epoch milliseconds, or undefined for no expiry AND for unreadable. */
export function toEpochMs(value: unknown): number | undefined {
  const ms = msOf(value)
  return typeof ms === 'number' ? ms : undefined
}

/** Epoch seconds, or undefined for no expiry AND for unreadable. */
export function toEpochSeconds(value: unknown): number | undefined {
  const e = readExpiry(value)
  return e.kind === 'at' ? e.seconds : undefined
}

/**
 * The value to STORE for an incoming `expires_at`.
 *
 * - undefined stays undefined: the field was not given, and the store's merge
 *   skips undefined, so a partial write never erases an expiry already held.
 * - Every spelling of "no expiry" becomes null.
 * - Every readable instant becomes epoch seconds.
 * - An unreadable value is returned exactly as it came: kept, never erased and
 *   never turned into "no expiry". The caller logs it.
 *
 * Idempotent: canonicalExpiresAt(canonicalExpiresAt(x)) === canonicalExpiresAt(x).
 */
export function canonicalExpiresAt(value: unknown): unknown {
  if (value === undefined) return undefined
  const e = readExpiry(value)
  if (e.kind === 'at') return e.seconds
  if (e.kind === 'none') return null
  return value
}
