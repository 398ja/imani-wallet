/**
 * Event types emitted by DmPollService
 */

import type { Voucher } from './voucher';
import type { GiftWrapEvent, Profile, TokenDm } from './dm';

/**
 * Emitted when a token DM is received
 */
export interface TokenReceivedEvent {
  /** Gift wrap event ID */
  eventId: string;

  /** Cashu token string */
  token: string;

  /** Parsed token DM */
  tokenDm: TokenDm;
}

/**
 * Emitted when a token is successfully redeemed
 */
export interface RedemptionSuccessEvent {
  /** The redeemed voucher */
  voucher: Voucher;

  /** Sender's profile (if available) */
  senderProfile?: Profile;

  /** Original event ID */
  eventId: string;

  /**
   * Sender's pubkey from the gift-wrap inner-event author (forge-resistant given the
   * receiver's decrypt key). Listeners that need to attribute the bundle to a sender
   * MUST use this value, not any sender-claimed metadata field. Spec 012-multi-voucher-send
   * Phase 0 R11.
   */
  senderPubkey?: string;

  /**
   * Spec 012-multi-voucher-send: bundle metadata extracted from the decrypted DM body,
   * when present. Absence of `bundle.bundleId` means this was a standalone send and the
   * receiver bundle aggregator MUST NOT create or update any BundleReceiptRecord.
   */
  bundle?: {
    bundleId: string;
    bundleTotal: number;
    bundlePartIndex: number;
    bundlePartCount: number;
    bundlePartId: string;
    bundleAttempt: number;
  };
}

/**
 * Emitted when token redemption fails
 */
export interface RedemptionErrorEvent {
  /** Error message */
  message: string;

  /** Original error */
  error: Error;

  /** Cashu token that failed */
  token: string;

  /** Gift wrap event ID */
  eventId: string;
}

/**
 * Emitted when subscription state changes
 */
export interface SubscriptionStateEvent {
  /** Current state */
  state: 'connecting' | 'connected' | 'disconnected' | 'error';

  /** Subscription mode */
  mode: string;

  /** Error message if state is 'error' */
  error?: string;
}

/**
 * Represents a failed event that can be replayed
 */
export interface FailedEvent {
  /** Gift wrap event ID */
  eventId: string;

  /** The original gift wrap event data */
  event: GiftWrapEvent;

  /** Error message from the failure */
  error: string;

  /** Number of processing attempts */
  attempts: number;

  /** Timestamp of last attempt (ms since epoch) */
  lastAttempt: number;

  /** Original creation timestamp of the DM */
  createdAt?: number;
}

/**
 * Status information for the DM poll service
 */
export interface DmPollStatus {
  /** Whether the service is running */
  isRunning: boolean;

  /** Subscription mode */
  subscriptionMode: string;

  /** Recipient pubkey (truncated for display) */
  recipientPubkey: string;

  /** Whether private key is set */
  hasPrivkey: boolean;

  /** Number of processed events */
  processedCount: number;

  /** Number of failed events */
  failedCount: number;

  /** List of failed events (summary) */
  failedEvents: Array<{
    eventId: string;
    error: string;
    attempts: number;
    lastAttempt: string;
  }>;
}

/**
 * Result of processing unclaimed tokens
 */
export interface ProcessUnclaimedResult {
  /** Number of tokens successfully processed */
  processed: number;

  /** Number of tokens that failed */
  failed: number;

  /** Number of tokens skipped (recently failed) */
  skipped: number;
}

/**
 * Result of replaying failed events
 */
export interface ReplayResult {
  /** Number of events successfully replayed */
  success: number;

  /** Number of events that failed again */
  failed: number;
}

/**
 * Event map for TypedEventEmitter
 */
export type DmPollEvents = {
  'token:received': TokenReceivedEvent;
  'redemption:success': RedemptionSuccessEvent;
  'redemption:error': RedemptionErrorEvent;
  'subscription:state': SubscriptionStateEvent;
  [key: string]: unknown;
};
