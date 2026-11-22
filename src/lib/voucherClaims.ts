import { groupHistory, type HistoryEntry } from './historyGroups'
import type { WalletTransaction } from './transactions'
import { PAGE_SIZE } from '../components/ui/usePagination'

/**
 * The claims against one issued voucher, shaped for display.
 *
 * A customer paying €6 with €3 + €3 of this stall's vouchers writes two claim rows that share a
 * bundle id. Listed flat they read as two payments, which is the confusion #106 removed from
 * History. So the claims fold with the SAME function History uses (`groupHistory`): same key,
 * same refusal to add across currencies or counterparties, same per-part voucher count (#661)
 * when the row renders through `HistoryListItem`. Rows with no bundle id stay single entries.
 *
 * A RECORD here is one displayed entry: a single claim, or one folded bundle however many parts
 * it has. The detail screen's "last three" and the claims page's 21 per page both count records,
 * never raw rows, so a bundle is never split across a cap or a page boundary.
 *
 * Display only. The claimed figure and settlement keep reading the flat rows.
 */

/** How many records the voucher screen shows before "See all claims". */
export const RECENT_CLAIMS = 3

/** Claims newest first, folded by bundle. Sorts defensively: callers' order is not trusted. */
export function claimEntries(claims: WalletTransaction[]): HistoryEntry[] {
  return groupHistory([...claims].sort((a, b) => b.at - a.at))
}

/** The newest `limit` records, and whether there are more behind the link. */
export function recentClaims(entries: HistoryEntry[], limit: number = RECENT_CLAIMS) {
  return { visible: entries.slice(0, limit), hasMore: entries.length > limit }
}

/**
 * Read `?page=` as a page number. Anything that is not a positive whole number is page 1:
 * a hand-edited or stale URL should land somewhere useful, not throw.
 */
export function parsePage(raw: string | null): number {
  if (raw === null || !/^\d+$/.test(raw)) return 1
  const n = Number(raw)
  return n >= 1 && Number.isSafeInteger(n) ? n : 1
}

export type ClaimsPage<T> = {
  visible: T[]
  page: number
  pageCount: number
  total: number
  /** The requested page is past the end. `visible` is empty; the screen says so and offers a way back. */
  outOfRange: boolean
}

/** One page of records. Page numbers are 1-based; an empty list still has one (empty) page. */
export function pageOf<T>(items: T[], page: number, pageSize: number = PAGE_SIZE): ClaimsPage<T> {
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize))
  const outOfRange = page > pageCount
  const start = (page - 1) * pageSize
  return {
    visible: outOfRange ? [] : items.slice(start, start + pageSize),
    page,
    pageCount,
    total: items.length,
    outOfRange,
  }
}
