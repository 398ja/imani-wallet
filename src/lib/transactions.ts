import type { TransactionRow } from '@imani/wallet-storage'
import type { VoucherValidation } from './voucherToken'
import { displayDecimals } from './format'

/**
 * A transaction, in the shape the screens actually need.
 *
 * `TransactionRow`'s declared fields are snake_case, but nothing writes them.
 * Every row in this wallet comes from imani-apps' `_buildReceiveTransactionRow`
 * (shared/tokenRedemption.js), which emits camelCase — `merchantId`, `tokenId`,
 * `voucherId`, `merchantName`, `unit`, `decimals`. Those reach TypeScript only
 * through the row's `[extra: string]: unknown` index signature, so every read
 * needs a cast. Doing that cast at each call site is how `transactionsWith`
 * came to filter on `issuer_id` and match nothing (§11.6): the field names
 * looked right against the type and were wrong against the writer.
 *
 * One conversion, one place to correct when the writer changes.
 */
export interface WalletTransaction {
  id: string
  /** 'received' | 'payment' — the writer's vocabulary, not TransactionRow's. */
  type: string
  /** Derived from `type`; see below. */
  direction: 'in' | 'out'
  /** Normalised to epoch milliseconds. */
  at: number
  amount: number
  unit: string
  decimals: number
  merchantId?: string
  merchantName?: string
  counterparty?: string
  /**
   * Display name of whoever a `'sent'` row went to. Stored at send time rather
   * than resolved on read: `counterparty` is a bare pubkey, and the kind-0 that
   * names it may be unreachable by the time the history is opened.
   */
  recipientName?: string
  voucherId?: string
  tokenId?: string
  /**
   * What was actually checked about this coupon when it arrived.
   *
   * Absent on every row written before verification existed, and that absence
   * is meaningful: it means "not checked", never "checked and fine". The UI
   * must not render a missing record as a pass.
   */
  validation?: VoucherValidation
  memo?: string
  bundleId?: string
  /**
   * The NUT-18V payment request this settles, when it settles one.
   *
   * On the wire as `request_id` in the gateway's `cashu_token_transfer` DM —
   * `TokenTransferMessage` has carried it for as long as bundles have, and
   * `matchPayment`'s comment about it never arriving described this wallet
   * dropping it at the parser rather than the gateway omitting it. With it, a
   * merchant's request settles by id instead of by guessing from the amount.
   */
  paymentId?: string
  /**
   * When an ISSUED coupon expires, epoch milliseconds. Only set on rows this
   * merchant wrote at issuance — a received coupon's expiry lives on the voucher
   * itself, not on the transaction that delivered it.
   */
  expiresAt?: number
}

/**
 * Epoch milliseconds, whatever the writer used.
 *
 * `TransactionRow` documents `timestamp` as epoch SECONDS, with an exception for
 * spec-020 rows in milliseconds; `_buildReceiveTransactionRow` in fact writes
 * `Date.now()`, so the common row is milliseconds. Rather than trust either,
 * discriminate by magnitude: 1e11 seconds is the year 5138 and 1e11 ms is 1973,
 * so anything below the threshold is seconds and needs scaling. Getting this
 * wrong dates every coupon to January 1970, which reads as a data-loss bug.
 */
function toEpochMs(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e11 ? value * 1000 : value
  }
  const parsed = Date.parse(String(value ?? ''))
  return Number.isNaN(parsed) ? 0 : parsed
}

function isValidation(value: unknown): value is VoucherValidation {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as VoucherValidation).signatureValid === 'boolean'
  )
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function toTransaction(row: TransactionRow): WalletTransaction {
  const r = row as unknown as Record<string, unknown>
  const type = String(r.type ?? 'received')

  return {
    id: String(r.id ?? r.txId ?? ''),
    type,
    // DERIVED, never read from the row. `_buildReceiveTransactionRow` hardcodes
    // `direction: 'in'` for every row it builds, including payments — trusting
    // it puts an incoming arrow on money leaving the wallet.
    // 'issued' joins 'payment' on the outgoing side: a merchant handing a
    // customer a coupon is value leaving this wallet, exactly as paying a
    // merchant is. 'sent' is the customer's own version of the same thing —
    // a voucher passed to someone else. Anything else is incoming.
    direction: type === 'payment' || type === 'issued' || type === 'sent' ? 'out' : 'in',
    at: toEpochMs(r.timestamp ?? r.created_at),
    amount: Number(r.amount ?? 0),
    unit: String(r.unit ?? r.face_unit ?? 'UNKNOWN'),
    // The unit decides, and only then the row. A history row written before
    // DEV-238 carries decimals: 2 for XAF, so the old default rendered every
    // pre-fix FCFA transaction 100x too small — the balance moved correctly,
    // the statement lied about it. Display only; `amount` is untouched.
    decimals: displayDecimals(
      String(r.unit ?? r.face_unit ?? ''),
      typeof r.decimals === 'number'
        ? r.decimals
        : typeof r.face_decimals === 'number'
          ? r.face_decimals
          : 2,
    ),
    merchantId: str(r.merchantId) ?? str(r.merchant_id) ?? str(r.issuer_id),
    merchantName: str(r.merchantName),
    counterparty: str(r.counterparty),
    voucherId: str(r.voucherId) ?? str(r.voucher_id),
    tokenId: str(r.tokenId) ?? str(r.token_id),
    // Only ever read, never defaulted: a row without it was written before the
    // wallet verified anything, and inventing a record would turn "unknown"
    // into "fine" — the one thing this must never do.
    validation: isValidation(r.validation) ? r.validation : undefined,
    memo: str(r.memo),
    recipientName: str(r.recipientName),
    bundleId: str(r.bundleId) ?? str(r.bundle_id),
    paymentId: str(r.paymentId) ?? str(r.requestId) ?? str(r.request_id),
    // Through the same normaliser as `timestamp`: it is written in seconds (the
    // gateway's unit) and read back for display in milliseconds.
    expiresAt: r.expiresAt === undefined ? undefined : toEpochMs(r.expiresAt),
  }
}

/**
 * The row to store when this wallet pays a merchant.
 *
 * Written in the SAME camelCase shape as imani-apps'
 * `_buildReceiveTransactionRow`, deliberately — `toTransaction` is the only
 * reader, and a second spelling here would mean it has two shapes to support
 * and one of them silently returning undefined, which is the exact bug class
 * that emptied the transactions list before.
 *
 * `direction` is stored as 'out' even though `toTransaction` derives it. The
 * legacy writer stores a flatly wrong 'in' on payments; there is no reason to
 * copy that just because readers work around it.
 *
 * The id follows the writer's `${type}:${tokenId}` convention, keyed on the
 * SPENT coupon's token_id — one payment per coupon, so re-recording the same
 * spend overwrites rather than duplicates.
 */
export function buildPaymentTransaction(input: {
  tokenId: string
  amount: number
  unit: string
  decimals: number
  merchantId: string
  merchantName?: string
  voucherId?: string
  memo?: string
  /** Set when this row is one part of a multi-voucher payment — see below. */
  bundleId?: string
  at: number
}): TransactionRow {
  return {
    id: `payment:${input.tokenId}`,
    txId: `payment:${input.tokenId}`,
    type: 'payment',
    direction: 'out',
    timestamp: input.at,
    amount: input.amount,
    unit: input.unit,
    decimals: input.decimals,
    merchantId: input.merchantId,
    merchantName: input.merchantName ?? null,
    counterparty: input.merchantId,
    voucherId: input.voucherId,
    tokenId: input.tokenId,
    bundleId: input.bundleId,
    memo: input.memo || 'Payment to merchant',
  } as unknown as TransactionRow
}

/**
 * A row for the merchant side: a coupon issued and delivered to a customer.
 *
 * The merchant's own record, held client-side, because nothing else holds it.
 * gateway-portal's `GET /portal/vouchers` looks like the obvious source and is
 * not: `PortalDashboardService.allMerchantVouchers` merges only kind-30078
 * `possa:payment-requests` events and the `cashback_record` table, and its own
 * comment says customer-wallet "is intentionally NOT consulted" because
 * `WalletPort#listVouchers` is a deliberate `UnsupportedOperationException`.
 * Coupons issued through `POST /portal/vouchers` — the Sell flow — appear in
 * neither, which is why that endpoint answers `{"items":[]}` right after a
 * successful sale.
 *
 * Constitution Principle II points the same way: voucher state is client-held
 * and the backend must not persist it. The merchant is a client.
 *
 * Keyed on the voucher id rather than a token id: this row is written before
 * the merchant ever sees the coupon again, and `voucher_id` is what issuance
 * returns. One row per issued coupon, so a retry overwrites rather than
 * duplicating.
 *
 * NOT saved as a voucher. `listVouchers()` feeds `walletTotals`, so a coupon the
 * merchant has given away would be counted as one they still hold — money on
 * screen that does not exist.
 */
export function buildIssueTransaction(input: {
  voucherId: string
  amount: number
  unit: string
  decimals: number
  /** The customer who received it. */
  recipientPubkey: string
  memo?: string
  /** Epoch SECONDS, as the gateway reports it. Undefined when it never settled. */
  expiresAt?: number
  at: number
}): TransactionRow {
  return {
    id: `issued:${input.voucherId}`,
    txId: `issued:${input.voucherId}`,
    type: 'issued',
    direction: 'out',
    timestamp: input.at,
    amount: input.amount,
    unit: input.unit,
    decimals: input.decimals,
    counterparty: input.recipientPubkey,
    voucherId: input.voucherId,
    memo: input.memo || 'Voucher issued',
    expiresAt: input.expiresAt,
  } as unknown as TransactionRow
}

/**
 * The row to store when this wallet sends a voucher to another person.
 *
 * The field split is the whole point of this builder, and getting it backwards
 * is what makes the home screen wrong:
 *
 *  - `merchantId` is the **issuer** of the voucher being spent, NOT the person
 *    receiving it. `withPastMerchants` (lib/merchants.ts) turns any transaction
 *    counterparty that is not a currently-held merchant into a merchant card on
 *    the customer's home deck — so recording a friend's pubkey there would put
 *    that friend on the deck as a merchant, with a merchant page of their own.
 *    Keying on the issuer also files the send in the right place: spending
 *    Merchant A's vouchers IS Merchant A activity, and `transactionsWith` reads
 *    `merchantId ?? counterparty`, so the row lands on their history.
 *  - `counterparty` is the recipient, which is what the row is *about*, and
 *    `recipientName` names them — see `otherParty`, which special-cases this type.
 *
 * Id follows the writer's `${type}:${tokenId}` convention, keyed on the SPENT
 * voucher's token_id: one send per voucher, so re-recording overwrites rather
 * than duplicating.
 */
export function buildSentTransaction(input: {
  tokenId: string
  amount: number
  unit: string
  decimals: number
  /** Issuer of the voucher spent — see above, this is not the recipient. */
  merchantId: string
  merchantName?: string
  recipientPubkey: string
  recipientName?: string
  voucherId?: string
  memo?: string
  /**
   * Set when this row is one part of a multi-voucher send. Several rows share
   * it, which is what lets the history present them as one send of the total
   * instead of three unexplained ones — and it is the same id the recipient's
   * wallet reads off the DM's `Bundle-Id:` line.
   */
  bundleId?: string
  at: number
}): TransactionRow {
  return {
    id: `sent:${input.tokenId}`,
    txId: `sent:${input.tokenId}`,
    type: 'sent',
    direction: 'out',
    timestamp: input.at,
    amount: input.amount,
    unit: input.unit,
    decimals: input.decimals,
    merchantId: input.merchantId,
    merchantName: input.merchantName ?? null,
    counterparty: input.recipientPubkey,
    recipientName: input.recipientName ?? null,
    voucherId: input.voucherId,
    tokenId: input.tokenId,
    bundleId: input.bundleId,
    memo: input.memo || 'Voucher sent',
  } as unknown as TransactionRow
}

/**
 * Who is on the other side of this movement, and what to call them.
 *
 * `counterparty` is that person by construction — the sender of an arriving
 * coupon, the recipient of a leaving one. `merchantId` is NOT, and the two only
 * look interchangeable from a customer's wallet, where the stall is both.
 *
 * Two rows break that. On a merchant's own till `merchantId` is the merchant,
 * so reading the other party off it put the stall's own name on every
 * redemption it took and left the customer folded away in the raw details. And
 * on a `'sent'` row `merchantId` is the issuer of the coupon being SPENT, which
 * would name a merchant on a row about handing money to a friend.
 *
 * `pubkey` is the signed-in wallet. Without it no row can be my own stall,
 * which is the customer reading — the safe thing to be wrong about.
 */
export function otherParty(
  tx: WalletTransaction,
  pubkey?: string,
): { pubkey: string; label: string } | undefined {
  const ownStall = pubkey !== undefined && tx.merchantId === pubkey
  const who = ownStall || tx.type === 'sent' ? tx.counterparty : (tx.merchantId ?? tx.counterparty)
  if (!who) return undefined
  // Only one kind of person is ever across the counter from your own stall.
  return { pubkey: who, label: ownStall ? 'Customer' : tx.direction === 'in' ? 'From' : 'To' }
}

/** Human label for the row type. */
export function transactionLabel(tx: WalletTransaction): string {
  if (tx.type === 'payment') return 'Paid'
  if (tx.type === 'sent') return 'Sent'
  return tx.type === 'issued' ? 'Issued' : 'Received'
}
