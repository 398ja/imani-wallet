import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'

import { encodePlainTokenV4 } from '../plainToken'
import { decodeCbor, tokenProofs } from '../voucherToken'

/**
 * Test util for cashu-voucher#64: a v1 (inline) voucher token rewritten into its v2 (by reference)
 * form. Each unlocked `VOUCHER` proof's `data` becomes hex(sha256(D)) and D moves to the token's
 * `v` map. Locked and plain proofs are untouched.
 *
 * The mint signature `C` no longer matches the new secret. That is fine for parsing and
 * verification: the issuer signature is over the document, not over the proof.
 */
export function toByReference(v1Token: string): string {
  const root = decodeCbor(b64url(v1Token.slice(6))) as Record<string, unknown>
  const documents = new Map<string, Uint8Array>()
  const proofs = tokenProofs(v1Token).map((p) => {
    const secret = referenceSecret(p.secret, documents)
    return { amount: p.amount, id: p.id, secret, C: p.C, ...(p.dleq ? { dleq: p.dleq } : {}) }
  })
  return encodePlainTokenV4(String(root.m ?? ''), String(root.u ?? 'sat'), proofs, documents)
}

/** One secret in its by-reference form, recording its document. */
export function referenceSecret(secret: string, documents: Map<string, Uint8Array>): string {
  const parsed = JSON.parse(secret) as unknown[]
  if (parsed[0] !== 'VOUCHER') return secret
  const second = parsed[1]
  const hex = typeof second === 'string' ? second : (second as { data: string }).data
  const doc = hexToBytes(hex)
  const key = bytesToHex(sha256(doc))
  documents.set(key, doc)
  if (typeof second === 'string') return JSON.stringify([parsed[0], key, ...parsed.slice(2)])
  return JSON.stringify([parsed[0], { ...(second as object), data: key }])
}

/** The v1 token re-encoded by the wallet's own encoder, so it compares with `toByReference`. */
export function reencoded(token: string): string {
  const root = decodeCbor(b64url(token.slice(6))) as Record<string, unknown>
  return encodePlainTokenV4(String(root.m ?? ''), String(root.u ?? 'sat'), tokenProofs(token))
}

function b64url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  return Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0))
}

/** Minimal CBOR writer for hostile `v` maps in negative tests. */
export function tokenWithRawV(v1Token: string, vEntries: Array<[string, Uint8Array]>, rewrite = true): string {
  const documents = new Map<string, Uint8Array>()
  const root = decodeCbor(b64url(v1Token.slice(6))) as Record<string, unknown>
  const proofs = tokenProofs(v1Token).map((p) => ({
    amount: p.amount,
    id: p.id,
    secret: rewrite ? referenceSecret(p.secret, documents) : p.secret,
    C: p.C,
  }))
  // Encode with no v (references left dangling would throw), then splice v in by hand.
  const plainProofs = proofs.map((p) => ({ ...p, secret: p.secret }))
  const base = encodeWithoutDocs(String(root.m ?? ''), String(root.u ?? 'sat'), plainProofs, documents)
  const bytes = b64url(base.slice(6))
  // Root head is 0xa3 (3 entries): bump to 4 and append "v".
  if (bytes[0] !== 0xa3) throw new Error('unexpected root head')
  const parts: number[] = [0xa4, ...bytes.slice(1), 0x61, 0x76, ...head(5, vEntries.length)]
  for (const [k, d] of vEntries) {
    const kb = new TextEncoder().encode(k)
    parts.push(...head(3, kb.length), ...kb, ...head(2, d.length), ...d)
  }
  let bin = ''
  for (const b of parts) bin += String.fromCharCode(b)
  return 'cashuB' + btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function encodeWithoutDocs(m: string, u: string, proofs: Array<{ amount: number; id: string; secret: string; C: string }>, docs: Map<string, Uint8Array>): string {
  // Encode with full docs, then strip the trailing v by re-encoding through a token that drops it.
  const full = encodePlainTokenV4(m, u, proofs, docs)
  const root = decodeCbor(b64url(full.slice(6))) as Record<string, unknown>
  if (!root.v) return full
  // Rebuild: encode the same proofs with the documents attached is the only path the encoder
  // allows, so cut the `v` entry off the end instead.
  const bytes = b64url(full.slice(6))
  const vBytes = vLength(root.v as Record<string, Uint8Array>)
  const cut = new Uint8Array([0xa3, ...bytes.slice(1, bytes.length - vBytes)])
  let bin = ''
  for (const b of cut) bin += String.fromCharCode(b)
  return 'cashuB' + btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function vLength(v: Record<string, Uint8Array>): number {
  let n = 2 + head(5, Object.keys(v).length).length
  for (const [k, d] of Object.entries(v)) n += head(3, k.length).length + k.length + head(2, d.length).length + d.length
  return n
}

function head(major: number, n: number): number[] {
  if (n < 24) return [(major << 5) | n]
  if (n < 0x100) return [(major << 5) | 24, n]
  if (n < 0x10000) return [(major << 5) | 25, n >> 8, n & 0xff]
  return [(major << 5) | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
}
