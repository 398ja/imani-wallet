import type { DirectoryAdapter, LookupAdapter } from '../types/adapters.js';
import type { Profile, MerchantProfile } from '../types/profile.js';
import type { ProfileFilter, ProfileSearchResult } from '../types/filters.js';
import { normalizePubkey, isValidPubkey } from '../utils/validate.js';
import { networkError, rateLimitError } from '../types/errors.js';

/**
 * HTTP client interface for API requests
 * Compatible with fetch API or custom implementations
 */
export interface HttpClient {
  get<T>(url: string, options?: RequestOptions): Promise<T>;
  post<T>(url: string, body: unknown, options?: RequestOptions): Promise<T>;
}

/**
 * Request options for HTTP client
 */
export interface RequestOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/**
 * Default HTTP client using fetch
 */
export class FetchHttpClient implements HttpClient {
  private readonly baseUrl: string;
  private readonly defaultHeaders: Record<string, string>;

  constructor(baseUrl: string, headers?: Record<string, string>) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.defaultHeaders = {
      'Content-Type': 'application/json',
      ...headers,
    };
  }

  async get<T>(url: string, options?: RequestOptions): Promise<T> {
    const response = await fetch(`${this.baseUrl}${url}`, {
      method: 'GET',
      headers: { ...this.defaultHeaders, ...options?.headers },
      signal: options?.signal,
    });

    return this.handleResponse<T>(response);
  }

  async post<T>(url: string, body: unknown, options?: RequestOptions): Promise<T> {
    const response = await fetch(`${this.baseUrl}${url}`, {
      method: 'POST',
      headers: { ...this.defaultHeaders, ...options?.headers },
      body: JSON.stringify(body),
      signal: options?.signal,
    });

    return this.handleResponse<T>(response);
  }

  private async handleResponse<T>(response: Response): Promise<T> {
    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After');
      throw rateLimitError(retryAfter ? parseInt(retryAfter, 10) : undefined);
    }

    if (!response.ok) {
      throw networkError(`HTTP ${response.status}: ${response.statusText}`);
    }

    return response.json() as Promise<T>;
  }
}

/**
 * API response types
 */
interface ApiProfile {
  pubkey: string;
  name?: string;
  display_name?: string;
  picture?: string;
  banner?: string;
  about?: string;
  nip05?: string;
  lud16?: string;
  lud06?: string;
  website?: string;
  merchant_tags?: string[];
  currencies?: string[];
  location?: {
    lat: number;
    lon: number;
    address?: string;
    country?: string;
    city?: string;
  };
  created_at?: number;
}

interface ApiMerchantProfile {
  pubkey: string;
  business_name?: string;
  business_type?: string;
  currencies?: string[];
  payment_methods?: string[];
  location?: {
    lat: number;
    lon: number;
    address?: string;
    country?: string;
    city?: string;
  };
  hours?: Record<string, string>;
  verified?: boolean;
  verified_at?: number;
  created_at?: number;
  // Frontend camelCase fields (raw kind-30078 event content)
  active?: boolean;
  categories?: string[];
  paymentMethods?: string[];
  issuanceCurrency?: string;
  issuanceRatio?: number;
  voucherValidityDays?: number;
  businessName?: string;
  businessType?: string;
  createdAt?: number;
  [key: string]: unknown;
}

interface ApiSearchResponse {
  profiles: ApiProfile[];
  cursor?: string;
  total?: number;
}

interface ApiBatchResponse {
  profiles: ApiProfile[];
}

/**
 * Configuration for ImaniApiAdapter
 */
export interface ImaniApiAdapterConfig {
  /** Base URL for the Imani API */
  baseUrl: string;
  /** HTTP client instance (optional, uses fetch by default) */
  httpClient?: HttpClient;
  /** API key for authentication (optional) */
  apiKey?: string;
  /** Request timeout in ms (default: 10000) */
  timeoutMs?: number;
}

/**
 * ImaniApiAdapter provides profile operations via Imani HTTP API
 *
 * Implements both DirectoryAdapter and LookupAdapter for unified API access.
 * Uses the imani-sdk-node patterns for HTTP operations.
 */
export class ImaniApiAdapter implements DirectoryAdapter, LookupAdapter {
  private readonly httpClient: HttpClient;
  private readonly timeoutMs: number;

  constructor(config: ImaniApiAdapterConfig) {
    const headers: Record<string, string> = {};
    if (config.apiKey) {
      headers['Authorization'] = `Bearer ${config.apiKey}`;
    }

    this.httpClient = config.httpClient ?? new FetchHttpClient(config.baseUrl, headers);
    this.timeoutMs = config.timeoutMs ?? 10000;
  }

  /**
   * Search for profiles matching the filter
   */
  async search(filter: ProfileFilter): Promise<ProfileSearchResult> {
    const params = new URLSearchParams();

    if (filter.query) {
      params.set('q', filter.query);
    }
    if (filter.merchantOnly) {
      params.set('merchant_only', 'true');
    }
    if (filter.currencies && filter.currencies.length > 0) {
      params.set('currencies', filter.currencies.join(','));
    }
    if (filter.location) {
      params.set('lat', filter.location.lat.toString());
      params.set('lon', filter.location.lon.toString());
      params.set('radius_km', filter.location.radiusKm.toString());
    }
    if (filter.limit) {
      params.set('limit', filter.limit.toString());
    }
    if (filter.cursor) {
      params.set('cursor', filter.cursor);
    }

    const url = `/profiles/search?${params.toString()}`;

    const response = await this.request<ApiSearchResponse>(() =>
      this.httpClient.get<ApiSearchResponse>(url, { signal: this.createAbortSignal() })
    );

    return {
      profiles: response.profiles.map(this.mapApiProfile),
      cursor: response.cursor,
      totalCount: response.total,
    };
  }

  /**
   * Get search suggestions
   */
  async suggest(query: string): Promise<string[]> {
    const params = new URLSearchParams({ q: query });
    const url = `/profiles/suggest?${params.toString()}`;

    const response = await this.request<{ suggestions: string[] }>(() =>
      this.httpClient.get<{ suggestions: string[] }>(url, { signal: this.createAbortSignal() })
    );

    return response.suggestions;
  }

  /**
   * Get a single profile by pubkey
   */
  async getProfile(pubkey: string): Promise<Profile | null> {
    if (!isValidPubkey(pubkey)) {
      return null;
    }

    const normalized = normalizePubkey(pubkey);

    try {
      const response = await this.request<ApiProfile>(() =>
        this.httpClient.get<ApiProfile>(`/profiles/${normalized}`, {
          signal: this.createAbortSignal(),
        })
      );

      return this.mapApiProfile(response);
    } catch (error) {
      // Return null for 404 errors
      if (error instanceof Error && error.message.includes('404')) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Get multiple profiles by pubkey
   */
  async getProfiles(pubkeys: string[]): Promise<Profile[]> {
    const validPubkeys = pubkeys
      .filter(isValidPubkey)
      .map(normalizePubkey);

    if (validPubkeys.length === 0) {
      return [];
    }

    // Deduplicate
    const uniquePubkeys = [...new Set(validPubkeys)];

    const response = await this.request<ApiBatchResponse>(() =>
      this.httpClient.post<ApiBatchResponse>(
        '/profiles/batch',
        { pubkeys: uniquePubkeys },
        { signal: this.createAbortSignal() }
      )
    );

    return response.profiles.map(this.mapApiProfile);
  }

  /**
   * Get merchant profile
   */
  async getMerchantProfile(pubkey: string): Promise<MerchantProfile | null> {
    if (!isValidPubkey(pubkey)) {
      return null;
    }

    const normalized = normalizePubkey(pubkey);

    try {
      const response = await this.request<ApiMerchantProfile>(() =>
        this.httpClient.get<ApiMerchantProfile>(`/profiles/${normalized}/merchant`, {
          signal: this.createAbortSignal(),
        })
      );

      return this.mapApiMerchantProfile(response);
    } catch (error) {
      // Return null for 404 errors
      if (error instanceof Error && error.message.includes('404')) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Make a request with error handling
   */
  private async request<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          throw networkError('Request timeout');
        }
        throw error;
      }
      throw networkError('Unknown error');
    }
  }

  /**
   * Create an abort signal with timeout
   */
  private createAbortSignal(): AbortSignal {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), this.timeoutMs);
    return controller.signal;
  }

  /**
   * Map API profile to internal Profile type
   */
  private mapApiProfile = (api: ApiProfile): Profile => {
    return {
      pubkey: api.pubkey,
      name: api.name,
      displayName: api.display_name,
      picture: api.picture,
      banner: api.banner,
      about: api.about,
      nip05: api.nip05,
      lud16: api.lud16,
      lud06: api.lud06,
      website: api.website,
      merchantTags: api.merchant_tags,
      currencies: api.currencies,
      location: api.location,
      createdAt: api.created_at,
    };
  };

  /**
   * Map API merchant profile to internal MerchantProfile type
   */
  private mapApiMerchantProfile = (api: ApiMerchantProfile): MerchantProfile => {
    // The backend returns raw kind-30078 event content which may use either camelCase
    // (paymentMethods, issuanceCurrency) or snake_case (payment_methods, voucher_validity_days).
    // Map all known fields explicitly using camelCase only — DO NOT spread the raw response,
    // as that leaks snake_case fields into the cached profile causing merge conflicts later.
    const result: Record<string, unknown> = {
      pubkey: api.pubkey,
      businessName: api.business_name ?? api.businessName,
      businessType: api.business_type ?? api.businessType,
      categories: api.categories ?? [],
      currencies: api.currencies ?? api.categories ?? [],
      paymentMethods: api.payment_methods ?? api.paymentMethods ?? [],
      location: api.location,
      hours: api.hours,
      verified: api.verified,
      verifiedAt: api.verified_at ?? (api as Record<string, unknown>).verifiedAt,
      createdAt: api.created_at ?? api.createdAt,
      // App-specific fields from kind-30078 event content
      active: api.active,
      issuanceCurrency: api.issuanceCurrency ?? (api as Record<string, unknown>).issuance_currency,
      issuanceRatio: api.issuanceRatio ?? (api as Record<string, unknown>).issuance_ratio,
      voucherValidityDays: api.voucherValidityDays ?? (api as Record<string, unknown>).voucher_validity_days,
    };
    // Strip undefined values so they don't interfere with downstream merges
    return Object.fromEntries(
      Object.entries(result).filter(([, v]) => v !== undefined)
    ) as unknown as MerchantProfile;
  };
}

/**
 * Create an ImaniApiAdapter instance
 */
export function createImaniApiAdapter(config: ImaniApiAdapterConfig): ImaniApiAdapter {
  return new ImaniApiAdapter(config);
}
