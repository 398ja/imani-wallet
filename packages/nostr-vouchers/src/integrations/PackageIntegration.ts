/**
 * Package Integration
 *
 * Wires together @imani/nostr-vouchers, @imani/auto-redemption, and @imani/nostr-transactions
 * for seamless integration in the Imani wallet.
 *
 * This module provides:
 * 1. Shared database creation for all packages
 * 2. Event-driven integration between packages
 * 3. Type conversion helpers
 *
 * @example
 * ```typescript
 * import { createIntegratedWallet } from '@imani/nostr-vouchers/integrations';
 *
 * const wallet = await createIntegratedWallet({
 *   dbName: 'imani-wallet',
 *   autoRedemption: {
 *     publicKey: '...',
 *     privateKey: '...',
 *     relays: ['wss://relay.imani.casa'],
 *     apiBaseUrl: 'https://api.imani.casa',
 *   },
 * });
 *
 * // All events are wired automatically
 * await wallet.autoRedemption.start();
 *
 * // When a token is redeemed:
 * // 1. auto-redemption emits 'redemption:success'
 * // 2. voucher is saved to VoucherStore
 * // 3. transaction is recorded in TransactionStore
 * ```
 */

import type { Voucher } from '../types';
import { VoucherStatus, BackingStrategy, fromAutoRedemptionVoucher } from '../types';
import { VoucherStore, VoucherStoreConfig } from '../store';
import { createSharedDatabase, StoreDefinition } from '../database';

/**
 * Auto-redemption voucher format (snake_case)
 */
export interface AutoRedemptionVoucher {
  voucher_id: string;
  token: string;
  face_value: number;
  face_unit: string;
  face_decimals: number;
  token_amount: number;
  token_unit: string;
  backing_strategy: 'MINIMAL' | 'FULL' | 'LEGACY';
  issuer_id?: string;
  sender_pubkey?: string;
  memo?: string;
  expires_at?: string;
  created_at: string;
  status: 'active' | 'spent' | 'expired';
  mint_url: string;
  merchant_metadata?: Record<string, unknown>;
}

/**
 * Transaction input for recording
 */
export interface TransactionInput {
  type: string;
  direction: string;
  tokenAmount: number;
  faceValue: number;
  faceUnit: string;
  faceDecimals: number;
  voucherId?: string;
  issuerId?: string;
  issuerName?: string;
  counterparty?: string;
  counterpartyName?: string;
  memo?: string;
}

/**
 * Auto-redemption service interface (minimal)
 */
export interface AutoRedemptionServiceInterface {
  on(event: 'redemption:success', handler: (voucher: AutoRedemptionVoucher) => void): void;
  on(event: 'redemption:error', handler: (error: { message: string; token?: string }) => void): void;
  on(event: 'token:received', handler: (token: { eventId: string; token: string }) => void): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  off(event: string, handler: (...args: any[]) => void): void;
  start(): Promise<void>;
  stop(): void;
}

/**
 * Transaction store interface (minimal)
 */
export interface TransactionStoreInterface {
  init(): Promise<void>;
  record(input: TransactionInput): Promise<unknown>;
  close(): Promise<void>;
}

/**
 * Integration configuration
 */
export interface IntegrationConfig {
  /** Database name for shared database */
  dbName?: string;
  /** Database version */
  dbVersion?: number;
  /** Voucher store configuration */
  voucherStore?: Partial<VoucherStoreConfig>;
  /** Additional store definitions for shared database */
  additionalStores?: StoreDefinition[];
  /** Enable transaction recording */
  enableTransactions?: boolean;
  /** Custom event handlers */
  handlers?: {
    onVoucherReceived?: (voucher: Voucher) => void | Promise<void>;
    onVoucherExpired?: (voucher: Voucher) => void | Promise<void>;
    onTransactionRecorded?: (transaction: TransactionInput) => void | Promise<void>;
    onError?: (error: Error, context: string) => void;
  };
}

/**
 * Integration result
 */
export interface IntegrationResult {
  /** Shared database instance */
  database: IDBDatabase;
  /** Voucher store instance */
  voucherStore: VoucherStore;
  /** Cleanup function to disconnect all handlers */
  cleanup: () => void;
  /** Connect auto-redemption service */
  connectAutoRedemption: (service: AutoRedemptionServiceInterface) => () => void;
  /** Connect transaction store */
  connectTransactionStore: (store: TransactionStoreInterface) => () => void;
}

/**
 * Transaction types
 */
export const TransactionTypes = {
  RECEIVED: 'voucher_received',
  SENT: 'voucher_sent',
  PURCHASED: 'voucher_purchased',
  REDEEMED: 'voucher_redeemed',
  SPLIT: 'voucher_split',
  EXPIRED: 'voucher_expired',
} as const;

/**
 * Transaction directions
 */
export const TransactionDirections = {
  IN: 'in',
  OUT: 'out',
  INTERNAL: 'internal',
} as const;

/**
 * Create an integrated wallet with wired packages
 */
export async function createPackageIntegration(
  config: IntegrationConfig = {}
): Promise<IntegrationResult> {
  const {
    dbName = 'imani-wallet',
    dbVersion = 1,
    voucherStore: voucherStoreConfig = {},
    additionalStores = [],
    handlers = {},
  } = config;

  // Track connected services for cleanup
  const connectedHandlers: Array<() => void> = [];
  let transactionStore: TransactionStoreInterface | null = null;

  // Create shared database
  const database = await createSharedDatabase({
    dbName,
    version: dbVersion,
    additionalStores,
  });

  // Create voucher store with shared database
  const voucherStore = new VoucherStore({
    ...voucherStoreConfig,
    database,
  });

  await voucherStore.init();

  // Wire voucher store events
  const unsubExpiring = voucherStore.on('voucher:expiring', async (event) => {
    try {
      await handlers.onVoucherExpired?.(event.voucher);
    } catch (error) {
      handlers.onError?.(error as Error, 'voucher:expiring handler');
    }
  });
  connectedHandlers.push(unsubExpiring);

  const unsubExpired = voucherStore.on('voucher:expired', async (event) => {
    // Record expiry transaction
    if (transactionStore) {
      try {
        const tx: TransactionInput = {
          type: TransactionTypes.EXPIRED,
          direction: TransactionDirections.OUT,
          tokenAmount: event.voucher.tokenAmount,
          faceValue: event.voucher.faceValue,
          faceUnit: event.voucher.faceUnit,
          faceDecimals: event.voucher.faceDecimals,
          voucherId: event.voucher.id,
          issuerId: event.voucher.issuerId,
          issuerName: event.voucher.issuerName,
        };
        await transactionStore.record(tx);
        await handlers.onTransactionRecorded?.(tx);
      } catch (error) {
        handlers.onError?.(error as Error, 'recording expiry transaction');
      }
    }

    try {
      await handlers.onVoucherExpired?.(event.voucher);
    } catch (error) {
      handlers.onError?.(error as Error, 'voucher:expired handler');
    }
  });
  connectedHandlers.push(unsubExpired);

  /**
   * Connect an auto-redemption service
   */
  function connectAutoRedemption(service: AutoRedemptionServiceInterface): () => void {
    const handleRedemptionSuccess = async (arVoucher: AutoRedemptionVoucher) => {
      try {
        // Convert from auto-redemption format to nostr-vouchers format
        const voucher = fromAutoRedemptionVoucher(arVoucher);

        // Save to voucher store
        const savedVoucher = await voucherStore.add({
          token: voucher.token,
          faceValue: voucher.faceValue,
          faceUnit: voucher.faceUnit,
          faceDecimals: voucher.faceDecimals,
          tokenAmount: voucher.tokenAmount,
          tokenUnit: voucher.tokenUnit,
          issuanceRatio: voucher.issuanceRatio,
          backingStrategy: voucher.backingStrategy as BackingStrategy,
          status: voucher.status as VoucherStatus,
          expiresAt: voucher.expiresAt,
          issuerId: voucher.issuerId,
          issuerName: voucher.issuerName,
          merchantMetadata: voucher.merchantMetadata,
          mintUrl: voucher.mintUrl,
          memo: voucher.memo,
          senderPubkey: voucher.senderPubkey,
          receivedVia: 'dm',
        });

        console.log('[integration] Voucher saved:', savedVoucher.id);

        // Record transaction
        if (transactionStore) {
          const tx: TransactionInput = {
            type: TransactionTypes.RECEIVED,
            direction: TransactionDirections.IN,
            tokenAmount: savedVoucher.tokenAmount,
            faceValue: savedVoucher.faceValue,
            faceUnit: savedVoucher.faceUnit,
            faceDecimals: savedVoucher.faceDecimals,
            voucherId: savedVoucher.id,
            issuerId: savedVoucher.issuerId,
            issuerName: savedVoucher.issuerName,
            counterparty: savedVoucher.senderPubkey,
            memo: savedVoucher.memo,
          };
          await transactionStore.record(tx);
          console.log('[integration] Transaction recorded for voucher:', savedVoucher.id);
          await handlers.onTransactionRecorded?.(tx);
        }

        // Call custom handler
        await handlers.onVoucherReceived?.(savedVoucher);
      } catch (error) {
        console.error('[integration] Error handling redemption success:', error);
        handlers.onError?.(error as Error, 'redemption:success handler');
      }
    };

    const handleRedemptionError = (error: { message: string; token?: string }) => {
      console.error('[integration] Redemption error:', error.message);
      handlers.onError?.(new Error(error.message), 'redemption:error');
    };

    // Subscribe to events
    service.on('redemption:success', handleRedemptionSuccess);
    service.on('redemption:error', handleRedemptionError);

    // Return cleanup function
    const cleanup = () => {
      service.off('redemption:success', handleRedemptionSuccess);
      service.off('redemption:error', handleRedemptionError);
    };

    connectedHandlers.push(cleanup);
    return cleanup;
  }

  /**
   * Connect a transaction store
   */
  function connectTransactionStore(store: TransactionStoreInterface): () => void {
    transactionStore = store;

    // Return cleanup function
    const cleanup = () => {
      transactionStore = null;
    };

    connectedHandlers.push(cleanup);
    return cleanup;
  }

  /**
   * Cleanup all connections
   */
  function cleanup(): void {
    for (const handler of connectedHandlers) {
      try {
        handler();
      } catch {
        // Ignore cleanup errors
      }
    }
    connectedHandlers.length = 0;
    voucherStore.close();
  }

  return {
    database,
    voucherStore,
    cleanup,
    connectAutoRedemption,
    connectTransactionStore,
  };
}

/**
 * Full integrated wallet configuration
 */
export interface IntegratedWalletConfig {
  /** Database name */
  dbName?: string;
  /** Auto-redemption configuration (optional) */
  autoRedemption?: {
    publicKey: string;
    privateKey: string;
    relays: string[];
    apiBaseUrl: string;
  };
  /** Event handlers */
  handlers?: IntegrationConfig['handlers'];
}

/**
 * Full integrated wallet result
 */
export interface IntegratedWallet {
  /** Voucher store */
  voucherStore: VoucherStore;
  /** Transaction store (if available) */
  transactionStore: TransactionStoreInterface | null;
  /** Auto-redemption service (if configured) */
  autoRedemption: AutoRedemptionServiceInterface | null;
  /** Start all services */
  start: () => Promise<void>;
  /** Stop all services */
  stop: () => Promise<void>;
}

