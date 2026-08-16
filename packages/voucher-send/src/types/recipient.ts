/**
 * Recipient Types
 *
 * Types for recipient resolution and profile data.
 */

/**
 * Resolved recipient information
 */
export interface Recipient {
  /** Bech32-encoded npub */
  npub: string;

  /** Hex-encoded public key */
  pubkeyHex: string;

  /** NIP-05 identifier (if resolved from NIP-05) */
  nip05?: string;

  /** Display name from profile */
  displayName?: string;

  /** Profile picture URL */
  picture?: string;

  /** Preferred relay URLs (from NIP-65) */
  relays: string[];
}

/**
 * NIP-05 resolution result
 */
export interface Nip05Result {
  /** Whether resolution was successful */
  success: boolean;

  /** Resolved public key (hex) */
  pubkey?: string;

  /** Relay hints from nostr.json */
  relays?: string[];

  /** Error message if failed */
  error?: string;
}

/**
 * Nostr profile (kind 0 metadata)
 */
export interface NostrProfile {
  /** Display name */
  name?: string;

  /** About/bio */
  about?: string;

  /** Profile picture URL */
  picture?: string;

  /** NIP-05 identifier */
  nip05?: string;

  /** Lightning address */
  lud16?: string;

  /** Banner image */
  banner?: string;

  /** Website URL */
  website?: string;
}

/**
 * Recipient input - what the user provides
 */
export type RecipientInput =
  | string // npub1..., hex pubkey, or NIP-05 (user@domain)
  | Recipient; // Already resolved recipient
