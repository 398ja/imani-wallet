/**
 * API Adapter Interface
 *
 * Defines the interface for backend API operations.
 * Implementations handle the actual HTTP calls to the Imani backend.
 */

import type {
  SplitPreview,
  SplitResult,
  DmResult,
  NostrProfile,
  Voucher,
  BackingStrategy,
} from '../types';

/**
 * Split preview request
 */
export interface SplitPreviewRequest {
  /** Cashu token to split */
  token: string;

  /** Amount to send (face value) */
  sendFaceValue: number;
}

/**
 * Split execute request
 */
export interface SplitExecuteRequest {
  /** Cashu token to split */
  token: string;

  /** Amount to send (face value) */
  sendFaceValue: number;

  /** Optional memo */
  memo?: string;

  /** Whether to allow swap if split not possible */
  allowSwap?: boolean;
}

/**
 * DM send options
 */
export interface DmSendOptions {
  /** Transaction memo */
  memo?: string;

  /** Face value */
  faceValue?: number;

  /** Face unit */
  faceUnit?: string;

  /** Face decimals */
  faceDecimals?: number;

  /** Token amount in sats */
  tokenAmount?: number;

  /** Backing strategy */
  backingStrategy?: BackingStrategy;

  /** Issuer ID */
  issuerId?: string;

  /** Relay URLs to publish to */
  relayUrls?: string[];

  /** Sender pubkey (for chunked sends) */
  senderPubkey?: string;
}

/**
 * API Adapter Interface
 *
 * Implementations of this interface handle communication with the backend API.
 */
export interface ApiAdapter {
  /**
   * Preview a split operation
   *
   * @param token - Cashu token to split
   * @param amount - Amount to send (face value)
   * @returns Split preview result
   */
  splitPreview(token: string, amount: number): Promise<SplitPreview>;

  /**
   * Execute a split operation
   *
   * @param token - Cashu token to split
   * @param amount - Amount to send (face value)
   * @param memo - Optional memo
   * @returns Split result with send and keep tokens
   */
  splitExecute(token: string, amount: number, memo?: string): Promise<SplitResult>;

  /**
   * Send a token via encrypted DM
   *
   * @param token - Cashu token (or chunk reference JSON) to send
   * @param recipientPubkey - Recipient's hex public key
   * @param options - Additional options
   * @returns DM result with event ID and relay info
   */
  sendTokenDm(
    token: string,
    recipientPubkey: string,
    options?: DmSendOptions
  ): Promise<DmResult>;

  /**
   * Get a user's profile
   *
   * @param pubkey - Hex public key
   * @returns User profile
   */
  getProfile(pubkey: string): Promise<NostrProfile | null>;

  /**
   * Get a voucher by ID
   *
   * @param id - Voucher ID
   * @returns Voucher data
   */
  getVoucher?(id: string): Promise<Voucher | null>;
}

/**
 * Type guard to check if an object implements ApiAdapter
 */
export function isApiAdapter(obj: unknown): obj is ApiAdapter {
  if (typeof obj !== 'object' || obj === null) return false;
  const adapter = obj as Partial<ApiAdapter>;
  return (
    typeof adapter.splitPreview === 'function' &&
    typeof adapter.splitExecute === 'function' &&
    typeof adapter.sendTokenDm === 'function' &&
    typeof adapter.getProfile === 'function'
  );
}
