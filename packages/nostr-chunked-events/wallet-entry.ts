/**
 * The wallet's entry into the vendored library: the low-level, pure API only.
 *
 * `src/` is a verbatim copy of 398ja/nostr-chunked-events v0.3.0 at c0d73e7
 * (see VENDORED.md). Every name below is exported from that release's ROOT
 * index too, so swapping the alias for the npm package changes no import.
 * This file only exists because the copy's index also pulls in
 * ChunkedPublisher/ChunkedFetcher/RelayPool, which the wallet does not use (#203,
 * see src/lib/chunkedRecord.ts) and which would be type-checked under this app's
 * stricter settings. Delete it when the release replaces the copy.
 */
export { createSnapshotChunks, parseDTag } from './src/chunker'
export { groupChunksBySnapshot, isChunkEvent, validateSnapshot } from './src/reassembler'
export { compress, decompress } from './src/compression'
export { maxNip44PlaintextSize } from './src/hash'
export type { ChunkEventData } from './src/types'
