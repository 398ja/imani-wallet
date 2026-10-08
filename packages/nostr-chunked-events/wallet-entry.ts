/**
 * The wallet's entry into the vendored library: the low-level, pure API only.
 *
 * `src/` is a verbatim copy of imani-apps/packages/nostr-chunked-events 0.2.0.
 * Its index also exports ChunkedPublisher/ChunkedFetcher, which the wallet does
 * not use (#203, see src/lib/chunkedRecord.ts) and which fail this app's stricter
 * `noUnusedParameters`. Re-exporting the pure modules keeps the copy untouched.
 * Delete this file when the standalone release replaces the copy.
 */
export { createChunks, parseDTag } from './src/chunker'
export { groupChunksBySnapshot, isChunkEvent, validateSnapshot } from './src/reassembler'
export { compress, decompress } from './src/compression'
export type { ChunkEventData } from './src/types'
