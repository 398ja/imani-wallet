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
 * cannot grow the buffer without bound. 16 chunks is the gateway's own
 * `max_chunks`, and 24576 chars is its `chunk_payload_chars`; this is that
 * budget with room to spare rather than a number chosen here.
 */
const MAX_CHUNKS = 16
const MAX_REASSEMBLED_BYTES = 16 * 24576 * 2

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

/** How long an incomplete transfer may sit before its pieces are discarded. */
const PENDING_TTL_MS = 10 * 60 * 1000

function sweep(now: number): void {
  for (const [id, p] of pending) {
    if (now - p.firstSeenMs > PENDING_TTL_MS) {
      console.warn('[dmChunks] discarding incomplete transfer', {
        transfer_id: id.slice(0, 8),
        had: p.parts.size,
        of: p.total,
      })
      pending.delete(id)
    }
  }
}

/**
 * Offer one chunk. Returns the reassembled payload once the last piece lands.
 *
 * Null for "not yet" AND for "this transfer is unusable", which the caller
 * treats identically: in both cases this DM yields no token on its own.
 */
export async function offerChunk(
  chunk: ChunkEnvelope,
  now = Date.now(),
): Promise<string | null> {
  sweep(now)

  let entry = pending.get(chunk.transfer_id)
  if (!entry) {
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
    return null
  }

  entry.parts.set(chunk.chunk_index, chunk)
  if (entry.parts.size < entry.total) return null

  pending.delete(chunk.transfer_id)

  try {
    return await decodeAssembly(entry)
  } catch (error) {
    // Integrity failures are refusals, not warnings to carry forward: the whole
    // point of the digest is that a payload failing it must not be credited.
    console.error('[dmChunks] refusing a transfer that failed verification', {
      transfer_id: chunk.transfer_id.slice(0, 8),
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
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
}

/** How many transfers are part-assembled. For tests and diagnostics. */
export function pendingChunkTransfers(): number {
  return pending.size
}
