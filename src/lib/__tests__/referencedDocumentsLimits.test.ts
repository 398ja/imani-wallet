/**
 * @vitest-environment jsdom
 */
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { encodePlainTokenV4 } from '../plainToken'
import { receiveByOwnSwap, type MintTransport } from '../receiveSwap'
import { pendingSwapIntents } from '../swapIntent'
import {
  MAX_VOUCHER_DOCUMENT_BYTES,
  MAX_VOUCHER_DOCUMENTS_TOTAL_BYTES,
  VoucherDocumentMissing,
  VoucherDocumentsInvalid,
  referencedDocuments,
  validateVoucherDocuments,
} from '../voucherToken'

/**
 * cashu-voucher#64 review M4/L7: outgoing documents (tokens and swaps) get the same count,
 * per-document and 1 MiB total checks as incoming ones, matching cashu-lib VoucherDocuments
 * (MAX_DOCUMENT_BYTES 65536, MAX_TOTAL_DOCUMENT_BYTES 1048576, count <= proofs).
 */
const PUBKEY = 'c'.repeat(64)
const MINT = 'https://mint.example.test'
const KEYSET = '00ab'
const C = '02' + '11'.repeat(32)

beforeEach(() => localStorage.clear())

function doc(size: number, fill: number): Uint8Array {
  return new Uint8Array(size).fill(fill)
}

function refProof(d: Uint8Array, i: number) {
  const key = bytesToHex(sha256(d))
  return {
    amount: 1,
    id: KEYSET,
    secret: JSON.stringify(['VOUCHER', { nonce: `n${i}`, data: key, tags: [] }]),
    C,
    document: bytesToHex(d),
  }
}

describe('outgoing voucher document limits', () => {
  it('matches the Java limits', () => {
    expect(MAX_VOUCHER_DOCUMENT_BYTES).toBe(65_536)
    expect(MAX_VOUCHER_DOCUMENTS_TOTAL_BYTES).toBe(1_048_576)
  })

  it('accepts documents exactly at the per-document limit', () => {
    expect(referencedDocuments([refProof(doc(MAX_VOUCHER_DOCUMENT_BYTES, 1), 0)])).toBeDefined()
  })

  it('refuses a token whose documents total more than 1 MiB', () => {
    // 17 maximal documents: each one fine, together over 1 MiB.
    const proofs = Array.from({ length: 17 }, (_, i) => refProof(doc(MAX_VOUCHER_DOCUMENT_BYTES, i + 1), i))
    expect(() => referencedDocuments(proofs)).toThrow(VoucherDocumentsInvalid)
    expect(() => encodePlainTokenV4(MINT, 'sat', proofs)).toThrow(VoucherDocumentsInvalid)
  })

  it('refuses an oversize single document in the Map form too', () => {
    const big = doc(MAX_VOUCHER_DOCUMENT_BYTES + 1, 7)
    const proof = { ...refProof(big, 0), document: undefined }
    const documents = new Map([[bytesToHex(sha256(big)), big]])
    expect(() => referencedDocuments([proof], documents)).toThrow(VoucherDocumentsInvalid)
    // Record form: an oversize document is not resolvable at all.
    expect(() => referencedDocuments([refProof(big, 0)])).toThrow(VoucherDocumentMissing)
  })

  it('bounds the document count by the proofs, as the decoder does', () => {
    // Outgoing documents are collected per referencing proof, so the count can never exceed the
    // proofs. The shared check still refuses more entries than proofs.
    const d = doc(10, 3)
    const shared = [refProof(d, 0), refProof(d, 1)]
    expect(Object.keys(referencedDocuments(shared)!)).toHaveLength(1)
    const a = doc(5, 1)
    const b = doc(5, 2)
    expect(() =>
      validateVoucherDocuments({ [bytesToHex(sha256(a))]: a, [bytesToHex(sha256(b))]: b }, 1),
    ).toThrow(VoucherDocumentsInvalid)
  })

  it('falls back to documents when a proof carries a document that does not hash to its reference', () => {
    const good = doc(20, 9)
    const proof = { ...refProof(good, 0), document: bytesToHex(doc(20, 8)) }
    const key = bytesToHex(sha256(good))
    expect(referencedDocuments([proof], new Map([[key, good]]))).toEqual({ [key]: bytesToHex(good) })
    expect(() => referencedDocuments([proof])).toThrow(VoucherDocumentMissing)
  })
})

describe('receiveByOwnSwap refuses oversize outgoing documents before any intent', () => {
  it('refuses a swap over 1 MiB without calling the mint or writing an intent', async () => {
    const proofs = Array.from({ length: 17 }, (_, i) => refProof(doc(MAX_VOUCHER_DOCUMENT_BYTES, i + 1), i))
    const swap = vi.fn()
    await expect(
      receiveByOwnSwap({ pubkey: PUBKEY, mintUrl: MINT, proofs, releaseVoucher: true }, { swap } as unknown as MintTransport),
    ).rejects.toThrow(VoucherDocumentsInvalid)
    expect(swap).not.toHaveBeenCalled()
    expect(pendingSwapIntents(PUBKEY)).toHaveLength(0)
  })

  it('refuses a proof whose own document does not match, with no fallback, before any intent', async () => {
    const proofs = [{ ...refProof(doc(20, 9), 0), document: bytesToHex(doc(20, 8)) }]
    const swap = vi.fn()
    await expect(
      receiveByOwnSwap({ pubkey: PUBKEY, mintUrl: MINT, proofs, releaseVoucher: true }, { swap } as unknown as MintTransport),
    ).rejects.toThrow(VoucherDocumentMissing)
    expect(swap).not.toHaveBeenCalled()
    expect(pendingSwapIntents(PUBKEY)).toHaveLength(0)
  })
})
