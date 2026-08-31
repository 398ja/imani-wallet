import { describe, expect, it } from 'vitest'
import {
  parseVoucherToken,
  javaDoubleToString,
  verifyVoucher,
  voucherCanonicalBytes,
  type SignedVoucherFields,
} from '../voucherToken'

/**
 * A real voucher from staging (`imani_core.voucher_send`), reduced to the fields
 * the issuer signed plus the signature itself. The token is deliberately NOT here
 * — it is bearer value and does not belong in a repository; these fields are not.
 *
 * GBP, faceValue 1000 (£10.00), ratio 1000/17820. Signed before the canonicalizer
 * fix, so it only verifies against the truncated form.
 */
const STAGING: SignedVoucherFields = {
  voucherId: '1d4410af-70f5-4c14-8606-519404684ea7',
  issuerId: '32571441619edd632f41b5d263ea508d30f43c0bef1b37c57a129f0242a4c30f',
  unit: 'GBP',
  faceValue: 1000,
  expiresAt: 1808069579,
  memo: 'Atomic purchase ap_4a6d5fb793d149b4',
  backingStrategy: 'PROPORTIONAL',
  issuanceRatio: 0.05611672278338945,
  faceDecimals: 2,
  merchantMetadata: null,
  nonce: '9637578ddcad0aafe73d5afc6d74bb32900023e2445827bc1d3fe4e9b0c98945',
  issuerSignature:
    'e68978f2fd840614eb82ccb8b05c6b030f8810a00332859fa091ac7b84d39ed6' +
    'c4378248e0cac31ed8da4b6fc7cfb9635d943f6069246f66b5f10574c094caa6',
  issuerPublicKey: '3919fce5dcc18e15654f4fd9efb70f9d18cd753a685469a139e1832126cbc75b',
}

describe('voucherCanonicalBytes', () => {
  it('reproduces the bytes the issuer actually signed', () => {
    // If this string drifts by one character every genuine voucher stops
    // verifying, which is a worse failure than the hole this closes. Pinned
    // literally rather than derived.
    expect(new TextDecoder().decode(voucherCanonicalBytes(STAGING, true))).toBe(
      '["VOUCHER",' +
        '"31643434313061662d373066352d346331342d383630362d353139343034363834656137",' +
        '"9637578ddcad0aafe73d5afc6d74bb32900023e2445827bc1d3fe4e9b0c98945",' +
        '[["issuer","32571441619edd632f41b5d263ea508d30f43c0bef1b37c57a129f0242a4c30f"],' +
        '["unit","GBP"],' +
        '["face_value",1000],' +
        '["expires_at",1808069579],' +
        '["memo","Atomic purchase ap_4a6d5fb793d149b4"],' +
        '["face_decimals",2],' +
        '["backing_strategy","PROPORTIONAL"],' +
        '["issuance_ratio",0]]]',
    )
  })

  it('omits the ratio tag entirely at parity, as setIssuanceRatio does', () => {
    const bytes = new TextDecoder().decode(
      voucherCanonicalBytes({ ...STAGING, issuanceRatio: 1 }),
    )
    expect(bytes).not.toContain('issuance_ratio')
  })
})

describe('verifyVoucher', () => {
  it('verifies a real staging voucher and reports it as legacy-signed', () => {
    // The end-to-end proof that the canonical reconstruction is byte-exact: this
    // signature was produced by the Java signer over bytes this module rebuilt
    // from a CBOR blob, with no shared code.
    expect(verifyVoucher(STAGING)).toEqual({
      signatureValid: true,
      legacyCanonical: true,
    })
  })

  it('rejects a rewritten issuer', () => {
    const forged = { ...STAGING, issuerId: 'f'.repeat(64) }
    expect(verifyVoucher(forged).signatureValid).toBe(false)
  })

  it('rejects a rewritten face value', () => {
    const inflated = { ...STAGING, faceValue: 100000 }
    expect(verifyVoucher(inflated).signatureValid).toBe(false)
  })

  it('does NOT reject a rewritten ratio on a legacy voucher — the known hole', () => {
    // Documents the exposure rather than pretending it is closed. The ratio was
    // truncated to 0 before signing, so any fractional value verifies. This is
    // exactly why credit must be bounded by the signed faceValue, and why
    // legacyCanonical is surfaced to callers at all.
    const rewritten = { ...STAGING, issuanceRatio: 0.5611672278338945 }
    expect(verifyVoucher(rewritten)).toEqual({
      signatureValid: true,
      legacyCanonical: true,
    })
  })

  it('returns not-verified rather than throwing on malformed input', () => {
    expect(verifyVoucher({ ...STAGING, issuerSignature: 'nonsense' }).signatureValid).toBe(false)
  })
})

describe('javaDoubleToString', () => {
  // Captured from `java D.java` on JDK 21 — the digits agree with JS, the
  // notation does not, and these bytes get hashed.
  it.each([
    [0.05611672278338945, '0.05611672278338945'],
    [0.01, '0.01'],
    [0.001, '0.001'],
    [0.0009, '9.0E-4'],
    [1e-4, '1.0E-4'],
    [1.5e-7, '1.5E-7'],
    [0.5, '0.5'],
    [2.5, '2.5'],
    [0.1 + 0.2, '0.30000000000000004'],
    [1 / 3, '0.3333333333333333'],
  ])('formats %p as Java does: %s', (input, expected) => {
    expect(javaDoubleToString(input)).toBe(expected)
  })

  it('differs from JS String() exactly where Java switches notation', () => {
    expect(String(0.0009)).toBe('0.0009')
    expect(javaDoubleToString(0.0009)).toBe('9.0E-4')
  })
})

// --- token assembly, so the parse path can be tested without a bearer token ---

function cborBytes(...parts: Array<number | Uint8Array>): Uint8Array {
  const flat: number[] = []
  for (const p of parts) {
    if (typeof p === 'number') flat.push(p)
    else flat.push(...p)
  }
  return new Uint8Array(flat)
}
const head = (major: number, n: number): Uint8Array =>
  n < 24
    ? new Uint8Array([(major << 5) | n])
    : n < 256
      ? new Uint8Array([(major << 5) | 24, n])
      : new Uint8Array([(major << 5) | 25, n >> 8, n & 0xff])
const tstr = (s: string) => {
  const b = new TextEncoder().encode(s)
  return cborBytes(head(3, b.length), b)
}
const uint = (n: number) => head(0, n)

/** A TokenV4 carrying `secrets.length` proofs of 1 sat each. */
function makeToken(secrets: string[]): string {
  const proofs = secrets.map((s) => cborBytes(head(5, 2), tstr('a'), uint(1), tstr('s'), tstr(s)))
  const entry = cborBytes(head(5, 1), tstr('p'), head(4, proofs.length), ...proofs)
  const root = cborBytes(
    head(5, 3),
    tstr('m'), tstr('http://mint.test'),
    tstr('u'), tstr('sat'),
    tstr('t'), head(4, 1), entry,
  )
  let bin = ''
  for (const byte of root) bin += String.fromCharCode(byte)
  return 'cashuB' + btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const blobHex = (() => {
  // Minimal CBOR map of the voucher fields readVoucherFields requires.
  const pair = (k: string, v: Uint8Array) => cborBytes(tstr(k), v)
  return Array.from(
    cborBytes(
      head(5, 8),
      pair('voucherId', tstr(STAGING.voucherId)),
      pair('issuerId', tstr(STAGING.issuerId)),
      pair('unit', tstr('GBP')),
      pair('faceValue', uint(1000)),
      pair('faceDecimals', uint(2)),
      pair('nonce', tstr(STAGING.nonce)),
      pair('issuerSignature', tstr(STAGING.issuerSignature)),
      pair('issuerPublicKey', tstr(STAGING.issuerPublicKey)),
    ),
  )
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
})()

const secretFor = (hex: string, nonce: string) => JSON.stringify(['VOUCHER', hex, nonce, []])

/**
 * The NUT-10 secret as cashu-lib actually writes it today.
 *
 * `WellKnownSecretSerializer` emits `["VOUCHER", {nonce, data, tags}]` — an
 * OBJECT as the second element, not the flat `[kind, hex, nonce, tags]` form.
 * Every test above builds the flat form, which is why the parser could stop
 * reading real tokens without a single test noticing.
 */
const objectSecretFor = (hex: string, nonce: string) =>
  JSON.stringify(['VOUCHER', { nonce, data: hex, tags: [] }])

describe('parseVoucherToken', () => {
  /**
   * The regression behind "Not checked" coming back on verified coupons.
   *
   * cashu-lib's `WellKnownSecretSerializer` writes the object form, so
   * `hexToBytes(parsed[1])` ran against an OBJECT and threw.
   * `verifiedVoucherFrom` catches that and treats it as "not a voucher" — the
   * same path plain ecash takes legitimately — so no validation record was ever
   * built and the merchant's Checks section read "Not checked" on a coupon
   * whose signature would have verified.
   */
  it('reads the object-form NUT-10 secret that cashu-lib actually writes', () => {
    const parsed = parseVoucherToken(makeToken([objectSecretFor(blobHex, 'nonce-a')]))
    expect(parsed.voucher.voucherId).toBe(STAGING.voucherId)
    expect(parsed.voucher.issuerId).toBe(STAGING.issuerId)
    expect(parsed.tokenAmount).toBe(1)
  })

  it('reads a multi-proof token in the object form', () => {
    const parsed = parseVoucherToken(
      makeToken([objectSecretFor(blobHex, 'nonce-a'), objectSecretFor(blobHex, 'nonce-b')]),
    )
    expect(parsed.proofCount).toBe(2)
    expect(parsed.tokenAmount).toBe(2)
  })

  /** The mixed-provenance guard must survive the shape change, not be lost to it. */
  it('still rejects mixed vouchers in the object form', () => {
    const other = blobHex.replace(/^..../, '9999')
    expect(() =>
      parseVoucherToken(makeToken([objectSecretFor(blobHex, 'a'), objectSecretFor(other, 'b')])),
    ).toThrow(/more than one voucher/)
  })

  /** A VOUCHER secret whose object carries no `data` is malformed, not a voucher. */
  it('rejects an object-form secret with no data field', () => {
    const secret = JSON.stringify(['VOUCHER', { nonce: 'n', tags: [] }])
    expect(() => parseVoucherToken(makeToken([secret]))).toThrow(/not a voucher/)
  })

  it('accepts a multi-proof token whose proofs have different wrapper nonces', () => {
    // Every real token looks like this — proofs MUST have distinct NUT-10 nonces
    // or they would be the same proof. Comparing whole secret strings rejected
    // every genuine multi-proof token; only the voucher blob is shared.
    const token = makeToken([secretFor(blobHex, 'nonce-a'), secretFor(blobHex, 'nonce-b')])
    const parsed = parseVoucherToken(token)
    expect(parsed.proofCount).toBe(2)
    expect(parsed.tokenAmount).toBe(2)
    expect(parsed.voucher.voucherId).toBe(STAGING.voucherId)
  })

  it('rejects a token mixing proofs from two different vouchers', () => {
    const other = blobHex.replace(/^..../, '9999')
    expect(() =>
      parseVoucherToken(makeToken([secretFor(blobHex, 'a'), secretFor(other, 'b')])),
    ).toThrow(/more than one voucher/)
  })

  it('rejects a non-voucher token', () => {
    const plain = JSON.stringify(['P2PK', blobHex, 'n', []])
    expect(() => parseVoucherToken(makeToken([plain]))).toThrow(/not a voucher/)
  })
})
