import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'

/**
 * Reads a voucher out of the token it is actually carried in, and checks the
 * issuer signed it.
 *
 * Until this module existed nothing in the wallet decoded a token at all —
 * `TokenParser` only regex-matches the `cashuB…` string out of message text.
 * Everything the UI showed about a coupon came from sibling fields on the DM
 * envelope (`dmCrypto.ts`'s `TokenTransferPayload`), which the *sender* writes:
 * `issuer_id`, `face_value`, `token_amount`. NIP-17 tells you who sent a DM. It
 * says nothing about whether their claims about the token inside it are true, so
 * a sender could declare any face value they liked against a genuine low-value
 * token and the mint would never see the discrepancy — it only ever sees proofs.
 *
 * The voucher is inside the token, signed. This reads it from there.
 *
 * Deliberately no network: a merchant at a stall with no signal must still be
 * able to tell their own coupon from someone else's, which is what makes the
 * offline cap meaningful rather than a guess.
 */

// ---------------------------------------------------------------- CBOR

const BREAK = Symbol('cbor-break')

class CborReader {
  private i = 0
  constructor(private readonly b: Uint8Array) {}

  private u8(): number {
    if (this.i >= this.b.length) throw new Error('cbor: truncated')
    return this.b[this.i++]
  }

  private take(n: number): Uint8Array {
    if (this.i + n > this.b.length) throw new Error('cbor: truncated')
    return this.b.subarray(this.i, (this.i += n))
  }

  private num(n: number): number {
    let v = 0
    for (const byte of this.take(n)) v = v * 256 + byte
    return v
  }

  /** Argument of a head byte. `null` means indefinite length. */
  private arg(ai: number): number | null {
    if (ai < 24) return ai
    if (ai === 24) return this.u8()
    if (ai === 25) return this.num(2)
    if (ai === 26) return this.num(4)
    if (ai === 27) return this.num(8)
    if (ai === 31) return null
    throw new Error(`cbor: bad additional info ${ai}`)
  }

  private float(ai: number): number {
    const bytes = this.take(ai === 25 ? 2 : ai === 26 ? 4 : 8)
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (ai === 26) return dv.getFloat32(0)
    if (ai === 27) return dv.getFloat64(0)
    // float16 — not emitted by the Java encoder, decoded for completeness.
    const h = dv.getUint16(0)
    const sign = h & 0x8000 ? -1 : 1
    const exp = (h >> 10) & 0x1f
    const frac = h & 0x3ff
    if (exp === 0) return sign * 2 ** -14 * (frac / 1024)
    if (exp === 0x1f) return frac ? NaN : sign * Infinity
    return sign * 2 ** (exp - 15) * (1 + frac / 1024)
  }

  read(): unknown {
    const ib = this.u8()
    if (ib === 0xff) return BREAK
    const mt = ib >> 5
    const ai = ib & 0x1f

    if (mt === 7) {
      if (ai === 20) return false
      if (ai === 21) return true
      if (ai === 22) return null
      if (ai === 23) return undefined
      if (ai >= 25 && ai <= 27) return this.float(ai)
      return this.arg(ai)
    }

    const n = this.arg(ai)

    switch (mt) {
      case 0:
        return n
      case 1:
        return -1 - (n as number)
      case 2:
        return n === null ? this.concatIndefinite() : this.take(n).slice()
      case 3:
        return n === null
          ? this.readIndefinite().join('')
          : new TextDecoder().decode(this.take(n))
      case 4: {
        if (n === null) return this.readIndefinite()
        const out: unknown[] = []
        for (let k = 0; k < n; k++) out.push(this.read())
        return out
      }
      case 5: {
        const out: Record<string, unknown> = {}
        if (n === null) {
          for (;;) {
            const key = this.read()
            if (key === BREAK) break
            out[String(key)] = this.read()
          }
          return out
        }
        for (let k = 0; k < n; k++) out[String(this.read())] = this.read()
        return out
      }
      case 6:
        // Tagged value — the tag itself carries no meaning for this payload.
        return this.read()
      default:
        throw new Error(`cbor: unsupported major type ${mt}`)
    }
  }

  private readIndefinite(): string[] {
    const parts: string[] = []
    for (;;) {
      const v = this.read()
      if (v === BREAK) break
      parts.push(v as string)
    }
    return parts
  }

  private concatIndefinite(): Uint8Array {
    const chunks: Uint8Array[] = []
    for (;;) {
      const v = this.read()
      if (v === BREAK) break
      chunks.push(v as Uint8Array)
    }
    const total = chunks.reduce((s, c) => s + c.length, 0)
    const out = new Uint8Array(total)
    let at = 0
    for (const c of chunks) {
      out.set(c, at)
      at += c.length
    }
    return out
  }
}

export function decodeCbor(bytes: Uint8Array): unknown {
  return new CborReader(bytes).read()
}

// ---------------------------------------------------------------- base64url

function base64UrlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

// ---------------------------------------------------------------- types

/** The voucher as the issuer signed it. Every field here is inside the token. */
export interface SignedVoucherFields {
  voucherId: string
  issuerId: string
  unit: string
  /**
   * The issued face value, in minor units. Signed, so this is the one hard
   * ceiling on what a redemption may credit — see `issuanceRatio`.
   */
  faceValue: number
  expiresAt?: number
  memo?: string
  backingStrategy?: string
  /**
   * Face minor units per sat.
   *
   * NOT covered by the signature on any voucher issued before the canonicalizer
   * fix: `getCanonicalBytesForSigning` truncated every number through
   * `longValue()`, so every ratio in (0,1) signed as 0 and one fractional ratio
   * is interchangeable with another. Never derive a credit ceiling from this
   * alone — bound it by `faceValue`, which is signed on every voucher.
   */
  issuanceRatio: number
  faceDecimals: number
  merchantMetadata?: string | null
  nonce: string
  issuerSignature: string
  issuerPublicKey: string
}

export interface ParsedVoucherToken {
  mintUrl: string
  unit: string
  memo?: string
  /** Summed proof amounts, in sats. */
  tokenAmount: number
  proofCount: number
  voucher: SignedVoucherFields
}

// ---------------------------------------------------------------- parsing

/**
 * `cashuB…` → the voucher inside it.
 *
 * TokenV4 is base64url-encoded CBOR: `{m: mintUrl, u: unit, d?: memo, t: [{i:
 * keysetId, p: [{a: amount, s: secret, c: signature}]}]}`. The NUT-10 secret `s`
 * is `["VOUCHER", <hex>, <nonce>, <tags>]` — and on the wire the tag array is
 * EMPTY, with every voucher field living in the hex blob, which is itself CBOR.
 * The tags are rebuilt from that blob before signature checking (this is what
 * `SignedVoucherCodec` does server-side), which is why `voucherCanonicalBytes`
 * has to reconstruct them rather than read them off the wire.
 */
export function parseVoucherToken(token: string): ParsedVoucherToken {
  if (!token?.startsWith('cashuB')) {
    throw new Error('not a TokenV4 (cashuB) token')
  }
  const root = decodeCbor(base64UrlDecode(token.slice(6))) as Record<string, unknown>

  const entries = (root.t ?? []) as Array<Record<string, unknown>>
  const proofs = entries.flatMap((e) => (e.p ?? []) as Array<Record<string, unknown>>)
  if (proofs.length === 0) throw new Error('token carries no proofs')

  const secret = proofs[0].s
  if (typeof secret !== 'string') throw new Error('proof has no NUT-10 secret')

  const parsed = JSON.parse(secret) as [string, string, string, unknown[]]
  if (!Array.isArray(parsed) || parsed[0] !== 'VOUCHER') {
    throw new Error('token is not a voucher (NUT-10 kind is not VOUCHER)')
  }

  const blob = decodeCbor(hexToBytes(parsed[1])) as Record<string, unknown>
  const voucher = readVoucherFields(blob)

  // Every proof must carry the same voucher. A bundle mixing provenance would
  // otherwise be summed under one voucher's ratio, which is the shape of an
  // inflated token — the server-side ProofCompatibilityValidator rejects the
  // same case.
  //
  // Compare the voucher BLOB, not the whole secret: each proof carries its own
  // NUT-10 wrapper nonce (they have to, or two proofs would be the same proof),
  // so the secret strings of a perfectly good token never match each other. Only
  // the blob — the signed voucher — is shared.
  for (const p of proofs) {
    if (typeof p.s !== 'string') throw new Error('proof has no NUT-10 secret')
    let blobHex: string
    try {
      blobHex = (JSON.parse(p.s) as [string, string, string, unknown[]])[1]
    } catch {
      throw new Error('proof secret is not a NUT-10 secret')
    }
    if (blobHex !== parsed[1]) throw new Error('token mixes proofs from more than one voucher')
  }

  return {
    mintUrl: String(root.m ?? ''),
    unit: String(root.u ?? ''),
    memo: typeof root.d === 'string' ? root.d : undefined,
    tokenAmount: proofs.reduce((sum, p) => sum + Number(p.a ?? 0), 0),
    proofCount: proofs.length,
    voucher,
  }
}

function readVoucherFields(blob: Record<string, unknown>): SignedVoucherFields {
  const str = (k: string): string | undefined => {
    const v = blob[k]
    return typeof v === 'string' && v.length > 0 ? v : undefined
  }
  const required = (k: string): string => {
    const v = str(k)
    if (!v) throw new Error(`voucher blob is missing ${k}`)
    return v
  }
  return {
    voucherId: required('voucherId'),
    issuerId: required('issuerId'),
    unit: required('unit'),
    faceValue: Number(blob.faceValue ?? 0),
    expiresAt: blob.expiresAt == null ? undefined : Number(blob.expiresAt),
    memo: str('memo'),
    backingStrategy: str('backingStrategy'),
    issuanceRatio: blob.issuanceRatio == null ? 1 : Number(blob.issuanceRatio),
    faceDecimals: Number(blob.faceDecimals ?? 0),
    merchantMetadata: str('merchantMetadata') ?? null,
    nonce: required('nonce'),
    issuerSignature: required('issuerSignature'),
    issuerPublicKey: required('issuerPublicKey'),
  }
}

// ---------------------------------------------------------------- canonical bytes

/**
 * Java's `Double.toString`, which is what the signer appended.
 *
 * JS and Java agree on the DIGITS on JDK 19+ — both emit the shortest decimal
 * that round-trips — but not on when to use scientific notation, and the
 * canonical bytes are hashed, so one character is a rejected voucher:
 *
 *   0.0009  →  Java "9.0E-4"    JS "0.0009"
 *   1.5e-7  →  Java "1.5E-7"    JS "1.5e-7"
 *
 * Java uses plain decimal only on [1e-3, 1e7) and `E` notation outside it, with
 * an unsigned positive exponent and always a digit after the point.
 *
 * Only ever called for finite non-integral values — integral doubles take the
 * `longValue()` path in the caller, matching the Java.
 */
export function javaDoubleToString(d: number): string {
  const abs = Math.abs(d)
  if (abs >= 1e-3 && abs < 1e7) return String(d)

  const [mantissa, exp] = d.toExponential().split('e')
  const digits = mantissa.includes('.') ? mantissa : `${mantissa}.0`
  // Java writes E7, not E+7; negative exponents keep their sign.
  return `${digits}E${exp.startsWith('+') ? exp.slice(1) : exp}`
}

function escapeJson(input: string): string {
  let out = ''
  for (const c of input) {
    const code = c.codePointAt(0)!
    if (c === '"') out += '\\"'
    else if (c === '\\') out += '\\\\'
    else if (c === '\b') out += '\\b'
    else if (c === '\f') out += '\\f'
    else if (c === '\n') out += '\\n'
    else if (c === '\r') out += '\\r'
    else if (c === '\t') out += '\\t'
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, '0')}`
    else out += c
  }
  return out
}

function appendNumber(n: number, legacy: boolean): string {
  // Matches VoucherSignatureService.appendNumber. `legacy` reproduces the
  // pre-fix truncation, which put every number through longValue().
  if (legacy) return String(Math.trunc(n))
  if (Number.isFinite(n) && !Number.isInteger(n)) return javaDoubleToString(n)
  return String(Math.trunc(n))
}

/**
 * Rebuilds the bytes the issuer signed.
 *
 * `["VOUCHER", hex(voucherId utf8), nonce, [tags…]]` — the data field is the
 * voucher UUID (`VoucherSecret` sets it from `voucherId.toString()`), the nonce
 * is the one INSIDE the blob rather than the NUT-10 wrapper's, and the tags come
 * in `VoucherSecret.Builder.build()` insertion order. `issuer_sig` and
 * `issuer_pubkey` are excluded — they are set after signing.
 *
 * Tag order is load-bearing: these bytes are hashed, so reordering two tags
 * fails every signature.
 */
export function voucherCanonicalBytes(v: SignedVoucherFields, legacy = false): Uint8Array {
  const tags: string[] = []
  const strTag = (k: string, value: string) => tags.push(`["${k}","${escapeJson(value)}"]`)
  const numTag = (k: string, value: number) => tags.push(`["${k}",${appendNumber(value, legacy)}]`)

  strTag('issuer', v.issuerId)
  strTag('unit', v.unit)
  numTag('face_value', v.faceValue)
  if (v.expiresAt != null) numTag('expires_at', v.expiresAt)
  if (v.memo != null) strTag('memo', v.memo)
  numTag('face_decimals', v.faceDecimals)
  if (v.backingStrategy != null) strTag('backing_strategy', v.backingStrategy)
  // setIssuanceRatio writes no tag at all when the ratio is exactly 1.0, so a
  // parity voucher must not emit one either.
  if (v.issuanceRatio !== 1) numTag('issuance_ratio', v.issuanceRatio)
  if (v.merchantMetadata != null) strTag('merchant_metadata', v.merchantMetadata)

  const dataHex = bytesToHex(new TextEncoder().encode(v.voucherId))
  return new TextEncoder().encode(`["VOUCHER","${dataHex}","${v.nonce}",[${tags.join(',')}]]`)
}

// ---------------------------------------------------------------- verification

export interface VoucherVerification {
  signatureValid: boolean
  /**
   * True when the signature only checked out against the pre-fix canonical form,
   * in which `issuance_ratio` was truncated to 0 and so is unsigned. The voucher
   * is genuine; its ratio is not attested. Credit must be bounded by `faceValue`.
   */
  legacyCanonical: boolean
}

/**
 * Checks the issuer's BIP-340 signature over the canonical bytes.
 *
 * Tries the current form first and falls back to the pre-fix truncated one, the
 * same two-step `VoucherSignatureService.verify` does, because vouchers issued
 * before the fix are live and cannot be re-signed — the issuer's key is not here.
 */
export function verifyVoucher(v: SignedVoucherFields): VoucherVerification {
  try {
    const sig = hexToBytes(v.issuerSignature)
    const pub = hexToBytes(v.issuerPublicKey)
    if (sig.length !== 64 || pub.length !== 32) {
      return { signatureValid: false, legacyCanonical: false }
    }
    if (schnorr.verify(sig, sha256(voucherCanonicalBytes(v, false)), pub)) {
      return { signatureValid: true, legacyCanonical: false }
    }
    if (schnorr.verify(sig, sha256(voucherCanonicalBytes(v, true)), pub)) {
      return { signatureValid: true, legacyCanonical: true }
    }
    return { signatureValid: false, legacyCanonical: false }
  } catch {
    // Malformed hex, bad point, truncated blob — all of it is "not verified".
    return { signatureValid: false, legacyCanonical: false }
  }
}
