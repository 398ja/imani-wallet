import type { WalletTransaction } from './transactions'

/**
 * One payment made of several vouchers, as one line in history (#106).
 *
 * A €6 payment sent as €3 + €3 writes two rows, one per voucher, and each is
 * correct: that is what moved, and it is what a merchant's claims and request
 * settlement are built from. But read as a statement, two "+€3.00" lines look
 * like two payments, which is the confusion #94 removed from the toasts and
 * the bell. This folds them back into one line for DISPLAY, with the rows
 * underneath so the total can be checked rather than only believed.
 *
 * What it never does:
 *   - use a declared total. The rows carry no declaration and must not; the
 *     group's figure is the sum of the rows that are actually there.
 *   - add money across currencies, or across directions or kinds of movement.
 *     A row that differs in any of those is left as its own line.
 *   - change the rows. Everything that settles or reconciles keeps reading the
 *     flat list; this only shapes what a list screen draws.
 */

export type HistoryEntry =
  | { kind: 'single'; tx: WalletTransaction }
  | {
      kind: 'bundle'
      /** `bundle:<bundleId>`, stable as parts land. */
      id: string
      bundleId: string
      /** Newest first, the order the list itself uses. */
      parts: WalletTransaction[]
      /** Sum of the parts' `amount`, in the shared unit. */
      amount: number
      unit: string
      decimals: number
      direction: 'in' | 'out'
      type: string
      /** The newest part's time, so the group sorts where its latest part would. */
      at: number
    }

/** What rows must share to be added up as one payment. */
function groupKey(tx: WalletTransaction): string | undefined {
  if (!tx.bundleId) return undefined
  return [tx.bundleId, tx.direction, tx.type, tx.unit, tx.decimals].join('\u0000')
}

/**
 * Fold rows that belong to one bundle into one entry, keeping list order.
 *
 * The group takes the position of its first (newest, in a newest-first list)
 * part, and a bundle with a single row stays a `single`: a group of one says
 * nothing a plain row does not.
 */
export function groupHistory(transactions: WalletTransaction[]): HistoryEntry[] {
  const groups = new Map<string, WalletTransaction[]>()
  for (const tx of transactions) {
    const key = groupKey(tx)
    if (!key) continue
    const rows = groups.get(key)
    if (rows) rows.push(tx)
    else groups.set(key, [tx])
  }

  const out: HistoryEntry[] = []
  const emitted = new Set<string>()
  for (const tx of transactions) {
    const key = groupKey(tx)
    const rows = key ? groups.get(key) : undefined
    if (!key || !rows || rows.length < 2) {
      out.push({ kind: 'single', tx })
      continue
    }
    if (emitted.has(key)) continue
    emitted.add(key)
    out.push({
      kind: 'bundle',
      id: `bundle:${tx.bundleId}`,
      bundleId: tx.bundleId!,
      parts: rows,
      amount: rows.reduce((sum, r) => sum + r.amount, 0),
      unit: tx.unit,
      decimals: tx.decimals,
      direction: tx.direction,
      type: tx.type,
      at: Math.max(...rows.map((r) => r.at)),
    })
  }
  return out
}
