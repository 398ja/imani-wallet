/**
 * Integrations Module
 *
 * Pre-built adapters for integrating @imani/voucher-send with specific platforms.
 *
 * @packageDocumentation
 */

// Imani Wallet Integration
export {
  // Factory functions
  createImaniAdapters,
  createImaniVoucherSender,
  createStorageFunctions,
  // Individual adapters
  ImaniApiAdapter,
  createImaniApiAdapter,
  ImaniStorageAdapter,
  createImaniStorageAdapter,
  ImaniNostrAdapter,
  createImaniNostrAdapter,
  // Types
  type ImaniAdaptersConfig,
  type ImaniVoucherSenderConfig,
  type GatewayAPI,
  type ImaniApiAdapterConfig,
  type ImaniStorageFunctions,
  type ImaniStorageAdapterConfig,
  type NostrUtilsInterface,
  type Nip60PublisherInterface,
  type ImaniNostrAdapterConfig,
} from './imani';
