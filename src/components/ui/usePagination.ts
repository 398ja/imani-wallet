import { useMemo, useState } from 'react'

/**
 * Paging for the record lists.
 *
 * Every list in this app was unbounded. That is fine for the wallet of someone
 * who has bought three coupons and wrong for the stall that issued four hundred
 * last month: the page renders every row, the phone scrolls for a minute, and
 * the row someone actually wants is unreachable in practice. A cap is the fix,
 * and a cap without a way forward is just hidden data — so the two ship
 * together, here, once.
 *
 * ## Why paging rather than infinite scroll
 *
 * These are records, and records get looked FOR. "Page 3 of 9" tells a merchant
 * how much there is and lets them come back to where they were; an infinite
 * list answers neither question and cannot be linked to. It is also honest
 * about size: a scroll that keeps growing hides the fact that there are nine
 * hundred of them.
 *
 * The whole list is already in memory in every caller — these come from local
 * IndexedDB reads, not a paged API — so this slices an array rather than
 * fetching. If a list ever outgrows that, the cursor belongs in the loader and
 * this component keeps its shape.
 */

/**
 * Items per page, everywhere.
 *
 * 21 divides by 3, which is what the grid layouts use, and leaves a whole page
 * that still ends somewhere reachable by thumb on a phone.
 */
export const PAGE_SIZE = 21

/**
 * Cut a list into the page currently being viewed.
 *
 * Returns the slice plus the controls to render under it. Callers keep owning
 * their data and their empty state; this owns only which window is visible.
 *
 * @param items the FULL list, in the order it should be read
 * @param pageSize overridable for tests and for any list with a different shape
 */
export function usePagination<T>(items: T[], pageSize: number = PAGE_SIZE) {
  const [page, setPage] = useState(1)

  const pageCount = Math.max(1, Math.ceil(items.length / pageSize))

  /**
   * Stay in range when the list shrinks underneath the reader.
   *
   * These lists are live — `onWalletChanged` reloads them while the screen is
   * open — so the page someone is on can stop existing: filtering a list down,
   * or a voucher expiring out of the expiring-soon window, would otherwise
   * leave them on page 9 of 4 looking at a blank panel with no way back.
   *
   * A render-phase update, which is React's own pattern for deriving state from
   * changing input and the one the rest of this app uses (see
   * `useSessionReauth`). It re-runs this hook before anything commits, so
   * nothing ever renders against the out-of-range page and there is no second
   * pass. An effect here would be exactly the cascading render
   * `react-hooks/set-state-in-effect` exists to stop.
   */
  if (page > pageCount) setPage(pageCount)

  // Clamped on read as well. `setPage` above schedules the correction; this is
  // what the CURRENT render uses, so a shrink shows the last real page rather
  // than an empty one.
  const current = Math.min(page, pageCount)
  const start = (current - 1) * pageSize

  const visible = useMemo(
    () => items.slice(start, start + pageSize),
    [items, start, pageSize],
  )

  return {
    /** The rows to render right now. */
    visible,
    page: current,
    pageCount,
    setPage,
    /** Index of the first visible row in the full list, 1-based, for captions. */
    firstIndex: items.length === 0 ? 0 : start + 1,
    lastIndex: Math.min(start + pageSize, items.length),
    total: items.length,
  }
}
