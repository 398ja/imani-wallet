import type { Nip05Result, Nip05Resolver as INip05Resolver, CacheStore } from '../types/index.js';
import { nip05ResolutionError, validationError } from '../types/errors.js';
import { validateNip05 } from '../utils/validate.js';

/**
 * Configuration for NIP-05 resolver
 */
export interface Nip05ResolverConfig {
  /** Cache store for resolved identifiers */
  cache?: CacheStore<Nip05Result>;
  /** Timeout for HTTP requests in ms */
  timeoutMs?: number;
  /** Custom fetch function (for testing/SSR) */
  fetch?: typeof globalThis.fetch;
}

/**
 * Default timeout for NIP-05 HTTP requests
 */
const DEFAULT_TIMEOUT_MS = 5000;

/**
 * NIP-05 resolver with HTTP fetch and caching
 * Resolves identifiers like "user@domain.com" to pubkeys and relays
 */
export class Nip05Resolver implements INip05Resolver {
  private readonly cache?: CacheStore<Nip05Result>;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly pendingRequests = new Map<string, Promise<Nip05Result | null>>();

  constructor(config: Nip05ResolverConfig = {}) {
    this.cache = config.cache;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchFn = config.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * Resolve a NIP-05 identifier without caching
   */
  async resolve(identifier: string): Promise<Nip05Result | null> {
    // Validate identifier format
    try {
      validateNip05(identifier);
    } catch {
      throw validationError(`Invalid NIP-05 identifier: ${identifier}`);
    }

    const normalizedId = identifier.toLowerCase();

    // Deduplicate concurrent requests for same identifier
    const pending = this.pendingRequests.get(normalizedId);
    if (pending) {
      return pending;
    }

    const fetchPromise = this.fetchNip05(normalizedId);
    this.pendingRequests.set(normalizedId, fetchPromise);

    try {
      return await fetchPromise;
    } finally {
      this.pendingRequests.delete(normalizedId);
    }
  }

  /**
   * Resolve with caching (preferred method)
   */
  async resolveWithCache(identifier: string): Promise<Nip05Result | null> {
    // Validate identifier format
    try {
      validateNip05(identifier);
    } catch {
      throw validationError(`Invalid NIP-05 identifier: ${identifier}`);
    }

    const normalizedId = identifier.toLowerCase();
    const cacheKey = `nip05:${normalizedId}`;

    // Check cache first
    if (this.cache) {
      const cached = await this.cache.get(cacheKey);
      if (cached) {
        return cached;
      }
    }

    // Resolve and cache
    const result = await this.resolve(normalizedId);

    if (result && this.cache) {
      await this.cache.set(cacheKey, result);
    }

    return result;
  }

  /**
   * Fetch NIP-05 data from domain's well-known endpoint
   */
  private async fetchNip05(identifier: string): Promise<Nip05Result | null> {
    const [name, domain] = identifier.split('@');
    const wellKnownUrl = `https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

      const response = await this.fetchFn(wellKnownUrl, {
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
        },
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        return null;
      }

      const data = (await response.json()) as NIP05WellKnownResponse;

      // Look up pubkey (case-insensitive)
      const pubkey = data.names?.[name] ?? data.names?.[name.toLowerCase()];
      if (!pubkey) {
        return null;
      }

      // Get relays if available
      const relays = data.relays?.[pubkey] ?? [];

      return {
        pubkey,
        relays,
        identifier,
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw nip05ResolutionError(identifier, new Error('Request timed out'));
      }
      throw nip05ResolutionError(identifier, error instanceof Error ? error : undefined);
    }
  }

  /**
   * Clear pending requests (for cleanup)
   */
  clearPending(): void {
    this.pendingRequests.clear();
  }
}

/**
 * NIP-05 well-known response format
 */
interface NIP05WellKnownResponse {
  names?: Record<string, string>;
  relays?: Record<string, string[]>;
}

/**
 * Create a NIP-05 resolver with default configuration
 */
export function createNip05Resolver(
  config: Nip05ResolverConfig = {}
): Nip05Resolver {
  return new Nip05Resolver(config);
}
