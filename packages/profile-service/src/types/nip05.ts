/**
 * Result of NIP-05 resolution
 */
export interface Nip05Result {
  /** Resolved hex pubkey */
  pubkey: string;
  /** Recommended relays from NIP-05 */
  relays?: string[];
  /** Original NIP-05 identifier */
  identifier: string;
}

/**
 * NIP-05 resolver interface
 */
export interface Nip05Resolver {
  /**
   * Resolve a NIP-05 identifier to pubkey and relays
   * @param identifier - NIP-05 identifier (e.g., "user@domain.com")
   */
  resolve(identifier: string): Promise<Nip05Result | null>;

  /**
   * Resolve with caching
   * @param identifier - NIP-05 identifier
   */
  resolveWithCache(identifier: string): Promise<Nip05Result | null>;
}
