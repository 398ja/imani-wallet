/**
 * Event Types
 *
 * Types for the event system.
 */

import type { Voucher } from './voucher';
import type { Recipient } from './recipient';
import type { SplitResult, SplitPreview } from './split';
import type { Transaction } from './transaction';

/**
 * Send stages
 */
export const SendStages = {
  VALIDATING: 'validating',
  SELECTING_VOUCHER: 'selecting_voucher',
  SPLITTING: 'splitting',
  RESOLVING_RECIPIENT: 'resolving_recipient',
  BUILDING_PAYLOAD: 'building_payload',
  CHUNKING: 'chunking',
  SENDING_DM: 'sending_dm',
  PUBLISHING_NIP60: 'publishing_nip60',
  RECORDING_TRANSACTION: 'recording_transaction',
  COMPLETE: 'complete',
} as const;

export type SendStage = (typeof SendStages)[keyof typeof SendStages];

/**
 * DM send result
 */
export interface DmResult {
  /** Nostr event ID */
  eventId: string;

  /** Recipient public key */
  recipientPubkey: string;

  /** Timestamp when sent */
  sentAt: string;

  /** Relays the event was published to */
  relaysUsed: string[];

  /** Whether chunking was used */
  chunked?: boolean;

  /** Number of chunks if chunked */
  chunkCount?: number;
}

/**
 * Chunk progress
 */
export interface ChunkProgress {
  /** Number of chunks published */
  published: number;

  /** Total chunks */
  total: number;
}

/**
 * Event map for typed events
 */
export interface SendEventMap {
  // Main send events
  'send:start': { params: SendParams };
  'send:progress': { stage: SendStage; details?: Record<string, unknown> };
  'send:complete': { result: SendResult };
  'send:error': { error: Error; stage: SendStage };

  // Selection events
  'selection:start': { merchantId?: string; amount: number };
  'selection:complete': { voucher: Voucher };

  // Split events
  'split:preview': SplitPreview;
  'split:start': { token: string; amount: number };
  'split:complete': { result: SplitResult };

  // Recipient events
  'recipient:resolve': { identifier: string };
  'recipient:found': { recipient: Recipient };
  'recipient:notfound': { identifier: string; error: string };

  // DM events
  'dm:sending': { recipient: Recipient; relayCount: number };
  'dm:sent': DmResult;
  'dm:failed': { error: Error };

  // Chunk events
  'chunk:start': { totalChunks: number; tokenSize: number };
  'chunk:progress': ChunkProgress;
  'chunk:complete': { eventId: string; chunkCount: number };
  'chunk:failed': { error: Error; publishedCount: number; totalCount: number };

  // NIP-60 events
  'nip60:publishing': { proofCount: number };
  'nip60:published': { success: boolean };
}

/**
 * Send parameters
 */
export interface SendParams {
  /** Voucher to send from (ID or object) */
  voucher?: string | Voucher;

  /** Merchant ID to select voucher from */
  merchantId?: string;

  /** Amount to send (face value in minor units) */
  amount: number;

  /** Recipient identifier (npub, NIP-05, or Recipient object) */
  recipient: string | Recipient;

  /** Optional memo */
  memo?: string;

  /** Payment request string (if paying a request) */
  paymentRequest?: string;
}

/**
 * Send result
 */
export interface SendResult {
  /** Whether the send was successful */
  success: boolean;

  /** Voucher that was sent */
  sentVoucher: Voucher;

  /** Voucher kept (change) */
  keepVoucher?: Voucher;

  /** Resolved recipient */
  recipient: Recipient;

  /** DM send result */
  dmResult: DmResult;

  /** Transaction record */
  transaction: Transaction;

  /** Split result details */
  splitResult?: SplitResult;
}

/**
 * Preview parameters
 */
export interface PreviewParams {
  /** Voucher to preview split for */
  voucher: string | Voucher;

  /** Amount to preview (face value) */
  amount: number;
}

/**
 * Preview result
 */
export interface PreviewResult extends SplitPreview {
  /** Source voucher */
  voucher: Voucher;

  /** Merchant info */
  merchant?: {
    id: string;
    name: string;
  };
}
