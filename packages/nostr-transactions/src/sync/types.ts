/**
 * Types for relay synchronization
 */

import type { Transaction } from '../types';

/**
 * NIP-60 Transaction History Event (kind 7376)
 */
export const NIP60_HISTORY_KIND = 7376;

/**
 * Nostr event structure
 */
export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

/**
 * Unsigned event for signing
 */
export interface UnsignedEvent {
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
}

/**
 * Nostr signer interface (NIP-07 compatible)
 */
export interface NostrSigner {
  getPublicKey(): Promise<string>;
  signEvent(event: UnsignedEvent): Promise<NostrEvent>;
  nip04?: {
    encrypt(pubkey: string, plaintext: string): Promise<string>;
    decrypt(pubkey: string, ciphertext: string): Promise<string>;
  };
  nip44?: {
    encrypt(pubkey: string, plaintext: string): Promise<string>;
    decrypt(pubkey: string, ciphertext: string): Promise<string>;
  };
}

/**
 * Crypto provider for encryption/decryption
 */
export interface CryptoProvider {
  encrypt(pubkey: string, plaintext: string): Promise<string>;
  decrypt(pubkey: string, ciphertext: string): Promise<string>;
}

/**
 * Relay sync configuration
 */
export interface RelaySyncConfig {
  /** User's public key (hex) */
  pubkey: string;
  /** Nostr signer for signing events */
  signer: NostrSigner;
  /** Relay URLs to sync with */
  relayUrls: string[];
  /** Wallet d-tag for NIP-60 */
  walletDTag?: string;
  /** Enable encryption (default: true) */
  encryption?: boolean;
  /** Custom crypto provider (defaults to signer's nip44) */
  cryptoProvider?: CryptoProvider;
  /** Sync batch size (default: 50) */
  batchSize?: number;
  /** Auto-sync interval in ms (0 = disabled, default: 0) */
  autoSyncInterval?: number;
}

/**
 * Sync direction
 */
export type SyncDirection = 'push' | 'pull' | 'full';

/**
 * Sync result
 */
export interface SyncResult {
  direction: SyncDirection;
  pushed: number;
  pulled: number;
  errors: SyncError[];
  duration: number;
  timestamp: number;
}

/**
 * Sync error details
 */
export interface SyncError {
  transactionId?: string;
  eventId?: string;
  message: string;
  code: string;
  retryable: boolean;
}

/**
 * Sync status
 */
export interface SyncStatus {
  /** Whether sync is currently in progress */
  inProgress: boolean;
  /** Current sync direction if in progress */
  currentDirection?: SyncDirection;
  /** Last successful sync timestamp */
  lastSync?: number;
  /** Last push timestamp */
  lastPush?: number;
  /** Last pull timestamp */
  lastPull?: number;
  /** Number of pending (unsynced) transactions */
  pendingCount: number;
  /** Whether all transactions are synced */
  synced: boolean;
  /** Last sync error if any */
  lastError?: string;
}

/**
 * NIP-60 history event content structure
 */
export interface Nip60HistoryContent {
  /** Transaction type */
  type: string;
  /** Direction: in, out, internal */
  direction: string;
  /** Token amount in sats */
  amount: number;
  /** Face value in minor units */
  face_value?: number;
  /** Face value currency */
  face_unit?: string;
  /** Face value decimals */
  face_decimals?: number;
  /** Related voucher ID */
  voucher_id?: string;
  /** Mint URL */
  mint_url?: string;
  /** Counterparty pubkey */
  counterparty?: string;
  /** Counterparty display name */
  counterparty_name?: string;
  /** Issuer/merchant pubkey */
  issuer_id?: string;
  /** Issuer display name */
  issuer_name?: string;
  /** Transaction memo */
  memo?: string;
  /** Original timestamp */
  timestamp?: number;
  /** Spec 014: delivery confirmation state — synced so a new device sees the badge. */
  delivery_state?: 'pending' | 'partial' | 'confirmed';
  /** Spec 014: Unix seconds the row first transitioned to 'confirmed'. */
  delivered_at?: number;
  /** Spec 014: bundles only — count of distinct part-receipts received. */
  delivery_confirmed_parts?: number;
}

/**
 * Transaction to event mapping
 */
export function transactionToHistoryContent(tx: Transaction): Nip60HistoryContent {
  return {
    type: tx.type,
    direction: tx.direction,
    amount: tx.tokenAmount,
    face_value: tx.faceValue,
    face_unit: tx.faceUnit,
    face_decimals: tx.faceDecimals,
    voucher_id: tx.voucherId,
    mint_url: tx.mintUrl,
    counterparty: tx.counterparty,
    counterparty_name: tx.counterpartyName,
    issuer_id: tx.issuerId,
    issuer_name: tx.issuerName,
    memo: tx.memo,
    timestamp: tx.timestamp,
    // Spec 014 (T071c): delivery confirmation rides cross-device sync
    // so a new device sees the same badge as the originating device.
    delivery_state: tx.deliveryState,
    delivered_at: tx.deliveredAt,
    delivery_confirmed_parts: tx.deliveryConfirmedParts,
  };
}

/**
 * Event content to transaction mapping
 */
export function historyContentToTransaction(
  content: Nip60HistoryContent,
  eventId: string,
  createdAt: number,
  walletId?: string
): Partial<Transaction> {
  return {
    eventId,
    type: content.type as Transaction['type'],
    direction: content.direction as Transaction['direction'],
    tokenAmount: content.amount,
    faceValue: content.face_value ?? 0,
    faceUnit: content.face_unit ?? 'SAT',
    faceDecimals: content.face_decimals ?? 0,
    voucherId: content.voucher_id,
    mintUrl: content.mint_url,
    counterparty: content.counterparty,
    counterpartyName: content.counterparty_name,
    issuerId: content.issuer_id,
    issuerName: content.issuer_name,
    memo: content.memo,
    timestamp: content.timestamp ?? createdAt,
    walletId,
    synced: true,
    syncedAt: Math.floor(Date.now() / 1000),
    // Spec 014 (T071c): hydrate delivery state from the synced event so
    // a fresh wallet on a new device renders the blue check immediately.
    deliveryState: content.delivery_state,
    deliveredAt: content.delivered_at,
    deliveryConfirmedParts: content.delivery_confirmed_parts,
  };
}
