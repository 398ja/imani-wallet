/**
 * Public types for @imani/wallet-storage.
 *
 * Shapes mirror what shared/storage.js already writes to
 * localStorage.imani_vouchers and localStorage.imani_transactions today.
 * Forward-compatible — unknown fields pass through unchanged.
 *
 * See specs/024-vouchers-tx-idb-migration/data-model.md §1 + §2 + §3.
 */

/**
 * A voucher row stored in the `wallet_vouchers` IDB object store.
 *
 * Primary key: `token_id` (spec 017 content-derived fingerprint).
 * Secondary indexes: `by-voucher-id` (non-unique), `by-created-at`,
 * `by-status`.
 */
export interface VoucherRow {
  /** Primary key — spec 017 content-derived (sha256(token).substring(0, 32)). */
  token_id: string;
  /** Merchant template id (not unique across rows — different cashu tokens can share). */
  voucher_id?: string;
  /** The cashu V4 token string. Required for save (the backstop rejects malformed tokens). */
  token: string;
  /** Token amount in mint units (sats for sat-denominated mints; smallest unit for fiat-pegged). */
  amount: number;
  face_value?: number;
  face_unit?: string;
  face_decimals?: number;
  token_amount?: number;
  backing_strategy?: string;
  issuer_id?: string;
  merchant_template_id?: string;
  bundle_id?: string;
  /** Lifecycle status — `active` / `redeemed` / `expired` etc. Default `active` at save time. */
  status?: string;
  /** Unix epoch seconds. */
  expires_at?: number;
  /** ISO-8601 — set on first save. */
  created_at: string;
  /** ISO-8601 — set on every save. */
  updated_at: string;
  // ---------- Spec 038 FR-020 — receive provenance fields ----------
  // All four are optional / nullable to preserve backward compatibility
  // with pre-spec-038 rows. NO destructive migration; existing rows load
  // unchanged. See specs/038-unified-receive-pipeline/data-model.md.
  /**
   * FR-020. The kind-1059 gift-wrap event id this voucher was received
   * from. Populated by the unified pipeline on every receive; left null
   * for vouchers received via paths that don't carry an event id (manual
   * paste, URL receive, cashback, mint operation).
   */
  received_via_event_id?: string;
  /**
   * FR-020. ISO-8601 of the moment `api.receive` returned success and
   * the swap output proofs landed in this row. Absence on a non-zero
   * face-value voucher is the marker of a pre-spec-038 legacy-receive
   * row (FR-008's detection heuristic + Phase 6 recovery affordance
   * read this).
   */
  swap_completed_at?: string;
  /**
   * FR-020. Keyset ids of the proofs freshly issued by the swap (from
   * the `api.receive` response). Public identifiers — NOT proof
   * secrets (FR-022 forbids carrying secret material in provenance).
   * Used by the FR-008 detection heuristic.
   */
  swap_proof_ids?: string[];
  /**
   * FR-020. Which code path produced this voucher. Phase 7
   * observability + the FR-021 backfill writes `manual` for legacy
   * rows that have `swap_completed_at` set but no `source_transport`.
   *
   * Spec 041 (SA-006) extends the union with two client-mint values:
   * `'client_mint'` marks rows materialized by the browser via the
   * spec-041 orchestrator (no gateway-side proof custody — see spec
   * 041 FR-003 / FR-004); `'gateway_mint'` is the explicit legacy
   * label so downstream consumers can distinguish "this came from
   * the old custodial path" from "this is a receive" without having
   * to infer it from absence.
   */
  source_transport?: 'sse' | 'catchup' | 'manual' | 'cashback' | 'escrow_recovery' | 'client_mint' | 'gateway_mint';
  // ---------- Spec 041 SA-006 — client-mint provenance fields ----------
  // All optional (TS-level `?`) so receive-side and gateway-mint rows
  // stay unchanged — absence ≡ "not a client-mint row" and downstream
  // readers branch on that. Populated by the browser orchestrator when
  // `source_transport === 'client_mint'`. These fields are NOT typed
  // to accept `null` because we never persist `null` for them — a row
  // either has provenance (client-mint path) or omits it entirely.
  /**
   * Spec 041 SA-006. The atomic-purchase `purchase_id` this voucher
   * was materialized for. Lets the wallet UI look up the matching
   * voucher row from a saga SSE callback via
   * `walletStorage.getVoucherByPurchaseId(...)` (plan.md M1) without
   * a primary-key lookup or a separate index.
   */
  purchase_id?: string;
  /**
   * Spec 041 SA-006. ISO-8601 of the moment the browser's orchestrator
   * finished unblinding + IDB write. Distinct from `created_at`
   * (which is the row's first-save timestamp) and `swap_completed_at`
   * (which is the spec-038 receive marker — never set on client-mint
   * rows).
   */
  materialized_at?: string;
  /**
   * Spec 041 SA-006 / FR-011 step 6. Sum of proof amounts in this
   * voucher's token, in sats. The orchestrator validates this equals
   * the quoted `amount_sats` before writing; the server's
   * `clientMaterialized` endpoint validates the same equality on the
   * confirmation POST. Carrying it on the row lets the UI / reconciler
   * cross-check without re-decoding the cashu V4 token.
   */
  proof_sum?: number;
  /**
   * Spec 041 SA-006. Distinct keyset ids referenced by the proofs in
   * this voucher's token. Spec 041's keyset selection is single-keyset
   * (highest-id active sat keyset per NUT-02), so this is typically a
   * one-element array, but the type accepts multiple to forward-
   * compatibility for future mixed-keyset materializations. Public
   * identifiers — NOT secret material (FR-022 unchanged).
   */
  keyset_ids?: string[];
  /** Forward-compatible — unknown fields persist unchanged. */
  [extra: string]: unknown;
}

/**
 * A transaction row stored in the `wallet_transactions` IDB object store.
 *
 * Primary key: `id` (caller-supplied — typically UUID or composite like `send:<voucherId>:<ts>`).
 * Secondary indexes: `by-voucher-id`, `by-direction`, `by-timestamp`, `by-delivery-state`.
 */
export interface TransactionRow {
  /** Primary key — caller-supplied. */
  id: string;
  voucher_id?: string;
  /** `send` / `receive` / `cashback` / `bundle-receive` / etc. — LocalTransactionStore taxonomy. */
  type: string;
  direction: 'in' | 'out';
  /** Unix epoch seconds (epoch ms for spec-020 receipt-delivery rows). */
  timestamp: number;
  amount?: number;
  face_value?: number;
  face_unit?: string;
  counterparty?: string;
  memo?: string;
  /** Spec 020 — `unconfirmed` / `confirmed`. Sparse index. */
  delivery_state?: 'unconfirmed' | 'confirmed';
  /** Spec 020 — epoch seconds. */
  delivered_at?: number;
  /** Spec 012 — bundle correlation. */
  bundle_id?: string;
  /** Spec 016 — per-part breakdown. */
  bundle_parts?: Array<{
    voucherId: string;
    amount: number;
    timestamp: number;
    redemptionStatus: string;
  }>;
  /** Spec 016 — ISO-8601 of the most recent part received. */
  bundle_most_recent_part_at?: string;
  [extra: string]: unknown;
}

/**
 * Cross-tab change event posted on the existing `walletSnapshotSync`
 * BroadcastChannel. Pure invalidation signal — NO row payload.
 *
 * Per Clarifications Q3 (lazy mark-stale): receivers set their shadow
 * cache stale on receipt and re-read on the next access. IDB stays the
 * single source of truth.
 */
export interface WalletStorageEvent {
  type: 'vouchers:changed' | 'transactions:changed';
  /** Tab UUID — generated once per WalletStorage instance. Used to filter self-events. */
  source: string;
  /** Epoch ms of the originating write. */
  ts: number;
}

/**
 * Constructor config for WalletStorage.
 */
export interface WalletStorageConfig {
  /**
   * Pre-opened IDB database (typically from `createSharedDatabase` in
   * `@imani/nostr-vouchers`). When provided, the package attaches to
   * this connection instead of opening its own.
   */
  db?: IDBDatabase;
  /** User id for the user-scoped DB name. Required when `db` is omitted. */
  userId?: string;
  /**
   * Optional BroadcastChannel. If omitted, the package creates one on the
   * channel named by `channelName` (or the default, which is the existing
   * `walletSnapshotSync` channel name).
   */
  broadcastChannel?: BroadcastChannel;
  /** Override the channel name. Defaults to the existing walletSnapshotSync channel. */
  channelName?: string;
  /** Inject a custom now() for tests. */
  now?: () => number;
}
