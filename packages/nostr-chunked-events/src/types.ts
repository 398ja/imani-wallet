import type { Event, UnsignedEvent } from 'nostr-tools';

// ============================================================================
// Core Types
// ============================================================================

/**
 * A chunk of content with metadata
 */
export interface Chunk {
  /** 0-based chunk index */
  index: number;
  /** Total number of chunks */
  total: number;
  /** Chunk content */
  data: string;
  /** Generated d-tag (e.g., "mydata-chunk-0") */
  dTag: string;
}

/**
 * Chunk data extracted from an event
 */
export interface ChunkData {
  /** 0-based chunk index */
  index: number;
  /** Total number of chunks */
  total: number;
  /** Chunk content */
  data: string;
}

/**
 * Additional metadata extracted from a chunk event
 */
export interface ChunkMetadata {
  /** Snapshot identifier shared across all chunks in a snapshot */
  snapshotId?: string;
  /** Hash of the reconstructed payload */
  payloadHash?: string;
  /** Hash algorithm for payloadHash */
  hashAlg?: string;
  /** Explicit total chunk count tag value */
  totalChunksTag?: number;
  /** Author pubkey for the source event */
  author?: string;
  /** Event timestamp */
  createdAt?: number;
  /** Source event ID */
  eventId?: string;
  /** Source event d-tag */
  dTag?: string;
  /** Parent ancestry references (undefined for legacy pre-ancestry snapshots) */
  parents?: SnapshotParentReference[];
}

/**
 * Ordered ancestry reference to a parent snapshot.
 */
export interface SnapshotParentReference {
  /** Parent snapshot identifier */
  snapshotId: string;
  /** Parent snapshot content hash */
  contentHash: string;
}

/**
 * Rich chunk data extracted from a source event
 */
export interface ChunkEventData extends ChunkData, ChunkMetadata {
  /** Original source event */
  rawEvent?: Event;
}

/**
 * Options for creating chunks
 */
export interface ChunkOptions {
  /** Maximum bytes per chunk (default: 300KB) */
  chunkSize?: number;
  /** d-tag prefix (e.g., "wallet", "backup") */
  dTagPrefix?: string;
}

/**
 * Result of chunk validation
 */
export interface ValidationResult {
  /** Whether all chunks are present and valid */
  valid: boolean;
  /** Indices of missing chunks */
  missing: number[];
  /** Indices with duplicate chunks */
  duplicates: number[];
}

/**
 * Validation issue from strict snapshot validation
 */
export interface SnapshotValidationIssue {
  code:
    | 'empty'
    | 'wrong_author'
    | 'mixed_snapshot'
    | 'duplicate_index'
    | 'missing_snapshot_id'
    | 'inconsistent_total'
    | 'inconsistent_payload_hash'
    | 'inconsistent_parents'
    | 'missing_payload_hash'
    | 'unsupported_hash_alg'
    | 'missing_index'
    | 'payload_hash_mismatch';
  message: string;
  chunkIndex?: number;
  eventId?: string;
}

/**
 * Options for strict snapshot validation
 */
export interface SnapshotValidationOptions {
  /** Require all events to match this author */
  expectedAuthor?: string;
  /** Require consistent metadata across the candidate set (default: true) */
  requireConsistentMetadata?: boolean;
  /** Require snapshot_id on all chunks when strict metadata is in use */
  requireSnapshotId?: boolean;
  /** Require payload_hash on all chunks when strict metadata is in use */
  requirePayloadHash?: boolean;
  /** Verify reconstructed payload hash when payload_hash is present */
  verifyPayloadHash?: boolean;
  /** Allow legacy chunk sets without strict metadata (default: true) */
  allowLegacy?: boolean;
  /** Custom hashing function for payload verification */
  hashFn?: (algorithm: string, content: string) => Promise<string>;
}

/**
 * Result of strict snapshot validation
 */
export interface SnapshotValidationResult {
  /** Whether the candidate snapshot is valid */
  valid: boolean;
  /** Snapshot ID for this candidate, if present */
  snapshotId: string | null;
  /** Deduped and sorted chunks used for evaluation */
  chunks: ChunkEventData[];
  /** Expected chunk count for the candidate */
  totalChunks: number;
  /** Validation issues */
  issues: SnapshotValidationIssue[];
  /** Whether the candidate used legacy metadata rules */
  legacyFormat: boolean;
  /** Whether payload hash verification was performed successfully */
  payloadHashVerified: boolean;
}

/**
 * Minimal snapshot shape used by ancestry helpers.
 */
export interface AncestrySnapshotLike {
  /** Snapshot identifier */
  snapshotId?: string | null;
  /** Snapshot content hash (or payload hash in raw chunk metadata) */
  contentHash?: string | null;
  /** Raw chunk payload hash, accepted as an alias for contentHash */
  payloadHash?: string | null;
  /** Ordered ancestry references (undefined for legacy snapshots) */
  parents?: SnapshotParentReference[];
}

/**
 * Group of chunk events belonging to one candidate snapshot
 */
export interface SnapshotCandidate {
  /** Snapshot ID shared by grouped chunks, or null for legacy groups */
  snapshotId: string | null;
  /** Newest timestamp seen in this candidate */
  newestCreatedAt: number;
  /** Raw parsed chunks that belong to this candidate */
  chunks: ChunkEventData[];
}

/**
 * Options for choosing the best chunk snapshot
 */
export interface SnapshotSelectionOptions extends SnapshotValidationOptions {
  /** How to choose among competing snapshots (default: newest-valid) */
  strategy?: 'newest-valid' | 'newest-seen';
}

/**
 * Result of choosing a best chunk snapshot
 */
export interface SnapshotSelectionResult {
  /** Selected candidate snapshot, if any */
  selected: SnapshotCandidate | null;
  /** Validation result for the selected candidate */
  validation: SnapshotValidationResult | null;
  /** Rejected candidates and their validation failures */
  rejected: Array<{
    candidate: SnapshotCandidate;
    validation: SnapshotValidationResult;
  }>;
}

// ============================================================================
// Compression Types
// ============================================================================

/**
 * Result of compression operation
 */
export interface CompressionResult {
  /** Compressed data (base64 encoded) */
  data: string;
  /** Original size in bytes */
  originalSize: number;
  /** Compressed size in bytes */
  compressedSize: number;
  /** Compression ratio (compressedSize / originalSize) */
  ratio: number;
}

// ============================================================================
// Signer Types
// ============================================================================

/**
 * Interface for signing Nostr events
 */
export interface Signer {
  /** Sign an unsigned event and return the signed event */
  signEvent: (event: UnsignedEvent) => Promise<Event>;
  /** Get the signer's public key in hex format */
  getPublicKey: () => Promise<string>;
}

// ============================================================================
// Publisher Types
// ============================================================================

/**
 * Options for the ChunkedPublisher constructor
 */
export interface PublisherOptions {
  /** Default relay URLs to publish to */
  defaultRelays?: string[];
  /** Enable gzip compression (default: false) */
  compression?: boolean;
  /** Delete orphaned chunks when chunk count decreases (default: false) */
  deleteOrphanedChunks?: boolean;
  /** NIP-42 authentication callback */
  authHandler?: (challenge: string) => Promise<Event>;
  /** Connection timeout in ms (default: 10000) */
  timeout?: number;
}

/**
 * Options for a publish operation
 */
export interface PublishOptions {
  /** Event kind (e.g., 30078, 37375) */
  kind: number;
  /** Prefix for d-tags (e.g., "wallet", "article") */
  dTagPrefix: string;
  /** Target relay URLs (uses defaultRelays if not specified) */
  relayUrls?: string[];
  /** Additional tags to include on all events */
  additionalTags?: string[][];
  /** Progress callback */
  onProgress?: (published: number, total: number) => void;
}

/**
 * Result of a publish operation
 */
export interface PublishResult {
  /** Whether the publish was successful */
  success: boolean;
  /** Whether content was chunked */
  chunked: boolean;
  /** Whether compression was applied */
  compressed: boolean;
  /** Number of chunks published */
  chunkCount: number;
  /** Event IDs of all published events */
  eventIds: string[];
  /** Timestamp when published */
  publishedAt: number;
  /** Original content size in bytes */
  originalSize: number;
  /** Final size after compression (if applied) */
  finalSize: number;
  /** Error message if failed */
  error?: string;
}

// ============================================================================
// Fetcher Types
// ============================================================================

/**
 * Options for the ChunkedFetcher constructor
 */
export interface FetcherOptions {
  /** Default relay URLs to fetch from */
  defaultRelays?: string[];
  /** NIP-42 authentication callback */
  authHandler?: (challenge: string) => Promise<Event>;
  /** Query timeout in ms (default: 10000) */
  timeout?: number;
  /**
   * Use backend API when available (default: true)
   * When nostrApi is available, queries will use the backend API
   * which handles chunk reassembly transparently via nostrdb.
   */
  useApi?: boolean;
}

/**
 * Options for a fetch operation
 */
export interface FetchOptions {
  /** Event kind to query */
  kind: number;
  /** d-tag prefix to look for */
  dTagPrefix: string;
  /** Relay URLs to query (uses defaultRelays if not specified) */
  relayUrls?: string[];
  /** Query timeout in ms */
  timeout?: number;
  /** Filter by author pubkey (optional, uses pubkey param if not set) */
  author?: string;
  /** Strict snapshot selection and validation options */
  snapshotSelection?: SnapshotSelectionOptions;
}

/**
 * Result of a fetch operation
 */
export interface FetchResult {
  /** Whether the fetch was successful */
  success: boolean;
  /** Reassembled content (null if not found) */
  content: string | null;
  /** Whether data was chunked */
  chunked: boolean;
  /** Number of chunks retrieved */
  chunkCount: number;
  /** Raw events retrieved */
  events: Event[];
  /** Whether content was compressed */
  compressed: boolean;
  /** Selected snapshot ID, if applicable */
  snapshotId?: string | null;
  /** Validation result for strict snapshot selection */
  validation?: SnapshotValidationResult;
  /** Rejected candidate snapshots during strict selection */
  rejectedSnapshots?: Array<{
    snapshotId: string | null;
    issues: SnapshotValidationIssue[];
  }>;
  /** Error message if failed */
  error?: string;
}

/**
 * Result of probing for chunked data
 */
export interface ProbeResult {
  /** Whether any data exists */
  exists: boolean;
  /** Whether data is chunked */
  chunked: boolean;
  /** Number of chunks (1 if not chunked) */
  chunkCount: number;
}

// ============================================================================
// Relay Types
// ============================================================================

/**
 * Options for relay connections
 */
export interface RelayOptions {
  /** Connection/query timeout in ms */
  timeout?: number;
  /** Number of retry attempts on failure */
  retries?: number;
  /** NIP-42 authentication callback */
  authHandler?: (challenge: string) => Promise<Event>;
}

/**
 * Response from a relay publish operation
 */
export interface RelayPublishResponse {
  /** Whether the publish was successful */
  success: boolean;
  /** Relay URL */
  relay: string;
  /** Response message from relay */
  message?: string;
}

// ============================================================================
// Constants for external use
// ============================================================================

export const LIBRARY_VERSION = '1';
export const CLIENT_TAG = 'nostr-chunked-events';
