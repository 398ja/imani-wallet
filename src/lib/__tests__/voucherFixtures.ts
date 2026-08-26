import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'

import { voucherCanonicalBytes, type SignedVoucherFields } from '../voucherToken'

/**
 * Builds real voucher tokens for tests.
 *
 * Signs with a throwaway key over the same canonical bytes the Java issuer uses,
 * so a token from here is genuine in every checkable way. That matters: a fixture
 * that only *looks* like a voucher would let a broken verifier pass.
 */

// ---- minimal CBOR encoder, only the shapes a TokenV4 needs ----

function bytes(...parts: Array<number | Uint8Array>): Uint8Array {
  const flat: number[] = []
  for (const p of parts) {
    if (typeof p === 'number') flat.push(p)
    else flat.push(...p)
  }
  return new Uint8Array(flat)
}

function head(major: number, n: number): Uint8Array {
  if (n < 24) return new Uint8Array([(major << 5) | n])
  if (n < 0x100) return new Uint8Array([(major << 5) | 24, n])
  if (n < 0x10000) return new Uint8Array([(major << 5) | 25, n >> 8, n & 0xff])
  return new Uint8Array([
    (major << 5) | 26,
    (n >>> 24) & 0xff,
    (n >>> 16) & 0xff,
    (n >>> 8) & 0xff,
    n & 0xff,
  ])
}

const tstr = (s: string) => {
  const b = new TextEncoder().encode(s)
  return bytes(head(3, b.length), b)
}
const uint = (n: number) => head(0, n)

function float64(d: number): Uint8Array {
  const buf = new Uint8Array(9)
  buf[0] = (7 << 5) | 27
  new DataView(buf.buffer).setFloat64(1, d)
  return buf
}

// ---- voucher blob + token ----

function voucherBlob(v: SignedVoucherFields): Uint8Array {
  const pairs: Uint8Array[] = [
    bytes(tstr('voucherId'), tstr(v.voucherId)),
    bytes(tstr('issuerId'), tstr(v.issuerId)),
    bytes(tstr('unit'), tstr(v.unit)),
    bytes(tstr('faceValue'), uint(v.faceValue)),
    bytes(tstr('faceDecimals'), uint(v.faceDecimals)),
    bytes(tstr('issuanceRatio'), float64(v.issuanceRatio)),
    bytes(tstr('nonce'), tstr(v.nonce)),
    bytes(tstr('issuerSignature'), tstr(v.issuerSignature)),
    bytes(tstr('issuerPublicKey'), tstr(v.issuerPublicKey)),
  ]
  if (v.expiresAt != null) pairs.push(bytes(tstr('expiresAt'), uint(v.expiresAt)))
  if (v.memo != null) pairs.push(bytes(tstr('memo'), tstr(v.memo)))
  if (v.backingStrategy != null) {
    pairs.push(bytes(tstr('backingStrategy'), tstr(v.backingStrategy)))
  }
  return bytes(head(5, pairs.length), ...pairs)
}

function base64Url(b: Uint8Array): string {
  let bin = ''
  for (const byte of b) bin += String.fromCharCode(byte)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export interface BuiltVoucherToken {
  token: string
  voucher: SignedVoucherFields
}

/**
 * A signed voucher wrapped in a TokenV4 carrying `amounts.length` proofs.
 *
 * Each proof gets its own NUT-10 wrapper nonce, as real proofs must — they would
 * otherwise be the same proof.
 */
export function buildVoucherToken(
  overrides: Partial<SignedVoucherFields> = {},
  amounts: number[] = [1000, 782],
  /**
   * Applied AFTER signing, so the blob no longer matches the signature. This is
   * the only way to build a genuinely forged voucher — altering the inputs before
   * signing just produces a different, valid one.
   */
  tamper: Partial<SignedVoucherFields> = {},
): BuiltVoucherToken {
  const priv = schnorr.utils.randomSecretKey()
  const pub = bytesToHex(schnorr.getPublicKey(priv))

  const unsigned: SignedVoucherFields = {
    voucherId: '1d4410af-70f5-4c14-8606-519404684ea7',
    issuerId: pub,
    unit: 'GBP',
    faceValue: 1000,
    expiresAt: 1808069579,
    memo: 'Test coupon',
    backingStrategy: 'PROPORTIONAL',
    issuanceRatio: 0.05611672278338945,
    faceDecimals: 2,
    merchantMetadata: null,
    nonce: '9637578ddcad0aafe73d5afc6d74bb32900023e2445827bc1d3fe4e9b0c98945',
    issuerSignature: '',
    issuerPublicKey: pub,
    ...overrides,
  }

  const signature = bytesToHex(
    schnorr.sign(sha256(voucherCanonicalBytes(unsigned)), priv),
  )
  const voucher: SignedVoucherFields = { ...unsigned, issuerSignature: signature, ...tamper }

  const blobHex = bytesToHex(voucherBlob(voucher))
  const proofs = amounts.map((amount, i) =>
    bytes(
      head(5, 2),
      tstr('a'),
      uint(amount),
      tstr('s'),
      tstr(JSON.stringify(['VOUCHER', blobHex, `wrapper-nonce-${i}`, []])),
    ),
  )
  const entry = bytes(head(5, 1), tstr('p'), head(4, proofs.length), ...proofs)
  const root = bytes(
    head(5, 3),
    tstr('m'),
    tstr('http://mint.test'),
    tstr('u'),
    tstr('sat'),
    tstr('t'),
    head(4, 1),
    entry,
  )

  return { token: `cashuB${base64Url(root)}`, voucher }
}

/** The JSON envelope the gateway sends, around whatever token you hand it. */
export function dmEnvelope(token: string, claims: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: 'cashu_token_transfer', token, ...claims })
}
