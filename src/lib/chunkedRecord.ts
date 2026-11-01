import type { Event, EventTemplate } from 'nostr-tools'
import {
  compress,
  createSnapshotChunks,
  decompress,
  groupChunksBySnapshot,
  isChunkEvent,
  maxNip44PlaintextSize,
  parseDTag,
  validateSnapshot,
  type ChunkEventData,
} from 'nostr-chunked-events'

/**
 * Self-encrypted records that may be too large for one relay event (#203).
 *
 * The ONLY file that imports `nostr-chunked-events`, pinned to the git tag
 * `github:398ja/nostr-chunked-events#v0.3.0` (not published to npm).
 *
 * WHY THE LOW-LEVEL API. The library's `ChunkedPublisher`/`ChunkedFetcher` key
 * everything by `d` and assume a parameterised-replaceable kind: a record that
 * fits is written as `<prefix>-state`, and a fetch asks for exact `d` values.
 * kind 7375 is a REGULAR kind (NIP-60), so a relay never replaces anything, and
 * a coupon that fits must stay one plain NIP-60 event with `d` = token_id that
 * other NIP-60 wallets can read. So we keep our own events and relay calls and
 * use the library for the format: chunking, the chunk/snapshot tags, grouping,
 * validation (including the payload hash) and gzip.
 *
 * ORDER: gzip, then chunk, then NIP-44 each chunk. Not encrypt-then-chunk:
 * NIP-44 v2 refuses plaintext over 65,535 bytes, so one encryption of the whole
 * record caps the record at 64 KB however many events it is split into. Per-chunk
 * encryption has no such ceiling and costs the same number of events, because the
 * event budget, not the cipher, decides the count.
 */

/** strfry's `maxEventSize` on staging, prod's stock config and the local gate. */
export const RELAY_MAX_EVENT_BYTES = 65_536

/**
 * Every event we publish must estimate at or under this. 5.5 KB below the limit,
 * for what the estimate does not model exactly (JSON escaping in tags, a relay
 * that counts the envelope).
 */
export const EVENT_BUDGET_BYTES = 60_000

/**
 * Plaintext per chunk: the library's strfry sizing, the largest plaintext whose
 * NIP-44 payload leaves 1.5 KB of a 65,536-byte event for id, pubkey, sig and
 * tags. That is 40,960 bytes (pads to itself), about 55 KB per event, and the
 * per-chunk guard below checks every chunk against our own 60,000 budget too.
 */
export const CHUNK_PLAINTEXT_BYTES = maxNip44PlaintextSize(RELAY_MAX_EVENT_BYTES - 1_536)

/**
 * The record a chunk belongs to (#203 review V1). Explicit, so a chunk written
 * without a `d` tag (v0.3.0's `createSnapshotChunks` adds none by default) still
 * names its coupon. `d=<id>-chunk-<n>` is kept too, and read as a fallback, so
 * chunks written before this tag existed still restore.
 */
export const RECORD_ID_TAG = 'record_id'

/**
 * NIP-44 v2 padded length (the spec's `calc_padded_len`), as nostr-tools does it.
 */
export function nip44PaddedLength(plainLen: number): number {
  if (plainLen <= 32) return 32
  const nextPower = 2 ** (Math.floor(Math.log2(plainLen - 1)) + 1)
  const chunk = nextPower <= 256 ? 32 : nextPower / 8
  return chunk * (Math.floor((plainLen - 1) / chunk) + 1)
}

/**
 * Length of a NIP-44 v2 payload: base64(version 1 + nonce 32 + u16 length 2 +
 * padded + mac 32). One layer, gc's `GiftWrapSizeModel` with the seal and wrap
 * collapsed into the single self-encryption this record uses.
 */
export function nip44PayloadLength(plainLen: number): number {
  const raw = 1 + 32 + 2 + nip44PaddedLength(plainLen) + 32
  return 4 * Math.ceil(raw / 3)
}

/**
 * Serialized size of a signed event whose content is a NIP-44 payload of
 * `plainLen` plaintext bytes: the fixed envelope (id, pubkey, sig, kind,
 * created_at, keys) plus the tags as JSON plus the payload.
 */
export function estimateEventBytes(plainLen: number, tags: string[][]): number {
  const envelope =
    '{"id":"","pubkey":"","created_at":0000000000,"kind":00000,"tags":,"content":"","sig":""}'.length +
    64 + 64 + 128
  return envelope + JSON.stringify(tags).length + nip44PayloadLength(plainLen)
}

const utf8 = (s: string) => new TextEncoder().encode(s).length

export interface Sealer {
  encrypt(plaintext: string): string
  decrypt(ciphertext: string): string
}

export interface ChunkingOptions {
  /** Estimated event size above which a record is chunked. */
  budget?: number
  /** Plaintext bytes per chunk. */
  chunkSize?: number
}

/**
 * Templates for one record: a single plain event when it fits, otherwise
 * gzip-compressed chunks sharing a snapshot_id.
 *
 * `id` is the record's identity (`d` on a plain event, the `d` prefix on chunks).
 * `extraTags` go on every event.
 */
export async function buildRecordEvents(
  kind: number,
  id: string,
  plaintext: string,
  extraTags: string[][],
  sealer: Sealer,
  options: ChunkingOptions = {},
): Promise<EventTemplate[]> {
  const budget = options.budget ?? EVENT_BUDGET_BYTES
  const chunkSize = options.chunkSize ?? CHUNK_PLAINTEXT_BYTES
  const created_at = Math.floor(Date.now() / 1000)

  const plainTags = [['d', id], ...extraTags]
  if (estimateEventBytes(utf8(plaintext), plainTags) <= budget) {
    return [{ kind, created_at, tags: plainTags, content: sealer.encrypt(plaintext) }]
  }

  // Too big as a plain record: gzip and chunk. Even when the gzip alone would
  // fit one event it goes out in the chunk format (one chunk of one), because
  // a plain 7375 must hold the plain JSON other readers expect.
  const payload = compress(plaintext).data
  // payload_hash covers the chunk PLAINTEXT (here the gzip/base64 text), so a
  // reader decrypts every chunk before validateSnapshot (v0.3.0 semantics).
  const { chunks } = createSnapshotChunks(payload, { chunkSize, dTagPrefix: id })

  return chunks.map((chunk) => {
    const tags = [...chunk.tags, [RECORD_ID_TAG, id], ['compressed', 'gzip'], ...extraTags]
    const size = estimateEventBytes(utf8(chunk.data), tags)
    if (size > budget) {
      // A configuration error (a chunk size the budget cannot hold), not data.
      throw new Error(`chunk ${chunk.index} would be ${size} bytes, over the ${budget} budget`)
    }
    return { kind, created_at, tags, content: sealer.encrypt(chunk.data) }
  })
}

/** The record id an event belongs to: `record_id` on a chunk, else `d` without its `-chunk-n`. */
export function recordIdOf(event: Pick<Event, 'tags'>): string | undefined {
  const tag = (name: string) => event.tags.find(([n]) => n === name)?.[1]
  if (!isChunkEvent(event as Event)) return tag('d') || undefined
  const explicit = tag(RECORD_ID_TAG)
  if (explicit) return explicit
  const d = tag('d')
  if (!d) return undefined
  const parsed = parseDTag(d)
  return parsed.chunkIndex === null ? undefined : parsed.prefix
}

export { isChunkEvent }

export interface ReassembledRecord {
  id: string
  at: number
  plaintext: string
  /** The event ids of the snapshot this record was read from. */
  eventIds: string[]
}

export interface ChunkSet {
  /** The record id, or undefined when no chunk names one. */
  id: string | undefined
  snapshotId: string | null
  at: number
  eventIds: string[]
}

export interface ReassemblyResult {
  records: ReassembledRecord[]
  /** Snapshots that are incomplete, corrupt or unattributable. */
  rejected: (ChunkSet & { reason: string })[]
}

/**
 * Every complete, verified chunked record among `events`, newest snapshot per
 * id first in nothing: callers pick. Each set is decrypted chunk by chunk, then
 * validated with v0.3.0's 7375 recipe (snapshot id and payload hash required and
 * verified, identical duplicates from a retried publish allowed), then joined in
 * INDEX order from `validation.chunks`, never in relay order.
 *
 * A bad set is never silently skipped: it lands in `rejected` with its reason.
 */
export async function reassembleChunkSets(
  events: Event[],
  author: string,
  sealer: Sealer,
): Promise<ReassemblyResult> {
  const byId = new Map(events.map((e) => [e.id, e]))
  const records: ReassembledRecord[] = []
  const rejected: ReassemblyResult['rejected'] = []
  for (const candidate of groupChunksBySnapshot(events.filter(isChunkEvent), { expectedAuthor: author })) {
    const eventIds = candidate.chunks.map((c) => c.eventId).filter((x): x is string => Boolean(x))
    const ids = new Set(eventIds.map((eid) => byId.get(eid)).map((e) => (e ? recordIdOf(e) : undefined)))
    const set: ChunkSet = {
      id: ids.size === 1 ? [...ids][0] : undefined,
      snapshotId: candidate.snapshotId,
      at: candidate.newestCreatedAt,
      eventIds,
    }
    if (!set.id) {
      rejected.push({ ...set, reason: ids.size > 1 ? 'chunks name different records' : 'no record id on the chunks' })
      continue
    }
    try {
      const opened: ChunkEventData[] = candidate.chunks.map((c) => ({ ...c, data: sealer.decrypt(c.data) }))
      const validation = await validateSnapshot(opened, {
        expectedAuthor: author,
        requireSnapshotId: true,
        requirePayloadHash: true,
        verifyPayloadHash: true,
        allowIdenticalDuplicates: true,
      })
      if (!validation.valid) {
        rejected.push({ ...set, reason: validation.issues.map((i) => i.message).join('; ') })
        continue
      }
      const payload = validation.chunks.map((c) => c.data).join('')
      records.push({ id: set.id, at: set.at, plaintext: decompress(payload), eventIds })
    } catch (error) {
      rejected.push({ ...set, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return { records, rejected }
}

/**
 * Every complete, verified chunked record among `events`. A rejected set is
 * reported through `onReject` unless a verified snapshot of the same record
 * exists (an orphan of a failed publish that was since republished, #203 L3).
 */
export async function reassembleRecords(
  events: Event[],
  author: string,
  sealer: Sealer,
  onReject: (id: string, reason: string, set: ChunkSet) => void = () => undefined,
): Promise<ReassembledRecord[]> {
  const { records, rejected } = await reassembleChunkSets(events, author, sealer)
  const good = new Set(records.map((r) => r.id))
  for (const r of rejected) {
    if (r.id && good.has(r.id)) continue
    onReject(r.id ?? '(unknown)', r.reason, r)
  }
  return records
}
