/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

import {
  asChunk,
  offerChunk,
  resetChunkAssembly,
  pendingChunkTransfers,
  type ChunkEnvelope,
} from '../dmChunks'
import javaChunks from './fixtures/java-encoded-chunks.json'
import javaPayloadRaw from './fixtures/java-encoded-payload.json'

/**
 * The expected payload, as a STRING.
 *
 * Imported as JSON and re-serialised rather than read as text, because the
 * fixture is itself a JSON document; `JSON.stringify` of the parsed value is
 * byte-identical to what the Java side wrote, since both use compact
 * separators and the same key order.
 */
const javaPayload = JSON.stringify(javaPayloadRaw)

/**
 * Reassembling a coupon that arrived in pieces.
 *
 * These fixtures are built with the SAME steps the Java sender uses
 * (ChunkedDmCodec): serialise the payload, optionally gzip it, base64 the
 * result, split that base64 string into fragments, and stamp each fragment
 * with the transfer's length and SHA-256. Anything else would be testing a
 * format nobody sends.
 *
 * The gzip fixture is produced with CompressionStream, the exact inverse of
 * the DecompressionStream the implementation uses, so a real deflate stream is
 * exercised rather than a stub.
 */

const enc = new TextEncoder()

const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const b64 = (bytes: Uint8Array): string => {
  let s = ''
  for (const byte of bytes) s += String.fromCharCode(byte)
  return btoa(s)
}

const gzip = async (bytes: Uint8Array): Promise<Uint8Array> => {
  const cs = new CompressionStream('gzip')
  const writer = cs.writable.getWriter()
  void writer.write(bytes as unknown as Uint8Array)
  void writer.close()
  const parts: Uint8Array[] = []
  const reader = cs.readable.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value as Uint8Array)
  }
  const total = parts.reduce((t, p) => t + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** A coupon payload of the shape the receive path expects to end up with. */
const payloadFor = (token: string) =>
  JSON.stringify({
    type: 'cashu_token_transfer',
    version: '1.0',
    token,
    face_value: 20000,
    face_unit: 'EUR',
    voucher_id: 'e4d45d6b-6ffe-4f2a-852f-1452e36a933e',
  })

/** Encode a payload the way the gateway does, into `parts` chunks. */
async function makeChunks(
  payload: string,
  parts: number,
  opts: { gzip?: boolean; transferId?: string } = {},
): Promise<ChunkEnvelope[]> {
  const original = enc.encode(payload)
  const body = opts.gzip ? await gzip(original) : original
  const base64 = b64(body)
  // The digest and length are over the ORIGINAL payload, before encoding —
  // matching ChunkedDmCodec, which verifies after decompressing.
  const digest = await sha256Hex(original)

  const size = Math.ceil(base64.length / parts)
  const fragments: string[] = []
  for (let at = 0; at < base64.length; at += size) fragments.push(base64.slice(at, at + size))
  while (fragments.length < parts) fragments.push('')

  return fragments.map((fragment, index) => ({
    type: 'cashu_dm_chunk' as const,
    version: '1.0',
    payload_type: 'cashu_token_transfer',
    payload_version: '1.0',
    transfer_id: opts.transferId ?? '879adb71-f34e-538e-a61d-d8ae6edab90c',
    chunk_index: index,
    chunk_total: fragments.length,
    content_encoding: opts.gzip ? ('gzip' as const) : ('identity' as const),
    content_length: original.length,
    content_sha256: digest,
    payload: fragment,
  }))
}

/** A token big enough to be worth splitting, like the ones that failed. */
const BIG_TOKEN = `cashuB${'x'.repeat(39000)}`

beforeEach(() => {
  resetChunkAssembly()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

describe('recognising a chunk', () => {
  it('sees a cashu_dm_chunk envelope', async () => {
    const [chunk] = await makeChunks(payloadFor('cashuBabc'), 2)
    expect(asChunk(JSON.stringify(chunk))).not.toBeNull()
  })

  it('does not mistake a whole coupon for a chunk', () => {
    // The ordinary small-coupon path must keep flowing untouched.
    expect(asChunk(payloadFor('cashuBabc'))).toBeNull()
  })

  it('does not mistake a legacy text DM for a chunk', () => {
    expect(asChunk('🎁 Token Transfer: 1.00 USD')).toBeNull()
  })

  it('refuses an envelope missing the fields reassembly needs', () => {
    // Holding these open would mean waiting forever for siblings that can
    // never validate, so they are rejected on arrival instead.
    const half = { type: 'cashu_dm_chunk', transfer_id: 't', chunk_index: 0 }
    expect(asChunk(JSON.stringify(half))).toBeNull()
  })

  it('refuses an impossible index/total', () => {
    const bad = {
      type: 'cashu_dm_chunk',
      transfer_id: 't',
      chunk_index: 5,
      chunk_total: 2,
      payload: 'x',
      content_length: 1,
      content_sha256: 'ab',
    }
    expect(asChunk(JSON.stringify(bad))).toBeNull()
  })
})

describe('reassembling a coupon sent in pieces', () => {
  it('yields nothing until the last piece lands, then the whole payload', async () => {
    const payload = payloadFor(BIG_TOKEN)
    const chunks = await makeChunks(payload, 2)

    // This is the incident in miniature: the first piece alone is not a
    // coupon, and treating it as a failed DM is what lost the money.
    expect(await offerChunk(chunks[0])).toBeNull()
    expect(await offerChunk(chunks[1])).toBe(payload)
  })

  it('recovers the exact token, not a truncated one', async () => {
    const chunks = await makeChunks(payloadFor(BIG_TOKEN), 2)
    await offerChunk(chunks[0])
    const whole = await offerChunk(chunks[1])

    // Base64 fragments are concatenated BEFORE decoding; decoding each piece
    // separately would corrupt every boundary and produce a plausible-looking
    // but wrong token.
    expect(JSON.parse(whole!).token).toBe(BIG_TOKEN)
  })

  it('reassembles a gzip-compressed transfer', async () => {
    const payload = payloadFor(BIG_TOKEN)
    const chunks = await makeChunks(payload, 2, { gzip: true })

    await offerChunk(chunks[0])
    expect(await offerChunk(chunks[1])).toBe(payload)
  })

  it('accepts the pieces in any order', async () => {
    // Relays make no ordering promise, and the two wraps are separate events.
    const payload = payloadFor(BIG_TOKEN)
    const chunks = await makeChunks(payload, 3)

    expect(await offerChunk(chunks[2])).toBeNull()
    expect(await offerChunk(chunks[0])).toBeNull()
    expect(await offerChunk(chunks[1])).toBe(payload)
  })

  it('tolerates the same piece arriving twice', async () => {
    // dm-poll re-reads events it has not marked processed, so redelivery is
    // the normal case rather than an edge one.
    const payload = payloadFor(BIG_TOKEN)
    const chunks = await makeChunks(payload, 2)

    expect(await offerChunk(chunks[0])).toBeNull()
    expect(await offerChunk(chunks[0])).toBeNull()
    expect(await offerChunk(chunks[1])).toBe(payload)
  })

  it('keeps two transfers apart', async () => {
    const a = payloadFor('cashuB-aaa'.repeat(2000))
    const b = payloadFor('cashuB-bbb'.repeat(2000))
    const ca = await makeChunks(a, 2, { transferId: 'transfer-a' })
    const cb = await makeChunks(b, 2, { transferId: 'transfer-b' })

    // Interleaved, because two coupons sent together arrive together.
    await offerChunk(ca[0])
    await offerChunk(cb[0])
    expect(await offerChunk(cb[1])).toBe(b)
    expect(await offerChunk(ca[1])).toBe(a)
  })

  it('handles a single-chunk transfer', async () => {
    const payload = payloadFor('cashuBsmall')
    const chunks = await makeChunks(payload, 1)
    expect(await offerChunk(chunks[0])).toBe(payload)
  })

  it('releases its memory once a transfer completes', async () => {
    const chunks = await makeChunks(payloadFor(BIG_TOKEN), 2)
    await offerChunk(chunks[0])
    expect(pendingChunkTransfers()).toBe(1)
    await offerChunk(chunks[1])
    expect(pendingChunkTransfers()).toBe(0)
  })
})

/**
 * The decisive test: bytes produced by the ACTUAL Java sender.
 *
 * Every other fixture here is built by this file, so it could agree with a
 * misreading of the format and still pass. This one was generated by running
 * `ChunkedDmCodec.encodeTokenTransfer` from imani-wallet-lib — the same class
 * the gateway calls — and committed verbatim. If the two languages ever
 * disagree about base64 splitting, gzip framing, or which bytes the digest
 * covers, this fails and nothing else does.
 */
describe('decoding what the Java sender actually produced', () => {
  it('reassembles a real gateway-encoded transfer', async () => {
    const chunks = javaChunks as ChunkEnvelope[]

    // Shape assertions first, so a regenerated fixture that stopped being
    // chunked or compressed fails loudly instead of passing vacuously.
    expect(chunks).toHaveLength(2)
    expect(chunks[0].content_encoding).toBe('gzip')

    expect(await offerChunk(chunks[0])).toBeNull()
    const whole = await offerChunk(chunks[1])

    expect(whole).toBe(javaPayload)
    expect(JSON.parse(whole!).type).toBe('cashu_token_transfer')
  })
})

describe('refusing a transfer that does not verify', () => {
  it('refuses a payload whose checksum does not match', async () => {
    const chunks = await makeChunks(payloadFor(BIG_TOKEN), 2)
    // A tampered fragment: the digest is the whole reason to trust the result,
    // so a mismatch must yield nothing rather than a "probably fine" coupon.
    chunks[1] = { ...chunks[1], payload: chunks[1].payload.replace(/.$/, 'A') }

    await offerChunk(chunks[0])
    expect(await offerChunk(chunks[1])).toBeNull()
  })

  it('refuses a payload whose length does not match', async () => {
    const chunks = await makeChunks(payloadFor(BIG_TOKEN), 2)
    const lying = chunks.map((c) => ({ ...c, content_length: c.content_length + 1 }))

    await offerChunk(lying[0])
    expect(await offerChunk(lying[1])).toBeNull()
  })

  it('drops the transfer when the sender disagrees about its own size', async () => {
    const chunks = await makeChunks(payloadFor(BIG_TOKEN), 2)
    await offerChunk(chunks[0])

    expect(await offerChunk({ ...chunks[1], chunk_total: 3 })).toBeNull()
    expect(pendingChunkTransfers()).toBe(0)
  })

  it('discards pieces that have waited too long', async () => {
    const chunks = await makeChunks(payloadFor(BIG_TOKEN), 2)
    const t0 = 1_000_000

    await offerChunk(chunks[0], t0)
    expect(pendingChunkTransfers()).toBe(1)

    // An abandoned half-transfer must not pin memory forever. The wrap is
    // still on the relay, so a later redelivery starts the assembly again.
    await offerChunk({ ...chunks[0], transfer_id: 'other' }, t0 + 11 * 60 * 1000)
    expect(pendingChunkTransfers()).toBe(1)
  })
})
