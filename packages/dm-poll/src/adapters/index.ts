/**
 * Adapter exports for @imani/dm-poll
 */

// NostrdbAdapter - REQUIRED
export type { NostrdbAdapter } from './NostrdbAdapter';
export { isNostrdbAdapter } from './NostrdbAdapter';

// CryptoAdapter - REQUIRED
export type { CryptoAdapter } from './CryptoAdapter';
export { isCryptoAdapter } from './CryptoAdapter';

// StorageAdapter - Optional
export type { StorageAdapter } from './StorageAdapter';
export { isStorageAdapter } from './StorageAdapter';

// RedemptionAdapter - Optional
export type { RedemptionAdapter, RedemptionOptions } from './RedemptionAdapter';
export { isRedemptionAdapter } from './RedemptionAdapter';

// UiAdapter - Optional
export type { UiAdapter } from './UiAdapter';
export { isUiAdapter } from './UiAdapter';

// LegacyApiAdapter - Optional (backward compatibility)
export type { LegacyApiAdapter, LegacyDm, ClaimResponse, ReceiveResponse } from './LegacyApiAdapter';
export { isLegacyApiAdapter } from './LegacyApiAdapter';

// Nip60WalletAdapter - Optional
export type { Nip60WalletAdapter } from './Nip60WalletAdapter';
export { isNip60WalletAdapter } from './Nip60WalletAdapter';
