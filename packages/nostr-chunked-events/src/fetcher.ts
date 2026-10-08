/**
 * Chunked event fetcher
 * Handles automatic detection, fetching, and reassembly of chunked content
 *
 * Backend API Integration:
 * When nostrApi is available, the fetcher can use the backend API
 * which handles chunk reassembly transparently via nostrdb.
 * This simplifies the client-side code and improves performance.
 */

import type { Event, Filter } from 'nostr-tools';
import {
  filterEventsByAuthor,
  parseChunkEvent,
  parseChunkFromEvent,
  hasMigrationMarker,
  getCompressionType,
  reassembleChunks,
  reassembleSnapshot,
  selectBestSnapshot,
  validateChunks,
} from './reassembler';
import { getChunkDTag, getSingleEventDTag } from './chunker';
import { tryDecompress } from './compression';
import { RelayPool } from './relay';
import type { FetcherOptions, FetchOptions, FetchResult, ProbeResult } from './types';

const STRICT_CHUNK0_LIMIT = 10;

/**
 * Check if nostrApi is available in the global scope
 */
function isApiAvailable(): boolean {
  return typeof (globalThis as any).nostrApi !== 'undefined' &&
         typeof (globalThis as any).nostrApi.queryEvents === 'function';
}

/**
 * Fetcher for chunked events
 *
 * Automatically handles:
 * - Detection of chunked vs single events
 * - Fetching all chunks
 * - Reassembly and validation
 * - Decompression
 *
 * @example
 * ```ts
 * const fetcher = new ChunkedFetcher({
 *   defaultRelays: ['wss://relay.example.com']
 * });
 *
 * const result = await fetcher.fetch(pubkey, {
 *   kind: 30078,
 *   dTagPrefix: 'myapp-data'
 * });
 *
 * if (result.success) {
 *   console.log('Content:', result.content);
 * }
 * ```
 */
export class ChunkedFetcher {
  private options: FetcherOptions;

  constructor(options?: FetcherOptions) {
    this.options = {
      defaultRelays: options?.defaultRelays ?? [],
      authHandler: options?.authHandler,
      timeout: options?.timeout,
      useApi: options?.useApi ?? true, // Default to using API when available
    };
  }

  /**
   * Check if we should use the backend API
   */
  private shouldUseApi(): boolean {
    return this.options.useApi !== false && isApiAvailable();
  }

  /**
   * Fetch and reassemble content from relays
   *
   * Automatically detects chunked vs single event format.
   * When nostrApi is available, uses the backend API which handles
   * chunk reassembly transparently via nostrdb.
   *
   * @param pubkey - Author's public key in hex
   * @param options - Fetch options
   * @returns Fetch result with reassembled content
   */
  async fetch(pubkey: string, options: FetchOptions): Promise<FetchResult> {
    // Try API-backed fetch first (backend handles reassembly)
    if (this.shouldUseApi() && !options.snapshotSelection) {
      try {
        return await this.fetchWithApi(pubkey, options);
      } catch (error) {
        console.warn('[ChunkedFetcher] API fetch failed, falling back to relay:', error);
        // Fall through to relay-based fetch
      }
    }

    const relayUrls = options.relayUrls ?? this.options.defaultRelays ?? [];

    if (relayUrls.length === 0) {
      return {
        success: false,
        content: null,
        chunked: false,
        chunkCount: 0,
        events: [],
        compressed: false,
        error: 'No relay URLs provided',
      };
    }

    const pool = new RelayPool(relayUrls, {
      timeout: options.timeout ?? this.options.timeout,
      authHandler: this.options.authHandler,
    });

    try {
      const author = options.author ?? pubkey;
      const useStrictSelection = Boolean(options.snapshotSelection);

      // Strategy: Try chunked format first (query for chunk-0)
      const chunk0DTag = getChunkDTag(options.dTagPrefix, 0);
      const chunk0Filter: Filter = {
        kinds: [options.kind],
        authors: [author],
        '#d': [chunk0DTag],
        limit: useStrictSelection ? STRICT_CHUNK0_LIMIT : 1,
      };

      const chunk0Events = this.filterExactAuthor(await pool.query(chunk0Filter), author);

      if (chunk0Events.length > 0) {
        // Found chunked data - fetch all chunks
        return await this.fetchChunkedData(pool, author, options, chunk0Events);
      }

      // No chunked data found - try single event format
      const stateDTag = getSingleEventDTag(options.dTagPrefix);
      const stateFilter: Filter = {
        kinds: [options.kind],
        authors: [author],
        '#d': [stateDTag],
        limit: 1,
      };

      const stateEvents = this.filterExactAuthor(await pool.query(stateFilter), author);

      if (stateEvents.length === 0) {
        return {
          success: false,
          content: null,
          chunked: false,
          chunkCount: 0,
          events: [],
          compressed: false,
          error: 'No data found',
        };
      }

      const stateEvent = stateEvents[0];

      // Check for migration marker
      if (hasMigrationMarker(stateEvent)) {
        return {
          success: false,
          content: null,
          chunked: false,
          chunkCount: 0,
          events: [stateEvent],
          compressed: false,
          error: 'Data migrated to chunks but chunks not found',
        };
      }

      // Single event - check for compression and return
      const compressionType = getCompressionType(stateEvent);
      const isCompressed = compressionType !== null;
      const content = tryDecompress(stateEvent.content, isCompressed);

      return {
        success: true,
        content,
        chunked: false,
        chunkCount: 1,
        events: [stateEvent],
        compressed: isCompressed,
        snapshotId: null,
      };
    } catch (error) {
      return {
        success: false,
        content: null,
        chunked: false,
        chunkCount: 0,
        events: [],
        compressed: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    } finally {
      pool.close();
    }
  }

  /**
   * Fetch and parse content as JSON
   *
   * @param pubkey - Author's public key in hex
   * @param options - Fetch options
   * @returns Fetch result with parsed JSON data
   */
  async fetchJSON<T>(
    pubkey: string,
    options: FetchOptions
  ): Promise<FetchResult & { data: T | null }> {
    const result = await this.fetch(pubkey, options);

    if (!result.success || !result.content) {
      return { ...result, data: null };
    }

    try {
      const data = JSON.parse(result.content) as T;
      return { ...result, data };
    } catch (error) {
      return {
        ...result,
        success: false,
        data: null,
        error: 'Failed to parse JSON',
      };
    }
  }

  /**
   * Probe for existence of chunked data without fetching all content
   *
   * @param pubkey - Author's public key in hex
   * @param options - Fetch options
   * @returns Probe result with existence and chunk info
   */
  async probe(pubkey: string, options: FetchOptions): Promise<ProbeResult> {
    // Try API-backed probe first
    if (this.shouldUseApi()) {
      try {
        const result = await this.probeWithApi(pubkey, options);
        if (result.exists) return result;
      } catch (error) {
        console.warn('[ChunkedFetcher] API probe failed, falling back to relay:', error);
      }
    }

    const relayUrls = options.relayUrls ?? this.options.defaultRelays ?? [];

    if (relayUrls.length === 0) {
      return { exists: false, chunked: false, chunkCount: 0 };
    }

    const pool = new RelayPool(relayUrls, {
      timeout: options.timeout ?? this.options.timeout,
      authHandler: this.options.authHandler,
    });

    try {
      const author = options.author ?? pubkey;

      // Check for chunk-0
      const chunk0DTag = getChunkDTag(options.dTagPrefix, 0);
      const chunk0Filter: Filter = {
        kinds: [options.kind],
        authors: [author],
        '#d': [chunk0DTag],
        limit: 1,
      };

      const chunk0Events = this.filterExactAuthor(await pool.query(chunk0Filter), author);

      if (chunk0Events.length > 0) {
        const chunkData = parseChunkFromEvent(chunk0Events[0]);
        return {
          exists: true,
          chunked: true,
          chunkCount: chunkData?.total ?? 1,
        };
      }

      // Check for single event
      const stateDTag = getSingleEventDTag(options.dTagPrefix);
      const stateFilter: Filter = {
        kinds: [options.kind],
        authors: [author],
        '#d': [stateDTag],
        limit: 1,
      };

      const stateEvents = this.filterExactAuthor(await pool.query(stateFilter), author);

      if (stateEvents.length > 0) {
        const stateEvent = stateEvents[0];
        if (hasMigrationMarker(stateEvent)) {
          return { exists: false, chunked: false, chunkCount: 0 };
        }
        return { exists: true, chunked: false, chunkCount: 1 };
      }

      return { exists: false, chunked: false, chunkCount: 0 };
    } finally {
      pool.close();
    }
  }

  private filterExactAuthor(events: Event[], author: string): Event[] {
    return filterEventsByAuthor(events, author);
  }

  private async queryAllChunkEvents(
    pool: RelayPool,
    author: string,
    options: FetchOptions,
    chunk0Events: Event[],
  ): Promise<Event[]> {
    const totals = chunk0Events
      .map((event) => parseChunkEvent(event)?.total ?? 0)
      .filter((total) => total > 0);

    const maxTotal = Math.max(...totals, 1);
    const chunkDTags = Array.from({ length: maxTotal }, (_value, index) =>
      getChunkDTag(options.dTagPrefix, index),
    );

    const allChunkEvents = await pool.query({
      kinds: [options.kind],
      authors: [author],
      '#d': chunkDTags,
    });

    return this.filterExactAuthor(allChunkEvents, author);
  }

  /**
   * Fetch all chunks and reassemble
   */
  private async fetchChunkedData(
    pool: RelayPool,
    author: string,
    options: FetchOptions,
    chunk0Events: Event[]
  ): Promise<FetchResult> {
    const useStrictSelection = Boolean(options.snapshotSelection);
    const firstChunk0 = chunk0Events[0];

    if (!firstChunk0 || !parseChunkFromEvent(firstChunk0)) {
      return {
        success: false,
        content: null,
        chunked: true,
        chunkCount: 0,
        events: chunk0Events,
        compressed: false,
        error: 'Invalid chunk-0 event',
      };
    }

    const allEvents = useStrictSelection
      ? await this.queryAllChunkEvents(pool, author, options, chunk0Events)
      : [];

    if (useStrictSelection) {
      const selection = await selectBestSnapshot(allEvents, {
        strategy: 'newest-valid',
        expectedAuthor: author,
        allowLegacy: true,
        verifyPayloadHash: true,
        ...options.snapshotSelection,
      });

      if (!selection.selected || !selection.validation) {
        const firstRejected = selection.rejected[0]?.validation.issues[0];
        return {
          success: false,
          content: null,
          chunked: true,
          chunkCount: 0,
          events: allEvents,
          compressed: false,
          rejectedSnapshots: selection.rejected.map(({ candidate, validation }) => ({
            snapshotId: candidate.snapshotId,
            issues: validation.issues,
          })),
          error: firstRejected?.message || 'No valid chunk snapshot found',
        };
      }

      try {
        const { content: reassembled, validation } = await reassembleSnapshot(
          selection.selected.chunks,
          {
            expectedAuthor: author,
            allowLegacy: true,
            verifyPayloadHash: true,
            ...options.snapshotSelection,
          },
        );

        const compressionType = getCompressionType(selection.selected.chunks[0]?.rawEvent ?? firstChunk0);
        const isCompressed = compressionType !== null;
        const content = tryDecompress(reassembled, isCompressed);

        return {
          success: true,
          content,
          chunked: true,
          chunkCount: validation.totalChunks,
          events: selection.selected.chunks
            .map((chunk) => chunk.rawEvent)
            .filter((event): event is Event => Boolean(event)),
          compressed: isCompressed,
          snapshotId: validation.snapshotId,
          validation,
          rejectedSnapshots: selection.rejected.map(({ candidate, validation: rejectedValidation }) => ({
            snapshotId: candidate.snapshotId,
            issues: rejectedValidation.issues,
          })),
        };
      } catch (error) {
        return {
          success: false,
          content: null,
          chunked: true,
          chunkCount: selection.validation.totalChunks,
          events: allEvents,
          compressed: false,
          snapshotId: selection.validation.snapshotId,
          validation: selection.validation,
          rejectedSnapshots: selection.rejected.map(({ candidate, validation }) => ({
            snapshotId: candidate.snapshotId,
            issues: validation.issues,
          })),
          error: error instanceof Error ? error.message : 'Reassembly failed',
        };
      }
    }

    const chunk0Data = parseChunkFromEvent(firstChunk0);
    if (!chunk0Data) {
      return {
        success: false,
        content: null,
        chunked: true,
        chunkCount: 0,
        events: [firstChunk0],
        compressed: false,
        error: 'Invalid chunk-0 event',
      };
    }

    const totalChunks = chunk0Data.total;
    const legacyEvents: Event[] = [firstChunk0];
    const legacyChunks = [chunk0Data];

    if (totalChunks > 1) {
      const fetchPromises: Promise<Event[]>[] = [];

      for (let i = 1; i < totalChunks; i++) {
        fetchPromises.push(pool.query({
          kinds: [options.kind],
          authors: [author],
          '#d': [getChunkDTag(options.dTagPrefix, i)],
          limit: 1,
        }));
      }

      const results = await Promise.all(fetchPromises);
      for (const events of results) {
        const exactAuthorEvents = this.filterExactAuthor(events, author);
        if (exactAuthorEvents.length === 0) {
          continue;
        }
        const event = exactAuthorEvents[0];
        legacyEvents.push(event);
        const chunkData = parseChunkFromEvent(event);
        if (chunkData) {
          legacyChunks.push(chunkData);
        }
      }
    }

    try {
      const validation = validateChunks(legacyChunks);
      if (!validation.valid) {
        const error = validation.missing.length > 0
          ? `Missing chunks: ${validation.missing.join(', ')}`
          : validation.duplicates.length > 0
            ? `Duplicate chunks: ${validation.duplicates.join(', ')}`
            : 'Invalid chunks';
        throw new Error(error);
      }

      const reassembled = reassembleChunks(legacyChunks);
      const compressionType = getCompressionType(firstChunk0);
      const content = tryDecompress(reassembled, compressionType !== null);

      return {
        success: true,
        content,
        chunked: true,
        chunkCount: totalChunks,
        events: legacyEvents,
        compressed: getCompressionType(firstChunk0) !== null,
        snapshotId: null,
      };
    } catch (error) {
      return {
        success: false,
        content: null,
        chunked: true,
        chunkCount: legacyChunks.length,
        events: legacyEvents,
        compressed: false,
        error: error instanceof Error ? error.message : 'Reassembly failed',
      };
    }
  }

  // ==================== API-BACKED FETCH ====================

  /**
   * Fetch content via backend API
   *
   * The backend handles chunk reassembly transparently via nostrdb,
   * so this method returns already-reassembled content.
   *
   * @param pubkey - Author's public key in hex
   * @param options - Fetch options
   * @returns Fetch result with reassembled content
   */
  private async fetchWithApi(pubkey: string, options: FetchOptions): Promise<FetchResult> {
    const nostrApi = (globalThis as any).nostrApi;
    const author = options.author ?? pubkey;

    console.log('[ChunkedFetcher] Using API-backed fetch for kind:', options.kind);

    // Query via API - backend returns events with chunks already reassembled
    // Query for both single event and chunked formats
    const singleDTag = getSingleEventDTag(options.dTagPrefix);
    const chunk0DTag = getChunkDTag(options.dTagPrefix, 0);

    // Query for single event format
    const events = this.filterExactAuthor(await nostrApi.queryEvents({
      kinds: [options.kind],
      authors: [author],
      tags: { '#d': [singleDTag] },
      limit: 1
    }), author);

    if (events.length > 0) {
      const event = events[0] as Event;

      // Check for migration marker
      if (hasMigrationMarker(event)) {
        // Data was migrated to chunks, but backend should have reassembled it
        // This shouldn't happen if backend is working correctly
        console.warn('[ChunkedFetcher] Found migration marker but expected reassembled content');
      }

      // Check for compression
      const compressionType = getCompressionType(event);
      const isCompressed = compressionType !== null;
      const content = tryDecompress(event.content, isCompressed);

      return {
        success: true,
        content,
        chunked: false,
        chunkCount: 1,
        events: [event],
        compressed: isCompressed,
      };
    }

    // If no single event found, check for chunk-0 to see if it's chunked
    // (Backend should have reassembled, but we verify)
    const chunk0Events = this.filterExactAuthor(await nostrApi.queryEvents({
      kinds: [options.kind],
      authors: [author],
      tags: { '#d': [chunk0DTag] },
      limit: 1
    }), author);

    if (chunk0Events.length > 0) {
      // Found chunked data - this means backend didn't reassemble
      // Fall back to manual chunk fetching
      console.log('[ChunkedFetcher] Backend returned chunk-0, manual reassembly needed');
      throw new Error('Backend returned raw chunks instead of reassembled content');
    }

    // No data found
    return {
      success: false,
      content: null,
      chunked: false,
      chunkCount: 0,
      events: [],
      compressed: false,
      error: 'No data found',
    };
  }

  /**
   * Probe via backend API
   * 
   * @param pubkey - Author's public key in hex
   * @param options - Fetch options
   * @returns Probe result
   */
  private async probeWithApi(pubkey: string, options: FetchOptions): Promise<ProbeResult> {
    const nostrApi = (globalThis as any).nostrApi;
    const author = options.author ?? pubkey;

    // Check for single event
    const singleDTag = getSingleEventDTag(options.dTagPrefix);
    const events = this.filterExactAuthor(await nostrApi.queryEvents({
      kinds: [options.kind],
      authors: [author],
      tags: { '#d': [singleDTag] },
      limit: 1
    }), author);

    if (events.length > 0) {
      return { exists: true, chunked: false, chunkCount: 1 };
    }

    // Check for chunked (look for chunk-0)
    const chunk0DTag = getChunkDTag(options.dTagPrefix, 0);
    const chunk0Events = this.filterExactAuthor(await nostrApi.queryEvents({
      kinds: [options.kind],
      authors: [author],
      tags: { '#d': [chunk0DTag] },
      limit: 1
    }), author);

    if (chunk0Events.length > 0) {
      const chunkData = parseChunkFromEvent(chunk0Events[0] as Event);
      return {
        exists: true,
        chunked: true,
        chunkCount: chunkData?.total ?? 1,
      };
    }

    return { exists: false, chunked: false, chunkCount: 0 };
  }
}
