import type { ReactNode } from 'react'

/**
 * Drop entries with no value, so a record list only ever shows real data.
 *
 * The other half of the rule `RawDetails` documents and `DetailRow` assumes:
 * entries with nothing in them are dropped by the CALLER rather than rendered
 * as an em-dash, since on this stack a DM-received coupon has no expiry and no
 * memo and a fixed field list would be mostly blanks. A convention every detail
 * screen has to follow, with the helper copied into each one, is a convention
 * waiting to be followed slightly differently.
 *
 * In `lib` rather than beside the components it serves, because `ui/layout.tsx`
 * exports components and Fast Refresh requires such a file to export ONLY
 * components — a shared function there costs the whole module its hot reload.
 *
 * `Boolean` is the filter, so this drops empty strings as well as null and
 * undefined. Deliberate, and the reason callers pass `'No expiry'` rather than
 * a bare `formatDate(...)` for a field whose absence is itself a fact worth
 * printing.
 */
export function present<T extends ReactNode>(
  entries: Array<[string, T | undefined | null]>,
): Array<[string, T]> {
  return entries.filter((e): e is [string, T] => Boolean(e[1]))
}
