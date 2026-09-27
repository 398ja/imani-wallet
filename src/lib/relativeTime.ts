/**
 * "3m ago", not a timestamp.
 *
 * A notification's age is the only temporal thing worth knowing here, and
 * "14:32" makes the reader do the subtraction. Coarse on purpose: past a week
 * the exact day stops mattering.
 */
export function relativeTime(epochMs: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - epochMs) / 1000))
  if (seconds < 45) return 'Just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days}d ago`
  const weeks = Math.round(days / 7)
  return `${weeks}w ago`
}
