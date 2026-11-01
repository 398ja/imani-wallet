/**
 * Event types emitted by DmPollService
 */

import type { Voucher } from './voucher';
import type { GiftWrapEvent, Profile, TokenDm } from './dm';
import type { RefusalReason } from '../errors';
import type { HoldReason } from '../adapters/RedemptionAdapter';

/**
 * Emitted when the backing gate HOLDS a token instead of redeeming it
 * (imani-wallet#133 review): its mint is not on the wallet's list, or the wallet
 * knows no trusted mint at all.
 *
 * Not a refusal. Nothing was swapped, nothing is marked received, and the
 * delivery is left unconsumed, so it is offered again on every later poll and is
 * redeemed as soon as the configuration names its mint. The wallet uses this to
 * keep the coupon VISIBLE as "waiting to be verified" rather than letting it sit
 * silently until it ages out of the poll window.
 */
export interface RedemptionHeldEvent {
  eventId: string;
  senderPubkey: string;
  /** May be empty for plain ecash. */
  voucherId: string;
  reason: HoldReason;
  detail: string;
  /** The token, kept so the wallet can re-offer it after a configuration change. */
  token: string;
  /** When the delivery was created, epoch seconds. */
  createdAt: number;
  /** Display only, from the envelope: sender-written. */
  faceValue?: number;
  faceUnit?: string;
  faceDecimals?: number;
  /** The payer the payload names, as on `redemption:refused`. */
  payerPubkey?: string;
}

/** A delivery held earlier in this session has now been redeemed. */
export interface RedemptionReleasedEvent {
  eventId: string;
}

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

  /**
   * The payment request this coupon answered, when the DM named one (imani-wallet#300), so a
   * till that already showed Paid on gateway-core's verdict can say the coupon did not arrive.
   * Sender-written and display only.
   */
  requestId?: string;

  /**
   * Whether this service will offer the delivery again (imani-wallet#314). False only when it
   * has given up on it for good (a token the mint can never accept), so a listener can stop
   * promising "will keep trying". Absent from older emitters: treat that as retryable.
   */
  retryable?: boolean;
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

  /**
   * The payment this coupon was part of, when the sender declared one, so the
   * recipient can show the refusal ON that payment rather than only in a
   * passing toast (#145). Sender-written and display only.
   */
  bundleId?: string;
  /** How many coupons the sender said the payment was made of. Display only. */
  bundlePartCount?: number;
  /** The payment request this coupon answered, when it named one. */
  requestId?: string;
  /**
   * The payer the payload names (`sender_pubkey`), as distinct from
   * `senderPubkey`, the gift wrap's signer, which is the gateway on a relayed
   * send. Sender-written like the ids above.
   */
  payerPubkey?: string;
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
  'redemption:unsaved': RedemptionUnsavedEvent;
  'redemption:held': RedemptionHeldEvent;
  'redemption:released': RedemptionReleasedEvent;
  'subscription:state': SubscriptionStateEvent;
  [key: string]: unknown;
};

/**
 * #110: the gateway settled a receive of this token (the swap happened) but
 * the value is NOT in this wallet. Not a success, and not retryable by
 * re-swapping. Emitted so the wallet can surface it for reconciliation.
 */
export interface RedemptionUnsavedEvent {
  eventId: string;
  senderPubkey: string;
  /** The gateway escrow the value sits behind, when known. */
  receiveId: string | null;
  /** e.g. 'already-settled' | 'replay-without-token'. */
  reason: string | null;
  /** The payment request this coupon answered, when the DM named one (imani-wallet#300). */
  requestId?: string;
}
