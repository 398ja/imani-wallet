/// <reference types="vite/client" />
/**
 * The `terminal` issuance warrant (#160 phase 5, spec 5.1 and 5.5).
 *
 * A till cannot sign as the stall: its key `K` is its own, generated on the device. What it
 * holds instead is a terminal credential, a `P2PK_VOUCHER` the stall's issuing service minted
 * and locked to `K`, whose signed metadata names the stall, the role and `K` as `lock_key`. A
 * `terminal` warrant carries that credential's signed secret (never the proof's `C`, so it is
 * not spendable) and `K`'s signature over the same sale digest a `merchant` warrant signs.
 *
 * Wire form, one JSON object:
 *
 *     {"form":"terminal","sale_total","face_decimals","unit","nonce","signature","credential"}
 *
 * `verifyTerminalWarrant` is a line-by-line mirror of cashu-voucher 0.16.1's
 * `IssuanceWarrant.verifyTerminal`. The portal runs the Java at issuance and a customer's wallet
 * runs this when the coupon arrives, so the two must refuse exactly the same things. Each check
 * names the Java refusal it mirrors.
 */
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha256'
import { hexToBytes } from '@noble/hashes/utils'

import { warrantSaleDigest } from './issuanceWarrant'
import { hasCanonicalNumericTags, lockedCanonicalBytes } from './voucherToken'

/** Why a `terminal` warrant was refused. Same names as `IssuanceWarrant.TerminalRefusal`. */
export const TERMINAL_REFUSAL = {
  MALFORMED_SALE: 'MALFORMED_SALE',
  COUPON_ABOVE_SALE: 'COUPON_ABOVE_SALE',
  UNTRUSTED_SERVICE_KEY: 'UNTRUSTED_SERVICE_KEY',
  BAD_CREDENTIAL_SIGNATURE: 'BAD_CREDENTIAL_SIGNATURE',
  MALFORMED_CREDENTIAL: 'MALFORMED_CREDENTIAL',
  WRONG_STALL: 'WRONG_STALL',
  CREDENTIAL_EXPIRED: 'CREDENTIAL_EXPIRED',
  NOT_A_SELLING_TERMINAL: 'NOT_A_SELLING_TERMINAL',
  LOCK_IS_STALL: 'LOCK_IS_STALL',
  LOCK_MISMATCH: 'LOCK_MISMATCH',
  BAD_SALE_SIGNATURE: 'BAD_SALE_SIGNATURE',
} as const

export type TerminalRefusal = (typeof TERMINAL_REFUSAL)[keyof typeof TERMINAL_REFUSAL]

export type TerminalVerdict = { valid: true } | { valid: false; refusal: TerminalRefusal }

/**
 * The caller's explicit choice about the credential's expiry. There is no default.
 *
 * - `{ at: epochSeconds }` refuses a credential expired at that instant. The portal uses it with
 *   now, so an expired till cannot warrant a NEW sale.
 * - `'skip-offline'` skips the instant. A customer checking a coupon already sold uses it,
 *   because a coupon sold before the till expired rightly stays valid.
 *
 * Boundary: `expires_at` is the last valid second, so a credential is expired only when
 * `at > expires_at`, as in the Java and the mint.
 */
export type ExpiryCheck = { at: number } | 'skip-offline'

export interface TerminalSale {
  /** The stall, lowercase hex, from the coupon's `issuer`. */
  issuerId: string
  /** The credential's NUT-10 secret, exactly as it arrived on the wire. */
  credential: string
  /** The service keys that mint terminal credentials. Empty refuses everything. */
  trustedServiceKeys: readonly string[]
  saleTotalMinor: number
  faceDecimals: number
  unit: string
  saleNonce: string
  /** `K`'s BIP-340 signature over the sale digest, hex. */
  signatureHex: string
  /** THIS coupon's face value, which must fit inside the sale. */
  couponFaceMinor: number
  expiryCheck: ExpiryCheck
}

const LOWER_HEX64 = /^[0-9a-f]{64}$/
const HEX64 = /^[0-9a-fA-F]{64}$/
const CANONICAL_INTEGER = /^(0|[1-9][0-9]{0,18})$/
const MAX_FACE_DECIMALS = 18
/** Java's Long.MAX_VALUE: a canonical integer above it does not parse there, so not here. */
const JAVA_LONG_MAX = 9_223_372_036_854_775_807n
const ISSUE_AND_REDEEM = 'issue-and-redeem'

/**
 * The service keys this build trusts to mint terminal credentials: `VITE_VOUCHER_ISSUER_PUBKEYS`,
 * the same list `issuerAllowlist.ts` reads. Read defensively, because this module is also loaded
 * by the Node services (under tsx, with no Vite env), where the answer is "none" and every
 * `terminal` warrant is refused rather than trusted.
 */
export function trustedCredentialServiceKeys(): string[] {
  // `import.meta.env` spelled out, so Vite inlines it and Vitest's stubEnv reaches it. A cast
  // around `import.meta` hid it from Vitest, so tests always saw "none" and could not tell the
  // default allow-list from an empty one (#196 review: that mutant survived). Under tsx (the
  // Node services) `import.meta.env` is undefined, and the answer is "none".
  const env = import.meta.env as Record<string, string | undefined> | undefined
  return (env?.VITE_VOUCHER_ISSUER_PUBKEYS ?? '')
    .split(',')
    .map((k) => k.trim().toLowerCase())
    .filter((k) => k.length > 0)
}

/**
 * C0 controls (US among them, the digest's separator), DEL, C1 controls (U+0080..U+009F), and
 * malformed UTF-16. Mirrors `IssuanceWarrant.hasControlCharacter`.
 *
 * A lone surrogate is refused because Java's UTF-8 encoder writes it as `?` while `TextEncoder`
 * writes U+FFFD, so the two sides would hash different bytes for the same nonce. A properly
 * paired surrogate (an emoji) encodes the same on both sides and is fine.
 */
export function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) return true
  }
  return hasLoneSurrogate(value)
}

/** The parts of a credential secret this check reads, or null if it is not a credential. */
interface CredentialSecret {
  data: string
  rows: string[][]
  /** The bytes the service signed: the secret minus `issuer_sig` and `issuer_pubkey`. */
  signed: Uint8Array
}

/** `data`: a compressed key, lowercase, prefix 02 or 03, exactly as the gateway writes it. */
const COMPRESSED_LOWER_HEX = /^0[23][0-9a-f]{64}$/

/** An unpaired UTF-16 surrogate: Java hashes it as `?`, `TextEncoder` as U+FFFD. */
function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : -1
      if (next < 0xdc00 || next > 0xdfff) return true
      i++
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true
    }
  }
  return false
}

function isPoint(compressedHex: string): boolean {
  try {
    secp256k1.Point.fromHex(compressedHex)
    return true
  } catch {
    return false
  }
}

/** Java's `Long.parseLong(s.trim())`, or null. */
function javaLong(raw: string): bigint | null {
  const t = raw.trim()
  if (!/^[+-]?[0-9]+$/.test(t)) return null
  const n = BigInt(t)
  return n > JAVA_LONG_MAX || n < -JAVA_LONG_MAX - 1n ? null : n
}

/**
 * cashu-lib's `P2PKVoucherSecret.validate`, which the Java runs on every parse: each key in
 * `pubkeys` and `refund` a compressed point, no key twice in one pathway (compared on the
 * x-coordinate, so `02||x` and `03||x` collide), `n_sigs` and `n_sigs_refund` in 1..keys,
 * a known `sigflag`, a non-negative `locktime`, and no `locktime` without refund keys.
 *
 * In particular `data` equal to a `pubkeys` key is refused here, as in the Java, before any
 * verdict (a lock_key that is the stall's own key arrives exactly that way).
 */
function nut11Valid(data: string, rows: string[][]): boolean {
  const values = (key: string) => rows.find((r) => r[0] === key)?.slice(1) ?? []
  const first = (key: string) => rows.find((r) => r[0] === key)?.[1]
  const keyOk = (k: string) => {
    const n = k.trim().toLowerCase()
    return /^[0-9a-f]{66}$/.test(n) && (n.startsWith('02') || n.startsWith('03')) && isPoint(n)
  }
  const xOnly = (k: string) => k.trim().toLowerCase().slice(2)
  const distinct = (keys: string[]) => new Set(keys.map(xOnly)).size === keys.length
  const threshold = (key: string, count: number) => {
    const raw = first(key)
    if (raw === undefined) return true
    const n = javaLong(raw)
    return n !== null && n >= 1n && n <= BigInt(count)
  }
  const pubkeys = values('pubkeys')
  const refund = values('refund')
  if (!pubkeys.every(keyOk) || !refund.every(keyOk)) return false
  const main = [data, ...pubkeys]
  if (!distinct(main) || !distinct(refund)) return false
  if (!threshold('n_sigs', main.length)) return false
  if (refund.length > 0 && !threshold('n_sigs_refund', refund.length)) return false
  const sigflag = first('sigflag')
  if (sigflag !== undefined && sigflag !== 'SIG_INPUTS' && sigflag !== 'SIG_ALL') return false
  const locktime = first('locktime')
  if (locktime !== undefined) {
    const n = javaLong(locktime)
    if (n === null || n < 0n || refund.length === 0) return false
  }
  return true
}

/**
 * Parses a credential the way `IssuanceWarrant.parseCredential` (cashu-voucher 0.16.1) does,
 * refusing everything the Java refuses at parse time:
 *
 * - any text that is not byte-for-byte its own canonical serialisation, so padding, extra
 *   elements and duplicate keys (which `JSON.parse` would silently resolve, last wins);
 * - a repeated tag row, whichever tag (NUT-11's "a tag appears more than once"), because a
 *   verifier reading the first row and one reading the last would see two credentials;
 * - `data` that is not a lowercase compressed key with prefix 02 or 03, or that is not a point
 *   on secp256k1 (cashu-lib's `P2PKPublicKeys.requireValid`);
 * - a lone surrogate in the nonce or any tag.
 */
export function parseCredentialSecret(wire: string): CredentialSecret | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(wire)
  } catch {
    return null
  }
  if (!Array.isArray(parsed) || parsed.length !== 2 || parsed[0] !== 'P2PK_VOUCHER') return null
  const body = parsed[1] as Record<string, unknown>
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const keys = Object.keys(body)
  if (keys.length !== 3 || keys[0] !== 'nonce' || keys[1] !== 'data' || keys[2] !== 'tags') return null
  const { nonce, data, tags } = body
  if (typeof nonce !== 'string' || typeof data !== 'string' || !Array.isArray(tags)) return null
  // Every tag value is a string on the wire, as cashu-lib writes it, and each tag appears once.
  const rows: string[][] = []
  const seen = new Set<string>()
  for (const t of tags) {
    if (!Array.isArray(t) || t.length < 1 || !t.every((v) => typeof v === 'string')) return null
    if (seen.has(t[0])) return null
    seen.add(t[0])
    if (t.some((v) => hasLoneSurrogate(v))) return null
    rows.push(t as string[])
  }
  if (hasLoneSurrogate(nonce)) return null
  if (!COMPRESSED_LOWER_HEX.test(data) || !isPoint(data)) return null
  if (!nut11Valid(data, rows)) return null
  // One credential, one wire form. Re-serialising what we read must give back the input.
  if (JSON.stringify(['P2PK_VOUCHER', { nonce, data, tags: rows }]) !== wire) return null

  // The bytes the service signed, built by the same code that verifies every locked voucher.
  const signed = lockedCanonicalBytes(data, nonce, rows)
  return { data, rows, signed }
}

function tagValues(rows: string[][], key: string): string[] | undefined {
  return rows.find((r) => r[0] === key)?.slice(1)
}

function single(rows: string[][], key: string): string | undefined {
  const values = tagValues(rows, key)
  return values && values.length === 1 ? values[0] : undefined
}

/**
 * Strict canonical verification of the service's signature: the current form only, no legacy
 * window (`VoucherSignatureService.verifyStrict`). Terminal credentials were all minted after the
 * canonical form existed, and a legacy window would let a holder rewrite `expires_at` "1000" to
 * "1000.5" and keep a valid signature (cashu-voucher#54 review N1).
 */
function credentialSignatureValid(credential: CredentialSecret): boolean {
  // Numeric tags must arrive already in canonical form: a value that only hashes the same after
  // normalising ("1000.0", "1e3") has two readings (cashu-voucher#48).
  if (!hasCanonicalNumericTags(credential.rows)) return false
  const sig = single(credential.rows, 'issuer_sig')
  const pub = single(credential.rows, 'issuer_pubkey')
  if (!sig || !pub || !/^[0-9a-fA-F]{128}$/.test(sig) || !HEX64.test(pub)) return false
  try {
    return schnorr.verify(hexToBytes(sig), sha256(credential.signed), hexToBytes(pub))
  } catch {
    return false
  }
}

/**
 * JSON object text with any key repeated at any depth, which `JSON.parse` hides (last wins) and
 * the Java's strict parser refuses. Only called on text `JSON.parse` already accepted.
 */
export function hasDuplicateKeys(json: string): boolean {
  const stack: Array<Set<string> | null> = []
  let expectKey = false
  for (let i = 0; i < json.length; i++) {
    const c = json[i]
    if (c === '"') {
      let j = i + 1
      while (json[j] !== '"') j += json[j] === '\\' ? 2 : 1
      const top = stack[stack.length - 1]
      if (expectKey && top) {
        const key = JSON.parse(json.slice(i, j + 1)) as string
        if (top.has(key)) return true
        top.add(key)
        expectKey = false
      }
      i = j
    } else if (c === '{') {
      stack.push(new Set())
      expectKey = true
    } else if (c === '[') {
      stack.push(null)
    } else if (c === '}' || c === ']') {
      stack.pop()
    } else if (c === ',') {
      expectKey = stack[stack.length - 1] != null
    }
  }
  return false
}

/** The `lock_key` of a selling terminal of `issuerId`, or null. Mirrors `terminalLockKey`. */
function terminalLockKey(metadataJson: string | undefined, issuerId: string): string | null {
  if (metadataJson === undefined) return null
  let metadata: unknown
  try {
    metadata = JSON.parse(metadataJson)
  } catch {
    return null
  }
  if (hasDuplicateKeys(metadataJson)) return null
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  const m = metadata as Record<string, unknown>
  // The boolean true, not truthy: "terminal": "yes" is not authority.
  if (m.terminal !== true) return null
  if (typeof m.stall_pubkey !== 'string' || m.stall_pubkey.toLowerCase() !== issuerId.toLowerCase()) return null
  if (m.role !== ISSUE_AND_REDEEM) return null
  // Lowercase only, as the gateway writes it and as the Java (0.16.1) requires.
  if (typeof m.lock_key !== 'string' || !LOWER_HEX64.test(m.lock_key)) return null
  return m.lock_key
}

function refused(refusal: TerminalRefusal): TerminalVerdict {
  console.warn('[warrant] terminal warrant refused:', refusal)
  return { valid: false, refusal }
}

/**
 * Verifies a `terminal` warrant: `K` signed the sale, and the warrant carries the credential the
 * stall's issuing service minted to `K`. Mirrors `IssuanceWarrant.verifyTerminal` step for step.
 *
 * Not checked, as in the Java: liveness (revocation is a NUT-07 spend only the gateway sees, and
 * the portal checks it at issuance), and the coupon's denomination (the caller compares it, as
 * `verifyIssuanceWarrant` does before calling this).
 */
export function verifyTerminalWarrant(sale: TerminalSale): TerminalVerdict {
  const { issuerId, saleTotalMinor, couponFaceMinor, faceDecimals } = sale

  // 1. The inputs are well-formed, so both languages hash the same bytes.
  if (
    !LOWER_HEX64.test(issuerId) ||
    hasControlCharacter(sale.unit) ||
    hasControlCharacter(sale.saleNonce) ||
    !Number.isSafeInteger(saleTotalMinor) ||
    saleTotalMinor < 0 ||
    !Number.isSafeInteger(couponFaceMinor) ||
    couponFaceMinor < 0 ||
    !Number.isInteger(faceDecimals) ||
    faceDecimals < 0 ||
    faceDecimals > MAX_FACE_DECIMALS
  ) {
    return refused(TERMINAL_REFUSAL.MALFORMED_SALE)
  }

  // 2. The ceiling, as for a merchant warrant.
  if (couponFaceMinor > saleTotalMinor) return refused(TERMINAL_REFUSAL.COUPON_ABOVE_SALE)

  // 3. Signed by a service key the caller trusts. Without the allow-list anyone could mint
  // themselves a credential under their own key.
  const credential = parseCredentialSecret(sale.credential)
  if (!credential) return refused(TERMINAL_REFUSAL.BAD_CREDENTIAL_SIGNATURE)
  const servicePubkey = single(credential.rows, 'issuer_pubkey')
  const trusted = sale.trustedServiceKeys.map((k) => k.toLowerCase())
  if (!servicePubkey || !trusted.includes(servicePubkey.toLowerCase())) {
    return refused(TERMINAL_REFUSAL.UNTRUSTED_SERVICE_KEY)
  }
  if (!credentialSignatureValid(credential)) return refused(TERMINAL_REFUSAL.BAD_CREDENTIAL_SIGNATURE)

  // An expiry we cannot read is malformed, and an absent one would sell forever.
  const rawExpiry = single(credential.rows, 'expires_at')
  if (rawExpiry === undefined || !CANONICAL_INTEGER.test(rawExpiry) || BigInt(rawExpiry) > JAVA_LONG_MAX) {
    return refused(TERMINAL_REFUSAL.MALFORMED_CREDENTIAL)
  }
  const expiresAt = Number(rawExpiry)

  // 4. A till sells only for the stall that issued it.
  const credentialIssuer = single(credential.rows, 'issuer')
  if (!credentialIssuer || credentialIssuer.toLowerCase() !== issuerId) {
    return refused(TERMINAL_REFUSAL.WRONG_STALL)
  }

  // 5. Expiry, per the caller's explicit choice.
  if (sale.expiryCheck !== 'skip-offline' && sale.expiryCheck.at > expiresAt) {
    return refused(TERMINAL_REFUSAL.CREDENTIAL_EXPIRED)
  }

  // 6. A selling terminal of this stall, whose key is not the stall's own.
  const lockKey = terminalLockKey(single(credential.rows, 'merchant_metadata'), issuerId)
  if (!lockKey) return refused(TERMINAL_REFUSAL.NOT_A_SELLING_TERMINAL)
  if (lockKey.toLowerCase() === issuerId) return refused(TERMINAL_REFUSAL.LOCK_IS_STALL)

  // 7. The mint lock is `lock_key`.
  if (credential.data.slice(2) !== lockKey) {
    return refused(TERMINAL_REFUSAL.LOCK_MISMATCH)
  }

  // 8. `K` signed this sale.
  if (!/^[0-9a-fA-F]{128}$/.test(sale.signatureHex)) return refused(TERMINAL_REFUSAL.BAD_SALE_SIGNATURE)
  try {
    const digest = warrantSaleDigest(issuerId, saleTotalMinor, faceDecimals, sale.unit, sale.saleNonce)
    if (!schnorr.verify(hexToBytes(sale.signatureHex), digest, hexToBytes(lockKey.toLowerCase()))) {
      return refused(TERMINAL_REFUSAL.BAD_SALE_SIGNATURE)
    }
  } catch {
    return refused(TERMINAL_REFUSAL.BAD_SALE_SIGNATURE)
  }
  return { valid: true }
}
