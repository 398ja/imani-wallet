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
  // Signed — `voucherCanonicalBytes` emits a `merchant_metadata` tag for it — but
  // absent from this encoder until a licence needed it. A fixture that dropped it
  // produced a token whose own signature did not verify, so any test relying on
  // the field would have been testing the rejection path by accident.
  if (v.merchantMetadata != null) {
    pairs.push(bytes(tstr('merchantMetadata'), tstr(v.merchantMetadata)))
  }
  // Signed as the `issuance_warrant` tag, so a fixture that dropped it would
  // build a token whose signature fails the moment a test sets one.
  if (v.issuanceWarrant != null) {
    pairs.push(bytes(tstr('issuanceWarrant'), tstr(v.issuanceWarrant)))
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
  /**
   * The issuer's key. Random by default. Pass the stall's own key when a test
   * needs a warrant inside the coupon to verify against the coupon's issuer.
   */
  issuerKey: Uint8Array = schnorr.utils.randomSecretKey(),
): BuiltVoucherToken {
  const priv = issuerKey
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

/**
 * A plain ecash TokenV4: bearer secrets, no voucher, at whatever mint and unit
 * the test names.
 *
 * The mint gate is about where the PROOFS are, which is a question every token
 * answers, voucher or not. A rogue mint does not need to forge a coupon to be
 * credited, so the gate has to be tested on ordinary ecash too.
 */
export function buildPlainToken(mintUrl: string, unit = 'sat', amounts: number[] = [8, 2]): string {
  const proofs = amounts.map((amount, i) =>
    bytes(
      head(5, 3),
      tstr('a'),
      uint(amount),
      tstr('s'),
      tstr(`plain-bearer-secret-${i}`),
      tstr('c'),
      // A compressed point's worth of bytes. The gate never reads it.
      bytes(head(2, 33), ...new Uint8Array(33).fill(2)),
    ),
  )
  const entry = bytes(
    head(5, 2),
    tstr('i'),
    bytes(head(2, 8), ...new Uint8Array(8).fill(1)),
    tstr('p'),
    head(4, proofs.length),
    ...proofs,
  )
  const root = bytes(head(5, 3), tstr('m'), tstr(mintUrl), tstr('u'), tstr(unit), tstr('t'), head(4, 1), entry)
  return `cashuB${base64Url(root)}`
}

/**
 * A legacy TokenV3 (`cashuA`, base64url JSON). Its unit is optional and, absent,
 * means sat, which is the case `withUnit: undefined` builds.
 */
export function buildLegacyToken(mintUrl: string, withUnit?: string): string {
  const json = JSON.stringify({
    token: [{ mint: mintUrl, proofs: [{ amount: 8, id: '00ad268c4d1f5826', secret: 'legacy-secret', C: '02'.repeat(33) }] }],
    ...(withUnit === undefined ? {} : { unit: withUnit }),
  })
  return `cashuA${base64Url(new TextEncoder().encode(json))}`
}

/** The JSON envelope the gateway sends, around whatever token you hand it. */
export function dmEnvelope(token: string, claims: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: 'cashu_token_transfer', token, ...claims })
}

// ---- locked (P2PK_VOUCHER) tokens, #160 ----

export interface LockedCredentialOptions {
  /** The issuing stall's secret key. Its x-only pubkey is the issuer and stall. */
  stallKey: Uint8Array
  /** The device's x-only public key, the lock in `data`. */
  devicePubkey: string
  role?: string
  /** Extra co-spenders in `pubkeys`. Defaults to the stall, as the gateway mints since #160. */
  pubkeys?: string[]
  /** Extra signed NUT-11 tags, such as `refund` or `locktime`. */
  extraTags?: string[][]
  voucherId?: string
  /** Overrides the signed metadata entirely. */
  metadata?: string
  /** `P2PK_VOUCHER` unless set, for the unlocked-fallback case. */
  kind?: 'P2PK_VOUCHER' | 'VOUCHER'
  /** Applied after signing, to forge a signature mismatch. */
  tamperMetadata?: string
  /** The signed `expires_at`, epoch seconds. A fixed instant in 2027 unless set. */
  expiresAt?: number
  /** Leaves the `expires_at` tag out altogether: a credential with no expiry. */
  omitExpiry?: boolean
}

/**
 * A terminal credential exactly as gateway-customer mints one: a one-proof TokenV4 whose
 * secret is `["P2PK_VOUCHER", {nonce, data: 02‖K, tags}]`, signed by the stall over the
 * same canonical bytes `lockedCanonicalBytes` rebuilds, with `pubkeys` = [02‖S].
 */
export function buildLockedCredentialToken(o: LockedCredentialOptions): string {
  const stall = bytesToHex(schnorr.getPublicKey(o.stallKey))
  const metadata =
    o.metadata ??
    JSON.stringify({
      terminal: true,
      stall_pubkey: stall,
      role: o.role ?? 'redeem-only',
      lock_key: o.devicePubkey,
      name: 'Front counter',
    })
  const coKeys = (o.pubkeys ?? [stall]).map((k) => (k.length === 64 ? `02${k}` : k))
  const data = `02${o.devicePubkey}`
  const nonce = 'ab'.repeat(32)
  const tags: string[][] = [
    ['n_sigs', '1'],
    ['sigflag', 'SIG_INPUTS'],
    ...(coKeys.length ? [['pubkeys', ...coKeys]] : []),
    ['voucher_id', o.voucherId ?? '5f8a487d-6cea-4a7d-b681-9d5d62cc9dd9'],
    ['issuer', stall],
    ['unit', 'sat'],
    ['face_value', '1'],
    ...(o.omitExpiry ? [] : [['expires_at', String(o.expiresAt ?? 1820071167)]]),
    ['memo', 'Imani terminal credential'],
    ['backing_strategy', 'PROPORTIONAL'],
    ['issuance_ratio', '1'],
    ['face_decimals', '0'],
    ['merchant_metadata', metadata],
    ...(o.extraTags ?? []),
  ]
  const kind = o.kind ?? 'P2PK_VOUCHER'
  const esc = (v: string) => JSON.stringify(v).slice(1, -1)
  const NUMERIC = ['face_value', 'expires_at', 'face_decimals', 'issuance_ratio']
  const rendered = tags
    .map(
      ([k, ...vs]) =>
        `["${esc(k)}"${vs.map((v) => ',' + (NUMERIC.includes(k) ? v : `"${esc(v)}"`)).join('')}]`,
    )
    .join(',')
  const canonical = new TextEncoder().encode(`["${kind}","${data}","${nonce}",[${rendered}]]`)
  const sig = bytesToHex(schnorr.sign(sha256(canonical), o.stallKey))

  const signedTags = [
    ...tags.map(([k, ...vs]) =>
      k === 'merchant_metadata' && o.tamperMetadata ? [k, o.tamperMetadata] : [k, ...vs],
    ),
    ['issuer_sig', sig],
    ['issuer_pubkey', stall],
  ]
  const secret = JSON.stringify([kind, { nonce, data, tags: signedTags }])

  const proof = bytes(
    head(5, 4),
    tstr('a'),
    uint(1),
    tstr('s'),
    tstr(secret),
    tstr('c'),
    tstr('02' + 'c'.repeat(64)),
    tstr('i'),
    tstr('00ad268c4d1f5826'),
  )
  const entry = bytes(head(5, 2), tstr('i'), tstr('00ad268c4d1f5826'), tstr('p'), head(4, 1), proof)
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
  return `cashuB${base64Url(root)}`
}

/**
 * A terminal credential the stall attested at enrolment (#160 decision 5), signed into its
 * metadata as gateway-customer 5b-2 mints it, with the credential's expiry equal to `T`.
 *
 * `attestWith` signs the attestation with another key (a forgery); `until` attests a different
 * `T` from the credential's expiry (`expiresAt`), to make one the credential outlives.
 */
export function buildAttestedCredentialToken(
  o: LockedCredentialOptions & { attestWith?: Uint8Array; until?: number; name?: string },
): string {
  const stall = bytesToHex(schnorr.getPublicKey(o.stallKey))
  const role = o.role ?? 'issue-and-redeem'
  const expiresAt = o.expiresAt ?? 1820071167
  const until = o.until ?? expiresAt
  const nonce = 'c4'.repeat(32)
  const preimage = ['imani-terminal-attestation', '1', stall, o.devicePubkey, role, String(until), nonce].join('\u001f')
  const sig = bytesToHex(schnorr.sign(sha256(new TextEncoder().encode(preimage)), o.attestWith ?? o.stallKey))
  const metadata = JSON.stringify({
    terminal: true,
    stall_pubkey: stall,
    role,
    lock_key: o.devicePubkey,
    name: o.name ?? 'Front counter',
    owner_attestation: { v: '1', expires_at: String(until), nonce, sig },
  })
  return buildLockedCredentialToken({ ...o, role, metadata, expiresAt })
}
