/**
 * TokenRedeemer - Token redemption orchestration
 *
 * Handles the redemption flow including deduplication,
 * redemption API call, and NIP-60 recording.
 */

import type { TokenDm, Profile } from '../types/dm';
import type { Voucher, Transaction } from '../types/voucher';
import type { RedemptionAdapter, RedemptionOptions } from '../adapters/RedemptionAdapter';
import type { StorageAdapter } from '../adapters/StorageAdapter';
import type { Nip60WalletAdapter } from '../adapters/Nip60WalletAdapter';
import type { NostrdbAdapter } from '../adapters/NostrdbAdapter';

/**
 * Options for TokenRedeemer
 */
export interface TokenRedeemerOptions {
  /** Redemption adapter (required for redemption) */
  redemptionAdapter?: RedemptionAdapter;

  /** Storage adapter for persistence */
  storageAdapter?: StorageAdapter;

  /** NIP-60 wallet for transaction recording */
  nip60Wallet?: Nip60WalletAdapter;

  /** nostrdb adapter for profile lookups */
  nostrdbAdapter?: NostrdbAdapter;

  /** Function to get token fingerprint */
  getTokenFingerprint: (token: string) => string;
}

/**
 * Result of a redemption attempt
 */
export interface RedemptionResult {
  /** Whether redemption was successful */
  success: boolean;

  /** Redeemed voucher (if successful) */
  voucher?: Voucher;

  /** Sender profile (if available) */
  senderProfile?: Profile;

  /** Error message (if failed) */
  error?: string;

  /** Whether token was a duplicate */
  isDuplicate?: boolean;
}

/**
 * Orchestrates token redemption with deduplication and recording
 */
export class TokenRedeemer {
  private readonly options: TokenRedeemerOptions;

  constructor(options: TokenRedeemerOptions) {
    this.options = options;
  }

  /**
   * Redeem a token from a DM
   *
   * @param tokenDm - Token DM to redeem
   * @returns Redemption result
   */
  async redeem(tokenDm: TokenDm): Promise<RedemptionResult> {
    const { token, metadata, senderPubkey } = tokenDm;

    // Check for duplicates
    if (this.options.storageAdapter) {
      const fingerprint = this.options.getTokenFingerprint(token);
      const isDuplicate = await this.options.storageAdapter.hasTokenBeenReceived(fingerprint);

      if (isDuplicate) {
        console.log('[TokenRedeemer] Duplicate token detected:', fingerprint.substring(0, 8));
        return {
          success: false,
          isDuplicate: true,
          error: 'Token has already been received',
        };
      }
    }

    // Check if redemption adapter is available
    if (!this.options.redemptionAdapter) {
      console.warn('[TokenRedeemer] No redemption adapter configured');
      return {
        success: false,
        error: 'Redemption adapter not configured',
      };
    }

    try {
      // Prepare redemption options
      const redemptionOptions: RedemptionOptions = {
        metadata,
        senderPubkey,
        nip60Wallet: this.options.nip60Wallet,
      };

      // Perform redemption
      const voucher = await this.options.redemptionAdapter.redeem(token, redemptionOptions);

      // Mark token as received
      if (this.options.storageAdapter) {
        const fingerprint = this.options.getTokenFingerprint(token);
        await this.options.storageAdapter.markTokenAsReceived(fingerprint);
        await this.options.storageAdapter.saveVoucher(voucher);
      }

      // Record transaction in NIP-60 wallet
      if (this.options.nip60Wallet) {
        await this.recordTransaction(voucher, senderPubkey);
      }

      // Get sender profile for notification
      let senderProfile: Profile | undefined;
      if (this.options.nostrdbAdapter) {
        senderProfile = await this.options.nostrdbAdapter.getProfile(senderPubkey) ?? undefined;
      }

      console.log('[TokenRedeemer] Redemption successful:', voucher.voucher_id);

      return {
        success: true,
        voucher,
        senderProfile,
      };
    } catch (error) {
      console.error('[TokenRedeemer] Redemption failed:', error);

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Redemption failed',
      };
    }
  }

  /**
   * Record a transaction in NIP-60 wallet
   */
  private async recordTransaction(voucher: Voucher, senderPubkey: string): Promise<void> {
    if (!this.options.nip60Wallet) return;

    const transaction: Transaction = {
      id: voucher.voucher_id,
      type: 'receive',
      amount: voucher.token_amount,
      unit: voucher.token_unit,
      timestamp: new Date().toISOString(),
      counterparty: senderPubkey,
      memo: voucher.memo,
      voucher_id: voucher.voucher_id,
    };

    try {
      await this.options.nip60Wallet.recordTransaction(transaction);
      console.log('[TokenRedeemer] Transaction recorded:', transaction.id);
    } catch (error) {
      console.error('[TokenRedeemer] Failed to record transaction:', error);
      // Don't throw - recording is non-critical
    }
  }

  /**
   * Check if a token is a duplicate
   */
  async isDuplicate(token: string): Promise<boolean> {
    if (!this.options.storageAdapter) return false;

    const fingerprint = this.options.getTokenFingerprint(token);
    return this.options.storageAdapter.hasTokenBeenReceived(fingerprint);
  }

  /**
   * Validate a token before redemption
   */
  async validate(token: string): Promise<{ valid: boolean; error?: string }> {
    // Check format
    if (!token.startsWith('cashuA') && !token.startsWith('cashuB')) {
      return { valid: false, error: 'Invalid token format' };
    }

    // Check for duplicate
    if (await this.isDuplicate(token)) {
      return { valid: false, error: 'Token already received' };
    }

    // Check with redemption adapter if available
    if (this.options.redemptionAdapter?.canRedeem) {
      const canRedeem = await this.options.redemptionAdapter.canRedeem(token);
      if (!canRedeem) {
        return { valid: false, error: 'Token cannot be redeemed' };
      }
    }

    return { valid: true };
  }
}

/**
 * Create a TokenRedeemer
 */
export function createTokenRedeemer(options: TokenRedeemerOptions): TokenRedeemer {
  return new TokenRedeemer(options);
}
