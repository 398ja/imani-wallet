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
