import { describe, expect, it, vi } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { finalizeEvent, nip44 } from 'nostr-tools'

/**
 * Voucher ledger v2 refusals the Java vectors do not cover one by one, plus the JSON writing rule
 * against `JSON.stringify` and the relay reader. The parity file proves agreement with the Java;
 * this one proves the TypeScript refuses every shape the spec says a reader refuses.
 */

let relayEvents: unknown[] = []
vi.mock('../relay', () => ({ eventsByDTag: async () => relayEvents }))

import type { LedgerEventLike, LedgerStatus } from '../voucherLedgerV2'

const L = await import('../voucherLedgerV2')
const { readVoucherLedgerStatus } = await import('../voucherLedgerV2Status')

const STALL_SK = hexToBytes('b2'.repeat(32))
const STALL = bytesToHex(schnorr.getPublicKey(STALL_SK))
const PLATFORM_SK = hexToBytes('a1'.repeat(32))
const PLATFORM = bytesToHex(schnorr.getPublicKey(PLATFORM_SK))
const VID = '0b8e3f6a-1c2d-4e5f-8a9b-0c1d2e3f4a5b'
const REF = L.voucherRef(STALL, VID)
const D = L.locator(REF)
const K = L.conversationKey(REF)

/** An event at the right address whose envelope is exactly `envelope`. */
const withEnvelope = (envelope: string): LedgerEventLike => ({ kind: 30078, tags: [['d', D]], content: nip44.v2.encrypt(envelope, K) })
/** A correctly signed envelope over an arbitrary body string. */
const signedEnvelope = (body: string, sk = STALL_SK): string =>
  JSON.stringify({ body, sig: bytesToHex(schnorr.sign(L.statement(D, body), sk)), signer: bytesToHex(schnorr.getPublicKey(sk)), pad: '' })
const refusal = (event: LedgerEventLike, trusted: string[] = []): string | undefined => {
  try {
    L.read(event, REF, trusted)
    return undefined
  } catch (e) {
    return e instanceof L.LedgerRefusedError ? e.reason : String(e)
  }
}
const goodBody = (over: Record<string, unknown> = {}, voucher: Record<string, unknown> = {}): string =>
  JSON.stringify({ v: 2, ref: bytesToHex(REF), status: 'REDEEMED', seq: 2, voucher: { voucherId: VID, issuerId: STALL, ...voucher }, ...over })

describe('JSON writing rule', () => {
  it('matches JSON.stringify for every BMP code unit and astral pairs', () => {
    let all = ''
    for (let c = 0; c < 0x10000; c++) if (c < 0xd800 || c > 0xdfff) all += String.fromCharCode(c)
    all += '\u{1f389}\u{10ffff}'
    expect(L.quoteJson(all)).toBe(JSON.stringify(all))
  })
  it('refuses lone surrogates', () => {
    expect(() => L.quoteJson('a\ud800')).toThrow(/surrogate/)
    expect(() => L.quoteJson('\udc00b')).toThrow(/surrogate/)
    expect(() => L.quoteJson('\ud800x')).toThrow(/surrogate/)
  })
})

describe('strict JSON', () => {
  it('refuses duplicate keys at any depth, trailing data, and non-JSON', () => {
    expect(() => L.parseStrictJson('{"a":1,"a":2}')).toThrow()
    expect(() => L.parseStrictJson('{"x":{"a":1,"a":1}}')).toThrow()
    expect(() => L.parseStrictJson('{"a":1} x')).toThrow()
    expect(() => L.parseStrictJson('{"a":01}')).toThrow()
    expect(() => L.parseStrictJson("{'a':1}")).toThrow()
    expect(L.parseStrictJson(' {"a":[1,true,null,"\\u00e9"]} ')).toBeTruthy()
  })
})

describe('reader refusals', () => {
  it('a valid REDEEMED by the stall is accepted, and with no trusted keys at all', () => {
    expect(L.read(withEnvelope(signedEnvelope(goodBody())), REF).status).toBe('REDEEMED')
  })
  it('address: wrong kind, two d tags, no d tag', () => {
    const e = withEnvelope(signedEnvelope(goodBody()))
    expect(refusal({ ...e, kind: 1 })).toBe('NOT_THIS_ADDRESS')
    expect(refusal({ ...e, tags: [['d', D], ['d', D]] })).toBe('NOT_THIS_ADDRESS')
    expect(refusal({ ...e, tags: [] })).toBe('NOT_THIS_ADDRESS')
  })
  it('undecryptable: another key, garbage', () => {
    expect(refusal({ kind: 30078, tags: [['d', D]], content: nip44.v2.encrypt('{}', new Uint8Array(32).fill(7)) })).toBe('UNDECRYPTABLE')
    expect(refusal({ kind: 30078, tags: [['d', D]], content: 'nope' })).toBe('UNDECRYPTABLE')
  })
  it('envelope: not JSON, an array, missing key, wrong types, bad hex, non-zero pad', () => {
    const body = goodBody()
    const sig = bytesToHex(schnorr.sign(L.statement(D, body), STALL_SK))
    expect(refusal(withEnvelope('not json'))).toBe('MALFORMED_ENVELOPE')
    expect(refusal(withEnvelope('[]'))).toBe('MALFORMED_ENVELOPE')
    expect(refusal(withEnvelope(JSON.stringify({ body, sig, signer: STALL })))).toBe('MALFORMED_ENVELOPE')
    expect(refusal(withEnvelope(JSON.stringify({ body: 1, sig, signer: STALL, pad: '' })))).toBe('MALFORMED_ENVELOPE')
    expect(refusal(withEnvelope(JSON.stringify({ body, sig: sig.toUpperCase(), signer: STALL, pad: '' })))).toBe('MALFORMED_ENVELOPE')
    expect(refusal(withEnvelope(JSON.stringify({ body, sig, signer: STALL.slice(2), pad: '' })))).toBe('MALFORMED_ENVELOPE')
    expect(refusal(withEnvelope(JSON.stringify({ body, sig, signer: STALL, pad: '01' })))).toBe('MALFORMED_ENVELOPE')
    expect(refusal(withEnvelope(JSON.stringify({ body, sig, signer: STALL, pad: '', x: 1 })))).toBe('UNKNOWN_KEY')
    expect(refusal(withEnvelope(`{"body":${JSON.stringify(body)},"sig":"${sig}","signer":"${STALL}","pad":"","pad":""}`))).toBe('DUPLICATE_KEY')
  })
  it('signature: over another locator, by another key than the named signer', () => {
    const body = goodBody()
    const wrongD = bytesToHex(schnorr.sign(L.statement('00'.repeat(32), body), STALL_SK))
    expect(refusal(withEnvelope(JSON.stringify({ body, sig: wrongD, signer: STALL, pad: '' })))).toBe('BAD_SIGNATURE')
    const byPlatform = bytesToHex(schnorr.sign(L.statement(D, body), PLATFORM_SK))
    expect(refusal(withEnvelope(JSON.stringify({ body, sig: byPlatform, signer: STALL, pad: '' })))).toBe('BAD_SIGNATURE')
  })
  it('body shape: types, int64, fractions, exponents, doc type, missing ids, non-normalised ids', () => {
    const r = (body: string): string | undefined => refusal(withEnvelope(signedEnvelope(body)))
    expect(r('[]')).toBe('MALFORMED_BODY')
    expect(r(goodBody({}, { faceValue: 1.5 }))).toBe('MALFORMED_BODY')
    expect(r(goodBody({}, { faceValue: '10' }))).toBe('MALFORMED_BODY')
    expect(r(goodBody().replace('"seq":2', '"seq":2e0'))).toBe('MALFORMED_BODY')
    expect(r(goodBody({}, { expiresAt: 1 }).replace('"expiresAt":1', '"expiresAt":9223372036854775808'))).toBe('MALFORMED_BODY')
    expect(r(goodBody({}, { memo: 5 }))).toBe('MALFORMED_BODY')
    expect(r(goodBody({ doc: 5 }))).toBe('MALFORMED_BODY')
    expect(r(goodBody({ voucher: { issuerId: STALL } }))).toBe('MALFORMED_BODY')
    expect(r(goodBody({}, { voucherId: VID.toUpperCase() }))).toBe('MALFORMED_BODY')
    expect(r(goodBody({ v: '2' }))).toBe('MALFORMED_BODY')
    expect(r(goodBody({ x: 1 }))).toBe('UNKNOWN_KEY')
    expect(r(goodBody({}, { x: 1 }))).toBe('UNKNOWN_KEY')
  })
  it('version, ref, status, seq, signer in that order', () => {
    const r = (body: string, trusted: string[] = []): string | undefined => refusal(withEnvelope(signedEnvelope(body)), trusted)
    expect(r(goodBody({ v: 3 }))).toBe('WRONG_VERSION')
    expect(r(goodBody({ v: 3, ref: '00' }))).toBe('WRONG_VERSION')
    expect(r(goodBody({ ref: '00'.repeat(32) }))).toBe('REF_MISMATCH')
    expect(r(goodBody({ status: 'EXPIRED' }))).toBe('STATUS_REFUSED')
    expect(r(goodBody({ status: 'redeemed' }))).toBe('STATUS_REFUSED')
    expect(r(goodBody({ seq: 1 }))).toBe('SEQ_MISMATCH')
    expect(r(goodBody({ status: 'ISSUED', seq: 2 }))).toBe('SEQ_MISMATCH')
    expect(r(goodBody({ status: 'REVOKED' }))).toBeUndefined()
  })
  it('signer authority: ISSUED by trusted or issuer, REDEEMED and REVOKED by the issuer only', () => {
    const issued = goodBody({ status: 'ISSUED', seq: 1 })
    expect(refusal(withEnvelope(signedEnvelope(issued, PLATFORM_SK)), [PLATFORM.toUpperCase()])).toBeUndefined()
    expect(refusal(withEnvelope(signedEnvelope(issued, PLATFORM_SK)), [])).toBe('UNAUTHORISED_SIGNER')
    expect(refusal(withEnvelope(signedEnvelope(issued, STALL_SK)), [])).toBeUndefined()
    expect(refusal(withEnvelope(signedEnvelope(goodBody(), PLATFORM_SK)), [PLATFORM])).toBe('UNAUTHORISED_SIGNER')
    expect(refusal(withEnvelope(signedEnvelope(goodBody({ status: 'REVOKED' }), PLATFORM_SK)), [PLATFORM])).toBe('UNAUTHORISED_SIGNER')
  })
  it('a doc that does not verify drops only the doc', () => {
    const opened = L.read(withEnvelope(signedEnvelope(goodBody({ doc: 'abcd' }))), REF)
    expect(opened.docDropped).toBe(true)
    expect(opened.doc).toBeUndefined()
    expect(L.read(withEnvelope(signedEnvelope(goodBody({ doc: 'xyz' }))), REF).docDropped).toBe(true)
  })
})

describe('writer refusals', () => {
  const fields = { voucherId: VID, issuerId: STALL }
  const root = L.ledgerRoot(STALL_SK)
  it('a terminal credential, a REDEEMED not signed by the issuer, an oversize envelope', () => {
    const code = (fn: () => unknown): string | undefined => {
      try {
        fn()
      } catch (e) {
        return e instanceof L.LedgerRefusedError ? e.reason : String(e)
      }
      return undefined
    }
    expect(code(() => L.seal({ status: 'ISSUED', voucher: { ...fields, merchantMetadata: '{"terminal":true}' } }, PLATFORM_SK, root))).toBe('TERMINAL_CREDENTIAL')
    expect(code(() => L.seal({ status: 'REDEEMED', voucher: fields }, PLATFORM_SK, root))).toBe('UNAUTHORISED_SIGNER')
    expect(code(() => L.seal({ status: 'ISSUED', voucher: { ...fields, memo: 'x'.repeat(70_000) } }, PLATFORM_SK, root))).toBe('TOO_LARGE')
  })
  it('pads every envelope to its exact bucket', () => {
    for (const n of [0, 500, 1500, 3000, 6000, 12_000, 30_000, 60_000]) {
      const sealed = L.seal({ status: 'ISSUED', voucher: { ...fields, memo: 'é'.repeat(n / 2) } }, PLATFORM_SK, root)
      const envelope = nip44.v2.decrypt(sealed.template.content, K)
      expect(L.BUCKETS).toContain(new TextEncoder().encode(envelope).length)
      expect(L.read(sealed.template, REF, [PLATFORM]).voucher.memo).toBe(n ? 'é'.repeat(n / 2) : undefined)
    }
  })
  it('omits the expiration tag for a voucher with no expiry, and fresh nonces differ', () => {
    const a = L.seal({ status: 'REDEEMED', voucher: fields }, STALL_SK, root)
    const b = L.seal({ status: 'REDEEMED', voucher: fields }, STALL_SK, root)
    expect(a.template.tags).toEqual([['d', D]])
    expect(a.template.content).not.toBe(b.template.content)
    expect(a.template.pubkey).toBe(b.template.pubkey)
  })
  it('canonical issuance ratio spelling', () => {
    expect(L.canonicalIssuanceRatio(2)).toBe('2')
    expect(L.canonicalIssuanceRatio(0.5)).toBe('0.5')
    expect(L.canonicalIssuanceRatio(0.0001)).toBe('1.0E-4')
  })
})

describe('readVoucherLedgerStatus', () => {
  const root = L.ledgerRoot(STALL_SK)
  const signed = (status: LedgerStatus, sk: Uint8Array): unknown => {
    const s = L.seal({ status, voucher: { voucherId: VID, issuerId: STALL } }, sk, root)
    return finalizeEvent({ ...s.template, created_at: 1 }, s.eventSecretKey)
  }
  it('resolves what the relay holds, highest seq winning whatever the order', async () => {
    relayEvents = [signed('REDEEMED', STALL_SK), signed('ISSUED', PLATFORM_SK)]
    expect((await readVoucherLedgerStatus(STALL, VID, [PLATFORM]))?.status).toBe('REDEEMED')
  })
  it('ignores a forged REDEEMED at the same address, whoever authors it', async () => {
    // seal() refuses to write this, so it is built by hand, as an attacker would.
    const forged = withEnvelope(signedEnvelope(goodBody(), PLATFORM_SK))
    relayEvents = [signed('ISSUED', PLATFORM_SK), finalizeEvent({ ...forged, created_at: 2 }, schnorr.utils.randomSecretKey())]
    expect((await readVoucherLedgerStatus(STALL, VID, [PLATFORM]))?.status).toBe('ISSUED')
  })
  it('answers null when nothing is accepted, and throws on invalid inputs', async () => {
    relayEvents = []
    expect(await readVoucherLedgerStatus(STALL, VID, [])).toBeNull()
    await expect(readVoucherLedgerStatus(STALL, 'not-a-uuid', [])).rejects.toThrow()
  })
})
