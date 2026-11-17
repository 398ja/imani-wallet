import type { EventTemplate, Event } from 'nostr-tools'
import { NIP60_HISTORY_KIND, type Nip60HistoryContent } from '@imani/nostr-transactions'
import type { TransactionRow } from '@imani/wallet-storage'

import { getSigner } from './nap'
import { allAddressable, publish } from './relay'
import { addRestoredTransaction, getWallet, notifyWalletChanged } from './wallet'
import { asGiftLinkRecord, toTransaction, type WalletTransaction } from './transactions'
import { asLockedGiftRecord, laterLockedGift, lockedGiftMemo } from './lockedGiftRecord'

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
 * The event content: NIP-60's shape, plus a few fields it has no slot for.
 *
 * The extras are ours and live inside the encrypted payload, so no other reader
 * is affected by them. Dropping them instead would restore coupons with no
 * expiry, receive rows with no token id (and therefore no way back to the same
 * row key), and bundles that no longer know they were bundles.
 */
export type HistoryContent = Nip60HistoryContent & {
  /** Epoch SECONDS, as the gateway reports it. */
  expires_at?: number
  /** The content-derived coupon key, for rows that have one. */
  token_id?: string
  /** Spec 012 bundle correlation. */
  bundle_id?: string
  /**
   * The two facts a cashback row cannot be rebuilt without.
   *
   * Neither is recoverable from anywhere else once the device is wiped: the
   * claim code was read out loud onto a paper receipt, and the id is the only
   * handle `GET /portal/cashback/{id}/status` answers to. Without them a
   * restored row says "Cashback −500 XAF" and nothing else, which is exactly
   * the blank history this file exists to prevent.
   *
   * The redemption status is deliberately NOT carried: it is a cache of
   * something the gateway will answer again as soon as the id is back.
   */
  cashback_id?: string
  claim_code?: string
  /**
   * The issuance evidence, on the stall's own `issued` rows.
   *
   * Carried for exactly the reason `cashback_id` is: none of it is recoverable
   * from anywhere else once the device is wiped. The warrant's nonce is
   * generated per sale and never seen again, the sibling ids exist only in what
   * the portal returned at the moment of sale, and a customer's attestation was
   * signed once at a counter.
   *
   * **Dropping these was a real defect, not a hypothetical one.** `toContent`
   * is a fixed whitelist, so the fields were written to IndexedDB and silently
   * absent from the relay copy — the copy that survives a wiped device, which
   * is precisely the situation in which someone wants to audit a stall's
   * history. A merchant restoring their records would have found every row
   * reading `unwarranted`, indistinguishable from a stall that had issued
   * without authorisation all along.
   */
  issuance_warrant?: string
  sale_voucher_ids?: readonly string[]
  cash_attestation?: string
  /** See `WalletTransaction.saleTotalMinor` (#462). Only on a partly delivered sale. */
  sale_total_minor?: number
  delivered_minor?: number
  /** See `WalletTransaction.exactValue`. Restored so the ceiling survives a wipe. */
  exact_value?: number
  /**
   * The customer-to-customer transfer signature evidence (#91). `transfer_id`
   * on both sides, `transfer_signature` (the sender's payload) on the
   * receiver's side only. Carried for the reason the issuance evidence is: the
   * nonce inside it exists nowhere else once the device is wiped, and without
   * it the receipt this wallet published can be neither found nor opened.
   */
  transfer_id?: string
  transfer_signature?: string
  /**
   * The till that handled this row, on the stall's own `issued` and `cashback` rows only
   * (terminals ticket 09). Carried since #160 phase 6 (F2): without it a restored stall read
   * every till sale as "Your device", the same defect class as the issuance evidence above.
   */
  terminal_pubkey?: string
  /** A Cashlink take-back's `sent` row id (`WalletTransaction.returnOf`). */
  return_of?: string
  /**
   * A gift link on a `sent` row (claim links phase 4): its secret, index, expiry and status, so a
   * restored or second device can show it again, watch it and take it back. Inside the sender's
   * own NIP-44-encrypted record, like everything else here.
   */
  gift_link?: unknown
  /**
   * A minted-locked gift's record (#410 G14) on its `gift_sent` / `gift_pending` row: the locked
   * token, `x` and where it stands, so a restored device still shows it, sweeps it and never
   * reopens one already settled. The token is useless without the matching key, and the record is
   * inside the owner's own NIP-44 encryption like everything else here.
   */
  locked_gift?: unknown
  /** A checkout code's status snapshot on its `checkout_code` row (#402). Nothing secret. */
  checkout_code?: unknown
  spend_source?: unknown
  /**
   * What the wallet checked about a received coupon (the issuer signature and
   * the warrant verdict), on `received` rows.
   *
   * Carried because it was NOT, and that read as a regression to the owner:
   * a restored history showed every coupon "Not checked" (2026-10-18). The
   * check was made once, at receive, against the PRE-swap token, which no
   * longer exists anywhere after the swap, so it cannot be re-derived from the
   * restored row. The record is the only copy. Inside the owner's own
   * NIP-44-sealed payload, like everything else here.
   */
  validation?: unknown
  /**
   * Filler that brings the plaintext to a size bucket (#99), so a record's
   * length does not say what it carries. Ignored on read: `toRow` never looks
   * at it, and a record written before it existed simply has none.
   */
  pad?: string
}

/**
 * The plaintext sizes a 7376 is padded up to, in UTF-8 bytes (#99).
 *
 * NIP-44 v2 already pads, but to powers of two above 256 bytes, and that is
 * exactly what leaks: measured on a typical `received` row, the JSON is about
 * 450 bytes without the sender's transfer signature and about 1380 with it,
 * which NIP-44 turns into 772 and 2140 characters of ciphertext. Anyone
 * reading the relay could tell which rows carry a signature. Every row seen
 * in measurement (received, payment, issued, cashback) is 150 to 1400 bytes,
 * with issuance evidence and a long memo reaching past 2 KB.
 *
 * So every record is padded to the first bucket that fits, a `received` row
 * sized as if it carried a signature (`TRANSFER_SIGNATURE_RESERVE`), so its
 * bucket never depends on whether it does. 2048 covers every ordinary row
 * with or without a transfer signature (2048 bytes becomes 2820
 * characters of ciphertext, far inside the relay's 64 KB event limit), and
 * the larger buckets only hold rows with unusual evidence or long memos, which
 * are rare and, thanks to the reserve, carry no transfer-signature signal
 * either. 32768 bytes becomes about 43.8 KB of ciphertext, still inside the
 * relay's 64 KB limit; a row past it (a memo of about 31 KB) is left
 * unpadded, and its length then says what it carries. Past the
 * last bucket a record is left as is. NIP-44's own padding then lands on the
 * same length for every record in a bucket.
 */
export const TX_PAD_BUCKETS = [2048, 4096, 8192, 16384, 32768] as const

/**
 * Bytes a `received` row's bucket is chosen as if its transfer signature were
 * present, whether or not it is (#98/#99 review L1).
 *
 * Choosing the bucket from the row's actual size leaked the signature for a
 * band of rows: one about 1100 to 2039 bytes without it (in practice a sender
 * memo of 650 bytes or more, and the memo is the sender's to choose) fitted
 * 2048 without the signature and needed 4096 with it. Reserving the most the
 * field can take puts both in the same bucket for every memo length. The
 * payload is fixed-width hex apart from `amount` (at most a 16-digit safe
 * integer), `unit` (at most 5 letters) and `decimals` (one digit), and is
 * stored as an escaped JSON string: its largest serialisation, field name
 * included, is under 1000 bytes (asserted in txRecordsPadding.test.ts), so
 * 1100 leaves room for a later payload version to grow a little.
 */
export const TRANSFER_SIGNATURE_RESERVE = 1100

/** `content` as JSON, padded to the first bucket it fits. Exported for tests. */
export function paddedJson(content: HistoryContent): string {
  const plain = JSON.stringify(content)
  const size = utf8Length(plain)
  // `,"pad":""` adds 9 bytes before any filler. The filler is ASCII, so one
  // character is one byte.
  const overhead = 9
  // A received row is bucketed as if it carried the signature: see
  // TRANSFER_SIGNATURE_RESERVE. Never less than its real size, so a payload
  // larger than the reserve still fits the bucket it is padded to.
  const sizing =
    content.type === 'received'
      ? Math.max(size, utf8Length(JSON.stringify({ ...content, transfer_signature: undefined })) + TRANSFER_SIGNATURE_RESERVE)
      : size
  const target = TX_PAD_BUCKETS.find((b) => b >= sizing + overhead)
  if (target === undefined) return plain
  return JSON.stringify({ ...content, pad: '0'.repeat(target - size - overhead) })
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length
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
    cashback_id: tx.cashbackId,
    claim_code: tx.claimCode,
    issuance_warrant: tx.issuanceWarrant,
    sale_voucher_ids: tx.saleVoucherIds,
    cash_attestation: tx.cashAttestation,
    sale_total_minor: tx.saleTotalMinor,
    delivered_minor: tx.deliveredMinor,
    exact_value: tx.exactValue,
    transfer_id: tx.transferId,
    transfer_signature: tx.transferSignature,
    terminal_pubkey: tx.terminalPubkey,
    ...(tx.returnOf ? { return_of: tx.returnOf } : {}),
    ...(tx.link ? { gift_link: tx.link } : {}),
    ...(tx.lockedGift ? { locked_gift: tx.lockedGift } : {}),
    ...(tx.checkoutCode ? { checkout_code: tx.checkoutCode } : {}),
    ...(tx.spendSource ? { spend_source: tx.spendSource } : {}),
    ...(tx.validation ? { validation: tx.validation } : {}),
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
    cashbackId: content.cashback_id,
    claimCode: content.claim_code,
    // Restored so a recovered history can still be audited. Absent on every
    // row written before this shipped, which reads as "not checked" rather
    // than as a failure - see validationStatus.
    issuanceWarrant: content.issuance_warrant,
    saleVoucherIds: content.sale_voucher_ids,
    cashAttestation: content.cash_attestation,
    saleTotalMinor: content.sale_total_minor,
    deliveredMinor: content.delivered_minor,
    exactValue: content.exact_value,
    transferId: content.transfer_id,
    transferSignature: content.transfer_signature,
    ...(content.terminal_pubkey ? { terminalPubkey: content.terminal_pubkey } : {}),
    ...(typeof content.return_of === 'string' && content.return_of ? { returnOf: content.return_of } : {}),
    ...(asGiftLinkRecord(content.gift_link) ? { link: asGiftLinkRecord(content.gift_link) } : {}),
    ...(asLockedGiftRecord(content.locked_gift) ? { lockedGift: asLockedGiftRecord(content.locked_gift) } : {}),
    ...(content.checkout_code ? { checkoutCode: content.checkout_code } : {}),
    ...(content.spend_source ? { spendSource: content.spend_source } : {}),
    // Read back through `toTransaction`'s own `isValidation` guard, so a
    // garbled value reads as "Not checked", never as a pass.
    ...(content.validation ? { validation: content.validation } : {}),
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
    // Padded, so the length does not say which rows carry a transfer
    // signature or anything else: see TX_PAD_BUCKETS.
    content: signer.nip44Encrypt(signer.pubkey, paddedJson(toContent(tx))),
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
    const result = await publish(await getSigner().signEvent(template))
    // `publish` never throws; a relay's `OK false` comes back as ok 0 with its
    // reason. Ignoring the result is how #203's coupon backups failed in silence.
    if (result.ok === 0) {
      throw new Error(`relay refused the record: ${result.errors.join('; ') || 'no reason given'}`)
    }
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
      const row = toRow(record.id, record.content) as unknown as Record<string, unknown>
      if (row.lockedGift) {
        // Never reopen a settled gift from an older copy (see `laterLockedGift`).
        const local = (await getWallet().getTransaction(record.id)) as unknown as Record<string, unknown> | null
        const kept = laterLockedGift(asLockedGiftRecord(local?.lockedGift), asLockedGiftRecord(row.lockedGift))
        if (kept) {
          row.lockedGift = kept
          row.memo = lockedGiftMemo(kept)
        }
      }
      await addRestoredTransaction(row as unknown as TransactionRow)
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
