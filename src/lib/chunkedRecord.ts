import type { Event, EventTemplate } from 'nostr-tools'
import {
  compress,
  createChunks,
  decompress,
  groupChunksBySnapshot,
  isChunkEvent,
  parseDTag,
  validateSnapshot,
  type ChunkEventData,
} from 'nostr-chunked-events'

/**
 * Self-encrypted records that may be too large for one relay event (#203).
 *
 * The ONLY file that imports `nostr-chunked-events`. It is vendored today from
 * imani-apps' hardened 0.2.0 (snapshot_id, payload_hash, total_chunks); when
 * the reconciled standalone release is published, the alias in vite.config.ts
 * and tsconfig.app.json is swapped for the npm dependency and nothing else moves.
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
 * Plaintext per chunk. 30,000 bytes pads to 32,768 under NIP-44 and the event
 * comes out at about 44 KB, as the owner's direction on #203 suggested; the
 * test asserts the estimate stays under the budget.
 */
export const CHUNK_PLAINTEXT_BYTES = 30_000

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

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

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
  const payloadHash = await sha256Hex(payload)
  const snapshotId = crypto.randomUUID()
  const chunks = createChunks(payload, { chunkSize, dTagPrefix: id })
  const total = chunks.length

  return chunks.map((chunk) => {
    const tags = [
      // createChunks names a lone chunk `<id>-state`; a chunk is always a chunk here.
      ['d', `${id}-chunk-${chunk.index}`],
      ['chunk', String(chunk.index), String(total)],
      ['total_chunks', String(total)],
      ['snapshot_id', snapshotId],
      ['payload_hash', payloadHash],
      ['hash_alg', 'sha256'],
      ['compressed', 'gzip'],
      ...extraTags,
    ]
    const size = estimateEventBytes(utf8(chunk.data), tags)
    if (size > budget) {
      // A configuration error (a chunk size the budget cannot hold), not data.
      throw new Error(`chunk ${chunk.index} would be ${size} bytes, over the ${budget} budget`)
    }
    return { kind, created_at, tags, content: sealer.encrypt(chunk.data) }
  })
}

/** The record id an event belongs to: `d`, with any `-chunk-n` suffix removed. */
export function recordIdOf(event: Pick<Event, 'tags'>): string | undefined {
  const d = event.tags.find(([name]) => name === 'd')?.[1]
  if (!d) return undefined
  return isChunkEvent(event as Event) ? parseDTag(d).prefix : d
}

export { isChunkEvent }

export interface ReassembledRecord {
  id: string
  at: number
  plaintext: string
}

/**
 * Every complete, verified chunked record among `events`.
 *
 * Incomplete or corrupted snapshots are skipped and reported through `onReject`:
 * one damaged coupon must not cost the restore of the others, and an older
 * complete snapshot of the same coupon still counts.
 */
export async function reassembleRecords(
  events: Event[],
  author: string,
  sealer: Sealer,
  onReject: (id: string, reason: string) => void = () => undefined,
): Promise<ReassembledRecord[]> {
  const out: ReassembledRecord[] = []
  for (const candidate of groupChunksBySnapshot(events.filter(isChunkEvent), { expectedAuthor: author })) {
    const id = candidate.chunks[0]?.dTag ? parseDTag(candidate.chunks[0].dTag).prefix : undefined
    if (!id) continue
    try {
      const opened: ChunkEventData[] = candidate.chunks.map((c) => ({ ...c, data: sealer.decrypt(c.data) }))
      const validation = await validateSnapshot(opened, {
        expectedAuthor: author,
        requireSnapshotId: true,
        requirePayloadHash: true,
        verifyPayloadHash: true,
      })
      if (!validation.valid) {
        onReject(id, validation.issues.map((i) => i.message).join('; '))
        continue
      }
      const payload = validation.chunks.map((c) => c.data).join('')
      out.push({ id, at: candidate.newestCreatedAt, plaintext: decompress(payload) })
    } catch (error) {
      onReject(id, error instanceof Error ? error.message : String(error))
    }
  }
  return out
}

/**
 * Ids whose chunk set is complete on the relay, judged from tags alone (no
 * decryption). For a back-fill: a coupon whose chunks only partly landed is
 * NOT known, so the next back-fill publishes it again.
 */
export function completeChunkedIds(events: Event[]): Set<string> {
  const ids = new Set<string>()
  for (const candidate of groupChunksBySnapshot(events.filter(isChunkEvent))) {
    const first = candidate.chunks[0]
    if (!first?.dTag) continue
    const indices = new Set(candidate.chunks.map((c) => c.index))
    if (indices.size === first.total && [...indices].every((i) => i < first.total)) {
      ids.add(parseDTag(first.dTag).prefix)
    }
  }
  return ids
}
