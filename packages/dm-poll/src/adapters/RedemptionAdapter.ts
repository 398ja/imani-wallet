/**
 * RedemptionAdapter - Interface for token redemption operations
 *
 * Optional adapter for redeeming Cashu tokens.
 */

import type { Voucher } from '../types/voucher';
import type { TokenMetadata } from '../types/dm';
import type { Nip60WalletAdapter } from './Nip60WalletAdapter';

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
 * Adapter for token redemption operations
 */
export interface RedemptionAdapter {
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

  /**
   * Get mint URL from token
   *
   * @param token - Cashu token string
   * @returns Mint URL if extractable
   */
  getMintUrl?(token: string): string | null;
}

/**
 * Type guard to check if an object implements RedemptionAdapter
 */
export function isRedemptionAdapter(obj: unknown): obj is RedemptionAdapter {
  if (!obj || typeof obj !== 'object') return false;
  const adapter = obj as RedemptionAdapter;
  return typeof adapter.redeem === 'function';
}
