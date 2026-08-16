import type { EventTemplate, Event } from 'nostr-tools'
import { NIP60_HISTORY_KIND, type Nip60HistoryContent } from '@imani/nostr-transactions'
import type { TransactionRow } from '@imani/wallet-storage'

import { getSigner } from './nap'
import { allAddressable, publish } from './relay'
import { addRestoredTransaction, getWallet, notifyWalletChanged } from './wallet'
import { toTransaction, type WalletTransaction } from './transactions'

/**
 * The wallet's ledger, backed by the key instead of the browser.
 *
 * `issuedRecords.ts` did this for one row type — a merchant's sales — and left
 * the other side of the counter on the floor. A redemption exists only as a row
 * written by imani-apps' `tokenRedemption.js`, and logout deletes the device
 * (`logout.ts` → `wipeWallet`), so a merchant who logged out came back to an
 * empty history: the relay had never been told, the gateway holds no ledger
 * (`JdbcWalletPort.listTransactions` is a deliberate empty stub), and re-reading
 * the gift wraps cannot rebuild it because those tokens are already spent at the
 * mint. The same hole swallowed the customer's payments.
 *
 * So every transaction row is also published as a NIP-60 history event
 * (kind 7376), `d` = the row's own id, NIP-44 sealed to the writer's OWN key.
 * The relay stores an opaque blob; only the key that made the transactions can
 * read them back. Hold the nsec, recover the books.
 *
 * Kind 7376 is a REGULAR kind, not addressable — relays keep every copy rather
 * than replacing by `d`. That is fine: `d` is identity here, not replacement,
 * and the read side takes the newest per `d` (`allAddressable` already does
 * exactly that), while `backfillTx` publishes only ids the relay lacks.
 *
 * What is deliberately NOT in here, as in `issuedRecords.ts`: the Cashu token.
 * That is bearer value, and writing it to a relay — even encrypted — would put
 * spendable money somewhere it does not need to be. A wiped device still loses
 * its unspent coupons; it no longer loses the record of what it did. These
 * records are a ledger, not a wallet.
 */

/**
 * The event content: NIP-60's shape, plus three fields it has no slot for.
 *
 * The extras are ours and live inside the encrypted payload, so no other reader
 * is affected by them. Dropping them instead would restore coupons with no
 * expiry, receive rows with no token id (and therefore no way back to the same
 * row key), and bundles that no longer know they were bundles.
 */
type HistoryContent = Nip60HistoryContent & {
  /** Epoch SECONDS, as the gateway reports it. */
  expires_at?: number
  /** The content-derived coupon key, for rows that have one. */
  token_id?: string
  /** Spec 012 bundle correlation. */
  bundle_id?: string
}

/** Exported for tests: the unit and amount conversions are the easy things to get wrong. */
export function toContent(tx: WalletTransaction): HistoryContent {
  return {
    type: tx.type,
    direction: tx.direction,
    // NIP-60's `amount` is the BACKING token amount in sats. This wallet never
    // stores that — the number the user sees, and the only one the rows carry,
    // is the face value. It goes in `face_value` where it belongs, and `toRow`
    // reads it back from there. Putting it in `amount` too would make the two
    // indistinguishable on a device that had never seen the original.
    amount: 0,
    face_value: tx.amount,
    face_unit: tx.unit,
    face_decimals: tx.decimals,
    voucher_id: tx.voucherId,
    counterparty: tx.counterparty,
    counterparty_name: tx.merchantName,
    issuer_id: tx.merchantId,
    memo: tx.memo,
    // Seconds on the wire, as everywhere else in this app. `toTransaction`
    // normalises back to ms on the way in.
    timestamp: Math.floor(tx.at / 1000),
    expires_at: tx.expiresAt === undefined ? undefined : Math.floor(tx.expiresAt / 1000),
    token_id: tx.tokenId,
    bundle_id: tx.bundleId,
  }
}

/**
 * Rebuild a stored row from a record.
 *
 * Emits the camelCase shape the WRITERS use — `_buildReceiveTransactionRow`,
 * `buildPaymentTransaction`, `buildIssueTransaction` — because `toTransaction`
 * is the only reader and a second spelling would mean it has two shapes to
 * support, with one of them silently returning undefined. That is the bug class
 * that emptied the transactions list before.
 */
export function toRow(id: string, content: HistoryContent): TransactionRow {
  return {
    id,
    txId: id,
    type: content.type,
    direction: content.direction === 'out' ? 'out' : 'in',
    // Milliseconds, as every writer stores it.
    timestamp: (content.timestamp ?? 0) * 1000,
    // face_value FIRST. `amount` in a NIP-60 record is sats; the row's `amount`
    // is the face value. Reading `amount` here restores the wrong money, and it
    // looks perfectly plausible on screen.
    amount: content.face_value ?? content.amount,
    unit: content.face_unit,
    decimals: content.face_decimals,
    merchantId: content.issuer_id,
    merchantName: content.counterparty_name ?? null,
    counterparty: content.counterparty,
    voucherId: content.voucher_id,
    tokenId: content.token_id,
    memo: content.memo,
    expiresAt: content.expires_at,
    bundleId: content.bundle_id,
  } as unknown as TransactionRow
}

/** The event for one row. Encrypted to self; throws if the wallet is locked. */
export function buildTxEvent(tx: WalletTransaction): EventTemplate | null {
  if (!tx.id) return null

  const signer = getSigner()
  return {
    kind: NIP60_HISTORY_KIND,
    created_at: Math.floor(Date.now() / 1000),
    // `type` and `direction` are duplicated as tags, as imani-apps' EventBuilder
    // does, so a future reader can filter without decrypting every record.
    tags: [
      ['d', tx.id],
      ['type', tx.type],
      ['direction', tx.direction],
    ],
    content: signer.nip44Encrypt(signer.pubkey, JSON.stringify(toContent(tx))),
  }
}

/**
 * Publish one row.
 *
 * Never throws. A relay that will not take the record has not undone the
 * transaction — the money has already moved and the row is already in
 * IndexedDB — so this is reported and not fatal, exactly as the kind-0 publish
 * is during registration. The cost of failure is one row missing until the next
 * login, when `backfillTx` publishes it.
 */
export async function publishTx(row: TransactionRow): Promise<void> {
  try {
    const template = buildTxEvent(toTransaction(row))
    if (!template) return
    await publish(await getSigner().signEvent(template))
  } catch (error) {
    console.error('[txRecords] transaction not backed up to the relay', error)
  }
}

/** Decrypt one event back into a record. Returns null for anything unreadable. */
function parseTx(event: Event): { id: string; content: HistoryContent } | null {
  try {
    const id = event.tags.find(([name]) => name === 'd')?.[1]
    if (!id) return null
    const signer = getSigner()
    const content = JSON.parse(signer.nip44Decrypt(signer.pubkey, event.content)) as HistoryContent
    return typeof content?.type === 'string' ? { id, content } : null
  } catch {
    // Written by another key, or by a future version that changed the shape.
    // One unreadable record must not abort the restore of all the others.
    return null
  }
}

/**
 * Rebuild the history from the relay into this device's wallet.
 *
 * Runs on every login, not only on an empty wallet: a transaction made on
 * another device should show up here too, and rows are keyed on their own id
 * (`received:<tokenId>`, `payment:<tokenId>`, `issued:<voucherId>`), so
 * re-writing a row this device already has is an overwrite, not a duplicate.
 *
 * Writes through `addRestoredTransaction`, which bypasses the publish hook —
 * otherwise every login would republish everything it just read.
 *
 * Never throws — an unreachable relay leaves whatever the device already had,
 * the same contract `refreshProfile` and `refreshMerchant` follow. Returns how
 * many rows were written, for the caller to log.
 */
export async function restoreTx(pubkey: string): Promise<number> {
  try {
    // Empty prefix: kind 7376 is ours alone, so every `d` under it is a row id.
    // `allAddressable` keeps the newest event per `d`, which is the dedupe this
    // non-replaceable kind needs.
    const events = await allAddressable(pubkey, NIP60_HISTORY_KIND, '')
    if (events.length === 0) return 0

    let restored = 0
    for (const event of events) {
      const record = parseTx(event)
      if (!record) continue
      await addRestoredTransaction(toRow(record.id, record.content))
      restored += 1
    }

    if (restored > 0) notifyWalletChanged()
    return restored
  } catch (error) {
    console.error('[txRecords] could not restore history from the relay', error)
    return 0
  }
}

/**
 * Back-fill records for transactions made before this existed, while a relay was
 * down, or whose publish lost the race with a closing tab. Publishes only what
 * the relay is missing.
 *
 * Cheap to call on login — one query — and it is what makes the fire-and-forget
 * publish on the write path acceptable.
 */
export async function backfillTx(pubkey: string): Promise<number> {
  try {
    const events = await allAddressable(pubkey, NIP60_HISTORY_KIND, '')
    const known = new Set(
      events
        .map((e) => e.tags.find(([name]) => name === 'd')?.[1])
        .filter((d): d is string => Boolean(d)),
    )

    const missing = (await getWallet().getAllTransactions()).filter(
      (row) => row.id && !known.has(row.id),
    )

    for (const row of missing) await publishTx(row)
    return missing.length
  } catch (error) {
    console.error('[txRecords] could not back-fill history to the relay', error)
    return 0
  }
}
