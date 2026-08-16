/**
 * DM and Gift Wrap related types
 */

/**
 * NIP-17 Gift Wrap event (kind 1059)
 */
export interface GiftWrapEvent {
  /** Event ID */
  id: string;

  /** Event kind (always 1059 for gift wraps) */
  kind: 1059;

  /** Ephemeral sender pubkey */
  pubkey: string;

  /** Creation timestamp (randomized for privacy) */
  created_at: number;

  /** Event tags (includes 'p' tag for recipient) */
  tags: string[][];

  /** Encrypted content (contains sealed rumor) */
  content: string;

  /** Event signature */
  sig: string;
}

/**
 * Unwrapped DM content after NIP-17 decryption
 */
export interface UnwrappedDm {
  /** Original gift wrap event ID */
  eventId: string;

  /** Actual sender's public key (from rumor) */
  senderPubkey: string;

  /** Decrypted message content */
  content: string;

  /** Actual creation timestamp (from rumor) */
  createdAt: number;
}

/**
 * DM containing a Cashu token
 */
export interface TokenDm {
  /** Gift wrap event ID */
  eventId: string;

  /** Sender's public key */
  senderPubkey: string;

  /** Cashu token string */
  token: string;

  /** Parsed token metadata */
  metadata: TokenMetadata;

  /** When the DM was created */
  createdAt: number;
}

/**
 * Metadata extracted from token transfer message
 */
export interface TokenMetadata {
  /** Optional memo/note */
  memo?: string;

  /** Display face value (e.g., 1.00 for $1.00) */
  faceValue?: number;

  /** Face value unit (e.g., 'USD') */
  faceUnit?: string;

  /** Decimal places for face value */
  faceDecimals?: number;

  /** Actual token amount in sats */
  tokenAmount?: number;

  /** Backing strategy used */
  backingStrategy?: 'MINIMAL' | 'FULL' | 'LEGACY';

  /** Issuer's public key or ID */
  issuerId?: string;

  /** Voucher ID if applicable */
  voucherId?: string;

  // --- Spec 012-multi-voucher-send: bundle metadata ---
  // Per contracts/bundle-metadata-wire-format.md §1. Wire encoding is the
  // `Bundle-*: <value>` text lines added by the gateway-app to the existing
  // human-readable DM body; TokenParser maps them to camelCase here.
  /** 32-char lowercase hex; presence indicates this is one part of a bundle. */
  bundleId?: string;
  /** Declared total face value of the bundle (minor units of faceUnit). */
  bundleTotal?: number;
  /** 0-based index of this part within the original bundle. */
  bundlePartIndex?: number;
  /** Initial part count of the bundle (NOT updated on retries). */
  bundlePartCount?: number;
  /** Stable per-part identifier — MUST equal `${bundleId}:${bundlePartIndex}`. */
  bundlePartId?: string;
  /** Retry attempt number; 0 for the original send. */
  bundleAttempt?: number;
}

/**
 * Profile information for display
 */
export interface Profile {
  /** Public key (hex) */
  pubkey: string;

  /** Display name */
  name?: string;

  /** Alternative display name */
  display_name?: string;

  /** NIP-05 identifier */
  nip05?: string;

  /** Lightning address */
  lud16?: string;

  /** Profile picture URL */
  picture?: string;

  /** About/bio text */
  about?: string;
}
