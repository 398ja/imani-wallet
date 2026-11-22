import type { Event } from 'nostr-tools'
import type { TransactionRow } from '@imani/wallet-storage'

import { toContent, toRow, type HistoryContent } from './txRecords'
import { toTransaction, warrantIssuedAt } from './transactions'
import { parseIssuanceWarrant, verifyIssuanceWarrant, type IssuanceWarrant } from './issuanceWarrant'
import { verifyIssuerDelegation } from './issuerDelegation'
import { parseCredentialSecret } from './terminalWarrant'
import { wrapMessage, type Rumor, type WrapPublisher } from './terminalDelivery'
import { allTerminals, noteTerminalUse } from './terminalRoster'
import { clampNote } from './note'
import { raiseHomecomingAlert, type RosterRefresh } from './terminalHomecoming'

/**
 * A till's sales reach the stall's own books (#160 phase 6, wallet#202, plan 2.1, Q1 (a)).
 *
 * ## Why this exists
 *
 * A terminal opens no NAP wallet (spec 2.3), so `recordSale`'s `getWallet().addTransaction`
 * threw on a till, was swallowed, and the sale existed nowhere but in the customer's wallet.
 * Even had it run, the row would have sat in the till's IndexedDB with its 7376 sealed to `K`,
 * never to the stall.
 *
 * ## The wire
 *
 * The till gift-wraps (NIP-17) the rows it would have written to the stall, sealed by `K`:
 * `{"type":"imani-terminal-sale/1","rows":[<toContent(row)>…],"credential_voucher_id"}`. It is
 * the same delivery path the credential and enrolled DMs use (`terminalDelivery.ts`), published
 * to the relay and the NIP-98 gateway mirror (`devicePublisher`).
 *
 * ## What the owner files, and why nobody else can write into its books
 *
 * A gift wrap's outer key is throwaway and `K` is public, so the owner's app trusts nothing the
 * wrap claims. Each row is filed only when:
 *
 * 1. it is an `issued` or `cashback` row carrying a `terminal` warrant;
 * 2. the seal is `K`, the lock of the credential inside that warrant (`sealer-not-lock`);
 * 3. `verifyIssuanceWarrant` reads the warrant `verified` for THIS stall: the service signed the
 *    credential, `K` signed the sale, the coupon fits under it, and the stall itself attested
 *    that till (spec 4.6.3). A till the stall never attested reads `unwarranted` and is refused.
 *
 * The row is then written through the owner's `addTransaction`, which republishes it as the
 * owner's own 7376, so it survives every device the owner has. Its id is the one the till would
 * have used (`issued:<voucher>`, `cashback:<id>`), so filing it twice is an overwrite.
 *
 * ## Delivery that cannot fail a sale
 *
 * The coupon is already with the customer when this runs. A wrap that reaches neither the relay
 * nor the mirror is kept in a device outbox and sent again at the next unlock and on a timer; the
 * sale never fails over its record, as before.
 */

export const SALE_DM_TYPE = 'imani-terminal-sale/1'

/** Where an unsent sale record waits on the till. Swept with everything else on decommission. */
const OUTBOX_KEY = 'imani-wallet:terminal:sale-outbox'

/** The owner's catch-up cursor (epoch seconds of the newest wrap seen), per stall. */
const CURSOR_KEY = (stall: string) => `imani-wallet:till-sales-cursor:${stall.toLowerCase()}`

/**
 * The content budget per wrap, sized on the EVENT the relay sees, not on NIP-44's plaintext cap.
 * NIP-17 encrypts twice and NIP-44 pads in steps: content past about 28.6 KB makes a 66,045-byte
 * kind 1059, over strfry's 65,536 `maxEventSize` (gc#207 H1, `GiftWrapSizeModel`). 24,000 is
 * gc's own direct-send limit and keeps a wrap at or under 55,121 bytes (review rv6 W1-M1). A row
 * is 2 to 2.5 KB, so a split sale goes as several wraps; one row never splits. Measured escaped,
 * as the content sits inside the rumor's JSON (the sale is nested JSON, so escaping adds ~15%),
 * and in UTF-8 bytes, not UTF-16 units: a CJK note is three bytes a unit (review sh6). One row
 * fits because its note is capped (`note.ts`, 280 units, at most ~1,960 bytes escaped) and its
 * warrant is bounded by the portal (4,096 units, at most ~16 KB escaped), so the worst row is
 * about 19.4 KB (review rw1).
 */
const MAX_WRAP_PLAINTEXT = 24_000

/** First run with no cursor: wraps from a day before the earliest terminal was added. */
const FIRST_RUN_SLACK_SECONDS = 24 * 3600

/**
 * How far a gift wrap's `created_at` may sit before the moment it was sent. NIP-59 blurs it, and
 * `terminalDelivery.wrapMessage` backdates by up to ten minutes. The cursor reads back by this
 * much, or a sale sent after the cursor moved, but stamped earlier, is never read (found by the
 * local gate, #160 phase 6 E3). Rows already filed are skipped by id, so re-reading costs nothing.
 */
export const WRAP_BLUR_SECONDS = 15 * 60

/** Whether a rumor's content is a till sale record, so dm-poll can hand it to the collector. */
export function isTillSaleMessage(content: string): boolean {
  try {
    return (JSON.parse(content) as { type?: unknown })?.type === SALE_DM_TYPE
  } catch {
    return false
  }
}

/** The sale record's JSON, as the till sends it. */
export function saleMessageJson(rows: readonly TransactionRow[], credentialVoucherId: string): string {
  return JSON.stringify({
    type: SALE_DM_TYPE,
    // The note capped again here, whatever screen built the row: one row never splits, so an
    // uncapped note is the one thing that could push a single wrap past the relay (review sh6).
    rows: rows.map((r) => {
      const tx = toTransaction(r)
      return toContent(tx.memo === undefined ? tx : { ...tx, memo: clampNote(tx.memo) })
    }),
    credential_voucher_id: credentialVoucherId,
  })
}

const encoder = new TextEncoder()
const utf8Bytes = (s: string): number => encoder.encode(s).length

/** The record split so each wrap fits the relay. One row never splits. */
function saleMessages(rows: readonly TransactionRow[], credentialVoucherId: string): string[] {
  const out: string[] = []
  let batch: TransactionRow[] = []
  for (const row of rows) {
    const next = [...batch, row]
    // Measured as it sits in the rumor: JSON in a JSON string, every quote escaped, and in UTF-8
    // BYTES, which is what the relay counts (`.length` counts UTF-16 units: a CJK or emoji note
    // read as a third of its size, review sh6).
    if (batch.length > 0 && utf8Bytes(JSON.stringify(saleMessageJson(next, credentialVoucherId))) > MAX_WRAP_PLAINTEXT) {
      out.push(saleMessageJson(batch, credentialVoucherId))
      batch = [row]
    } else {
      batch = next
    }
  }
  if (batch.length > 0) out.push(saleMessageJson(batch, credentialVoucherId))
  return out
}

// ---- the till -------------------------------------------------------------------------------

interface OutboxEntry {
  stall: string
  content: string
}

function readOutbox(): OutboxEntry[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(OUTBOX_KEY) ?? '[]') as unknown
    return Array.isArray(parsed)
      ? parsed.filter(
          (e): e is OutboxEntry =>
            !!e && typeof (e as OutboxEntry).stall === 'string' && typeof (e as OutboxEntry).content === 'string',
        )
      : []
  } catch {
    return []
  }
}

function writeOutbox(entries: OutboxEntry[]): void {
  try {
    if (entries.length === 0) localStorage.removeItem(OUTBOX_KEY)
    else localStorage.setItem(OUTBOX_KEY, JSON.stringify(entries))
  } catch {
    // Storage refused. The sale stands; only its copy in the stall's books is at risk.
  }
}

/** What Take out of service says while sale records have not reached the stall. */
export const UNSENT_SALES_WARNING = (n: number): string =>
  `${n === 1 ? 'One sale record has' : `${n} sale records have`} not reached the stall owner yet. ` +
  'Taking this terminal out of service now erases them, and those sales will be missing from the ' +
  "stall's history. Connect to the internet and wait a minute first."

/** How many sale records are waiting on this till. Take out of service warns while any are. */
export function pendingTillSales(): number {
  return readOutbox().length
}

/** Lends the till's key `K` for one seal, the way `signer.withPrivkey` does. */
export type SealWith = <T>(borrow: (key: Uint8Array) => T) => T

/**
 * Where a till's sale rows go: installed by the till when it unlocks, cleared when it locks.
 *
 * A seam rather than an import, so `issue.ts` and `cashbackIssue.ts` (which the owner's app
 * runs too) never reach for the till's key or its publisher. Null on the owner's device, where
 * rows go to the owner's own wallet as before.
 */
export type TillSaleSink = (rows: readonly TransactionRow[]) => Promise<boolean>

let sink: TillSaleSink | null = null

export function setTillSaleSink(next: TillSaleSink | null): void {
  sink = next
}

/**
 * Record a till's sale with its stall. NEVER THROWS. With no sink installed (a till that locked
 * mid-sale) the rows cannot be sealed, so they are reported lost rather than written somewhere
 * nobody reads.
 */
export async function recordTillSale(rows: readonly TransactionRow[]): Promise<boolean> {
  if (!sink) {
    console.error('[tillSales] a till sale with no way to reach its stall; it is not in the stall history')
    return false
  }
  try {
    return await sink(rows)
  } catch (error) {
    console.error('[tillSales] sale record not sent', error)
    return false
  }
}

async function deliver(
  entry: OutboxEntry,
  sealWith: SealWith,
  publisher: WrapPublisher,
): Promise<boolean> {
  try {
    // Wrapped at send time, never stored wrapped: NIP-59 back-dates a wrap by up to ten
    // minutes, and a wrap kept for hours would land behind the owner's catch-up cursor.
    const wrap = sealWith((key) => wrapMessage(key, entry.stall, entry.content))
    return await publisher.publish(wrap)
  } catch {
    return false
  }
}

/**
 * Send a till's sale rows to its stall. NEVER THROWS, and never fails the sale.
 *
 * @returns true when every wrap landed somewhere; false when any was queued for later
 */
export async function sendTillSale(
  rows: readonly TransactionRow[],
  stallPubkey: string,
  credentialVoucherId: string,
  sealWith: SealWith,
  publisher: WrapPublisher,
): Promise<boolean> {
  if (rows.length === 0) return true
  let all = true
  const queued: OutboxEntry[] = []
  for (const content of saleMessages(rows, credentialVoucherId)) {
    const entry = { stall: stallPubkey.toLowerCase(), content }
    if (!(await deliver(entry, sealWith, publisher))) {
      queued.push(entry)
      all = false
    }
  }
  if (queued.length > 0) writeOutbox([...readOutbox(), ...queued])
  return all
}

/**
 * Send whatever the outbox holds. Called at every unlock and on a timer while the till is open.
 *
 * @returns how many records were delivered
 */
export async function flushSaleOutbox(sealWith: SealWith, publisher: WrapPublisher): Promise<number> {
  const pending = readOutbox()
  if (pending.length === 0) return 0
  const kept: OutboxEntry[] = []
  let sent = 0
  for (const entry of pending) {
    if (await deliver(entry, sealWith, publisher)) sent += 1
    else kept.push(entry)
  }
  // Re-read before writing: a sale made while this flush was in flight queued its own entry.
  const added = readOutbox().slice(pending.length)
  writeOutbox([...kept, ...added])
  return sent
}

// ---- the owner ------------------------------------------------------------------------------

export type SaleRefusal =
  | 'not-a-terminal-sale'
  | 'sealer-not-lock'
  /** A `delegated` row sealed by a key other than the delegation's `p` (#275). */
  | 'sealer-not-delegate'
  /** A `delegated` row with no processor reference: not a card sale, so not the issuer's to file. */
  | 'not-a-card-sale'
  | 'warrant-unwarranted'
  | 'warrant-failed'
  | 'unreadable'

export interface ReadSale {
  /** Rows to file, rebuilt from the wire and attributed to the sealer. */
  rows: TransactionRow[]
  refused: Array<{ id: string; reason: SaleRefusal }>
}

/** The id the till's own writer would have used, so filing twice overwrites. */
function rowIdOf(content: HistoryContent): string | null {
  if (content.type === 'issued' && typeof content.voucher_id === 'string' && content.voucher_id) {
    return `issued:${content.voucher_id}`
  }
  if (content.type === 'cashback' && typeof content.cashback_id === 'string' && content.cashback_id) {
    return `cashback:${content.cashback_id}`
  }
  return null
}

/**
 * Read a sale record from an unwrapped rumor and its VERIFIED sealer (`unwrapSealed`).
 *
 * @returns null when the rumor is not a sale record at all
 */
export function saleRowsFromRumor(
  rumor: Rumor,
  sealer: string,
  stallPubkey: string,
  options: { trustedServiceKeys?: readonly string[] } = {},
): ReadSale | null {
  let message: Record<string, unknown>
  try {
    message = JSON.parse(rumor.content) as Record<string, unknown>
  } catch {
    return null
  }
  if (message?.type !== SALE_DM_TYPE || !Array.isArray(message.rows)) return null

  const stall = stallPubkey.toLowerCase()
  const k = sealer.toLowerCase()
  const out: ReadSale = { rows: [], refused: [] }
  for (const raw of message.rows) {
    const content = (raw && typeof raw === 'object' ? raw : {}) as HistoryContent
    const id = rowIdOf(content)
    const warrant = parseIssuanceWarrant(content.issuance_warrant)
    if (id && warrant.state === 'present' && warrant.form === 'delegated' && content.type === 'issued') {
      const filed = delegatedSaleRow(id, content, warrant, k, stall)
      if ('reason' in filed) out.refused.push({ id, reason: filed.reason })
      else out.rows.push(filed.row)
      continue
    }
    if (!id || warrant.state !== 'present' || warrant.form !== 'terminal') {
      out.refused.push({ id: id ?? 'unknown', reason: 'not-a-terminal-sale' })
      continue
    }
    // 2. The seal is K, the lock the mint enforces on the credential the warrant carries.
    const credential = parseCredentialSecret(warrant.credential)
    if (!credential) {
      out.refused.push({ id, reason: 'unreadable' })
      continue
    }
    if (credential.data.slice(2).toLowerCase() !== k) {
      out.refused.push({ id, reason: 'sealer-not-lock' })
      continue
    }
    // 3. Verified for THIS stall, the stall's own attestation of that till included.
    const row = toRow(id, content) as unknown as Record<string, unknown>
    const tx = toTransaction(row as unknown as TransactionRow)
    const verdict = verifyIssuanceWarrant(
      warrant,
      stall,
      { faceValueMinor: tx.amount, unit: tx.unit, faceDecimals: tx.decimals },
      options.trustedServiceKeys ? { trustedServiceKeys: options.trustedServiceKeys } : {},
    )
    if (verdict.verdict !== 'verified') {
      out.refused.push({ id, reason: verdict.verdict === 'unwarranted' ? 'warrant-unwarranted' : 'warrant-failed' })
      continue
    }
    // Attributed to the key that proved itself, never to what the row claims, and filed as
    // this stall's: a row naming another merchant would be checked against the wrong stall.
    out.rows.push({
      ...row,
      terminalPubkey: k,
      merchantId: stall,
      direction: 'out',
    } as unknown as TransactionRow)
  }
  return out
}

/**
 * A card sale the purchase issuer sent (imani-wallet#275, audit gap D).
 *
 * The issuer is not a till: it holds no credential the stall attested, so it proves itself the
 * way the till does when it redeems the coupon, with the stall's own signed delegation inside the
 * warrant (`issuerDelegation.ts`, the same checks gateway-customer#231 applies):
 *
 * 1. the delegation is a kind-30078 `imani:issuer-delegation` event whose NIP-01 id and sig verify,
 *    signed by THIS stall, scope `coupon:issue`, in force when the sale was made;
 * 2. the seal is the delegation's `p`, the key the stall delegated to (`sealer-not-delegate`);
 * 3. the delegate's signature over the sale and its processor reference verifies.
 *
 * Filed with no `terminalPubkey`: naming the issuer as a till would put it on the roster.
 */
function delegatedSaleRow(
  id: string,
  content: HistoryContent,
  warrant: Extract<IssuanceWarrant, { form: 'delegated' }>,
  sealer: string,
  stall: string,
): { row: TransactionRow } | { reason: SaleRefusal } {
  if (!warrant.reference) return { reason: 'not-a-card-sale' }
  const { terminal_pubkey: _ignored, ...rest } = content
  void _ignored
  const row = toRow(id, rest) as unknown as Record<string, unknown>
  const tx = toTransaction(row as unknown as TransactionRow)
  // Judged at the sale time, as the ledger judges it (#176 review): a lapsed delegation does not
  // un-authorise a past card sale. A row with no time is judged now. A row re-dated to its payment
  // is judged at its mint time (#648).
  const issuedAt = warrantIssuedAt(tx)
  const when = issuedAt !== undefined ? { issuedAt } : Date.now()
  const delegation = verifyIssuerDelegation(warrant.delegation, stall, when)
  if (!delegation.ok) return { reason: 'warrant-failed' }
  if (delegation.delegatePubkey.toLowerCase() !== sealer) return { reason: 'sealer-not-delegate' }
  const verdict = verifyIssuanceWarrant(
    warrant,
    stall,
    { faceValueMinor: tx.amount, unit: tx.unit, faceDecimals: tx.decimals },
    issuedAt !== undefined ? { issuedAt } : {},
  )
  if (verdict.verdict !== 'verified') return { reason: 'warrant-failed' }
  return { row: { ...row, merchantId: stall, direction: 'out' } as unknown as TransactionRow }
}

export interface CollectDeps {
  /** Gift wraps addressed to the stall since `since` (epoch seconds). */
  wraps(pubkey: string, since?: number): Promise<Event[]>
  /** Unwrap with the stall's key and verify the seal; null when it is not for the stall. */
  open(wrap: Event): { rumor: Rumor; sealer: string } | null
  has(id: string): Promise<boolean>
  write(row: TransactionRow): Promise<void>
  trustedServiceKeys?: readonly string[]
  now?: number
  /** Read the published roster again before alerting on an unknown till (default: the network). */
  refreshRoster?: RosterRefresh
}

function readCursor(stall: string): number | undefined {
  const raw = Number(localStorage.getItem(CURSOR_KEY(stall)))
  return Number.isFinite(raw) && raw > 0 ? raw : undefined
}

/**
 * File every verified till sale addressed to this stall that is not filed yet (owner side).
 *
 * Its own catch-up query rather than dm-poll's processed set (F8): an older owner build marks a
 * sale wrap processed as a non-token DM, so dm-poll alone would never offer it again.
 *
 * @returns how many rows were newly filed
 */
export async function collectTillSales(stallPubkey: string, deps: CollectDeps): Promise<number> {
  const stall = stallPubkey.toLowerCase()
  const cursor = readCursor(stall)
  const earliest = allTerminals(stall).reduce<number | undefined>(
    (min, t) => (t.enrolledAt > 0 && (min === undefined || t.enrolledAt < min) ? t.enrolledAt : min),
    undefined,
  )
  const since =
    cursor !== undefined
      ? cursor - WRAP_BLUR_SECONDS
      : earliest !== undefined ? Math.floor(earliest / 1000) - FIRST_RUN_SLACK_SECONDS : undefined

  const wraps = await deps.wraps(stall, since)
  let filed = 0
  let newest = cursor ?? 0
  const seen = new Set<string>()
  for (const wrap of wraps) {
    if (seen.has(wrap.id)) continue
    seen.add(wrap.id)
    newest = Math.max(newest, wrap.created_at)
    const opened = deps.open(wrap)
    if (!opened) continue
    const read = saleRowsFromRumor(opened.rumor, opened.sealer, stall, {
      ...(deps.trustedServiceKeys ? { trustedServiceKeys: deps.trustedServiceKeys } : {}),
    })
    if (!read) continue
    for (const refused of read.refused) {
      console.warn('[tillSales] sale record refused', refused)
    }
    for (const row of read.rows) {
      const id = String((row as unknown as { id: string }).id)
      if (await deps.has(id)) continue
      // Trigger (b) of the home-coming check (#160 phase 6, decision 5 Q2): a sale under a
      // credential the roster never had is filed (the customer paid) and marked on the row.
      const verdict = await raiseHomecomingAlert(stall, toTransaction(row).issuanceWarrant, id, deps.refreshRoster)
      await deps.write(verdict === 'unknown-till' ? ({ ...row, homecomingAlert: verdict } as unknown as TransactionRow) : row)
      filed += 1
      const tx = toTransaction(row)
      if (tx.terminalPubkey) noteTerminalUse(stall, tx.terminalPubkey, tx.at)
    }
  }
  if (newest > 0) {
    try {
      localStorage.setItem(CURSOR_KEY(stall), String(newest))
    } catch {
      // The next run reads from further back. Filing is idempotent.
    }
  }
  return filed
}
