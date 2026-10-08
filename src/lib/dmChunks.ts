/**
 * Reassembling a coupon that arrived in pieces.
 *
 * WHY THIS EXISTS. A Cashu token carries one ~1840-char proof per set bit of
 * its amount, so an ordinary round number mints a large token. Above
 * `direct_limit_bytes` (32768 on staging) the gateway stops sending one DM and
 * splits the payload across several, each a `cashu_dm_chunk` envelope inside
 * its own gift wrap.
 *
 * Nothing reassembled them. `dmPoll.ts` carried the comment "it is what gives
 * us server-side chunk reassembly", but the server explicitly refuses:
 *
 *   "Refusing to reassemble encrypted chunks server-side; decrypt on client
 *    and reassemble plaintext"  — NostrdbChunkReassemblyService
 *
 * and it could not do otherwise. The chunk metadata lives INSIDE the encrypted
 * rumor; the outer wrap carries nothing but a `p` tag, so a backend with no
 * private key cannot even tell a chunk from any other DM. The client is the
 * only place the pieces are legible.
 *
 * The cost of the gap was silent. `asPayload` recognises only
 * `cashu_token_transfer`, so a chunk fell through to the text parser, yielded
 * no token, and was classified `non_token_dm` — marked processed and NEVER
 * RETRIED. Three real coupons (200, 150, 150) were sent, acked by two relays,
 * and never seen again.
 *
 * WIRE FORMAT, mirrored from ChunkedDmCodec (imani-wallet-lib) rather than
 * invented here:
 *
 *   { type: "cashu_dm_chunk", version: "1.0",
 *     payload_type: "cashu_token_transfer", payload_version: "1.0",
 *     transfer_id, chunk_index, chunk_total,
 *     content_encoding: "identity" | "gzip",
 *     content_length, content_sha256, payload }
 *
 * `payload` is a base64 fragment. Concatenate every fragment in index order,
 * base64-decode once, gunzip if asked, then check length and SHA-256 before
 * believing any of it.
 */
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'

import { cancelDeferredWrite, deferWrite } from './deferredWrite'

/** The envelope the gateway sends for one piece of a split payload. */
export interface ChunkEnvelope {
  type: 'cashu_dm_chunk'
  version?: string
  payload_type?: string
  payload_version?: string
  transfer_id: string
  chunk_index: number
  chunk_total: number
  content_encoding?: 'identity' | 'gzip'
  content_length: number
  content_sha256: string
  payload: string
}

export const CHUNK_TYPE = 'cashu_dm_chunk'

/**
 * A ceiling on what one transfer may hold, so a malicious or broken sender
 * cannot grow the buffer without bound.
 *
 * **64, not 16, and the 16 was a real loss.** The old value was taken from the
 * gateway's `max_chunks` at one moment on one deployment and hard-coded as
 * though it were a protocol constant. It is not: it is the SENDER's
 * configuration, and the receiver refusing anything above it means a gateway
 * that raises its own limit, or a coupon whose token is simply bigger than the
 * one that was measured, becomes silently unreceivable. A 1000-unit sale is
 * exactly when that happens — a Cashu token carries one ~1840-char proof per
 * set bit of its amount, so the parts of a large sale are the largest tokens
 * the system ever sends.
 *
 * The real defence was never this count. It is `MAX_REASSEMBLED_BYTES`, which
 * bounds the thing that actually costs memory and is enforced before and after
 * decoding. This number only has to be high enough not to refuse honest
 * traffic, so it is set well clear of any sender's chunking rather than level
 * with one.
 */
const MAX_CHUNKS = 64
/**
 * The ceiling that actually matters, and it is derived from `MAX_CHUNKS` rather
 * than fixed beside it — a transfer of the maximum permitted number of chunks
 * must be reassemblable, or the count above is a limit the code cannot reach.
 * 24576 chars is the gateway's `chunk_payload_chars`; the doubling is headroom
 * for a sender that uses a larger fragment than the one measured.
 */
const MAX_REASSEMBLED_BYTES = MAX_CHUNKS * 24576 * 2

/**
 * Is this DM body a chunk envelope AT ALL, whatever we then make of it?
 *
 * Separate from `asChunk` because the two answer different questions and
 * conflating them loses coupons. `asChunk` says "here is a chunk I can work
 * with", and returns null both for a DM that is not a chunk and for a chunk
 * this build refuses. Those must not be handled alike: a non-chunk DM is
 * correctly marked processed and forgotten, while a REFUSED chunk marked
 * processed is a coupon deleted forever — the wrap is never offered again, so
 * raising a limit or fixing a parser later cannot recover it.
 *
 * Deliberately the loosest possible test, `type` and nothing else. Anything
 * stricter would start making the judgements that belong to `asChunk`, and a
 * chunk failing a stricter test here would land back in the silent-loss path
 * this exists to close.
 */
export function looksLikeChunk(content: string): boolean {
  try {
    const parsed = JSON.parse(content) as { type?: unknown } | null
    return parsed?.type === CHUNK_TYPE
  } catch {
    return false
  }
}

/** Is this decrypted DM body one piece of a larger coupon? */
export function asChunk(content: string): ChunkEnvelope | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return null // Not JSON — a legacy text DM.
  }
  const c = parsed as Partial<ChunkEnvelope> | null
  if (!c || c.type !== CHUNK_TYPE) return null

  // Every field below is load-bearing for reassembly, and a chunk missing one
  // cannot be completed later — so reject it now rather than hold a partial
  // assembly open forever waiting for siblings that can never validate.
  if (
    typeof c.transfer_id !== 'string' ||
    typeof c.chunk_index !== 'number' ||
    typeof c.chunk_total !== 'number' ||
    typeof c.payload !== 'string' ||
    typeof c.content_length !== 'number' ||
    typeof c.content_sha256 !== 'string'
  ) {
    console.warn('[dmChunks] ignoring malformed chunk envelope', {
      transfer_id: (c as { transfer_id?: unknown }).transfer_id,
    })
    return null
  }
  if (
    c.chunk_total < 1 ||
    c.chunk_total > MAX_CHUNKS ||
    c.chunk_index < 0 ||
    c.chunk_index >= c.chunk_total
  ) {
    console.warn('[dmChunks] ignoring chunk with impossible index/total', {
      index: c.chunk_index,
      total: c.chunk_total,
    })
    return null
  }
  return c as ChunkEnvelope
}

/** One transfer's pieces, as they arrive. */
interface Pending {
  total: number
  /** By index, so a duplicate delivery overwrites rather than appends. */
  parts: Map<number, ChunkEnvelope>
  firstSeenMs: number
}

/**
 * Chunks in hand that have not yet completed a transfer.
 *
 * Deliberately in memory and not persisted. The pieces of one send arrive
 * within seconds of each other, and a half-assembly that outlived a reload
 * would be a durable store of unusable fragments. If a reload does lose one,
 * the wrap itself is still on the relay: the poll re-reads it, because a chunk
 * that did not complete a transfer is never marked processed.
 */
const pending = new Map<string, Pending>()

/**
 * Transfers whose coupon has been DURABLY handled, so their stragglers can be
 * let go.
 *
 * Only ONE of a transfer's events ever yields a token (the one that completed
 * it), and dm-poll marks only that event processed. Every earlier chunk's event
 * stays unprocessed, so `fetchRecentDms` re-fetches and re-offers it on every
 * poll for as long as the wrap is inside the query window. Without a memory of
 * finished transfers each of those re-offers opened a pending entry that could
 * never complete.
 *
 * **Written only once the coupon is safe (#204).** This used to be written the
 * moment the pieces DECODED, which is before the coupon was redeemed, saved or
 * its escrow acknowledged. Anything that stopped the redemption in between left
 * a tombstone over a coupon that was never saved:
 *
 *  - a reload or a killed tab mid-receive (the gate's customer reloads every
 *    ~5 s; a phone does the same to a backgrounded PWA). After the reload every
 *    piece came back, `completed.has` answered null, and the coupon could not
 *    be reassembled for the next eight days;
 *  - and, with no reload at all, every outcome dm-poll deliberately leaves
 *    retryable: a failed save, a rate-limit budget that ran out, a deferred or
 *    held backing check, a transient mint error. dm-poll re-offers the
 *    completing event so it can try again, and the tombstone refused it.
 *
 * Now a transfer is remembered as completed only when dm-poll has marked its
 * completing event processed (`confirmChunkDeliveries`), which it does only on
 * an outcome it will not retry: the coupon saved, already held here, or refused
 * for good. Until then the transfer is `delivered` (below), in memory only, so
 * a reload simply reassembles it again from the relay and the receive replays
 * under the same idempotency key.
 *
 * Persisted, because the processed set it partners with is in localStorage and
 * both halves must have the same lifetime. Holds only ids and a timestamp.
 */
const COMPLETED_KEY = 'imani-wallet:dm-chunks:completed:v2'

/**
 * The store written under the old rule, tombstoned at DECODE time (#204).
 *
 * Not trusted: an entry here may be a coupon that was decoded and never saved,
 * which is exactly the stranded case. Nor discarded outright: most entries are
 * genuinely received coupons, and forgetting them would rebuild an assembly
 * nobody can finish for each one.
 *
 * So a legacy entry is simply assembled again. A stranded transfer has ALL its
 * pieces still unprocessed, completes, and is redeemed (or recognised by the
 * received-token set if it was in fact banked). A genuinely received one is
 * missing its completing piece, which is processed, so its assembly cannot
 * finish; one pending TTL after it was first offered it is promoted to
 * `completed`, after which its stragglers are released. One bounded, one-time
 * cost per old transfer, and no coupon left behind.
 */
const LEGACY_COMPLETED_KEY = 'imani-wallet:dm-chunks:completed'

function loadStore(key: string): Map<string, number> {
  // No storage API at all (a service worker, a node test): in memory only, by
  // design, and nothing to report. A store that EXISTS and throws is reported.
  if (typeof localStorage === 'undefined') return new Map()
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return new Map()
    const parsed = JSON.parse(raw) as [string, number][]
    // Shape-checked rather than trusted: this is parsed storage, and a bad
    // entry here would throw on every poll. A corrupt store is simply an empty
    // one, which costs one round of reassembly and then self-heals, because
    // the received-token set (keyed on the token) is what stops a double credit.
    return Array.isArray(parsed) ? new Map(parsed.filter(
      (e) => Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'number',
    )) : new Map()
  } catch (error) {
    // Private-browsing modes throw on access. In memory only is still correct,
    // just less durable, so this is said rather than swallowed.
    console.warn('[dmChunks] could not read completed transfers; starting empty', { key, error })
    return new Map()
  }
}

const completed = loadStore(COMPLETED_KEY)
const legacy = loadStore(LEGACY_COMPLETED_KEY)
/** When each legacy transfer was first offered this session. In memory. */
const legacyProbe = new Map<string, number>()

function persistLegacy(): void {
  deferWrite(LEGACY_COMPLETED_KEY, () => {
    try {
      if (legacy.size === 0) localStorage.removeItem(LEGACY_COMPLETED_KEY)
      else localStorage.setItem(LEGACY_COMPLETED_KEY, JSON.stringify([...legacy]))
    } catch (error) {
      console.warn('[dmChunks] could not persist legacy transfers', error)
    }
  })
}

function persistCompleted(): void {
  // Deferred and coalesced. A catch-up confirms many transfers in a burst, and
  // a synchronous write per confirmation serialises the whole set each time.
  // Safe to defer: losing the tail costs one reassembly that the received-token
  // set then recognises, never a coupon. See `deferredWrite`.
  deferWrite(COMPLETED_KEY, () => {
    try {
      localStorage.setItem(COMPLETED_KEY, JSON.stringify([...completed]))
    } catch (error) {
      console.warn('[dmChunks] could not persist completed transfers', error)
    }
  })
}

/**
 * How long a completed transfer is remembered.
 *
 * **Must outlast the poll's fetch window**, which is 7 days (`recentDmsSince`
 * in `dmPoll.ts`). One day longer, so the guard is retired only once the wraps
 * it guards against have dropped out of the query.
 */
const COMPLETED_TTL_MS = 8 * 24 * 60 * 60 * 1000

/**
 * A ceiling on remembered transfers. Oldest go first. Forgetting one early
 * costs a reassembly the received-token set then recognises, never a coupon.
 */
const MAX_COMPLETED = 5000

/** How long an incomplete transfer may sit before its pieces are discarded. */
const PENDING_TTL_MS = 10 * 60 * 1000

/**
 * How many transfers may be part-assembled at once.
 *
 * `MAX_REASSEMBLED_BYTES` bounds ONE transfer; this bounds how many are open
 * together, since every entry is decrypted fragments of someone's money. When
 * full, the OLDEST is dropped. Its wraps are never marked processed, so
 * dropping it costs a re-read and never a coupon. The same bound applies to
 * `delivered` below.
 */
const MAX_PENDING_TRANSFERS = 64

/**
 * Transfers reassembled and handed to dm-poll whose coupon is not yet safe.
 *
 * The middle state that did not exist, and whose absence was #204. A transfer
 * sits here from the moment it decodes until dm-poll marks its completing event
 * processed (then it moves to `completed`), or until it ages out.
 *
 * While here:
 *  - its OTHER pieces are held (`in_delivery`), neither processed nor failed,
 *    so a straggler re-offered mid-redemption can neither start a second
 *    assembly of the same coupon nor be tombstoned on the first one's behalf;
 *  - its COMPLETING event, offered again, gets the coupon again. dm-poll never
 *    offers an event that is still in flight, so seeing it again means the
 *    earlier attempt ended without consuming it: a failed save, a deferral, a
 *    hold. That is exactly the retry dm-poll intends, and the receive replays
 *    under the token's idempotency key, so the gateway settles it once.
 *
 * In memory only, on purpose. It holds the decrypted payload, and after a
 * reload the right behaviour is to reassemble from the relay, which is what an
 * absent entry gives.
 */
interface Delivered {
  /** The gift wrap whose piece completed the transfer, if the caller said. */
  eventId: string | undefined
  payload: string
  atMs: number
}

const delivered = new Map<string, Delivered>()

function sweep(now: number): void {
  let legacyChanged = false
  for (const [id, p] of pending) {
    if (now - p.firstSeenMs > PENDING_TTL_MS) {
      pending.delete(id)
      console.warn('[dmChunks] discarding incomplete transfer', {
        transfer_id: id.slice(0, 8),
        had: p.parts.size,
        of: p.total,
      })
    }
  }
  for (const [id, at] of legacy) {
    if (now - at > COMPLETED_TTL_MS) {
      legacy.delete(id)
      legacyChanged = true
    }
  }
  if (legacyChanged) persistLegacy()
  // A delivery nobody has asked about for the pending TTL is forgotten, so its
  // pieces assemble afresh. Its completing event refreshes `atMs` on every
  // re-offer, so a coupon still being retried is never aged out from under it.
  for (const [id, d] of delivered) {
    if (now - d.atMs > PENDING_TTL_MS) delivered.delete(id)
  }
  let expired = false
  for (const [id, at] of completed) {
    if (now - at > COMPLETED_TTL_MS) {
      completed.delete(id)
      expired = true
    }
  }
  // Written back only when something actually aged out, so the ordinary poll
  // -- which expires nothing -- does not serialise the whole set every cycle.
  if (expired) persistCompleted()
}

/** Remember a finished transfer, evicting the oldest if the set is full. */
function rememberCompleted(transferId: string, now: number): void {
  // Map preserves insertion order, so the first key is the oldest.
  while (completed.size >= MAX_COMPLETED) {
    const oldest = completed.keys().next().value
    if (oldest === undefined) break
    completed.delete(oldest)
  }
  completed.set(transferId, now)
  persistCompleted()
}

function rememberDelivered(transferId: string, entry: Delivered): void {
  delivered.delete(transferId)
  while (delivered.size >= MAX_PENDING_TRANSFERS) {
    const oldest = delivered.keys().next().value
    if (oldest === undefined) break
    delivered.delete(oldest)
  }
  delivered.set(transferId, entry)
}

/**
 * What one offered piece amounted to.
 *
 *  - `complete`: this piece finished the transfer (or is its completing event,
 *    offered again after an attempt that did not finish). Here is the coupon.
 *  - `pending`: more pieces are needed.
 *  - `in_delivery`: the transfer is reassembled and its coupon is being, or
 *    will be retried as, redeemed. Keep this wrap UNPROCESSED and unfailed.
 *  - `done`: the transfer's coupon is durably handled. A straggler, safe to
 *    mark processed.
 *  - `refused`: this transfer did not verify. Retryable from the relay.
 */
export type ChunkOffer =
  | { kind: 'complete'; payload: string; redelivery: boolean }
  | { kind: 'pending' }
  | { kind: 'in_delivery' }
  | { kind: 'done' }
  | { kind: 'refused' }

/**
 * Offer one piece, from the gift wrap `eventId`, and say what it amounted to.
 *
 * `eventId` is what lets a completing event that comes back be told apart from
 * a straggler. Without it, a reassembled transfer can only be re-offered by
 * assembling it again, which is still correct, just slower.
 */
export async function offerChunkFrom(
  chunk: ChunkEnvelope,
  eventId: string | undefined,
  now = Date.now(),
): Promise<ChunkOffer> {
  sweep(now)

  if (completed.has(chunk.transfer_id)) return { kind: 'done' }

  // A transfer the OLD rule tombstoned. Given one pending TTL to prove it can
  // still be assembled (a stranded coupon has every piece unprocessed and
  // completes at once). One that has not by then is missing its completing
  // piece because that piece was processed, so its coupon was received and
  // its stragglers can be released. Timed from the first offer this session,
  // not from the assembly, so evicting the assembly cannot restart the clock.
  if (legacy.has(chunk.transfer_id)) {
    const since = legacyProbe.get(chunk.transfer_id)
    if (since === undefined) {
      legacyProbe.set(chunk.transfer_id, now)
    } else if (now - since > PENDING_TTL_MS) {
      legacy.delete(chunk.transfer_id)
      legacyProbe.delete(chunk.transfer_id)
      pending.delete(chunk.transfer_id)
      persistLegacy()
      rememberCompleted(chunk.transfer_id, now)
      return { kind: 'done' }
    }
  }
  const inDelivery = delivered.get(chunk.transfer_id)
  if (inDelivery) {
    if (eventId !== undefined && inDelivery.eventId === eventId) {
      // Only the completing event keeps a delivery alive. If it stops being
      // offered, the delivery ages out and the pieces assemble afresh, so a
      // sibling can never pin a delivery whose own wrap has gone.
      inDelivery.atMs = now
      return { kind: 'complete', payload: inDelivery.payload, redelivery: true }
    }
    return { kind: 'in_delivery' }
  }

  let entry = pending.get(chunk.transfer_id)
  if (!entry) {
    // Evict before inserting, so the map never exceeds its bound. A transfer
    // dropped here is not lost: none of its wraps were marked processed.
    while (pending.size >= MAX_PENDING_TRANSFERS) {
      const oldest = pending.keys().next().value
      if (oldest === undefined) break
      console.warn('[dmChunks] too many transfers in flight; dropping the oldest', {
        transfer_id: oldest.slice(0, 8),
        limit: MAX_PENDING_TRANSFERS,
      })
      pending.delete(oldest)
    }

    entry = { total: chunk.chunk_total, parts: new Map(), firstSeenMs: now }
    pending.set(chunk.transfer_id, entry)
  }

  // A sender that disagrees with itself about the size of its own transfer is
  // not one to reassemble from. Drop the whole assembly rather than guess.
  if (entry.total !== chunk.chunk_total) {
    console.warn('[dmChunks] chunk_total disagreement; dropping transfer', {
      transfer_id: chunk.transfer_id.slice(0, 8),
      expected: entry.total,
      got: chunk.chunk_total,
    })
    pending.delete(chunk.transfer_id)
    return { kind: 'refused' }
  }

  entry.parts.set(chunk.chunk_index, chunk)
  if (entry.parts.size < entry.total) return { kind: 'pending' }

  // Everything that decides completeness above runs synchronously, before the
  // first await below, so two pieces racing cannot both complete the transfer.
  pending.delete(chunk.transfer_id)

  try {
    const whole = await decodeAssembly(entry)
    // Delivered, NOT completed. The coupon is not safe until dm-poll says so
    // (`confirmChunkDeliveries`); until then a reload or a failed attempt must
    // be able to produce it again (#204).
    rememberDelivered(chunk.transfer_id, { eventId, payload: whole, atMs: now })
    // A legacy tombstone that reassembled is a coupon the old rule stranded.
    // From here it follows the new rule.
    if (legacy.delete(chunk.transfer_id)) {
      legacyProbe.delete(chunk.transfer_id)
      console.warn('[dmChunks] recovering a chunked coupon an earlier build tombstoned before saving it (#204)', {
        transfer_id: chunk.transfer_id.slice(0, 8),
      })
      persistLegacy()
    }
    return { kind: 'complete', payload: whole, redelivery: false }
  } catch (error) {
    // Integrity failures are refusals: a payload failing its digest must not be
    // credited. Nothing is remembered, so the relay's copies can be retried.
    console.error('[dmChunks] refusing a transfer that failed verification', {
      transfer_id: chunk.transfer_id.slice(0, 8),
      error: error instanceof Error ? error.message : String(error),
    })
    return { kind: 'refused' }
  }
}

/**
 * Offer one chunk. Returns the reassembled payload once the last piece lands.
 *
 * The id-less form of `offerChunkFrom`, for callers that only care whether a
 * coupon came out. Null for every other outcome.
 */
export async function offerChunk(
  chunk: ChunkEnvelope,
  now = Date.now(),
): Promise<string | null> {
  const offer = await offerChunkFrom(chunk, undefined, now)
  return offer.kind === 'complete' ? offer.payload : null
}

/**
 * dm-poll has marked these gift wraps processed: any transfer one of them
 * completed is now durably handled.
 *
 * Called from the poller's processed-set write, which dm-poll makes only after
 * an outcome it will never retry. That is the single moment a transfer may be
 * remembered as completed (#204). Cheap when nothing is in delivery, which is
 * almost always.
 *
 * @returns how many transfers were confirmed
 */
export function confirmChunkDeliveries(processedEventIds: Iterable<string>, now = Date.now()): number {
  if (delivered.size === 0) return 0
  const processed = processedEventIds instanceof Set ? processedEventIds : new Set(processedEventIds)
  let confirmed = 0
  for (const [transferId, d] of delivered) {
    if (d.eventId === undefined || !processed.has(d.eventId)) continue
    delivered.delete(transferId)
    pending.delete(transferId)
    rememberCompleted(transferId, now)
    confirmed += 1
  }
  if (confirmed > 0) {
    // SYNCHRONOUS, unlike the sweep's write-back. The processed-set write that
    // calls this is deferred, so writing here at once guarantees the
    // completed record never lands AFTER the tombstone of its completing event.
    // The other order would leave a reload with the completing event consumed
    // and no record of the transfer, so its stragglers re-open an assembly that
    // can never finish. One write per chunked coupon, so the cost is nothing.
    cancelDeferredWrite(COMPLETED_KEY)
    try {
      localStorage.setItem(COMPLETED_KEY, JSON.stringify([...completed]))
    } catch (error) {
      console.warn('[dmChunks] could not persist completed transfers', error)
    }
  }
  return confirmed
}

/** Concatenate, decode, decompress, and verify. Throws if anything disagrees. */
async function decodeAssembly(entry: Pending): Promise<string> {
  const ordered: ChunkEnvelope[] = []
  for (let i = 0; i < entry.total; i += 1) {
    const part = entry.parts.get(i)
    if (!part) throw new Error(`missing chunk ${i} of ${entry.total}`)
    ordered.push(part)
  }

  // Base64 is concatenated BEFORE decoding, matching the sender: it splits one
  // base64 string into fragments, so each fragment is not independently
  // decodable and decoding them separately would corrupt every boundary.
  const base64 = ordered.map((c) => c.payload).join('')
  // Bounded BEFORE decoding as well as after. The decoded check below is what
  // actually enforces the ceiling — base64 only ever shrinks — so this is not a
  // second line of defence but an allocation saved: a hostile 50MB fragment is
  // refused without first materialising 37MB of bytes to measure.
  if (base64.length > MAX_REASSEMBLED_BYTES) {
    throw new Error(`encoded payload too large: ${base64.length}`)
  }
  const raw = base64Decode(base64)
  if (raw.length > MAX_REASSEMBLED_BYTES) {
    throw new Error(`reassembled payload too large: ${raw.length}`)
  }

  const head = ordered[0]
  const bytes = head.content_encoding === 'gzip' ? await gunzip(raw) : raw

  if (bytes.length !== head.content_length) {
    throw new Error(`length mismatch: got ${bytes.length}, expected ${head.content_length}`)
  }
  const digest = bytesToHex(sha256(bytes))
  if (!constantTimeEquals(digest, head.content_sha256.toLowerCase())) {
    throw new Error('checksum mismatch')
  }

  return new TextDecoder().decode(bytes)
}

/**
 * Compare digests without leaking, one character at a time, how much of the
 * expected value a forged assembly has matched. The sender supplies
 * `content_sha256`, so this is exactly the comparison an attacker would
 * otherwise iterate against — the Java side makes the same choice
 * (`ConstantTime.hexEquals`).
 */
function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * Decode base64 into bytes.
 *
 * The `Uint8Array<ArrayBuffer>` return type is load-bearing, not decoration.
 * TypeScript 5.7 made `Uint8Array` generic over its backing buffer, and the
 * streams API accepts only a view over a real `ArrayBuffer` — never a
 * `SharedArrayBuffer`. Returning the bare `Uint8Array` compiles under `tsc`
 * here but fails `npm run build`, which is how this reached a deploy.
 */
function base64Decode(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i)
  return out
}

/**
 * Inflate a gzip member using the platform's own decompressor.
 *
 * `DecompressionStream` rather than a hand-rolled DEFLATE or a new dependency:
 * this runs on a payload a stranger sent, and the browser's implementation is
 * memory-safe, audited, and already present. It is available everywhere this
 * app runs (Chrome 80+, Firefox 113+, Safari 16.4+) and in Node 18+, which is
 * what the tests use.
 *
 * Async, unlike everything else here, because the streams API is — which is
 * why `offerChunk` and `decodeAssembly` return promises.
 */
async function gunzip(input: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  if (input.length < 18 || input[0] !== 0x1f || input[1] !== 0x8b) {
    throw new Error('not a gzip stream')
  }

  const stream = new DecompressionStream('gzip')
  const writer = stream.writable.getWriter()
  void writer.write(input)
  void writer.close()

  const parts: Uint8Array[] = []
  let total = 0
  const reader = stream.readable.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value as Uint8Array)
    total += (value as Uint8Array).length
    // Bounded while streaming, so a decompression bomb is refused as it
    // inflates rather than after it has already been held in memory.
    if (total > MAX_REASSEMBLED_BYTES) {
      await reader.cancel().catch(() => {})
      throw new Error('gzip output too large')
    }
  }

  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/** Drop every half-assembled transfer. For tests and for sign-out. */
export function resetChunkAssembly(): void {
  pending.clear()
  delivered.clear()
  completed.clear()
  legacy.clear()
  legacyProbe.clear()
  cancelDeferredWrite(LEGACY_COMPLETED_KEY)
  // Cleared SYNCHRONOUSLY, unlike every other write to this key. This is the
  // sign-out path, and a deferred clear is a window in which one account's
  // transfer ids are still on disk — on a shared device, after the user
  // believes they have left. A queued write for this key is dropped first so
  // it cannot land after the clear and resurrect them.
  cancelDeferredWrite(COMPLETED_KEY)
  try {
    localStorage.removeItem(COMPLETED_KEY)
    localStorage.removeItem(LEGACY_COMPLETED_KEY)
  } catch (error) {
    // Private browsing. The in-memory clear above is the part that matters.
    console.warn('[dmChunks] could not clear completed transfers from storage', error)
  }
}

/** How many transfers are part-assembled. For tests and diagnostics. */
export function pendingChunkTransfers(): number {
  return pending.size
}

/** How many transfers are reassembled but not yet confirmed safe. For tests and diagnostics. */
export function deliveredChunkTransfers(): number {
  return delivered.size
}
