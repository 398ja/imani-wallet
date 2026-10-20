import { describe, expect, it } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'

import { hasCanonicalNumericTags, parseVoucherToken, verifyVoucher } from '../voucherToken'
import vectors from './fixtures/wholeIssuanceRatioVectors.json'

/**
 * A whole-number `issuance_ratio` other than 1 must verify (cashu-voucher#59).
 *
 * ## The bug
 *
 * cashu-lib up to 0.30.6 wrote a ratio of 50 as `"50.0"`. The issuer signed the
 * canonical bytes, where it renders as `50`, so the signature is good. Since
 * cashu-voucher#48 both verifiers also require every numeric tag to arrive
 * ALREADY canonical, and `"50.0"` is not, so every MINIMAL, FIXED and
 * merchant-denomination coupon with a whole ratio was refused. Those proofs are
 * live and their secret cannot be rewritten.
 *
 * ## The rule, the same on both sides
 *
 * Accept `"N.0"` for `issuance_ratio` only, and only exactly the spelling Java's
 * `Double.toString` produced. Every reader parses the ratio as a number, so `"50"`
 * and `"50.0"` mean 50 to all of them, and the signed bytes are identical. Any other
 * spelling stays refused, and `face_value`, `expires_at`, `face_decimals` keep the
 * strict rule: Java reads those with `Long.parseLong`, which is the two-readings
 * case #48 closed.
 *
 * The vectors are cashu-voucher's `whole-issuance-ratio-vectors.json`, replayed by
 * its `VoucherGoldenVectorTest`, so the two verifiers are pinned to one file.
 */

type Vector = (typeof vectors.vectors)[number]

/** The secret string a locked voucher with this ratio spelling carries on the wire. */
function lockedSecret(v: Vector, ratioWire: string, override?: [string, string]): string {
  const t = vectors.locked_template
  const tags = t.tags_before_ratio.map(([key, value]) =>
    override && override[0] === key ? [key, override[1]] : [key, value],
  )
  return JSON.stringify([
    t.kind,
    {
      nonce: t.nonce,
      data: t.data,
      tags: [
        ...tags,
        ['issuance_ratio', ratioWire],
        ['issuer_sig', v.issuer_sig],
        ['issuer_pubkey', vectors.issuer.pub],
      ],
    },
  ])
}

/** Wraps one secret in a minimal TokenV4, the CBOR the reader expects. */
function cashuBToken(secret: string): string {
  const header = (major: number, length: number): number[] => {
    if (length < 24) return [(major << 5) | length]
    if (length < 256) return [(major << 5) | 24, length]
    if (length < 65536) return [(major << 5) | 25, length >> 8, length & 0xff]
    return [(major << 5) | 26, length >>> 24, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff]
  }
  const text = (value: string) => {
    const bytes = new TextEncoder().encode(value)
    return [...header(3, bytes.length), ...bytes]
  }
  const bstr = (bytes: number[]) => [...header(2, bytes.length), ...bytes]
  const proof = [
    ...header(5, 3),
    ...text('a'), ...header(0, 2),
    ...text('s'), ...text(secret),
    ...text('c'), ...bstr(Array.from({ length: 33 }, (_, i) => (i === 0 ? 2 : 0xcd))),
  ]
  const entry = [
    ...header(5, 2),
    ...text('i'), ...bstr([0x00, 0xe3, 0x37, 0x2e, 0x61, 0xd0, 0x56, 0x05]),
    ...text('p'), ...header(4, 1), ...proof,
  ]
  const root = [
    ...header(5, 3),
    ...text('m'), ...text('https://mint.staging.398ja.xyz'),
    ...text('u'), ...text('sat'),
    ...text('t'), ...header(4, 1), ...entry,
  ]
  let binary = ''
  for (const byte of root) binary += String.fromCharCode(byte)
  return 'cashuB' + btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function verifyWire(v: Vector, ratioWire: string, override?: [string, string]) {
  const parsed = parseVoucherToken(cashuBToken(lockedSecret(v, ratioWire, override)))
  return { parsed, verification: verifyVoucher(parsed.voucher) }
}

describe('whole-number issuance ratio vectors (cashu-voucher#59)', () => {
  // The fixture itself: the pinned signature is over the pinned bytes, so a
  // failure below is about the reader, not a stale vector.
  it.each(vectors.vectors)('pins a genuine signature for ratio $ratio', (v) => {
    const bytes = new TextEncoder().encode(v.canonical_bytes_utf8)
    expect(bytesToHex(sha256(bytes))).toBe(v.sha256)
    expect(schnorr.verify(hexToBytes(v.issuer_sig), sha256(bytes), hexToBytes(vectors.issuer.pub))).toBe(true)
  })

  // The canonical wire, "50", is what a fixed issuer writes. It must verify, and
  // the bytes this reader rebuilds must be exactly the ones Java signed.
  it.each(vectors.vectors)('verifies ratio $ratio written canonically', (v) => {
    const { parsed, verification } = verifyWire(v, v.canonical_wire)

    expect(new TextDecoder().decode(parsed.voucher.canonicalWire)).toBe(v.canonical_bytes_utf8)
    expect(parsed.voucher.issuanceRatio).toBe(v.ratio)
    expect(verification.signatureValid).toBe(true)
  })

  // The legacy wire, "50.0", is on every whole-ratio proof issued so far. It was
  // signed over the same bytes and reads as the same ratio, so it must verify.
  it.each(vectors.vectors)('verifies ratio $ratio in the legacy "N.0" spelling', (v) => {
    const { parsed, verification } = verifyWire(v, v.legacy_wire)

    expect(new TextDecoder().decode(parsed.voucher.canonicalWire)).toBe(v.canonical_bytes_utf8)
    expect(parsed.voucher.issuanceRatio).toBe(v.ratio)
    expect(verification.signatureValid).toBe(true)
  })

  // Every other spelling of N hashes the same and is still refused: the window is
  // one spelling wide, so #48's rule is not loosened.
  it.each(vectors.vectors.flatMap((v) => v.refused_wires.map((wire) => [v.ratio, wire, v] as const)))(
    'refuses ratio %s written as %j',
    (_ratio, wire, v) => {
      expect(verifyWire(v, wire).verification.signatureValid).toBe(false)
    },
  )

  // face_value keeps the strict rule. "500.0" is the Long.parseLong divergence
  // #48 exists for, so the legacy window must not reach it.
  it('does not extend the legacy spelling to face_value', () => {
    const v = vectors.vectors[1]
    expect(verifyWire(v, v.legacy_wire, ['face_value', '500.0']).verification.signatureValid).toBe(false)
  })

  // Java switches Double.toString to E notation at 1e7, so the legacy spelling of
  // ten million is "1.0E7", not "10000000.0". Both sides must agree on exactly
  // which string that is, or one of them refuses a genuine voucher.
  it.each([
    ['1.0E7', true],
    ['1.2E7', true],
    ['9999999.0', true],
    ['10000000.0', false],
    ['1.0e7', false],
    ['1E7', false],
  ])('treats an issuance_ratio of %j as verifiable: %s', (wire, accepted) => {
    expect(hasCanonicalNumericTags([['issuance_ratio', wire]])).toBe(accepted)
    // A whole number with a decimal point is never acceptable for face_value.
    expect(hasCanonicalNumericTags([['face_value', wire]])).toBe(false)
  })
})
