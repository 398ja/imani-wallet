/**
 * Transaction types and interfaces
 */

/**
 * Transaction types (matching existing NIP-60 types)
 */
export enum TransactionType {
  RECEIVED = 'voucher_received',
  SENT = 'voucher_sent',
  PURCHASED = 'voucher_purchased',
  REDEEMED = 'voucher_redeemed',
  SPLIT = 'voucher_split',
  EXPIRED = 'voucher_expired',
}

/**
 * Transaction direction
 */
export enum TransactionDirection {
  IN = 'in',
  OUT = 'out',
  INTERNAL = 'internal',
}

/**
 * Bundle display state for multi-source-send aggregation (spec 012).
 *  - IN_FLIGHT: at least one part received; 90s wait window still open.
 *  - FINALIZED: all declared parts received OR received_amount === declared_total.
 *  - INCOMPLETE: wait window elapsed with at least one part missing.
 *  - FINALIZED_PARTIAL: all parts arrived BUT at least one part has
 *    `redemption_status === 'FAILED_PERMANENT'` (spec 015 Defense E-2).
 */
export type BundleState = 'IN_FLIGHT' | 'FINALIZED' | 'INCOMPLETE' | 'FINALIZED_PARTIAL';

/**
 * Sender-side delivery state on a sent transaction (spec 014, FR-011).
 *
 *  - 'pending'   — default after send; rendered with NO status badge in
 *                  the UI. Per FR-011, the green "S" sent/confirmed badge
 *                  is no longer rendered for sender rows under any state.
 *  - 'partial'   — bundles only; some but not all parts confirmed
 *                  (`deliveryConfirmedParts < bundlePartCount`). Rendered
 *                  as "k of N delivered".
 *  - 'confirmed' — full delivery confirmation received and applied;
 *                  rendered as the blue check.
 *
 * Pre-feature-014 records have `deliveryState === undefined`; the
 * renderer treats `undefined` identically to `'pending'`.
 */
export type DeliveryState = 'pending' | 'partial' | 'confirmed';

/**
 * Core transaction record stored in IndexedDB and synced to relays
 */
export interface Transaction {
  // Identity
  id: string; // Unique ID (event ID or UUID)
  eventId?: string; // Nostr event ID (if synced)

  // Type & Direction
  type: TransactionType; // received, sent, purchased, etc.
  direction: TransactionDirection; // in, out, internal

  // Value
  tokenAmount: number; // Backing token amount (sats)
  faceValue: number; // Face value in minor units
  faceUnit: string; // Currency code (EUR, USD, SAT)
  faceDecimals: number; // Decimal precision

  // Parties
  voucherId?: string; // Related voucher ID
  issuerId?: string; // Merchant/issuer pubkey
  issuerName?: string; // Merchant display name
  counterparty?: string; // Other party pubkey
  counterpartyName?: string; // Other party display name

  // Metadata
  memo?: string; // Transaction memo/message
  timestamp: number; // Unix timestamp (seconds)
  walletId?: string; // Parent wallet identifier
  mintUrl?: string; // Mint URL for the token

  // Sync Status
  synced: boolean; // Synced to relay
  syncedAt?: number; // Last sync timestamp

  // Bundle aggregation (spec 012-multi-voucher-send).
  // Set on records that represent a multi-source send/receive bundle.
  // The presence of bundleId is the discriminator: when set, this row
  // represents the WHOLE bundle, not one part. Per data-model.md upsert key
  // is (direction, bundleId).
  bundleId?: string;
  bundlePartIndex?: number;          // Set on transient per-part rows during ingestion only;
                                     // null on the finalized bundle row.
  bundlePartCount?: number;          // First-write-wins from the first-arriving part (FR-018a).
  bundleDeclaredTotal?: number;      // First-write-wins; minor units of faceUnit.
  bundleReceivedAmount?: number;     // Σ ingested-part amounts; updated idempotently.
  bundleState?: BundleState;         // Drives display: IN_FLIGHT / FINALIZED / INCOMPLETE.
  bundleFirstPartAt?: number;        // Unix seconds; clock anchor for the 90s wait window (R5).

  // Delivery confirmation (spec 014-payment-receipts).
  // Set on sender-side rows (direction OUT, type SENT) when a valid
  // PaymentReceipt envelope has been applied via TransactionStore.markDelivered
  // or applyBundlePartReceipt. undefined ≡ pre-014 record OR no confirmation
  // received yet — renderer treats both as "no badge" (FR-011).
  deliveryState?: DeliveryState;
  deliveredAt?: number;              // Unix seconds; first-time set when state→'confirmed' (FR-010 no downgrade).
  deliveryConfirmedParts?: number;   // Bundles only; count of distinct part-receipts received. ≤ bundlePartCount.

  // Metadata for extensibility
  metadata?: Record<string, unknown>;
}

/**
 * Input for creating a new transaction (without auto-generated fields)
 */
export interface TransactionInput {
  // Type & Direction
  type: TransactionType;
  direction: TransactionDirection;

  // Value
  tokenAmount: number;
  faceValue: number;
  faceUnit: string;
  faceDecimals?: number;

  // Parties (optional)
  voucherId?: string;
  issuerId?: string;
  issuerName?: string;
  counterparty?: string;
  counterpartyName?: string;

  // Metadata
  memo?: string;
  timestamp?: number; // Defaults to current time
  walletId?: string;
  mintUrl?: string;
  metadata?: Record<string, unknown>;

  // Bundle aggregation (spec 012). All optional; set on inputs that represent
  // a multi-source-send bundle row (sender side: one outgoing record per bundle;
  // receiver side: one incoming record per bundle, upserted by upsertBundleRecord).
  bundleId?: string;
  bundlePartIndex?: number;
  bundlePartCount?: number;
  bundleDeclaredTotal?: number;
  bundleReceivedAmount?: number;
  bundleState?: BundleState;
  bundleFirstPartAt?: number;

  // Delivery confirmation (spec 014). Almost always undefined at create
  // time; populated later via markDelivered / applyBundlePartReceipt.
  // Accepted on input only to support hydration from sync events that
  // already carry these fields.
  deliveryState?: DeliveryState;
  deliveredAt?: number;
  deliveryConfirmedParts?: number;
}

/**
 * Transaction update input (partial update)
 */
export interface TransactionUpdate {
  // Parties
  issuerName?: string;
  counterpartyName?: string;

  // Metadata
  memo?: string;
  walletId?: string;

  // Sync Status
  synced?: boolean;
  syncedAt?: number;
  eventId?: string;

  // Bundle aggregation (spec 012). Used by upsertBundleRecord to merge
  // per-part deltas into an existing bundle row.
  bundleReceivedAmount?: number;
  bundleState?: BundleState;
  bundlePartCount?: number;
  bundleDeclaredTotal?: number;

  // Delivery confirmation (spec 014). Mutated by markDelivered /
  // applyBundlePartReceipt only — direct callers should not set these.
  deliveryState?: DeliveryState;
  deliveredAt?: number;
  deliveryConfirmedParts?: number;

  // Extensibility
  metadata?: Record<string, unknown>;
}

/**
 * Get direction from transaction type
 */
export function getDirectionFromType(type: TransactionType): TransactionDirection {
  switch (type) {
    case TransactionType.RECEIVED:
    case TransactionType.PURCHASED:
    case TransactionType.REDEEMED:
      return TransactionDirection.IN;
    case TransactionType.SENT:
    case TransactionType.EXPIRED:
      return TransactionDirection.OUT;
    case TransactionType.SPLIT:
      return TransactionDirection.INTERNAL;
    default:
      return TransactionDirection.IN;
  }
}

/**
 * Generate a unique transaction ID
 */
export function generateTransactionId(): string {
  // Use crypto.randomUUID if available, otherwise fallback
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID
  return `tx_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
}

/**
 * Create a transaction from input
 */
export function createTransaction(input: TransactionInput): Transaction {
  return {
    id: generateTransactionId(),
    type: input.type,
    direction: input.direction,
    tokenAmount: input.tokenAmount,
    faceValue: input.faceValue,
    faceUnit: input.faceUnit,
    faceDecimals: input.faceDecimals ?? 0,
    voucherId: input.voucherId,
    issuerId: input.issuerId,
    issuerName: input.issuerName,
    counterparty: input.counterparty,
    counterpartyName: input.counterpartyName,
    memo: input.memo,
    timestamp: input.timestamp ?? Math.floor(Date.now() / 1000),
    walletId: input.walletId,
    mintUrl: input.mintUrl,
    synced: false,
    bundleId: input.bundleId,
    bundlePartIndex: input.bundlePartIndex,
    bundlePartCount: input.bundlePartCount,
    bundleDeclaredTotal: input.bundleDeclaredTotal,
    bundleReceivedAmount: input.bundleReceivedAmount,
    bundleState: input.bundleState,
    bundleFirstPartAt: input.bundleFirstPartAt,
    deliveryState: input.deliveryState,
    deliveredAt: input.deliveredAt,
    deliveryConfirmedParts: input.deliveryConfirmedParts,
    metadata: input.metadata,
  };
}
