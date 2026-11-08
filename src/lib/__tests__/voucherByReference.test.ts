import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { describe, expect, it, vi } from 'vitest'

import { carveProofs } from '../checkoutCarve'
import { faceSharesOf } from '../faceSplit'
import { createMintTransport } from '../mintTransport'
import { encodePlainTokenV4 } from '../plainToken'
import { splitTokenByVoucher } from '../tokenSplit'
import {
  MAX_VOUCHER_DOCUMENT_BYTES,
  VoucherDocumentMissing,
  creditableFaceValue,
  decodeCbor,
  isVoucherByReference,
  isVoucherSecret,
  parseVoucherToken,
  proofSecrets,
  tokenProofs,
  tokenVoucherDocuments,
  verifyVoucher,
  voucherOfProof,
  voucherOfSecret,
} from '../voucherToken'
import { reencoded, referenceSecret, toByReference, tokenWithRawV } from './byReference'
import { buildVoucherToken } from './voucherFixtures'

const FIXTURES = join(__dirname, 'fixtures')
const vectors = JSON.parse(readFileSync(join(FIXTURES, 'voucherByReferenceVectors.json'), 'utf8')) as { vouchers: unknown[] }
const PINNED_V1_SHA = 'e2ac672568d8722445d9e62adb2d7b8baf99c7da35c48fbfb993931e86205baa' // from the pre-#64 encoder (1bb991c6)

/** Every captured token whose proofs are unlocked v1 vouchers, read straight off disk. */
const capturedV1 = readdirSync(FIXTURES)
  .filter((f) => /\.(token|txt|staging-token)$/.test(f))
  .map((f) => ({ name: f, token: readFileSync(join(FIXTURES, f), 'utf8').trim() }))
  .filter(({ token }) => {
    try {
      return tokenProofs(token).some((p) => p.secret.startsWith('["VOUCHER"')) && !!parseVoucherToken(token)
    } catch {
      return false
    }
  })

const built = [
  { name: 'built 2-proof', token: buildVoucherToken().token },
  { name: 'built 7-proof with C', token: buildVoucherToken({}, [1, 2, 4, 8, 16, 32, 64], {}, undefined, true).token },
  { name: 'built forged', token: buildVoucherToken({}, [5, 3], { faceValue: 999_999 }).token },
]

const v1Fixtures = [...capturedV1, ...built]

const b64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0))
const root = (t: string) => decodeCbor(b64(t.slice(6))) as Record<string, unknown>

describe('voucher by reference: v1 and v2 read the same (cashu-voucher#64)', () => {
  it('has captured v1 fixtures to convert', () => {
    expect(capturedV1.length).toBeGreaterThanOrEqual(2)
  })

  it.each(v1Fixtures)('$name: parse, verdict and creditable sats are identical', ({ token }) => {
    const v2 = toByReference(token)
    expect(v2).not.toBe(token)
    expect(proofSecrets(v2).every(isVoucherByReference)).toBe(true)
    const a = parseVoucherToken(token)
    const b = parseVoucherToken(v2)
    expect(b).toEqual(a)
    expect(verifyVoucher(b.voucher)).toEqual(verifyVoucher(a.voucher))
    expect(creditableFaceValue(b)).toEqual(creditableFaceValue(a))
  })

  it.each(v1Fixtures)('$name: carries exactly one document per voucher, keyed by its hash', ({ token }) => {
    const docs = tokenVoucherDocuments(toByReference(token))
    expect(docs.size).toBe(1)
    for (const [k, d] of docs) expect(bytesToHex(sha256(d))).toBe(k)
  })

  it('v1 tokens are not by reference and carry no documents', () => {
    for (const { token } of v1Fixtures) {
      expect(proofSecrets(token).some(isVoucherByReference)).toBe(false)
      expect(tokenVoucherDocuments(token).size).toBe(0)
    }
  })

  it('a v2 secret is a voucher to every guard', () => {
    const v2 = toByReference(built[0].token)
    for (const s of proofSecrets(v2)) expect(isVoucherSecret(s)).toBe(true)
  })

  it('voucherOfProof resolves through the carried document, voucherOfSecret through a map', () => {
    const { token, voucher } = buildVoucherToken()
    const v2 = toByReference(token)
    const [p] = tokenProofs(v2)
    expect(voucherOfProof(p)?.voucherId).toBe(voucher.voucherId)
    expect(voucherOfSecret(p.secret, tokenVoucherDocuments(v2))?.voucherId).toBe(voucher.voucherId)
    expect(voucherOfSecret(p.secret)).toBeNull()
  })
})

describe('voucher by reference: refusals', () => {
  const v1 = buildVoucherToken().token
  const doc = () => {
    const m = new Map<string, Uint8Array>()
    referenceSecret(tokenProofs(v1)[0].secret, m)
    return [...m.entries()][0]
  }

  it('a missing document: decodes, but is unverifiable and never plain sats', () => {
    const t = tokenWithRawV(v1, [])
    expect(tokenProofs(t)).toHaveLength(2)
    expect(tokenProofs(t)[0].document).toBeUndefined()
    expect(() => parseVoucherToken(t)).toThrow(VoucherDocumentMissing)
    expect(proofSecrets(t).every(isVoucherSecret)).toBe(true)
    expect(voucherOfProof(tokenProofs(t)[0])).toBeNull()
    // Re-encoding would drop the coupon's only document: refused.
    expect(() => encodePlainTokenV4('http://mint.test', 'sat', tokenProofs(t))).toThrow(VoucherDocumentMissing)
  })

  it('a document whose hash is not its key', () => {
    const [k, d] = doc()
    const bad = d.slice()
    bad[bad.length - 1] ^= 1
    const t = tokenWithRawV(v1, [[k, bad]])
    expect(() => parseVoucherToken(t)).toThrow(/does not match/)
    expect(() => tokenProofs(t)).toThrow(/does not match/)
  })

  it('an uppercase key', () => {
    const [k, d] = doc()
    expect(() => tokenVoucherDocuments(tokenWithRawV(v1, [[k.toUpperCase(), d]]))).toThrow(/lowercase/)
  })

  it('an empty document', () => {
    const empty = new Uint8Array(0)
    expect(() => tokenVoucherDocuments(tokenWithRawV(v1, [[bytesToHex(sha256(empty)), empty]]))).toThrow(/empty or too large/)
  })

  it('an oversized document', () => {
    const big = new Uint8Array(MAX_VOUCHER_DOCUMENT_BYTES + 1).fill(7)
    expect(() => tokenVoucherDocuments(tokenWithRawV(v1, [[bytesToHex(sha256(big)), big]]))).toThrow(/empty or too large/)
    const max = new Uint8Array(MAX_VOUCHER_DOCUMENT_BYTES).fill(7)
    expect(tokenVoucherDocuments(tokenWithRawV(v1, [doc(), [bytesToHex(sha256(max)), max]])).size).toBe(2)
  })

  it('more documents than proofs', () => {
    const extra = (n: number): [string, Uint8Array] => {
      const d = new Uint8Array([n, 1, 2])
      return [bytesToHex(sha256(d)), d]
    }
    expect(() => tokenVoucherDocuments(tokenWithRawV(v1, [doc(), extra(1), extra(2)]))).toThrow(/more voucher documents than proofs/)
  })

  it('v2 mixed with v1 of the same voucher is one voucher', () => {
    const proofs = tokenProofs(v1)
    const docs = new Map<string, Uint8Array>()
    const mixed = encodePlainTokenV4(
      'http://mint.test',
      'sat',
      [proofs[0], { ...proofs[1], secret: referenceSecret(proofs[1].secret, docs) }],
      docs,
    )
    expect(parseVoucherToken(mixed)).toEqual(parseVoucherToken(v1))
  })

  it('v2 proofs of two different vouchers are refused as today', () => {
    const a = toByReference(buildVoucherToken({ voucherId: '11111111-1111-4111-8111-111111111111' }, [1]).token)
    const b = toByReference(buildVoucherToken({ voucherId: '22222222-2222-4222-8222-222222222222' }, [2]).token)
    const both = encodePlainTokenV4('http://mint.test', 'sat', [...tokenProofs(a), ...tokenProofs(b)])
    expect(() => parseVoucherToken(both)).toThrow(/more than one voucher/)
    // And the reader that cuts such a token keeps each part's document.
    const parts = splitTokenByVoucher(both)
    expect(parts).toHaveLength(2)
    expect(parts.map((t) => tokenVoucherDocuments(t).size)).toEqual([1, 1])
  })
})

describe('voucher by reference: carrying', () => {
  it('re-encoding is byte-identical with no by-reference proof (fixed vector)', () => {
    // Pinned bytes of a deterministic 2-proof v1 token from the Java golden secret: any change to the
    // encoder's output for v1 shows up here.
    const vec = (vectors.vouchers as Array<{ v1_secret: string; v2_secret: string; document_hex: string; document_key: string }>)[0]
    const proofs = [1, 2].map((amount) => ({ amount, id: '00ab', secret: vec.v1_secret, C: '02' + '11'.repeat(32) }))
    const v1 = encodePlainTokenV4('http://mint.test', 'sat', proofs)
    expect(bytesToHex(sha256(new TextEncoder().encode(v1)))).toBe(PINNED_V1_SHA)
    expect(reencoded(v1)).toBe(v1)
    const v2 = toByReference(v1)
    expect(reencoded(v2)).toBe(v2)
    expect([...tokenVoucherDocuments(v2).keys()]).toEqual([vec.document_key])
    expect(proofSecrets(v2)[0]).toBe(vec.v2_secret)
    expect(parseVoucherToken(v2)).toEqual(parseVoucherToken(v1))
  })

  it('v1 proofs decode to the same shape as before (no document field)', () => {
    for (const { token } of v1Fixtures) {
      for (const p of tokenProofs(token)) expect(Object.keys(p).sort()).toEqual(Object.keys(p).filter((k) => k !== 'document').sort())
    }
  })

  it('v is written last, keys ascending, only referenced documents', () => {
    const a = buildVoucherToken({ voucherId: '11111111-1111-4111-8111-111111111111' }, [1, 2])
    const b = buildVoucherToken({ voucherId: '22222222-2222-4222-8222-222222222222' }, [4])
    const docs = new Map<string, Uint8Array>()
    const pa = tokenProofs(a.token).map((p) => ({ ...p, secret: referenceSecret(p.secret, docs) }))
    const pb = tokenProofs(b.token).map((p) => ({ ...p, secret: referenceSecret(p.secret, docs) }))
    const both = encodePlainTokenV4('http://mint.test', 'sat', [...pb, ...pa], docs)
    const r = root(both)
    expect(Object.keys(r)).toEqual(['m', 'u', 't', 'v'])
    const keys = Object.keys(r.v as object)
    expect(keys).toEqual([...keys].sort())
    expect(keys).toHaveLength(2)
    // Only pa: one document dropped.
    const onlyA = encodePlainTokenV4('http://mint.test', 'sat', pa, docs)
    expect(tokenVoucherDocuments(onlyA).size).toBe(1)
    expect(parseVoucherToken(onlyA).voucher.voucherId).toBe(a.voucher.voucherId)
  })

  it('carving a v2 token keeps the document in both parts', () => {
    const v2 = toByReference(buildVoucherToken({}, [600, 400]).token)
    const shares = faceSharesOf(v2)!
    const carved = carveProofs(v2, shares.get(tokenProofs(v2)[1].secret)!)
    expect(carved).not.toBeNull()
    for (const t of [carved!.part, carved!.rest!]) {
      expect(tokenVoucherDocuments(t).size).toBe(1)
      expect(parseVoucherToken(t).voucher).toEqual(parseVoucherToken(v2).voucher)
    }
  })

  it('swap body adds vouchers only when an input is by reference (exact JSON)', async () => {
    const bodies: string[] = []
    const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
      bodies.push(init.body)
      return new Response(JSON.stringify({ signatures: [] }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const transport = createMintTransport()
    const outputs = [{ amount: 1, id: '00ab', B_: '02aa' }]
    const v1In = [{ amount: 1, id: '00ab', secret: 's1', C: '02cc' }]
    await transport.swap('http://mint.test', { inputs: v1In, outputs })
    expect(bodies[0]).toBe('{"inputs":[{"amount":1,"id":"00ab","secret":"s1","C":"02cc"}],"outputs":[{"amount":1,"id":"00ab","B_":"02aa"}]}')

    const docHex = 'a1' + '00'.repeat(40)
    const key = bytesToHex(sha256(hexToBytes(docHex)))
    const secret = JSON.stringify(['VOUCHER', { nonce: 'n', data: key, tags: [] }])
    await transport.swap('http://mint.test', { inputs: [{ amount: 1, id: '00ab', secret, C: '02cc', document: docHex }], outputs })
    expect(bodies[1]).toBe(
      `{"inputs":[{"amount":1,"id":"00ab","secret":${JSON.stringify(secret)},"C":"02cc"}],` +
        `"outputs":[{"amount":1,"id":"00ab","B_":"02aa"}],"vouchers":{"${key}":"${docHex}"}}`,
    )
    // The document never rides inside the input itself.
    expect(JSON.parse(bodies[1]).inputs[0].document).toBeUndefined()
    vi.unstubAllGlobals()
  })
})
