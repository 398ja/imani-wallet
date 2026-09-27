import type { WalletTransaction } from './transactions'
import { hasValidationClaim, validationStatus, type ValidationStatus } from './validationStatus'
import type { VoucherValidation } from './voucherToken'

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
      /**
       * Unique per group, derived from everything the group shares, so it is a
       * safe React key: two groups with one bundle id (a received and a
       * cashback row, or two counterparties) never collide.
       */
      id: string
      /** Newest first, the order the list itself uses. */
      parts: WalletTransaction[]
      /** Sum of the parts' `amount`, in the shared unit. */
      amount: number
      unit: string
      decimals: number
      direction: 'in' | 'out'
      /** The newest part's time, so the group sorts where its latest part would. */
      at: number
    }

/**
 * What rows must share to be added up as one payment.
 *
 * The bundle id is sender-chosen, so it is not trusted to be unique on its
 * own: a stall's list spans every customer, and nothing stops two senders
 * (or one sender on two days) reusing an id. The counterparty and the stall
 * are part of the key so different parties' money is never folded together.
 */
function groupKey(tx: WalletTransaction): string | undefined {
  if (!tx.bundleId) return undefined
  return [
    tx.bundleId,
    tx.direction,
    tx.type,
    tx.unit,
    tx.decimals,
    tx.counterparty ?? '',
    tx.merchantId ?? '',
  ].join('\u0000')
}

/** A stable, unique React key for any entry. */
export function entryKey(entry: HistoryEntry): string {
  return entry.kind === 'single' ? entry.tx.id : entry.id
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
      // The newest part's row id rides along so the key stays unique even if
      // every shared field above matched another group's.
      id: `bundle:${key}:${tx.id}`,
      parts: rows,
      amount: rows.reduce((sum, r) => sum + r.amount, 0),
      unit: tx.unit,
      decimals: tx.decimals,
      direction: tx.direction,
      at: Math.max(...rows.map((r) => r.at)),
    })
  }
  return out
}

/** Worst first: the order a reader must hear about them. */
const SEVERITY: Record<ValidationStatus, number> = { failed: 2, unchecked: 1, verified: 0 }

/**
 * The validation to show on a folded line: its WORST part's.
 *
 * Folding must not hide a check that failed. A payment whose second voucher
 * did not verify shows the failure on the one line the reader sees, not only
 * once they think to open it. Undefined when no part makes a claim to check,
 * exactly as a single row shows no badge then.
 */
export function worstValidation(parts: WalletTransaction[]): VoucherValidation | 'none' | undefined {
  const claims = parts.filter(hasValidationClaim)
  if (claims.length === 0) return undefined
  let worst = claims[0]!
  for (const p of claims) {
    if (SEVERITY[validationStatus(p.validation)] > SEVERITY[validationStatus(worst.validation)]) worst = p
  }
  // An unchecked part has no validation object; the badge reads undefined as
  // "not checked", which is what it is.
  return worst.validation ?? 'none'
}
