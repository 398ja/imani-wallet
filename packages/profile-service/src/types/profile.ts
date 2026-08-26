/**
 * Location data for profiles and merchants
 */
export interface ProfileLocation {
  lat: number;
  lon: number;
  address?: string;
  country?: string;
  city?: string;
}

/**
 * Profile representing Nostr kind-0 metadata
 */
export interface Profile {
  /** Hex pubkey */
  pubkey: string;
  name?: string;
  /** display_name in Nostr metadata */
  displayName?: string;
  picture?: string;
  banner?: string;
  about?: string;
  /** NIP-05 identifier (e.g., user@domain.com) */
  nip05?: string;
  /** Lightning address */
  lud16?: string;
  /** LNURL-pay */
  lud06?: string;
  website?: string;
  /** e.g., ['merchant', 'pos'] */
  merchantTags?: string[];
  /** e.g., ['USD', 'XAF'] */
  currencies?: string[];
  location?: ProfileLocation;
  /** Raw metadata for extensibility */
  metadata?: Record<string, unknown>;
  /** Event created_at timestamp */
  createdAt?: number;
}

/**
 * Merchant profile representing Nostr kind-30078 (NIP-78) data
 */
export interface MerchantProfile {
  pubkey: string;
  businessName?: string;
  /** e.g., 'restaurant', 'retail', 'services' */
  businessType?: string;
  /** Accepted currencies */
  currencies: string[];
  /** e.g., ['cashu', 'lightning', 'onchain'] */
  paymentMethods?: string[];
  location?: ProfileLocation;
  /** e.g., { "mon": "9:00-17:00" } */
  hours?: Record<string, string>;
  verified?: boolean;
  verifiedAt?: number;
  metadata?: Record<string, unknown>;
  createdAt?: number;
}

/**
 * Combined profile with optional merchant data
 */
export interface FullProfile {
  profile: Profile;
  merchantProfile?: MerchantProfile;
}
