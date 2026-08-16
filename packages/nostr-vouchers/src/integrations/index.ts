/**
 * Package Integrations
 *
 * This module provides integration utilities for wiring @imani/nostr-vouchers
 * with other packages in the Imani ecosystem.
 */

export {
  // Main integration function
  createPackageIntegration,
  // Types
  type IntegrationConfig,
  type IntegrationResult,
  type IntegratedWalletConfig,
  type IntegratedWallet,
  type AutoRedemptionVoucher,
  type AutoRedemptionServiceInterface,
  type TransactionStoreInterface,
  type TransactionInput,
  // Constants
  TransactionTypes,
  TransactionDirections,
} from './PackageIntegration';
