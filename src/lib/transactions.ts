import type { TransactionRow } from '@imani/wallet-storage'

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
  voucherId?: string
  tokenId?: string
  memo?: string
  bundleId?: string
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
    // merchant is. Anything else is incoming.
    direction: type === 'payment' || type === 'issued' ? 'out' : 'in',
    at: toEpochMs(r.timestamp ?? r.created_at),
    amount: Number(r.amount ?? 0),
    unit: String(r.unit ?? r.face_unit ?? 'UNKNOWN'),
    decimals: Number(r.decimals ?? r.face_decimals ?? 2),
    merchantId: str(r.merchantId) ?? str(r.merchant_id) ?? str(r.issuer_id),
    merchantName: str(r.merchantName),
    counterparty: str(r.counterparty),
    voucherId: str(r.voucherId) ?? str(r.voucher_id),
    tokenId: str(r.tokenId) ?? str(r.token_id),
    memo: str(r.memo),
    bundleId: str(r.bundleId) ?? str(r.bundle_id),
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

/** Who the transaction was with, best available: name, else pubkey, else ''. */
export function counterpartyOf(tx: WalletTransaction): string {
  return tx.merchantName ?? tx.merchantId ?? tx.counterparty ?? ''
}

/** Human label for the row type. */
export function transactionLabel(tx: WalletTransaction): string {
  if (tx.type === 'payment') return 'Paid'
  return tx.type === 'issued' ? 'Issued' : 'Received'
}
