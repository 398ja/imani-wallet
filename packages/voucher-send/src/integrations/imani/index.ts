/**
 * Imani Wallet Integration
 *
 * Provides ready-to-use adapters for integrating @imani/voucher-send
 * with the Imani wallet's existing infrastructure.
 *
 * @packageDocumentation
 */

import type { Adapters } from '../../adapters';
import { VoucherSender, createVoucherSender } from '../../orchestrator';
import type { SendConfigOptions } from '../../core';
import {
  ImaniApiAdapter,
  createImaniApiAdapter,
  type GatewayAPI,
  type ImaniApiAdapterConfig,
} from './ImaniApiAdapter';
import {
  ImaniStorageAdapter,
  createImaniStorageAdapter,
  type ImaniStorageFunctions,
  type ImaniStorageAdapterConfig,
} from './ImaniStorageAdapter';
import {
  ImaniNostrAdapter,
  createImaniNostrAdapter,
  type NostrUtilsInterface,
  type Nip60PublisherInterface,
  type ImaniNostrAdapterConfig,
} from './ImaniNostrAdapter';

// Re-export adapter classes and types
export {
  ImaniApiAdapter,
  createImaniApiAdapter,
  ImaniStorageAdapter,
  createImaniStorageAdapter,
  ImaniNostrAdapter,
  createImaniNostrAdapter,
};

export type {
  GatewayAPI,
  ImaniApiAdapterConfig,
  ImaniStorageFunctions,
  ImaniStorageAdapterConfig,
  NostrUtilsInterface,
  Nip60PublisherInterface,
  ImaniNostrAdapterConfig,
};

/**
 * Configuration for creating Imani adapters
 */
export interface ImaniAdaptersConfig {
  /** The GatewayAPI instance (window.api in browser) */
  api: GatewayAPI;

  /** Storage functions from storage.js (window globals) */
  storage: ImaniStorageFunctions;

  /** NostrUtils object (window.NostrUtils in browser) */
  nostrUtils: NostrUtilsInterface;

  /** Optional NIP-60 publisher */
  nip60Publisher?: Nip60PublisherInterface;

  /** Default NIP-05 domain */
  defaultDomain?: string;

  /** Default relays for publishing */
  defaultRelays?: string[];
}

/**
 * Create all Imani adapters at once
 *
 * @example
 * // In browser context
 * const adapters = createImaniAdapters({
 *   api: window.api,
 *   storage: {
 *     getVouchers,
 *     getVoucher,
 *     saveVoucher,
 *     deleteVoucher,
 *     updateVoucherAfterSplit,
 *     addTransaction,
 *     getTransactions,
 *   },
 *   nostrUtils: window.NostrUtils,
 *   nip60Publisher: Nip60Publisher.fromGlobal(pubkey, relays),
 *   defaultDomain: 'imani.casa',
 * });
 */
export function createImaniAdapters(config: ImaniAdaptersConfig): Adapters {
  return {
    api: createImaniApiAdapter(config.api),
    storage: createImaniStorageAdapter(config.storage),
    nostr: createImaniNostrAdapter({
      nostrUtils: config.nostrUtils,
      nip60Publisher: config.nip60Publisher,
      defaultDomain: config.defaultDomain,
      defaultRelays: config.defaultRelays,
    }),
  };
}

/**
 * Configuration for creating an Imani VoucherSender
 */
export interface ImaniVoucherSenderConfig extends ImaniAdaptersConfig {
  /** Optional send configuration overrides */
  sendConfig?: SendConfigOptions;
}

/**
 * Create a fully configured VoucherSender for the Imani wallet
 *
 * @example
 * // In browser context
 * const sender = createImaniVoucherSender({
 *   api: window.api,
 *   storage: {
 *     getVouchers,
 *     getVoucher,
 *     saveVoucher,
 *     deleteVoucher,
 *     updateVoucherAfterSplit,
 *     addTransaction,
 *     getTransactions,
 *   },
 *   nostrUtils: window.NostrUtils,
 *   defaultDomain: 'imani.casa',
 *   sendConfig: {
 *     chunking: { enabled: true },
 *     nip60: { enabled: true, relays: ['wss://relay.imani.casa'] },
 *   },
 * });
 *
 * // Use the sender
 * const result = await sender.send({
 *   voucher: 'voucher-id',
 *   amount: 500,
 *   recipient: 'alice@imani.casa',
 *   memo: 'Coffee payment',
 * });
 */
export function createImaniVoucherSender(
  config: ImaniVoucherSenderConfig
): VoucherSender {
  const adapters = createImaniAdapters({
    api: config.api,
    storage: config.storage,
    nostrUtils: config.nostrUtils,
    nip60Publisher: config.nip60Publisher,
    defaultDomain: config.defaultDomain,
    defaultRelays: config.defaultRelays,
  });

  // Build send config with Imani defaults
  const sendConfig: SendConfigOptions = {
    defaultNip05Domain: config.defaultDomain ?? 'imani.casa',
    relay: {
      infraRelay: config.api.infraRelay ?? 'wss://relay.imani.casa',
      defaultRelays: config.defaultRelays ?? ['wss://relay.imani.casa'],
    },
    ...config.sendConfig,
  };

  return createVoucherSender({
    adapters,
    config: sendConfig,
  });
}

/**
 * Helper to create storage functions object from window globals
 *
 * @example
 * // In browser context where storage functions are globals
 * const storage = createStorageFunctions();
 * const adapters = createImaniAdapters({ api, storage, nostrUtils });
 */
export function createStorageFunctions(): ImaniStorageFunctions {
  // These will be available as globals in the browser context
  // TypeScript can't verify them, but they exist at runtime
  const win = globalThis as unknown as {
    getVouchers?: ImaniStorageFunctions['getVouchers'];
    getVoucher?: ImaniStorageFunctions['getVoucher'];
    saveVoucher?: ImaniStorageFunctions['saveVoucher'];
    deleteVoucher?: ImaniStorageFunctions['deleteVoucher'];
    updateVoucherAfterSplit?: ImaniStorageFunctions['updateVoucherAfterSplit'];
    addTransaction?: ImaniStorageFunctions['addTransaction'];
    getTransactions?: ImaniStorageFunctions['getTransactions'];
    groupVouchersByMerchant?: ImaniStorageFunctions['groupVouchersByMerchant'];
  };

  if (!win.getVouchers || !win.getVoucher || !win.saveVoucher) {
    throw new Error(
      'Storage functions not found. Make sure storage.js is loaded before creating adapters.'
    );
  }

  return {
    getVouchers: win.getVouchers,
    getVoucher: win.getVoucher,
    saveVoucher: win.saveVoucher,
    deleteVoucher: win.deleteVoucher!,
    updateVoucherAfterSplit: win.updateVoucherAfterSplit!,
    addTransaction: win.addTransaction!,
    getTransactions: win.getTransactions!,
    groupVouchersByMerchant: win.groupVouchersByMerchant,
  };
}
