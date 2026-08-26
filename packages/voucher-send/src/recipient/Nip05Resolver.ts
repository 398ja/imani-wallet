/**
 * Nip05Resolver
 *
 * Resolves NIP-05 identifiers (user@domain) to public keys.
 */

import type { NostrAdapter } from '../adapters';
import type { Nip05Result } from '../types';
import { VoucherSendError } from '../core/errors';

/**
 * NIP-05 validation regex
 * Allows: username (alphanumeric, underscore, hyphen, starting with alphanumeric)
 * Allows: domain (alphanumeric, dots, hyphens)
 */
const NIP05_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_-]*@[a-zA-Z0-9][a-zA-Z0-9.-]+$/;

/**
 * Default domain for bare usernames
 */
const DEFAULT_DOMAIN = 'imani.casa';

/**
 * Nip05Resolver configuration
 */
export interface Nip05ResolverConfig {
  /** Default domain for bare usernames */
  defaultDomain?: string;

  /** Request timeout in milliseconds */
  timeout?: number;

  /** Custom fetch function (for testing) */
  fetchFn?: typeof fetch;
}

/**
 * Nip05Resolver
 *
 * Resolves NIP-05 identifiers to Nostr public keys.
 */
export class Nip05Resolver {
  private nostrAdapter?: NostrAdapter;
  private defaultDomain: string;
  private timeout: number;
  private fetchFn: typeof fetch;

  constructor(nostrAdapter?: NostrAdapter, config: Nip05ResolverConfig = {}) {
    this.nostrAdapter = nostrAdapter;
    this.defaultDomain = config.defaultDomain || DEFAULT_DOMAIN;
    this.timeout = config.timeout || 10000;
    this.fetchFn = config.fetchFn || fetch;
  }

  /**
   * Normalize a NIP-05 identifier
   * Adds default domain if missing
   */
  normalize(identifier: string): string {
    const trimmed = identifier.trim().toLowerCase();

    // If no @ sign, add default domain
    if (!trimmed.includes('@')) {
      return `${trimmed}@${this.defaultDomain}`;
    }

    return trimmed;
  }

  /**
   * Validate a NIP-05 identifier format
   */
  isValid(identifier: string): boolean {
    const normalized = this.normalize(identifier);
    return NIP05_REGEX.test(normalized);
  }

  /**
   * Parse a NIP-05 identifier into username and domain
   */
  parse(identifier: string): { username: string; domain: string } {
    const normalized = this.normalize(identifier);
    const [username, domain] = normalized.split('@');
    return { username: username!, domain: domain! };
  }

  /**
   * Resolve a NIP-05 identifier to a public key
   *
   * @param identifier - NIP-05 identifier (user@domain or bare username)
   * @returns Resolution result with pubkey
   */
  async resolve(identifier: string): Promise<Nip05Result> {
    const normalized = this.normalize(identifier);

    // Validate format
    if (!this.isValid(normalized)) {
      return {
        success: false,
        error: `Invalid NIP-05 format: ${identifier}`,
      };
    }

    // If we have a NostrAdapter, use it
    if (this.nostrAdapter) {
      try {
        return await this.nostrAdapter.fetchNip05(normalized);
      } catch (error) {
        return {
          success: false,
          error: (error as Error).message,
        };
      }
    }

    // Otherwise, fetch directly
    return this.fetchDirect(normalized);
  }

  /**
   * Resolve and throw on failure
   */
  async resolveOrThrow(identifier: string): Promise<{ pubkey: string; relays: string[] }> {
    const result = await this.resolve(identifier);

    if (!result.success || !result.pubkey) {
      throw VoucherSendError.recipientNotFound(identifier, result.error);
    }

    return {
      pubkey: result.pubkey,
      relays: result.relays || [],
    };
  }

  /**
   * Fetch NIP-05 directly via .well-known endpoint
   */
  private async fetchDirect(nip05: string): Promise<Nip05Result> {
    const { username, domain } = this.parse(nip05);
    const url = `https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(username)}`;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      const response = await this.fetchFn(url, {
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
        },
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        return {
          success: false,
          error: `User "${nip05}" not found (HTTP ${response.status})`,
        };
      }

      const data = await response.json();
      const pubkey = data.names?.[username] || data.names?.[username.toLowerCase()];

      if (!pubkey) {
        return {
          success: false,
          error: `User "${nip05}" not found in nostr.json`,
        };
      }

      // Get relay hints if available
      const relays = data.relays?.[pubkey] || [];

      return {
        success: true,
        pubkey,
        relays,
      };
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        return {
          success: false,
          error: `NIP-05 resolution timed out for "${nip05}"`,
        };
      }

      return {
        success: false,
        error: `Failed to resolve "${nip05}": ${(error as Error).message}`,
      };
    }
  }
}

/**
 * Create a NIP-05 resolver instance
 */
export function createNip05Resolver(
  nostrAdapter?: NostrAdapter,
  config?: Nip05ResolverConfig
): Nip05Resolver {
  return new Nip05Resolver(nostrAdapter, config);
}
