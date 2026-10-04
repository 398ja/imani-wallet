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
 * Why a redemption was refused. Each value is a different thing to tell a user.
 *
 * A listener should never have to parse `message` to decide what to say. The
 * two cases read completely differently to whoever is standing at the counter:
 * one means "this coupon is spent", the other means "this coupon is for
 * somebody else's stall", and telling a customer the wrong one sends them away
 * with the wrong belief about their own money.
 */
export type RefusalReason =
  /** The voucher has already paid out everything it was issued for. */
  | 'over-redeemed'
  /** A claim on a different stall, which is the only one that can honour it. */
  | 'another-stall'
  /**
   * Nothing outside the issuing service authorised this coupon.
   *
   * Covers all three unauthorised states, because they have the same answer at
   * the till: no warrant at all, a warrant the issuer signed as `none`, and a
   * warrant that was present and did not hold. The merchant-facing copy
   * distinguishes them; the refusal does not need to.
   */
  | 'unwarranted'
  /**
   * The token's proofs are at a mint the wallet does not trust (imani-wallet#131).
   * The coupon may be a perfect copy of a genuine signed voucher: the issuer
   * signature covers no mint, so only the backing tells it apart.
   */
  | 'untrusted-mint'
  /** The token's proofs are not in the unit the wallet credits (sat). */
  | 'wrong-unit'
  /** The token could not be read well enough to say where its value is. */
  | 'undecodable'

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
    /**
     * Which refusal this is.
     *
     * Defaulted rather than required, so the ceiling check — the only caller
     * when this class was written — keeps working unchanged and no existing
     * test has to be edited to accommodate a field it does not care about.
     */
    public readonly reason: RefusalReason = 'over-redeemed',
  ) {
    super(message)
    this.name = 'RedemptionRefusedError'
  }
}
