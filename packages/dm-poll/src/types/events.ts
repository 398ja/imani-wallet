/**
 * Event types emitted by DmPollService
 */

import type { Voucher } from './voucher';
import type { GiftWrapEvent, Profile, TokenDm } from './dm';
import type { RefusalReason } from '../errors';

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
 * Emitted when the recipient refused a redemption on POLICY grounds.
 *
 * Distinct from `redemption:error`, and the difference is the whole point: an
 * error is something that went wrong and might succeed on a retry, while this
 * is a decision that will be the same every time. `DmPollService` marks the
 * token received so the poller stops re-offering it, and emits no
 * `redemption:success`, because no money arrived.
 *
 * **Nothing has moved when this fires.** The refusal happens before the mint
 * swap, so the token is still the sender's and their send reclaims at their
 * next login. A listener can say so plainly.
 *
 * Was emitted for a release before it appeared in this map, reachable only
 * through the index signature below — so a listener could be written but got no
 * type checking, and nothing in the wallet subscribed at all. A refusal the
 * recipient cannot see reads as a coupon that silently failed to arrive.
 */
export interface RedemptionRefusedEvent {
  /** Gift wrap event ID. */
  eventId: string;

  /** Who sent the coupon. */
  senderPubkey: string;

  /** The voucher refused. May be empty when the refusal is not voucher-specific. */
  voucherId: string;

  /**
   * Face minor units already taken against this voucher.
   *
   * Zero when the refusal is not a ceiling breach — a coupon issued by another
   * stall has had nothing redeemed against it HERE, and reporting a figure
   * would tell the holder their coupon was spent, which is a different and
   * untrue story.
   */
  alreadyRedeemed: number;

  /** The issuer-signed ceiling, echoed so a listener can show its working. */
  signedFaceValue: number;

  /**
   * Which refusal this is, so a listener never parses `message` to decide what
   * to tell the user. See `RefusalReason`.
   */
  reason: RefusalReason;
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
  'redemption:refused': RedemptionRefusedEvent;
  'subscription:state': SubscriptionStateEvent;
  [key: string]: unknown;
};
