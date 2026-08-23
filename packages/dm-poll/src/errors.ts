/**
 * Error classes for @imani/dm-poll
 */

/**
 * Base error class for DM poll errors
 */
export class DmPollError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DmPollError';
  }
}

/**
 * Error when unwrapping a gift wrap fails
 */
export class GiftWrapError extends DmPollError {
  constructor(message: string, public readonly eventId: string) {
    super(message);
    this.name = 'GiftWrapError';
  }
}

/**
 * Error when token redemption fails
 */
export class RedemptionError extends DmPollError {
  constructor(
    message: string,
    public readonly token: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'RedemptionError';
  }
}

/**
 * Error when subscription fails
 */
export class SubscriptionError extends DmPollError {
  constructor(message: string, public readonly mode: string) {
    super(message);
    this.name = 'SubscriptionError';
  }
}

/**
 * Error when adapter is missing or invalid
 */
export class AdapterError extends DmPollError {
  constructor(message: string, public readonly adapterName: string) {
    super(message);
    this.name = 'AdapterError';
  }
}

/**
 * The recipient refused a redemption on policy grounds, before any swap.
 *
 * TERMINAL, and deliberately its own type rather than a message the
 * already-redeemed matcher happens to catch. Retrying cannot change the answer:
 * the voucher has paid out everything it was issued for, and it will still have
 * done so on the next tick. Left unclassified, an uncaught throw is treated as
 * transient (see runCatchupTick) and the same coupon is re-offered forever.
 *
 * Nothing has moved when this is raised — it is thrown before the mint swap — so
 * the token remains the sender's and their send reclaims at their next login.
 */
export class RedemptionRefusedError extends DmPollError {
  constructor(
    message: string,
    public readonly voucherId: string,
    /** What was already redeemed against this voucher, in face minor units. */
    public readonly alreadyRedeemed: number,
    /** The issuer-signed ceiling. */
    public readonly signedFaceValue: number,
  ) {
    super(message)
    this.name = 'RedemptionRefusedError'
  }
}
