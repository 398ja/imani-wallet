import { describe, expect, it } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils'
import { readFileSync } from 'node:fs'

import { parseVoucherToken, verifyVoucher } from '../voucherToken'

/**
 * One signature must not cover two readings of the same number.
 *
 * ## The bug, and why both sides need the fix
 *
 * The canonicaliser normalises numeric tags before hashing, which it must: the
 * bytes have to be identical in Java and here. The side effect is that `"1000"`,
 * `"01000"`, `"1000.0"` and `"1e3"` hash the same, so one signature satisfies all
 * four.
 *
 * That would be harmless if both readers agreed on the value, and they do not.
 * `Number("1000.0")` here is 1000, while Java's `Long.parseLong` REFUSES it and
 * yields no face value at all. So a holder can present whichever form suits them:
 * the wallet credits a face value the Java side cannot see, which is how the
 * Java-side face clamp gets dropped.
 *
 * Fixing one side alone would only reverse the disagreement. So the rule is the
 * same in both: the wire form must already BE canonical, not merely normalise to
 * something that is.
 *
 * cashu-voucher#48. The Java half is `CanonicalNumericTagTest`.
 */

/**
 * A locked voucher token whose `face_value` is written exactly as given.
 *
 * Built rather than captured, because the point is to control the WIRE FORM of one
 * number, which no captured token can do. Signed over the same canonical bytes the
 * reader rebuilds, so the signature is genuine and only the rendering varies. That
 * is what makes the refusals below attributable to the rendering and nothing else.
 *
 * The locked kind specifically: it is the only one whose numeric tags travel as
 * NUT-10 tags, so it is the only one where a wire form exists to be ambiguous.
 */
function lockedTokenWithFaceValue(faceValueOnTheWire: string) {
  const priv = schnorr.utils.randomSecretKey()
  const pub = bytesToHex(schnorr.getPublicKey(priv))
  const nonce = 'a'.repeat(64)
  const lockKey = '02' + 'b'.repeat(64)

  // Tag ORDER is hashed, so it is fixed here and the signature is made over the
  // same order the reader will see.
  const tags: [string, string][] = [
    ['voucher_id', '1d4410af-70f5-4c14-8606-519404684ea7'],
    ['issuer', pub],
    ['unit', 'EUR'],
    ['face_value', faceValueOnTheWire],
    ['face_decimals', '2'],
  ]

  const render = (value: string, key: string) => {
    const NUMERIC = ['face_value', 'expires_at', 'face_decimals', 'issuance_ratio']
    if (!NUMERIC.includes(key)) return `"${value}"`
    const number = Number(value)
    // Mirrors the canonicaliser: integral values render as integers.
    return Number.isInteger(number) ? String(number) : String(number)
  }

  const canonical = new TextEncoder().encode(
    `["P2PK_VOUCHER","${lockKey}","${nonce}",[${tags
      .map(([key, value]) => `["${key}",${render(value, key)}]`)
      .join(',')}]]`,
  )
  const signature = bytesToHex(schnorr.sign(sha256(canonical), priv))

  const secret = JSON.stringify([
    'P2PK_VOUCHER',
    {
      nonce,
      data: lockKey,
      tags: [
        ...tags.map(([key, value]) => [key, value]),
        ['issuer_sig', signature],
        ['issuer_pubkey', pub],
      ],
    },
  ])

  return cashuBToken(secret)
}

/** Wraps one secret in a minimal TokenV4, using the CBOR the reader expects. */
function cashuBToken(secret: string): string {
  const text = (value: string) => {
    const bytes = new TextEncoder().encode(value)
    return [...header(3, bytes.length), ...bytes]
  }
  const header = (major: number, length: number): number[] => {
    if (length < 24) return [(major << 5) | length]
    if (length < 256) return [(major << 5) | 24, length]
    if (length < 65536) return [(major << 5) | 25, length >> 8, length & 0xff]
    return [(major << 5) | 26, length >>> 24, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff]
  }
  const bstr = (bytes: number[]) => [...header(2, bytes.length), ...bytes]

  // {m, u, t: [{i, p: [{a, s, c}]}]}
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
  return (
    'cashuB' + btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  )
}

describe('a locked voucher whose numbers are canonical', () => {
  /**
   * The control. If this fails, the rule is refusing genuine vouchers, which is
   * worse than the bug it closes.
   */
  it('verifies', () => {
    const parsed = parseVoucherToken(lockedTokenWithFaceValue('1000'))

    expect(parsed.voucher.canonicalNumbers).toBe(true)
    expect(verifyVoucher(parsed.voucher).signatureValid).toBe(true)
  })

  /** And so does every real captured voucher, which is what actually matters. */
  it('holds for the captured fixtures', () => {
    for (const name of ['witness-positive.token', 'witness-test.token']) {
      const parsed = parseVoucherToken(
        readFileSync(`src/lib/__tests__/fixtures/${name}`, 'utf8').trim(),
      )
      if (!parsed.voucher.lockKey) continue
      expect(parsed.voucher.canonicalNumbers, name).toBe(true)
      expect(verifyVoucher(parsed.voucher).signatureValid, name).toBe(true)
    }
  })
})

describe('a locked voucher whose numbers are not canonical', () => {
  /**
   * `1000.0` is the form that genuinely diverges between the two readers, so it is
   * the one that matters most. The others are the same class and cost nothing to
   * cover.
   *
   * Each is signed over the SAME canonical bytes, so the signature verifies and the
   * only thing wrong is the rendering. Without the rule every one of these passes.
   */
  it.each(['1000.0', '01000', ' 1000', '+1000', '1e3'])(
    'refuses a face value written as %s',
    (wireForm) => {
      const parsed = parseVoucherToken(lockedTokenWithFaceValue(wireForm))

      expect(parsed.voucher.canonicalNumbers, 'the parser must spot the ambiguity').toBe(false)
      expect(
        verifyVoucher(parsed.voucher).signatureValid,
        'and verification must refuse it, however good the signature',
      ).toBe(false)
    },
  )
})
