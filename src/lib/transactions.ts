import type { TransactionRow } from '@imani/wallet-storage'
import type { VoucherValidation } from './voucherToken'
import { displayDecimals } from './format'
import { asLockedGiftRecord, lockedGiftMemo, type LockedGiftRecord } from './lockedGiftRecord'
import { asCheckoutCodeSnapshot, type CheckoutCodeSnapshot } from './checkoutCodeHistory'
import { parseSpendSource, type SpendSource } from './spendSource'

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
   * Which terminal handled this movement — terminals ticket 09.
   *
   * On the STALL's own copy only. This row is decrypted from the merchant's
   * own encrypted history; the coupon the customer holds carries no such
   * field, because a customer should learn who honours their voucher and
   * nothing about how the stall is staffed.
   *
   * Absent means the stall's own device handled it. Not "unknown" — a blank
   * would make an owner learn that most rows being empty is normal, so
   * `describeHandler` reads the absence as "your device".
   */
  terminalPubkey?: string
  /** A gift link this `sent` row went to (claim links phase 4). */
  link?: GiftLinkRecord
  /**
   * What was actually checked about this coupon when it arrived.
   *
   * Absent on every row written before verification existed, and that absence
   * is meaningful: it means "not checked", never "checked and fine". The UI
   * must not render a missing record as a pass.
   */
  validation?: VoucherValidation
  /**
   * The warrant this stall signed when issuing, verbatim, on `issued` rows.
   *
   * The merchant's own copy of what they authorised. See
   * `imani-docs/wallet/cash-warrant-reconciliation.md` for why storing it turns "trust my
   * ledger" into "verify my ledger", and for the limit that remains: it proves
   * the stall meant to issue this value, never that cash arrived.
   */
  issuanceWarrant?: string
  /**
   * The voucher ids of every coupon minted from the same sale as this row.
   *
   * Present only on multi-coupon sales; a single-coupon sale needs no list.
   * See `buildIssueTransaction` for what it does and does not establish.
   */
  saleVoucherIds?: readonly string[]
  /**
   * Written only when a sale landed PARTLY (#462): the total the sale was for,
   * and how much of it reached the customer, both in minor units. Lets a
   * reconciliation say "partly delivered" from the row itself rather than
   * inferring it from missing siblings. Absent on every complete sale and on
   * every row written before #462.
   */
  saleTotalMinor?: number
  deliveredMinor?: number
  /**
   * The customer's signed assertion that they paid for this sale, if they gave
   * one. See `cashAttestation.ts`; always optional, and its absence is never a
   * fault.
   */
  cashAttestation?: string
  /**
   * The nullifier of the public attestation published for this redemption.
   *
   * Kept on the row because it cannot be recomputed: it hashes the RECEIVED
   * token, and redemption swaps that token at the mint. This is the handle a
   * merchant uses to match their own published attestations against their own
   * history — including on a device that has been wiped and restored.
   */
  attestationNullifier?: string
  /**
   * The id of the published attestation event, and when it was published.
   *
   * Present ONLY once a relay accepted the record. That is the whole point of
   * carrying it separately from `attestationNullifier`: the nullifier is
   * stamped on EVERY redemption, because it must be computed before the mint
   * swap destroys the token it hashes, so its presence says nothing about
   * whether anything was published. A row with a nullifier and no event id is
   * simply not attested — plain ecash, a customer's own row, or a publish that
   * no relay took. The UI must key on THIS field, never on the nullifier.
   */
  attestationEventId?: string
  /** Epoch milliseconds. The EVENT's `created_at`, not the redemption's date. */
  attestationAt?: number
  /**
   * A merchant claim's value BEFORE rounding, in face minor units (#90).
   *
   * `amount` is the whole-unit credit. The ledger needs the unrounded figure
   * to credit the next part of the same voucher by cumulative rounding (see
   * `cumulativeCredit` in `@imani/redemption`), which is what stops a voucher
   * split into many tiny parts from collecting half a unit on each.
   */
  exactValue?: number
  memo?: string
  /**
   * A minted-locked gift on a `gift_sent` / `gift_pending` row (#410 G14). When present, `memo`
   * is read from it, never from the stored text: the stored memo is a copy that a restore of an
   * older backup can leave behind.
   */
  lockedGift?: LockedGiftRecord
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
  /**
   * The gateway's id for a cashback code this merchant issued.
   *
   * Its presence is what makes a row a cashback rather than a sale, and it is
   * the handle `GET /portal/cashback/{id}/status` is asked with — the one way
   * a merchant can find out whether the customer ever typed the code in.
   */
  cashbackId?: string
  /** The code that was read out at the counter: `CB-XXXXX-XXXXX`, or `CB-XXXX-YY` if issued before gateway-portal 0.4.0. */
  claimCode?: string
  /**
   * Last redemption status read back from the gateway: `Unclaimed`, `Claimed`,
   * `Expired`, `Revoked`, `ManualAttention`.
   *
   * A CACHE, never the authority — the gateway is. Stored so an offline detail
   * screen can still say what was true last time, and absent on rows written
   * before the status was ever fetched, which reads as "not checked" rather
   * than as "unclaimed".
   */
  cashbackStatus?: string
  /** When the customer redeemed it, epoch milliseconds. */
  claimedAt?: number
  /**
   * sha256(transferred token)[:32]: the gateway's `sent_voucher_id` on a
   * `sent` row, and the received token's fingerprint on a `received` one. The
   * id a customer-to-customer transfer signature (#91) is keyed on.
   *
   * On a `sent` row it is all the sender needs: the signature's nonce is
   * derived from their own key and this id, so `signTransfer` rebuilds the
   * whole payload after a wipe. See ADR 0014.
   */
  transferId?: string
  /**
   * The sender's signed payload (#91), JSON, on the RECEIVER's `received`
   * row. The only lasting copy of the nonce that finds, opens and discloses
   * the kind-7378 receipt this wallet published. Never shown; kept for audit.
   */
  transferSignature?: string
  /** A checkout code's snapshot on its `checkout_code` row (#402). See `checkoutCodeHistory.ts`. */
  checkoutCode?: CheckoutCodeSnapshot
  /** #402 traceability: where an online shop spent this incoming coupon. See `spendSource.ts`. */
  spendSource?: SpendSource
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

function lockedOf(r: Record<string, unknown>): LockedGiftRecord | undefined {
  return asLockedGiftRecord(r.lockedGift)
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
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
    direction:
      type === 'payment' || type === 'issued' || type === 'sent' || type === 'cashback' || type === 'gift_sent' || type === 'checkout_code'
        ? 'out'
        : 'in',
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
    attestationNullifier: str(r.attestationNullifier),
    attestationEventId: str(r.attestationEventId),
    // Through the same magnitude-discriminating normaliser as `timestamp`: the
    // receipt is written in milliseconds, but a row that has been round-tripped
    // through a relay record could carry seconds, and dating a receipt to 1970
    // reads as data loss.
    attestationAt: r.attestationAt === undefined ? undefined : toEpochMs(r.attestationAt),
    exactValue:
      typeof r.exactValue === 'number' && Number.isFinite(r.exactValue) ? r.exactValue : undefined,
    memo: lockedOf(r) ? lockedGiftMemo(lockedOf(r)!) : str(r.memo),
    ...(lockedOf(r) ? { lockedGift: lockedOf(r) } : {}),
    recipientName: str(r.recipientName),
    bundleId: str(r.bundleId) ?? str(r.bundle_id),
    paymentId: str(r.paymentId) ?? str(r.requestId) ?? str(r.request_id),
    // Through the same normaliser as `timestamp`: it is written in seconds (the
    // gateway's unit) and read back for display in milliseconds.
    expiresAt: r.expiresAt === undefined ? undefined : toEpochMs(r.expiresAt),
    cashbackId: str(r.cashbackId),
    claimCode: str(r.claimCode),
    // Issuance evidence, read from EITHER spelling: camelCase as this wallet
    // writes it locally, snake_case as the relay copy carries it. A reader
    // that knew only one would restore a history with the evidence silently
    // missing, which reads as "never authorised" rather than as "not
    // recovered".
    issuanceWarrant: str(r.issuanceWarrant) ?? str(r.issuance_warrant),
    cashAttestation: str(r.cashAttestation) ?? str(r.cash_attestation),
    saleTotalMinor: finiteNumber(r.saleTotalMinor) ?? finiteNumber(r.sale_total_minor),
    deliveredMinor: finiteNumber(r.deliveredMinor) ?? finiteNumber(r.delivered_minor),
    saleVoucherIds: Array.isArray(r.saleVoucherIds)
      ? (r.saleVoucherIds as string[]).filter((id): id is string => typeof id === 'string')
      : Array.isArray(r.sale_voucher_ids)
        ? (r.sale_voucher_ids as string[]).filter((id): id is string => typeof id === 'string')
        : undefined,
    cashbackStatus: str(r.cashbackStatus),
    // Same magnitude-discriminating normaliser as `timestamp`: the gateway
    // reports an ISO instant, this row stores milliseconds, and a relay
    // round-trip could turn either into seconds.
    claimedAt: r.claimedAt === undefined || r.claimedAt === null ? undefined : toEpochMs(r.claimedAt),
    // Either spelling, as for the issuance evidence above.
    transferId: str(r.transferId) ?? str(r.transfer_id),
    transferSignature: str(r.transferSignature) ?? str(r.transfer_signature),
    // Which till handled it (terminals ticket 09). Read back since #160 phase 6: it was written
    // on the stall's rows and never read, so even a local row lost its till on the way to a
    // screen. Either spelling, as for the evidence above.
    terminalPubkey: str(r.terminalPubkey) ?? str(r.terminal_pubkey),
    link: asGiftLinkRecord(r.link),
    ...(asCheckoutCodeSnapshot(r.checkoutCode) ? { checkoutCode: asCheckoutCodeSnapshot(r.checkoutCode) } : {}),
    ...(parseSpendSource(r.spendSource ?? r.spend_source) ? { spendSource: parseSpendSource(r.spendSource ?? r.spend_source) } : {}),
  }
}

/** Where a gift link stands (spec 4.2 step 6). */
export type GiftLinkStatus = 'outstanding' | 'claimed' | 'reclaimed' | 'expired'

/**
 * The gift link a `sent` row went to (claim links phase 4, spec 3.3).
 *
 * `k` is the link SECRET. It is a bearer secret on the sender's own device, the same class of thing
 * as the coupon it replaced (spec 3.3 allows it), so the sender can show the link again and take it
 * back. It is never logged and never leaves this device except inside the sender's own
 * NIP-44-encrypted history record. `i` is the derivation index, absent for a random secret (an
 * account whose key this wallet cannot read).
 */
export interface GiftLinkRecord {
  k: string
  i?: number
  /** The link's expiry, unix seconds. */
  x: number
  status: GiftLinkStatus
  /** When it was claimed or taken back, ms. */
  closedAt?: number
  /**
   * When the "Your Cashlink expired" bell entry was filed for it, ms (#295 phase 4). On the record,
   * not only on this device, so a restored or second device does not tell the sender twice.
   */
  noticedAt?: number
  /**
   * Whether the link comes back on its own (#295 phase 4). Absent on links made before it existed
   * and on links that were never armed: those come back the old way, when this wallet next runs.
   */
  arm?: GiftLinkArm
  /**
   * #379: when this wallet confirmed a `claimed` link really was claimed by someone else (the mint
   * says its gift is spent, and not into this wallet's own outputs), ms. A `claimed` record without
   * it was written by an older build, which could read its own burn as a claim, and is checked again.
   */
  verifiedAt?: number
}

/**
 * A Cashlink's return state (#295 phase 4).
 *
 * - `arming`: the gift is being locked to its link; a run that finds this finishes the job.
 * - `armed`: locked, and the take-back is signed and waiting at the voucher service. It comes back
 *   at its expiry without this wallet running.
 * - `not_armed`: nothing waits at the voucher service (it was off, refused, or unreachable). The
 *   gift may still be locked; this wallet takes it back itself when it next runs.
 * - `returning`: it has left the link and is on its way back as a voucher; the next run finishes it.
 *
 * `ks` is the keyset the take-back's outputs were made in (while `arming`, the burn's). Not shown.
 * The refund key itself is never stored: it is derived from this wallet's key and the link's index,
 * which is why only a link with an index (an account whose key this wallet can read) is armed.
 */
export interface GiftLinkArm {
  s: 'arming' | 'armed' | 'not_armed' | 'returning'
  ks?: string
}

const ARM_STATES: readonly GiftLinkArm['s'][] = ['arming', 'armed', 'not_armed', 'returning']

/** A NUT-02 keyset id: v1 (`00` + 14 hex) or v2 (`01` + 64 hex). */
const KEYSET_ID = /^(?:[0-9a-f]{16}|[0-9a-f]{66})$/i

function asArm(value: unknown): GiftLinkArm | undefined {
  if (!value || typeof value !== 'object') return undefined
  const { s, ks } = value as Record<string, unknown>
  if (typeof s !== 'string' || !ARM_STATES.includes(s as GiftLinkArm['s'])) return undefined
  return {
    s: s as GiftLinkArm['s'],
    // #379: a v1 keyset id (16 hex) or a v2 one (66 hex, as staging's mint has). Dropping a v2 id
    // made every resumed arm read as a fresh one, whose pre-check found our own burnt gift SPENT
    // and closed the link as "claimed".
    ...(typeof ks === 'string' && KEYSET_ID.test(ks) ? { ks } : {}),
  }
}

/** The words for a link's status in History (spec 4.2 step 6). */
export function giftStatusLabel(link: Pick<GiftLinkRecord, 'status' | 'x' | 'arm'>, nowMs = Date.now()): string {
  if (link.status === 'claimed') return 'Claimed'
  // "Taken back" means the mint swap is confirmed and the voucher is back in this wallet. Only
  // `reclaimed` says that: it is written after the swap and the re-form, never before.
  if (link.status === 'reclaimed') return 'Taken back'
  // #295 phase 4: the take-back has STARTED. `returning` is written by `onReturning`, before the
  // swap is sent to the mint, so the value may still be on the link (#396: Q4 showed "Taken back"
  // with every proof UNSPENT). Say it is coming back, never that it is back.
  if (link.status === 'outstanding' && link.arm?.s === 'returning') return 'Coming back'
  if (link.status === 'expired' || nowMs / 1000 >= link.x) return 'Expired'
  return 'Waiting to be claimed'
}

const LINK_STATUSES: readonly GiftLinkStatus[] = ['outstanding', 'claimed', 'reclaimed', 'expired']

/** A stored link record, or undefined for anything malformed (never trusted as-is). */
export function asGiftLinkRecord(value: unknown): GiftLinkRecord | undefined {
  if (!value || typeof value !== 'object') return undefined
  const { k, i, x, status, closedAt, noticedAt, arm, verifiedAt } = value as Record<string, unknown>
  if (typeof k !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(k)) return undefined
  if (typeof x !== 'number' || !Number.isFinite(x)) return undefined
  if (typeof status !== 'string' || !LINK_STATUSES.includes(status as GiftLinkStatus)) return undefined
  const parsedArm = asArm(arm)
  return {
    k,
    x,
    status: status as GiftLinkStatus,
    ...(typeof i === 'number' && Number.isSafeInteger(i) && i >= 0 ? { i } : {}),
    ...(typeof closedAt === 'number' && Number.isFinite(closedAt) ? { closedAt } : {}),
    ...(typeof noticedAt === 'number' && Number.isFinite(noticedAt) ? { noticedAt } : {}),
    ...(parsedArm ? { arm: parsedArm } : {}),
    ...(typeof verifiedAt === 'number' && Number.isFinite(verifiedAt) ? { verifiedAt } : {}),
  }
}

/**
 * #379: a Cashlink an older build closed as "claimed" while it was being locked (an `arm` on any of
 * its rows, the claim never confirmed). Its gift may still be locked to the link, unspent, and only
 * this wallet's return key can bring it back after the expiry. The next run checks it again; until
 * then logout stays off. By link key, over every row of each link.
 */
export function unconfirmedClaimLinks(links: ReadonlyArray<Pick<GiftLinkRecord, 'k' | 'status' | 'arm' | 'verifiedAt'>>): Set<string> {
  const armed = new Set(links.filter((l) => l.arm !== undefined).map((l) => l.k))
  return new Set(links.filter((l) => armed.has(l.k) && isUnverifiedClaim(l)).map((l) => l.k))
}

/** A `claimed` record the mint was never asked about (see `verifiedAt`). */
export function isUnverifiedClaim(link: Pick<GiftLinkRecord, 'status' | 'verifiedAt'>): boolean {
  return link.status === 'claimed' && link.verifiedAt === undefined
}

/**
 * #379, logout's check: the links whose value only this wallet can still bring back, from the stored
 * `sent` rows. An unconfirmed "claimed" (above), one being locked or on its way back, and one locked
 * to its link with nothing at the voucher service to return it (`not_armed`) once it has expired.
 * Never throws on a bad row.
 */
export function strandedCashlinks(rows: readonly unknown[], nowMs = Date.now()): number {
  const links: GiftLinkRecord[] = []
  for (const row of rows) {
    const r = row as Record<string, unknown> | null
    if (!r || r.type !== 'sent') continue
    const link = asGiftLinkRecord(r.link)
    if (link) links.push(link)
  }
  const stranded = unconfirmedClaimLinks(links)
  for (const l of links) {
    if (l.status !== 'outstanding' || !l.arm) continue
    if (l.arm.s === 'arming' || l.arm.s === 'returning' || (l.arm.s === 'not_armed' && nowMs / 1000 >= l.x)) stranded.add(l.k)
  }
  return stranded.size
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
  /**
   * Which terminal handled this, if it was not the stall's own device.
   *
   * Terminals ticket 09. On the STALL's row only — this record is encrypted to
   * the merchant's own key, while the coupon travels to the customer, and a
   * customer should learn who honours their voucher and nothing about how the
   * stall is staffed.
   */
  terminalPubkey?: string
  /**
   * The warrant this stall signed for the sale, verbatim.
   *
   * Kept so a merchant can verify their OWN history rather than only trust it.
   * Without it the signed bytes exist nowhere after the request: the nonce in
   * particular is generated per sale and never seen again, so a row and the
   * warrant that authorised it share no identifier at all.
   *
   * That is the difference between reconciliation as arithmetic over a ledger
   * you believe because it is yours, and reconciliation as a check anyone can
   * repeat. It matters the moment the question turns adversarial — a terminal
   * operator disputing what they issued, or an owner auditing a device they
   * did not watch.
   *
   * On the STALL's row only, like `terminalPubkey`, and for the same reason:
   * this record is encrypted to the merchant's own key while the coupon
   * travels to the customer.
   */
  issuanceWarrant?: string
  /**
   * Every voucher id minted from this SALE, including this row's own.
   *
   * One sale can become several coupons — a requested quantity, each
   * auto-splitting again when a coupon would be too large to receive — and the
   * device cannot predict how many. Each part gets its own row, and each row
   * carries the whole set, so a merchant holding any ONE coupon can find the
   * sale it came from and the siblings issued beside it.
   *
   * That is the question actually asked at a till: a customer presents a
   * coupon, and the merchant wants to know which sale produced it and whether
   * the rest of that sale is accounted for.
   *
   * **The limit, stated because it is easy to over-read.** This links coupons
   * to sales using THIS DEVICE's record of what the server returned. A
   * compromised issuing service that minted extra coupons against a real
   * warrant would not appear here, because it would never have told the
   * wallet. It makes the honest case auditable; it does not make the dishonest
   * one impossible.
   */
  saleVoucherIds?: readonly string[]
  /**
   * The stall this sale was issued for.
   *
   * Recorded so a later attestation can be checked against the stall it claims
   * to have paid. Taking that from the attestation itself would compare a
   * value to itself and accept anything.
   */
  merchantId?: string
  /**
   * The customer's own signature that they PAID for this sale, if collected.
   *
   * Optional by design and must stay so — see `cashAttestation.ts`. Its absence
   * is the ordinary case, never a fault, and nothing may refuse a sale for
   * lacking one.
   *
   * What it adds is the claim a warrant cannot make. A warrant says the stall
   * authorised issuing this value; on cash, nothing else says money arrived,
   * because there is no third party to ask.
   */
  cashAttestation?: string
  /** See `WalletTransaction.saleTotalMinor`. Pass both only for a partly delivered sale. */
  saleTotalMinor?: number
  deliveredMinor?: number
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
    // Written only when there IS one, so an owner's row carries no empty field
    // and `describeHandler` reads its absence as "the stall".
    ...(input.terminalPubkey ? { terminalPubkey: input.terminalPubkey } : {}),
    // Written only when there is one. Absent means this sale was issued
    // unwarranted, which is a real state and not the same as a stored empty
    // string — the reader distinguishes absent from a signed `none`.
    ...(input.issuanceWarrant ? { issuanceWarrant: input.issuanceWarrant } : {}),
    // Only when the sale produced more than this row, so a single-coupon sale
    // carries no list repeating its own id back at itself.
    ...(input.saleVoucherIds && input.saleVoucherIds.length > 1
      ? { saleVoucherIds: [...input.saleVoucherIds] }
      : {}),
    ...(input.merchantId ? { merchantId: input.merchantId } : {}),
    ...(input.cashAttestation ? { cashAttestation: input.cashAttestation } : {}),
    ...(input.saleTotalMinor !== undefined &&
    input.deliveredMinor !== undefined &&
    input.deliveredMinor !== input.saleTotalMinor
      ? { saleTotalMinor: input.saleTotalMinor, deliveredMinor: input.deliveredMinor }
      : {}),
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
  /**
   * The gateway's `sent_voucher_id`, when it returned one. Kept so the
   * sender's transfer signature (#91) can be rebuilt; see `transferId` above.
   */
  transferId?: string
  /** Set on a send to a gift link (claim links phase 4); see `GiftLinkRecord`. */
  link?: GiftLinkRecord
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
    ...(input.transferId ? { transferId: input.transferId } : {}),
    ...(input.link ? { link: input.link } : {}),
    memo: input.memo || 'Voucher sent',
  } as unknown as TransactionRow
}

/**
 * The row for a cashback code the merchant read out at the counter.
 *
 * A sale with no customer in it. `buildIssueTransaction` cannot serve: it keys
 * on a voucher id and files a `counterparty`, and a cashback has neither — the
 * whole point of the flow is reaching someone who has no wallet yet and so no
 * key to name. Its own type rather than `'issued'` for the same reason: the
 * Issued vouchers list is about coupons a named customer holds, and a code on a
 * paper receipt is not one of those.
 *
 * Written for the same reason every other merchant row is — nothing else holds
 * it. `GET /portal/cashback` would list these, but a merchant offline at a
 * stall cannot reach it, and their own history should not go blank when the
 * network does.
 *
 * Keyed on the cashback id, so a retry overwrites rather than duplicating, and
 * so the status write-back can find the row again by id alone.
 */
export function buildCashbackTransaction(input: {
  cashbackId: string
  claimCode: string
  /**
   * The voucher the code unlocks, from the portal's generate response. What
   * puts the cashback on the Vouchers list and links it to its detail screen.
   */
  voucherId?: string
  amount: number
  unit: string
  decimals: number
  memo?: string
  /** Epoch SECONDS, as the gateway reports it. */
  expiresAt?: number
  at: number
  /**
   * The warrant this stall signed for the sale, verbatim.
   *
   * Cashback is the one rail the receipt-time attestation cannot reach: there
   * is no recipient to send a receipt back, because the whole point of the
   * flow is reaching someone who has no wallet yet. So the merchant's own
   * signature is the ONLY evidence this sale can ever carry, which makes it
   * more important here than on the Sell path rather than less.
   */
  issuanceWarrant?: string
  /** The stall this was issued for, so an audit has something to check against. */
  merchantId?: string
  /** The till that issued it, when it was not the stall's own device (#160 phase 6). */
  terminalPubkey?: string
}): TransactionRow {
  return {
    id: `cashback:${input.cashbackId}`,
    txId: `cashback:${input.cashbackId}`,
    type: 'cashback',
    direction: 'out',
    timestamp: input.at,
    amount: input.amount,
    unit: input.unit,
    decimals: input.decimals,
    cashbackId: input.cashbackId,
    claimCode: input.claimCode,
    ...(input.voucherId ? { voucherId: input.voucherId } : {}),
    memo: input.memo || 'Cashlink issued',
    expiresAt: input.expiresAt,
    // Deliberately no status. The gateway has just minted it, so `Unclaimed` is
    // what it would say — but writing that here would make an unfetched row
    // indistinguishable from a checked one, and the detail screen must be able
    // to tell "not checked" from "not claimed".
    ...(input.issuanceWarrant ? { issuanceWarrant: input.issuanceWarrant } : {}),
    ...(input.merchantId ? { merchantId: input.merchantId } : {}),
    ...(input.terminalPubkey ? { terminalPubkey: input.terminalPubkey } : {}),
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
  // A gift link's counterparty is the link key, which names nobody: the Link section says who it is.
  if (tx.link && !ownStall) return undefined
  const who = ownStall || tx.type === 'sent' ? tx.counterparty : (tx.merchantId ?? tx.counterparty)
  if (!who) return undefined
  // Only one kind of person is ever across the counter from your own stall.
  return { pubkey: who, label: ownStall ? 'Customer' : tx.direction === 'in' ? 'From' : 'To' }
}

/**
 * A row that put a voucher into the world: a Sell coupon or a cashback code.
 *
 * The ONE test for "this stall issued that voucher" (#144). Every reader that
 * matches redemptions to issuance goes through it: the claimed figure, the
 * redemption ceiling, the row repair and the claim sweep. When only `issued`
 * counted, a cashback's redemptions were filed against nothing, so its
 * ceiling under-counted split parts and a till could take more than its face.
 */
export function isVoucherIssuance(row: Pick<WalletTransaction, 'type'>): boolean {
  return row.type === 'issued' || row.type === 'cashback'
}

/** Human label for the row type. */
export function transactionLabel(tx: WalletTransaction): string {
  if (tx.type === 'payment') return 'Paid'
  if (tx.type === 'sent') return 'Sent'
  if (tx.type === 'cashback') return 'Cashlink'
  // #410 G14: a gift minted locked. Neither row is balance: the memo says where it stands.
  if (tx.type === 'gift_sent') return 'Gift sent'
  if (tx.type === 'gift_pending') return 'Gift'
  if (tx.type === 'checkout_code') return 'Checkout code'
  if (tx.type === 'checkout_change') return 'Change'
  return tx.type === 'issued' ? 'Issued' : 'Received'
}
