/**
 * The merchant dashboard's range filters, and where each one starts.
 *
 * Every range is counted in the merchant's own calendar days: "Today" is local
 * midnight to now, "7 days" is today plus the six days before, each from local
 * midnight. Not `now - n * 24h`: that window starts at whatever time of day it
 * happens to be, and on the days the clocks change a 24-hour step lands an hour
 * off midnight. `Date#setDate` steps calendar days and lets the zone rules
 * decide how long each one was.
 */
export const RANGES = [
  { label: 'Today', days: 1 },
  { label: '7 days', days: 7 },
  { label: '30 days', days: 30 },
] as const

/** A month is what a merchant opens the dashboard to check. */
export const DEFAULT_RANGE_DAYS = 30

/**
 * A range that is still offered, or the default.
 *
 * Anything else (90 days, which was dropped, or a value that does not parse)
 * falls back rather than drawing a window no button is pressed for. Nothing
 * stores the choice today; this is the gate any future stored or URL value
 * goes through.
 */
export function rangeDays(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : value
  return RANGES.some((r) => r.days === n) ? (n as number) : DEFAULT_RANGE_DAYS
}

/** Local midnight `days - 1` calendar days before `now`, so the window includes today. */
export function rangeFrom(days: number, now: number): number {
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - (days - 1))
  return start.getTime()
}
