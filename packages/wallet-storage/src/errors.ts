/**
 * Errors thrown by @imani/wallet-storage.
 *
 * See specs/024-vouchers-tx-idb-migration/contracts/wallet-storage.contract.md §1.5.
 */

/**
 * Thrown when `saveVoucher` is called with a token that fails the
 * `looksLikeCashuToken` shape check. Same posture as
 * `shared/storage.js:3733`'s saveVoucher_backstop — defense-in-depth at
 * the substrate layer prevents corrupt bytes from ever reaching IDB.
 */
export class WalletStorageInvalidTokenError extends Error {
  readonly token_length: number;
  readonly token_prefix: string;
  readonly source: 'saveVoucher_backstop' | 'atomicallyWrite_backstop' | 'tokenId_compute_failed';

  constructor(
    message: string,
    details: {
      token_length: number;
      token_prefix: string;
      source: 'saveVoucher_backstop' | 'atomicallyWrite_backstop' | 'tokenId_compute_failed';
    }
  ) {
    super(message);
    this.name = 'WalletStorageInvalidTokenError';
    this.token_length = details.token_length;
    this.token_prefix = details.token_prefix;
    this.source = details.source;
  }
}

/**
 * Thrown when any `WalletStorage` operation is called before `init()`
 * has resolved. Surfaces a clear error instead of a cryptic "cannot
 * read property of undefined".
 */
export class WalletStorageNotInitializedError extends Error {
  constructor(operation: string) {
    super(
      `WalletStorage: ${operation}() called before init(). ` +
        `Call await walletStorage.init() during boot.`
    );
    this.name = 'WalletStorageNotInitializedError';
  }
}
