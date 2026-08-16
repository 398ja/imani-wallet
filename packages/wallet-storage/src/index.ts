/**
 * @imani/wallet-storage — IDB-backed wallet voucher + transaction store.
 *
 * Public API:
 * - `WalletStorage` — the async store class (Phase 2 stub; real impl in Phase 3).
 * - `WALLET_STORAGE_STORE_DEFINITIONS` — IDB store + index definitions to pass
 *   into `@imani/nostr-vouchers/createSharedDatabase`'s `additionalStores`.
 * - `STORES` — canonical store-name constants.
 * - Errors: `WalletStorageInvalidTokenError`, `WalletStorageNotInitializedError`.
 * - Types: `VoucherRow`, `TransactionRow`, `WalletStorageEvent`, `WalletStorageConfig`.
 *
 * See specs/024-vouchers-tx-idb-migration/ for the design.
 */

export { WalletStorage } from './WalletStorage';
export {
  WALLET_STORAGE_STORE_DEFINITIONS,
  STORES,
  type StoreDefinition,
} from './schema';
export {
  WalletStorageInvalidTokenError,
  WalletStorageNotInitializedError,
} from './errors';
export type {
  VoucherRow,
  TransactionRow,
  WalletStorageEvent,
  WalletStorageConfig,
} from './types';
