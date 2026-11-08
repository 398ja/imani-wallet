/**
 * The wallet reads vouchers by reference exactly as cashu-voucher does, on the Java's own vectors
 * (cashu-voucher#64).
 *
 * `fixtures/voucherByReferenceVectors.json` is copied byte for byte from cashu-voucher's
 * `cashu-voucher-domain/src/test/resources/voucher-by-reference-vectors.json`. Every document,
 * key and verdict was produced by the Java, not written to match this code. If a vector fails
 * here, one side changed: do not regenerate the file to make it pass.
 */
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { describe, expect, it } from 'vitest'

import { encodePlainTokenV4 } from '../plainToken'
import {
  MAX_VOUCHER_DOCUMENT_BYTES,
  MAX_VOUCHER_DOCUMENTS_TOTAL_BYTES,
  decodeCbor,
  isUnverifiableVoucherError,
  isVoucherByReference,
  isVoucherSecret,
  tokenProofs,
  tokenVoucherDocuments,
  parseVoucherToken,
  validateVoucherDocuments,
  verifyVoucher,
  voucherOfSecret,
} from '../voucherToken'
import vectors from './fixtures/voucherByReferenceVectors.json'

interface VoucherVector {
  name: string
  v1_secret: string
  v2_secret: string
  document_hex: string
  document_key: string
  voucher_id: string
  signature_valid: boolean
  valid: boolean
}
interface NegativeVector {
  name: string
  secret: string
  documents: Record<string, string>
  resolution: 'missing' | 'mismatch' | 'not_by_reference'
  documents_acceptable: boolean
  verifiable: boolean
  generated_document?: { length: number; fill: string }
}

const positives = vectors.vouchers as VoucherVector[]
const negatives = vectors.negatives as NegativeVector[]
const KEYSET = '00ab'
const token = (secrets: string[], documents?: Map<string, Uint8Array>) =>
  encodePlainTokenV4('http://mint.test', 'sat', secrets.map((secret, n) => ({ amount: 1 << n, id: KEYSET, secret, C: '02' + '11'.repeat(32) })), documents)

/** The vector's documents as a token's `v` map would decode them (byte strings). */
function documentsOf(n: NegativeVector): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {}
  for (const [k, hex] of Object.entries(n.documents)) out[k] = hexToBytes(hex)
  if (n.generated_document) {
    const doc = new Uint8Array(n.generated_document.length).fill(parseInt(n.generated_document.fill, 16))
    out[bytesToHex(sha256(doc))] = doc
  }
  return out
}

describe('Java by-reference vectors: positives', () => {
  it('the file is the Java one', () => {
    expect(vectors.max_document_bytes).toBe(MAX_VOUCHER_DOCUMENT_BYTES)
    expect(positives.length).toBeGreaterThan(0)
  })

  it.each(positives)('$name: key is sha256 of the document, v2 data is the key', (v) => {
    expect(bytesToHex(sha256(hexToBytes(v.document_hex)))).toBe(v.document_key)
    expect(isVoucherByReference(v.v2_secret)).toBe(true)
    expect(isVoucherByReference(v.v1_secret)).toBe(false)
    expect(isVoucherSecret(v.v2_secret)).toBe(true)
  })

  it.each(positives)('$name: v1 and v2 resolve to the same voucher and verdict', (v) => {
    const docs = new Map([[v.document_key, hexToBytes(v.document_hex)]])
    const a = voucherOfSecret(v.v1_secret)!
    const b = voucherOfSecret(v.v2_secret, docs)!
    expect(b).toEqual(a)
    expect(b.voucherId).toBe(v.voucher_id)
    expect(verifyVoucher(b).signatureValid).toBe(v.signature_valid)
    expect(verifyVoucher(a).signatureValid).toBe(v.signature_valid)
    const expired = b.expiresAt !== undefined && b.expiresAt * 1000 < Date.now()
    expect(v.signature_valid && !expired).toBe(v.valid)
  })

  it.each(positives)('$name: tokens of each form, and mixed, parse identically', (v) => {
    const docs = new Map([[v.document_key, hexToBytes(v.document_hex)]])
    const p1 = parseVoucherToken(token([v.v1_secret, v.v1_secret]))
    expect(parseVoucherToken(token([v.v2_secret, v.v2_secret], docs))).toEqual(p1)
    expect(parseVoucherToken(token([v.v1_secret, v.v2_secret], docs))).toEqual(p1)
  })
})

describe('Java by-reference vectors: negatives', () => {
  it.each(negatives)('$name', (n) => {
    const raw = documentsOf(n)
    const accept = () => validateVoucherDocuments(raw, 16)
    if (n.documents_acceptable) expect(accept).not.toThrow()
    else expect(accept).toThrow()

    // Never verifiable, never plain sats, whatever the map.
    expect(isVoucherSecret(n.secret)).toBe(true)
    expect(isVoucherByReference(n.secret)).toBe(n.resolution !== 'not_by_reference')
    const docs = n.documents_acceptable ? accept() : new Map<string, Uint8Array>()
    const v = voucherOfSecret(n.secret, docs)
    expect(v === null || !verifyVoucher(v).signatureValid).toBe(!n.verifiable)
  })

  it('documents adding up to more than 1 MiB are refused before hashing', () => {
    const per = MAX_VOUCHER_DOCUMENT_BYTES
    const count = MAX_VOUCHER_DOCUMENTS_TOTAL_BYTES / per
    const ok: Record<string, Uint8Array> = {}
    for (let i = 0; i < count; i++) {
      const d = new Uint8Array(per).fill(i + 1)
      ok[bytesToHex(sha256(d))] = d
    }
    expect(validateVoucherDocuments(ok, 64).size).toBe(count)
    // One byte over: bad keys on purpose, to show the total is checked before any hash.
    const over = { ...ok, ['00'.repeat(32)]: new Uint8Array(1) }
    expect(() => validateVoucherDocuments(over, 64)).toThrow(/1 MiB/)
  })
})

interface TokenMapVector {
  name: string
  token: string
  accepted: boolean
}

describe('Java by-reference vectors: token documents maps (review L5)', () => {
  const maps = vectors.token_documents_maps as TokenMapVector[]

  it('covers __proto__, duplicate and non-text keys', () => {
    expect(maps.map((m) => m.name)).toEqual(expect.arrayContaining(['well-formed', 'proto-key', 'duplicate-key', 'non-text-key']))
  })

  it.each(maps)('$name: accepted exactly when Java accepts it', (m) => {
    const read = () => tokenVoucherDocuments(m.token)
    if (m.accepted) expect(read().size).toBe(1)
    else expect(read).toThrow()
    if (!m.accepted) {
      expect(() => tokenProofs(m.token)).toThrow()
      expect(() => parseVoucherToken(m.token)).toThrow()
    }
  })

  it.each(maps.filter((m) => !m.accepted))('$name: refused as an unverifiable voucher, not plain ecash (review N8)', (m) => {
    let caught: unknown
    try {
      tokenVoucherDocuments(m.token)
    } catch (e) {
      caught = e
    }
    expect(isUnverifiableVoucherError(caught)).toBe(true)
    try {
      tokenProofs(m.token)
    } catch (e) {
      caught = e
    }
    expect(isUnverifiableVoucherError(caught)).toBe(true)
  })
})

interface DocumentCborVector {
  name: string
  document_hex: string
  document_key: string
  v1_secret: string
  v2_secret: string
  readable: boolean
}

describe('Java by-reference vectors: voucher document CBOR (review N7)', () => {
  const docs = vectors.documents_cbor as DocumentCborVector[]

  it('covers duplicate and non-text keys', () => {
    expect(docs.map((d) => d.name)).toEqual(expect.arrayContaining(['well-formed', 'duplicate-key', 'non-text-key']))
  })

  it.each(docs)('$name: readable exactly when Java reads it', (d) => {
    const bytes = hexToBytes(d.document_hex)
    const documents = new Map([[d.document_key, bytes]])
    if (d.readable) {
      expect(() => decodeCbor(bytes)).not.toThrow()
      expect(voucherOfSecret(d.v1_secret)).not.toBeNull()
      expect(voucherOfSecret(d.v2_secret, documents)).not.toBeNull()
    } else {
      expect(() => decodeCbor(bytes)).toThrow()
      expect(voucherOfSecret(d.v1_secret)).toBeNull()
      expect(voucherOfSecret(d.v2_secret, documents)).toBeNull()
    }
  })
})
