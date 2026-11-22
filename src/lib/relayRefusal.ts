/**
 * #532: what a relay's `OK false` (or a failed connection) means. Imports nothing, so the
 * purchase-issuer image can copy it alone.
 */
export type RelayRefusal =
  | { kind: 'too_large'; bytes: number | null; reason: string }
  | { kind: 'unreachable'; reason: string }
  | { kind: 'refused'; reason: string }

/** #532: what a relay's failure means. strfry says `invalid: event too large: 66045`. */
export function classifyRelayError(reason: string): RelayRefusal {
  const large = /too large(?::\s*(\d+))?/i.exec(reason)
  if (large) return { kind: 'too_large', bytes: large[1] ? Number(large[1]) : null, reason }
  if (/connection failure|timed out|could not connect|connection (closed|error)/i.test(reason)) return { kind: 'unreachable', reason }
  return { kind: 'refused', reason }
}

/** True when a relay refused the event for its size (permanent, never retried as it is). */
export function refusedTooLarge(result: { errors: string[]; refusals?: RelayRefusal[] }): boolean {
  return (result.refusals ?? result.errors.map(classifyRelayError)).some((r) => r.kind === 'too_large')
}
