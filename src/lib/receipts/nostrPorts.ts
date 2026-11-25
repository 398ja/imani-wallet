/**
 * Nostr storage for receipts, byte-compatible with Java `NostrEvidenceStore` (kind 9740) and
 * `NostrReceiptBackup` (kind 30740). Reads go through the gateway nostrdb cache only
 * (`gatewayQuery`); writes go through the app's relay `publish`, which also caches.
 */
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, nip44, type Event } from 'nostr-tools'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils'
import { decodeStoredReceipt, decodeSummary, encodeStoredReceipt, requireHex32, type EvidenceLocator, type StoredReceipt } from '@imani/receipts'

export const EVIDENCE_KIND = 9740
export const CHUNK_BYTES = 32 * 1024
export const MAX_BLOB_BYTES = 512 * 1024
export const EVIDENCE_ALT = 'imani receipt evidence blob'
export const BACKUP_KIND = 30740
export const PART_PLAINTEXT = 48 * 1024
export const MAX_PARTS = 16
export const BACKUP_ALT = 'imani encrypted receipt backup'
const D_LABEL = 'imani-receipt-backup-d-v1'

export interface NostrIo {
  /** Publish; resolves to how many relays took it. */
  publish: (e: Event) => Promise<number>
  /** Gateway nostrdb query. Throws when unreachable. */
  query: (filter: Record<string, unknown>) => Promise<Event[]>
}

const b64 = (bytes: Uint8Array): string => {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}
const unb64 = (text: string): Uint8Array | null => {
  try {
    const s = atob(text)
    const out = new Uint8Array(s.length)
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
    return out
  } catch {
    return null
  }
}
const tag = (tags: string[][], code: string): string | null => tags.find((t) => t.length >= 2 && t[0] === code)?.[1] ?? null

async function send(io: NostrIo, e: Event, what: string): Promise<void> {
  if ((await io.publish(e)) <= 0) throw new Error(`no relay accepted the ${what}`)
}

// ---------------------------------------------------------------- evidence (9740)

/** Java `NostrEvidenceStore.publish`: throwaway key, inline up to 32 KiB, else chunks plus a root. */
export async function publishEvidenceBlob(io: NostrIo, blob: Uint8Array, relayHint: string | null, now: number): Promise<EvidenceLocator> {
  if (blob.length === 0 || blob.length > MAX_BLOB_BYTES) throw new Error(`evidence blob must be 1..${MAX_BLOB_BYTES} bytes`)
  const digest = bytesToHex(sha256(blob))
  const key = generateSecretKey()
  try {
    const sign = (content: string, tags: string[][]) => finalizeEvent({ kind: EVIDENCE_KIND, content, tags, created_at: now }, key)
    let root: Event
    if (blob.length <= CHUNK_BYTES) {
      root = sign(b64(blob), [['x', digest], ['alt', EVIDENCE_ALT]])
    } else {
      const rootTags: string[][] = [['x', digest], ['size', String(blob.length)], ['alt', EVIDENCE_ALT]]
      for (let off = 0, i = 0; off < blob.length; off += CHUNK_BYTES, i++) {
        const chunk = sign(b64(blob.subarray(off, Math.min(blob.length, off + CHUNK_BYTES))), [['x', digest], ['i', String(i)]])
        await send(io, chunk, 'evidence')
        rootTags.push(['e', chunk.id, '', String(i)])
      }
      root = sign('', rootTags)
    }
    await send(io, root, 'evidence')
    return { eventId: root.id, relayHint }
  } finally {
    key.fill(0)
  }
}

async function byIds(io: NostrIo, ids: string[]): Promise<Map<string, Event>> {
  const out = new Map<string, Event>()
  for (const e of await io.query({ ids, kinds: [EVIDENCE_KIND] })) {
    if (e.kind === EVIDENCE_KIND && ids.includes(e.id) && !out.has(e.id) && verifyEvent(e)) out.set(e.id, e)
  }
  return out
}

/** Java `NostrEvidenceStore.fetch`. Null when absent or not intact; throws when the cache is unreachable. */
export async function fetchEvidenceBlob(io: NostrIo, eventId: string): Promise<Uint8Array | null> {
  const root = (await byIds(io, [eventId])).get(eventId)
  if (!root) return null
  const digest = tag(root.tags, 'x')
  if (!digest) return null
  let blob: Uint8Array | null
  if (root.content !== '') {
    blob = unb64(root.content)
  } else {
    const chunkIds: string[] = []
    for (const t of root.tags) {
      if (t.length >= 4 && t[0] === 'e') {
        if (String(chunkIds.length) !== t[3]) return null
        chunkIds.push(t[1])
      }
    }
    if (chunkIds.length === 0 || chunkIds.length > MAX_BLOB_BYTES / CHUNK_BYTES + 1) return null
    const chunks = await byIds(io, chunkIds)
    const parts: Uint8Array[] = []
    let size = 0
    for (let i = 0; i < chunkIds.length; i++) {
      const c = chunks.get(chunkIds[i])
      if (!c || c.pubkey !== root.pubkey || tag(c.tags, 'x') !== digest || tag(c.tags, 'i') !== String(i)) return null
      const part = unb64(c.content)
      if (!part || size + part.length > MAX_BLOB_BYTES) return null
      parts.push(part)
      size += part.length
    }
    blob = new Uint8Array(size)
    let off = 0
    for (const p of parts) {
      blob.set(p, off)
      off += p.length
    }
  }
  if (!blob || blob.length > MAX_BLOB_BYTES || bytesToHex(sha256(blob)) !== digest.toLowerCase()) return null
  return blob
}

// ---------------------------------------------------------------- backup (30740)

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream)).arrayBuffer()
  return new Uint8Array(out)
}
/** zlib, as Java `DeflaterOutputStream`. */
export const deflate = (b: Uint8Array) => pipe(b, new CompressionStream('deflate'))
export const inflate = (b: Uint8Array) => pipe(b, new DecompressionStream('deflate'))

/** Java `address`: HMAC(HMAC(sk, label), paymentId bytes), hex. Unlinkable without the key. */
export function backupAddress(secretKey: Uint8Array, paymentId: string): string {
  const k = hmac(sha256, secretKey, utf8ToBytes(D_LABEL))
  try {
    return bytesToHex(hmac(sha256, k, hexToBytes(requireHex32(paymentId, 'paymentId'))))
  } finally {
    k.fill(0)
  }
}

/** Java `NostrReceiptBackup.save`: deflate, base64, split at 48 KiB, NIP-44 to self. */
export async function saveBackup(io: NostrIo, withKey: <T>(use: (k: Uint8Array) => T) => T, r: StoredReceipt, now: number): Promise<void> {
  const body = b64(await deflate(encodeStoredReceipt(r)))
  const parts: string[] = []
  for (let off = 0; off < body.length; off += PART_PLAINTEXT) parts.push(body.slice(off, off + PART_PLAINTEXT))
  if (parts.length > MAX_PARTS) throw new Error('receipt too large to back up')
  const events = withKey((key) => {
    const address = backupAddress(key, decodeSummary(r.receipt.summaryBytes).paymentId)
    const ck = nip44.getConversationKey(key, getPublicKey(key))
    return parts.map((part, i) => {
      const tags: string[][] = [['d', parts.length === 1 ? address : `${address}:${i}`]]
      if (parts.length > 1) tags.push(['part', String(i), String(parts.length), address])
      tags.push(['alt', BACKUP_ALT])
      return finalizeEvent({ kind: BACKUP_KIND, content: nip44.encrypt(part, ck), tags, created_at: now }, key)
    })
  })
  for (const e of events) await send(io, e, 'receipt backup')
}

/** Java `restoreAll`. Throws when the cache is unreachable. */
export async function restoreBackups(
  io: NostrIo,
  withKey: <T>(use: (k: Uint8Array) => T) => T,
  publicKey: string,
): Promise<{ restored: StoredReceipt[]; unreadable: number }> {
  const raw = await io.query({ kinds: [BACKUP_KIND], authors: [publicKey] })
  const latest = new Map<string, Event>()
  for (const e of raw) {
    if (e.kind !== BACKUP_KIND || e.pubkey !== publicKey || !verifyEvent(e)) continue
    const d = tag(e.tags, 'd')
    if (!d) continue
    const prev = latest.get(d)
    if (!prev || e.created_at > prev.created_at) latest.set(d, e)
  }
  const ck = withKey((key) => nip44.getConversationKey(key, publicKey))
  const decrypt = (c: string) => nip44.decrypt(c, ck)
  const partOf = (e: Event) => e.tags.find((t) => t.length >= 4 && t[0] === 'part') ?? null
  const restored: StoredReceipt[] = []
  let unreadable = 0
  const multipart = new Map<string, Event[]>()
  const decode = async (text: string) => {
    const bytes = unb64(text)
    if (!bytes) throw new Error('bad base64')
    return decodeStoredReceipt(await inflate(bytes))
  }
  for (const e of latest.values()) {
    const p = partOf(e)
    if (p) {
      multipart.set(p[3], [...(multipart.get(p[3]) ?? []), e])
      continue
    }
    try {
      restored.push(await decode(decrypt(e.content)))
    } catch {
      unreadable++
    }
  }
  for (const group of multipart.values()) {
    try {
      const count = Number.parseInt(partOf(group[0])![2], 10)
      if (!(count >= 2 && count <= MAX_PARTS && group.length === count)) throw new Error('incomplete parts')
      const at = group[0].created_at
      group.sort((a, b) => Number.parseInt(partOf(a)![1], 10) - Number.parseInt(partOf(b)![1], 10))
      let text = ''
      group.forEach((e, i) => {
        const p = partOf(e)!
        if (Number.parseInt(p[1], 10) !== i || Number.parseInt(p[2], 10) !== count || e.created_at !== at) throw new Error('inconsistent parts')
        text += decrypt(e.content)
      })
      restored.push(await decode(text))
    } catch {
      unreadable++
    }
  }
  ck.fill(0)
  return { restored, unreadable }
}
