/**
 * The wallet's voucher ledger v2 agrees with cashu-voucher's Java, on the Java's own vectors.
 *
 * `fixtures/voucherLedgerV2Vectors.json` is copied byte for byte from cashu-voucher
 * `cashu-voucher-domain/src/test/resources/voucher-ledger-v2-vectors.json` (branch
 * feat/310-ledger-v2, commit af0ae305, sha256 117920e528d7f211b79f64f81030f5ea89b1abd934efb6e13d3ddd9e2f675de2).
 * `fixtures/nip44Vectors.json` is the official paulmillr/nip44 file the Java also replays.
 * Every byte below was produced by the Java, not written to match this code. If a vector fails,
 * one side changed: do not regenerate the file to make it pass.
 */
import { describe, expect, it } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils'
import { nip44 } from 'nostr-tools'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  conversationKey,
  eventKey,
  expirationTag,
  ledgerRoot,
  locator,
  normaliseIssuerId,
  normaliseVoucherId,
  read,
  resolve,
  seal,
  voucherRef,
  writeBody,
  LedgerRefusedError,
  type LedgerEntry,
  type LedgerEventLike,
  type LedgerStatus,
  type VoucherFields,
} from '../voucherLedgerV2'
import vectors from './fixtures/voucherLedgerV2Vectors.json'
import nip44Vectors from './fixtures/nip44Vectors.json'

const FIXTURE_SHA256 = 'e49bebf3b1efcd0055c1315d60686a911f8ab03338d7a5104aca22d66ba7c2db'

interface SealedVector {
  name: string
  input: {
    status: LedgerStatus
    signer: 'platform' | 'stall'
    root: 'platform' | 'stall'
    nip44Nonce: string
    auxRand: string
    voucher: VoucherFields
    doc?: string
  }
  body: string
  envelope: string
  envelopeBytes: number
  event: LedgerEventLike & { pubkey: string }
  trustedIssuerKeys: string[]
}

interface NegativeVector {
  name: string
  issuerId: string
  voucherId: string
  trustedIssuerKeys: string[]
  envelope?: string
  event: LedgerEventLike & { pubkey: string }
  expected: string
}

const keys = vectors.keys
const secretOf = (who: 'platform' | 'stall'): Uint8Array =>
  hexToBytes(who === 'platform' ? keys.platformSecretKey : keys.stallSecretKey)
const sealed = vectors.sealed as unknown as SealedVector[]
const negatives = vectors.negativeReads as unknown as NegativeVector[]

describe('fixture', () => {
  it('is the committed Java file, byte for byte', () => {
    const path = fileURLToPath(new URL('./fixtures/voucherLedgerV2Vectors.json', import.meta.url))
    expect(bytesToHex(sha256(readFileSync(path)))).toBe(FIXTURE_SHA256)
  })
})

describe('NIP-44 v2 (nostr-tools) on the official vectors, with a given conversation key', () => {
  const v2 = nip44Vectors.v2
  it.each(v2.valid.encrypt_decrypt)('encrypt/decrypt $plaintext', (v) => {
    const k = hexToBytes(v.conversation_key)
    expect(nip44.v2.encrypt(v.plaintext, k, hexToBytes(v.nonce))).toBe(v.payload)
    expect(nip44.v2.decrypt(v.payload, k)).toBe(v.plaintext)
  })
  it.each(v2.invalid.decrypt)('refuses: $note', (v) => {
    expect(() => nip44.v2.decrypt(v.payload, hexToBytes(v.conversation_key))).toThrow()
  })
})

describe('keys', () => {
  it('public keys and ledger roots', () => {
    for (const who of ['platform', 'stall'] as const) {
      const sk = secretOf(who)
      expect(bytesToHex(schnorr.getPublicKey(sk))).toBe(keys[`${who}PublicKey`])
      expect(bytesToHex(ledgerRoot(sk))).toBe(keys[`${who}LedgerRoot`])
    }
    expect(bytesToHex(schnorr.getPublicKey(hexToBytes(keys.attackerSecretKey)))).toBe(keys.attackerPublicKey)
  })
})

describe('derivations', () => {
  it.each(vectors.derivations)('$issuerId / $voucherId', (v) => {
    expect(normaliseIssuerId(v.issuerId)).toBe(v.normalisedIssuerId)
    expect(normaliseVoucherId(v.voucherId)).toBe(v.normalisedVoucherId)
    const ref = voucherRef(v.issuerId, v.voucherId)
    expect(bytesToHex(ref)).toBe(v.ref)
    expect(bytesToHex(conversationKey(ref))).toBe(v.key)
    expect(locator(ref)).toBe(v.locator)
    const sk = eventKey(ledgerRoot(secretOf(v.root as 'platform' | 'stall')), ref)
    expect(bytesToHex(sk)).toBe(v.eventKey)
    expect(bytesToHex(schnorr.getPublicKey(sk))).toBe(v.eventPubkey)
  })
})

describe('refusedInputs', () => {
  it.each(vectors.refusedInputs)('$note', (v) => {
    expect(() => voucherRef(v.issuerId, v.voucherId)).toThrow()
  })
})

describe('expirationTag', () => {
  it.each(vectors.expirationTag)('$expiresAt', (v) => {
    expect(expirationTag(v.expiresAt)).toBe(v.expiration)
  })
})

describe('sealed', () => {
  it.each(sealed)('$name reproduces body, envelope and event content', (v) => {
    const entry: LedgerEntry = {
      status: v.input.status,
      voucher: v.input.voucher,
      ...(v.input.doc ? { doc: hexToBytes(v.input.doc) } : {}),
    }
    const ref = voucherRef(v.input.voucher.issuerId, v.input.voucher.voucherId)
    expect(writeBody(entry, ref)).toBe(v.body)
    const out = seal(entry, secretOf(v.input.signer), ledgerRoot(secretOf(v.input.root)), hexToBytes(v.input.nip44Nonce), hexToBytes(v.input.auxRand))
    expect(nip44.v2.decrypt(out.template.content, conversationKey(ref))).toBe(v.envelope)
    expect(utf8ToBytes(v.envelope).length).toBe(v.envelopeBytes)
    expect(out.template).toEqual({ pubkey: v.event.pubkey, kind: v.event.kind, tags: v.event.tags, content: v.event.content })
    expect(bytesToHex(schnorr.getPublicKey(out.eventSecretKey))).toBe(v.event.pubkey)
  })

  it.each(sealed)('$name reads back', (v) => {
    const ref = voucherRef(v.input.voucher.issuerId, v.input.voucher.voucherId)
    const opened = read(v.event, ref, v.trustedIssuerKeys)
    expect(opened.status).toBe(v.input.status)
    expect(opened.docDropped).toBe(false)
    if (v.input.doc) expect(bytesToHex(opened.doc!)).toBe(v.input.doc)
  })
})

describe('negativeReads', () => {
  it.each(negatives)('$name is refused with $expected', (v) => {
    const ref = voucherRef(v.issuerId, v.voucherId)
    let reason: string | undefined
    try {
      read(v.event, ref, v.trustedIssuerKeys)
    } catch (e) {
      reason = e instanceof LedgerRefusedError ? e.reason : `threw ${String(e)}`
    }
    expect(reason).toBe(v.expected)
  })

  it.each(negatives.filter((v) => v.envelope))('$name carries the stated envelope', (v) => {
    const ref = voucherRef(v.issuerId, v.voucherId)
    // Only for events at this voucher's own address; the others do not decrypt by design.
    if (v.event.tags.some((t) => t[0] === 'd' && t[1] === locator(ref)) && v.expected !== 'UNDECRYPTABLE') {
      expect(nip44.v2.decrypt(v.event.content, conversationKey(ref))).toBe(v.envelope)
    }
  })
})

describe('resolve', () => {
  const byName = (name: string): LedgerEventLike =>
    name.startsWith('negative:')
      ? negatives.find((n) => `negative:${n.name}` === name)!.event
      : sealed.find((s) => s.name === name)!.event
  it.each(vectors.resolve)('$name -> $expectedStatus', (v) => {
    const first = byName(v.events[0])
    const s = sealed.find((x) => x.name === v.events[0])
    const n = negatives.find((x) => `negative:${x.name}` === v.events[0])
    const ids = s ? s.input.voucher : n!
    const trusted = s ? s.trustedIssuerKeys : n!.trustedIssuerKeys
    expect(first).toBeDefined()
    const result = resolve(v.events.map(byName), voucherRef(ids.issuerId, ids.voucherId), trusted)
    expect(result?.status ?? null).toBe(v.expectedStatus)
    if (v.expectedFaceValue !== undefined) expect(result?.voucher.faceValue).toBe(v.expectedFaceValue)
    // Order-independent (imani-wallet#582): the reversed input must fold to the same answer.
    const reversed = resolve([...v.events].reverse().map(byName), voucherRef(ids.issuerId, ids.voucherId), trusted)
    expect(reversed?.status ?? null).toBe(v.expectedStatus)
    expect(reversed?.voucher).toEqual(result?.voucher)
  })
})
