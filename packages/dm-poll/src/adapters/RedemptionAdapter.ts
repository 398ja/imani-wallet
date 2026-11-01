/**
 * RedemptionAdapter - Interface for token redemption operations
 *
 * Optional adapter for redeeming Cashu tokens.
 */

import type { Voucher } from '../types/voucher';
import type { TokenMetadata } from '../types/dm';
import type { Nip60WalletAdapter } from './Nip60WalletAdapter';
import type { RefusalReason } from '../errors';

/**
 * Options for token redemption
 */
export interface RedemptionOptions {
  /** Parsed token metadata */
  metadata?: TokenMetadata;

  /** NIP-60 wallet for transaction recording */
  nip60Wallet?: Nip60WalletAdapter;

  /** Skip duplicate check (use with caution) */
  skipDuplicateCheck?: boolean;

  /** Sender's public key for recording */
  senderPubkey?: string;

  /**
   * The kind-1059 gift wrap this token arrived in.
   *
   * `GiftWrapProcessor` has always set it on the TokenDm and `TokenRedeemer`
   * destructured it and dropped it here, so it reached no redemption path. It
   * is the only stable id both parties share for one delivery, which is what a
   * settlement receipt has to be keyed on: without it the recipient cannot tell
   * the sender WHICH coupon was claimed, and the sender's "Voucher Claimed"
   * notification never fires.
   */
  deliveryEventId?: string;
}

/**
 * What `checkBacking` says about where a token's value is.
 *
 * - `accept`: the proofs are at a mint the wallet trusts, in its unit.
 * - `refuse`: the token can never be credited here, whatever the configuration:
 *   its proofs are in a unit the wallet cannot read, or it cannot be read at all.
 *   Terminal. Nothing is swapped and the delivery is consumed.
 * - `hold`: the wallet will not credit this token NOW, but a configuration change
 *   could change that: its mint is not on the trusted list, or no trusted mint is
 *   known at all (imani-wallet#133 review). Nothing is swapped, the delivery is
 *   NOT consumed, nothing is marked received, and `redemption:held` is emitted so
 *   the wallet can show the coupon as waiting. A later poll offers it again.
 *   Deliberately not a refusal: a mismatch between two services' mint settings
 *   used to refuse, and so drop, every coupon it touched.
 * - `defer`: the wallet cannot tell yet (its trusted-mint list has not loaded).
 *   Nothing is swapped and the delivery is NOT consumed, so a later poll retries it.
 */
export type BackingVerdict =
  | { readonly outcome: 'accept' }
  | {
      readonly outcome: 'refuse';
      readonly reason: Extract<RefusalReason, 'wrong-unit' | 'undecodable'>;
      readonly detail: string;
    }
  | { readonly outcome: 'hold'; readonly reason: HoldReason; readonly detail: string }
  | { readonly outcome: 'defer'; readonly detail: string };

/** Why a token was held rather than credited. Each one is a different thing to tell a user. */
export type HoldReason =
  /** The token's mint is not one the wallet trusts. A config change may add it. */
  | 'untrusted-mint'
  /** The wallet knows no trusted mint from any source, so it can verify nothing. */
  | 'no-trusted-mint';

/**
 * Adapter for token redemption operations
 */
export interface RedemptionAdapter {
  /**
   * Is this token's value at a mint the wallet trusts, in a unit it understands?
   *
   * REQUIRED, and asked by dm-poll itself before every `redeem`, so no redemption
   * path can skip it. It replaces an optional `getMintUrl` hook that nothing ever
   * called, which left the mint and unit of a received token unchecked: a copy of
   * a genuine signed voucher backed by proofs at a rogue mint was swapped and
   * credited like the real thing (imani-wallet#131).
   *
   * Must not perform the swap and should not throw; an exception is treated as
   * `defer`, never as `accept`.
   */
  checkBacking(token: string): BackingVerdict;

  /**
   * Redeem a Cashu token
   *
   * @param token - Cashu token string
   * @param options - Redemption options
   * @returns Redeemed voucher
   * @throws Error if redemption fails
   */
  redeem(token: string, options?: RedemptionOptions): Promise<Voucher>;

  /**
   * Check if a token can be redeemed
   *
   * @param token - Cashu token string
   * @returns true if token appears valid and redeemable
   */
  canRedeem?(token: string): Promise<boolean>;
}

/**
 * Type guard to check if an object implements RedemptionAdapter
 */
export function isRedemptionAdapter(obj: unknown): obj is RedemptionAdapter {
  if (!obj || typeof obj !== 'object') return false;
  const adapter = obj as RedemptionAdapter;
  return typeof adapter.redeem === 'function' && typeof adapter.checkBacking === 'function';
}
