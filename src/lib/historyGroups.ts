import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'
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
  const bundle = tx.bundleId ?? linkBundle(tx) ?? returnBundle(tx)
  if (!bundle) return undefined
  return [
    bundle,
    tx.direction,
    tx.type,
    tx.unit,
    tx.decimals,
    tx.counterparty ?? '',
    tx.merchantId ?? '',
  ].join('\u0000')
}

/**
 * Rows already stored without a bundle id still fold when they are the coupons of ONE Cashlink:
 * a send adopted back from the relay wrote one row per coupon and no bundle id. Keyed on a hash of
 * the link, never the link secret itself, since the key ends up in the entry id.
 */
function linkBundle(tx: WalletTransaction): string | undefined {
  if (tx.type !== 'sent' || !tx.link?.k) return undefined
  return 'link:' + bytesToHex(sha256(new TextEncoder().encode(tx.link.k))).slice(0, 32)
}

/**
 * The coupons that came back off ONE debit fold into one entry, like a Cashlink take-back (#530):
 * an expired checkout code or an unclaimed locked gift writes one `returned:` row per coupon, each
 * naming the debit it reverses (`returnOf`, #643) and no bundle id. Read here rather than written,
 * so rows already stored fold too. The debit's id is this wallet's own row id, nothing secret.
 */
function returnBundle(tx: WalletTransaction): string | undefined {
  return tx.returnOf ? 'return:' + tx.returnOf : undefined
}

/** A stable, unique React key for any entry. */
export function entryKey(entry: HistoryEntry): string {
  return entry.kind === 'single' ? entry.tx.id : entry.id
}

/**
 * How many VOUCHERS a folded line is, for its "N vouchers" chip.
 *
 * Not `parts.length`: a row is one token, and one voucher can come back as several (a checkout
 * code's change, a Cashlink take-back, one row per proof), so a single €8.99 voucher read as
 * "6 vouchers". Rows naming the same `voucherId` (and stall) are one voucher. A row with no
 * `voucherId` is counted on its own, never merged into another.
 *
 * But that merge is right ONLY for rows that are the proofs of one held voucher coming back (a
 * Cashlink take-back, `returned:` rows). The parts of a multi-voucher send, payment or receive are
 * each a separate voucher on the wire, each its own token, even when the planner drew all of them
 * from ONE source voucher: they carry that source's `voucherId`, so merging on it told the sender
 * "1 voucher" for a bundle the recipient got as five (staging bundle 1d67db42: ten parts, one
 * source voucher_id). Those parts count one each, by token.
 */
export function entryVoucherCount(entry: HistoryEntry): number {
  if (entry.kind === 'single') return 1
  const ids = new Set<string>()
  for (const [i, tx] of entry.parts.entries()) {
    const proofOfHeldVoucher = tx.id.startsWith('returned:')
    if (proofOfHeldVoucher && tx.voucherId) ids.add(`v:${(tx.merchantId ?? '').toLowerCase()}:${tx.voucherId}`)
    else ids.add(tx.tokenId ? `t:${tx.tokenId}` : `row:${i}`)
  }
  return ids.size
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
