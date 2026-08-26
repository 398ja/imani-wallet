/**
 * SendConfig
 *
 * Configuration options for the VoucherSender.
 */

/**
 * Chunking configuration
 */
export interface ChunkingConfig {
  /** Enable auto-chunking for large tokens (default: true) */
  enabled: boolean;

  /** Size threshold in bytes before chunking (default: 40000) */
  threshold: number;

  /** Size per chunk in bytes (default: 30000) */
  chunkSize: number;

  /** Enable gzip compression before chunking (default: false) */
  compression: boolean;

  /** Publish chunks in parallel (default: true) */
  parallelPublish: boolean;
}

/**
 * Relay configuration
 */
export interface RelayConfig {
  /** Infrastructure relay URL (always included) */
  infraRelay?: string;

  /** Default relay URLs */
  defaultRelays?: string[];

  /** Maximum relays to publish to (default: 5) */
  maxRelays?: number;

  /** Connection timeout in ms (default: 5000) */
  connectionTimeout?: number;
}

/**
 * NIP-60 configuration
 */
export interface Nip60Config {
  /** Enable NIP-60 proof publishing (default: false) */
  enabled: boolean;

  /** Relay URLs for NIP-60 events */
  relays?: string[];
}

/**
 * Send configuration
 */
export interface SendConfigOptions {
  /** Chunking configuration */
  chunking?: Partial<ChunkingConfig>;

  /** Relay configuration */
  relay?: Partial<RelayConfig>;

  /** NIP-60 configuration */
  nip60?: Partial<Nip60Config>;

  /** Default NIP-05 domain for usernames without @ */
  defaultNip05Domain?: string;

  /** Request timeout in ms (default: 30000) */
  timeout?: number;

  /** Enable debug logging (default: false) */
  debug?: boolean;
}

/**
 * Default configuration values
 */
const DEFAULT_CHUNKING: ChunkingConfig = {
  enabled: true,
  threshold: 40_000,
  chunkSize: 30_000,
  compression: false,
  parallelPublish: true,
};

const DEFAULT_RELAY: Required<RelayConfig> = {
  infraRelay: undefined as unknown as string,
  defaultRelays: [],
  maxRelays: 5,
  connectionTimeout: 5000,
};

const DEFAULT_NIP60: Nip60Config = {
  enabled: false,
  relays: [],
};

/**
 * SendConfig class
 *
 * Manages configuration with defaults and validation.
 */
export class SendConfig {
  readonly chunking: ChunkingConfig;
  readonly relay: Required<RelayConfig>;
  readonly nip60: Nip60Config;
  readonly defaultNip05Domain: string;
  readonly timeout: number;
  readonly debug: boolean;

  constructor(options: SendConfigOptions = {}) {
    this.chunking = {
      ...DEFAULT_CHUNKING,
      ...options.chunking,
    };

    this.relay = {
      ...DEFAULT_RELAY,
      ...options.relay,
    };

    this.nip60 = {
      ...DEFAULT_NIP60,
      ...options.nip60,
    };

    this.defaultNip05Domain = options.defaultNip05Domain || 'imani.casa';
    this.timeout = options.timeout || 30_000;
    this.debug = options.debug || false;
  }

  /**
   * Create config from partial options
   */
  static create(options?: SendConfigOptions): SendConfig {
    return new SendConfig(options);
  }

  /**
   * Get infra relay if configured
   */
  getInfraRelay(): string | undefined {
    return this.relay.infraRelay;
  }

  /**
   * Get all default relay URLs
   */
  getDefaultRelays(): string[] {
    const relays: string[] = [];
    if (this.relay.infraRelay) {
      relays.push(this.relay.infraRelay);
    }
    relays.push(...(this.relay.defaultRelays || []));
    return relays;
  }

  /**
   * Check if chunking should be applied for a given size
   */
  shouldChunk(sizeBytes: number): boolean {
    if (!this.chunking.enabled) return false;
    // Estimate encrypted size (base64 + NIP-44 overhead ~40%)
    const estimatedSize = sizeBytes * 1.4;
    return estimatedSize > this.chunking.threshold;
  }

  /**
   * Log debug message if debug is enabled
   */
  log(...args: unknown[]): void {
    if (this.debug) {
      console.log('[VoucherSend]', ...args);
    }
  }
}
