/**
 * IndexedDB schema for @imani/wallet-storage.
 *
 * Defines two object stores — `wallet_vouchers` and `wallet_transactions` —
 * intended to be passed to `@imani/nostr-vouchers/createSharedDatabase` via
 * its `additionalStores` extension hook (per research §R1 + §R2). The
 * stores live alongside the existing `vouchers` + `sync_metadata` stores
 * in the `imani-wallet-{userId}` database, sharing the same IDB version
 * (currently 2 after T010's bump).
 *
 * The `StoreDefinition` shape matches what nostr-vouchers exposes
 * structurally; we redefine it locally so consumers don't need to import
 * from nostr-vouchers just for the type.
 *
 * See specs/024-vouchers-tx-idb-migration/data-model.md §1 + §2.
 */

/**
 * Store + index definition (mirrors `StoreDefinition` exported from
 * `@imani/nostr-vouchers/SharedDatabase.ts`). Kept duck-typed so the
 * array can be passed straight into `createSharedDatabase`'s
 * `additionalStores` config without an explicit cast.
 */
export interface StoreDefinition {
  name: string;
  keyPath: string;
  autoIncrement?: boolean;
  indexes?: Array<{
    name: string;
    keyPath: string | string[];
    unique?: boolean;
  }>;
}

/** Canonical store names. */
export const STORES = {
  VOUCHERS: 'wallet_vouchers',
  TRANSACTIONS: 'wallet_transactions',
} as const;

/**
 * Store definitions contributed by this package. Pass into
 * `createSharedDatabase({ additionalStores: WALLET_STORAGE_STORE_DEFINITIONS })`
 * at boot time so the shared `imani-wallet-{userId}` DB gains both
 * stores on first upgrade.
 */
export const WALLET_STORAGE_STORE_DEFINITIONS: StoreDefinition[] = [
  {
    name: STORES.VOUCHERS,
    keyPath: 'token_id',
    indexes: [
      // Lookup by merchant template id. Non-unique per spec 017 — different
      // cashu tokens can legitimately share the same voucher_id.
      { name: 'by-voucher-id', keyPath: 'voucher_id', unique: false },
      // Ordering for activity-list rendering + time-range queries.
      { name: 'by-created-at', keyPath: 'created_at', unique: false },
      // Filter active vs redeemed vs expired.
      { name: 'by-status', keyPath: 'status', unique: false },
    ],
  },
  {
    name: STORES.TRANSACTIONS,
    keyPath: 'id',
    indexes: [
      // Find-all-transactions-for-voucher.
      { name: 'by-voucher-id', keyPath: 'voucher_id', unique: false },
      // `in` vs `out` filter.
      { name: 'by-direction', keyPath: 'direction', unique: false },
      // Activity-list ordering.
      { name: 'by-timestamp', keyPath: 'timestamp', unique: false },
      // Spec 020 — sparse index for unconfirmed-sent badge rendering.
      // Only rows that explicitly set delivery_state populate this index.
      { name: 'by-delivery-state', keyPath: 'delivery_state', unique: false },
    ],
  },
];
