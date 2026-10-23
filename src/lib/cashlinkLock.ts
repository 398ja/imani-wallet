/**
 * The pieces of a Cashlink that comes back on its own (#295 phase 4), with no network in them.
 *
 * ## The shape
 *
 * A gift starts as an unlocked coupon on its link (spec 3.3). Once it is armed it is the same coupon
 * locked to the link: `P2PK_VOUCHER(data = link key, locktime = x, refund = [R], sigflag = SIG_ALL)`.
 *
 * - Before `x` only the link key can spend it: the recipient's claim, or the sender's own take-back
 *   (the sender derived the link key too).
 * - After `x` the refund key `R` can spend it as well. The sender signs that refund swap NOW, into
 *   outputs only the sender can unblind, and hands it to gateway-customer's relay, which posts it at
 *   `x + 60 s`. The relay can neither post it early (the mint refuses the refund path before `x`)
 *   nor change it (`SIG_ALL` covers the outputs) nor spend what comes back (it never has `r`).
 *
 * ## The hard rule
 *
 * A locked voucher with a locktime and NO refund key is spendable by ANYONE once the locktime passes
 * (NUT-11, pinned at the mint by cashu-mint#566). Nothing in this wallet may ever produce one, and
 * nothing may accept one as a Cashlink. {@link assertNotOpenAfterLocktime} is the one gate, and every
 * builder here calls it on its own output before returning it.
 *
 * ## Everything is derived
 *
 * Every secret, blinding factor and nonce the sender uses is derived from `R` and the proof it is
 * for. A page that dies half-way, a second device, or a restored wallet can rebuild the exact same
 * outputs and ask the mint (NUT-09) what it signed, so no step needs a record that could be lost.
 * The signatures use deterministic BIP-340 auxiliary data for the same reason: a retried request is
 * byte-identical, which is what the relay's idempotency and the mint's NUT-19 replay key on.
 *
 * Nothing here logs a key, a secret or a blinding factor.
 */
import { hmac } from '@noble/hashes/hmac'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { schnorr } from '@noble/curves/secp256k1.js'
import { blindMessage } from '@cashu/crypto/modules/client'
import { getPublicKey } from 'nostr-tools'

import { javaDoubleToString, verifyVoucher, voucherOfSecret, type SignedVoucherFields } from './voucherToken'
import { splitIntoDenominations, type BlindedOutput } from './walletSwap'

/** The secp256k1 group order. */
const N = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141')

const utf8 = (text: string) => new TextEncoder().encode(text)

// ─── Keys ───────────────────────────────────────────────────────────────────

/** Design 3.2: `R_i = HMAC-SHA256(identitySecret, "imani-gift-refund/v1/" || i) mod n`. */
export const REFUND_LABEL = 'imani-gift-refund/v1/'

/** A scalar from an HMAC, retried with `/r<n>` on the (2^-256) zero, so the rule is total. */
function scalarFrom(key: Uint8Array, label: string): bigint {
  for (let retry = 0; ; retry++) {
    const mac = hmac(sha256, key, utf8(retry === 0 ? label : `${label}/r${retry}`))
    const scalar = BigInt('0x' + bytesToHex(mac)) % N
    if (scalar !== 0n) return scalar
  }
}

const scalarBytes = (scalar: bigint) => hexToBytes(scalar.toString(16).padStart(64, '0'))

/**
 * The refund key for link `i`. A DEDICATED key, never the identity key and never derivable from the
 * link key: the recipient (and anyone who saw the link) holds the link key, and must not be able to
 * sign the sender's refund or ask for its re-signature.
 */
export function deriveRefundSecret(identitySecret: Uint8Array, i: number): Uint8Array {
  if (!Number.isSafeInteger(i) || i < 0) throw new Error('link index must be a non-negative integer')
  return scalarBytes(scalarFrom(identitySecret, `${REFUND_LABEL}${i}`))
}

/** A random refund key, for an account whose key this wallet cannot read (kept on the link record). */
export function randomRefundSecret(): Uint8Array {
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(32))
    const scalar = BigInt('0x' + bytesToHex(bytes))
    if (scalar !== 0n && scalar < N) return bytes
  }
}

/** The x-only public key of a secret. */
export const xOnlyPub = (secret: Uint8Array): string => getPublicKey(secret)

/** NUT-11 keys are compressed. BIP-340 keys have even y, so `02`. */
export const compressed = (xOnly: string): string => `02${xOnly.toLowerCase()}`

const xOnlyOf = (key: string): string => (key.length === 66 ? key.slice(2) : key).toLowerCase()

// ─── Derived outputs ────────────────────────────────────────────────────────

/**
 * What a derived value is for. Separate labels, so no two steps can ever produce the same output:
 * a refund output that equalled a burn output would let one swap's restore answer for the other.
 */
export type DerivedPurpose = 'burn' | 'refund' | 'takeback' | 'mint-link' | 'mint-refund' | 'lock' | 'resign-link' | 'resign-refund'

const anchorOf = (secret: string) => bytesToHex(sha256(utf8(secret)))

const label = (purpose: DerivedPurpose, part: string, anchor: string, n: number) =>
  `imani-gift-out/v1/${purpose}/${part}/${anchor}/${n}`

/**
 * One plain output, derived from the refund key, the proof it belongs to and its position. The
 * secret is hex text (the mint hashes the secret STRING), the blinding factor a scalar. Neither
 * depends on the keyset, so a deposit refused for an archived keyset is rebuilt with a new `id` and
 * the very same `B_` (and the same signature: `SIG_ALL` does not cover keyset ids).
 */
export function derivedOutput(
  refundSecret: Uint8Array,
  purpose: DerivedPurpose,
  anchorSecret: string,
  n: number,
  amount: number,
  keysetId: string,
): BlindedOutput {
  const anchor = anchorOf(anchorSecret)
  const secret = bytesToHex(hmac(sha256, refundSecret, utf8(label(purpose, 's', anchor, n))))
  const r = scalarFrom(refundSecret, label(purpose, 'r', anchor, n))
  return blinded(secret, r, amount, keysetId)
}

/** The outputs worth `amount`, one per power of two, largest first. */
export function derivedOutputs(
  refundSecret: Uint8Array,
  purpose: DerivedPurpose,
  anchorSecret: string,
  amount: number,
  keysetId: string,
): BlindedOutput[] {
  return splitIntoDenominations(amount).map((part, n) => derivedOutput(refundSecret, purpose, anchorSecret, n, part, keysetId))
}

/** An output carrying a CHOSEN secret (a signed successor), blinded with a derived factor. */
export function derivedCarrier(
  refundSecret: Uint8Array,
  purpose: DerivedPurpose,
  anchorSecret: string,
  secret: string,
  amount: number,
  keysetId: string,
): BlindedOutput {
  return blinded(secret, scalarFrom(refundSecret, label(purpose, 'r', anchorOf(anchorSecret), 0)), amount, keysetId)
}

/** A derived nonce (hex), so a resent proposal is the identical proposal. */
export function derivedNonce(refundSecret: Uint8Array, purpose: DerivedPurpose, anchorSecret: string): string {
  return bytesToHex(hmac(sha256, refundSecret, utf8(label(purpose, 'nonce', anchorOf(anchorSecret), 0))))
}

/** An output carrying `secret`, blinded with `r` (random when omitted). */
export function blinded(secret: string, r: bigint | undefined, amount: number, keysetId: string): BlindedOutput {
  const b = blindMessage(utf8(secret), r)
  return { amount, id: keysetId, B_: b.B_.toHex(true), secret, r: b.r.toString(16).padStart(64, '0') }
}

// ─── The hard rule ──────────────────────────────────────────────────────────

export class CashlinkInvariantError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CashlinkInvariantError'
  }
}

interface Nut10 {
  kind: string
  data: string
  rows: string[][]
}

function nut10(secret: string): Nut10 | null {
  try {
    const parsed = JSON.parse(secret) as unknown
    if (!Array.isArray(parsed) || typeof parsed[0] !== 'string') return null
    const body = parsed[1] as { data?: unknown; tags?: unknown } | undefined
    if (!body || typeof body !== 'object') return null
    const rows = Array.isArray(body.tags)
      ? (body.tags as unknown[]).filter((t): t is unknown[] => Array.isArray(t)).map((t) => t.map((v) => String(v)))
      : []
    return { kind: parsed[0], data: typeof body.data === 'string' ? body.data : '', rows }
  } catch {
    return null
  }
}

/**
 * Whether a secret carries a locktime with no refund key: anyone can spend it after the locktime.
 * Any `locktime` tag counts, whatever its value: a value the mint cannot parse is not one this wallet
 * may guess about. Only P2PK kinds have a lock to open.
 */
export function isOpenAfterLocktime(secret: string): boolean {
  const s = nut10(secret)
  if (!s || (s.kind !== 'P2PK' && s.kind !== 'P2PK_VOUCHER')) return false
  const locktime = s.rows.find((r) => r[0] === 'locktime')
  if (!locktime) return false
  const refund = s.rows.find((r) => r[0] === 'refund')
  return !refund || refund.slice(1).filter((k) => k.length > 0).length === 0
}

/** Throws on a secret that would be anyone-can-spend after its locktime. The one gate. */
export function assertNotOpenAfterLocktime(secret: string): void {
  if (isOpenAfterLocktime(secret)) {
    throw new CashlinkInvariantError('refused: a locktime with no refund key can be spent by anyone after it passes')
  }
}

// ─── Reading a link lock ────────────────────────────────────────────────────

export interface LinkLock {
  /** x-only. */
  linkPub: string
  /** x-only. */
  refundPub: string
  locktime: number
}

const HEX66 = /^0[23][0-9a-f]{64}$/i

/**
 * The link lock a secret carries, or null when it is anything else. Exactly the shape the
 * gateway signs (`LinkLock.shapeProblem`): one refund key that is not the link key, `SIG_ALL`, a
 * positive integer locktime, no other spending keys, thresholds of one, and no tag twice.
 */
export function readLinkLock(secret: string): LinkLock | null {
  const s = nut10(secret)
  if (!s || s.kind !== 'P2PK_VOUCHER' || !HEX66.test(s.data)) return null
  const keys = s.rows.map((r) => r[0])
  if (new Set(keys).size !== keys.length) return null
  if (isOpenAfterLocktime(secret)) return null
  const tag = (k: string) => s.rows.find((r) => r[0] === k)
  const refund = tag('refund')?.slice(1) ?? []
  if (refund.length !== 1 || !HEX66.test(refund[0])) return null
  if (tag('sigflag')?.[1] !== 'SIG_ALL' || tag('pubkeys')) return null
  for (const k of ['n_sigs', 'n_sigs_refund']) {
    const row = tag(k)
    if (row && (row.length !== 2 || row[1] !== '1')) return null
  }
  const locktimeText = tag('locktime')?.[1] ?? ''
  if (!/^[1-9][0-9]{0,15}$/.test(locktimeText)) return null
  const linkPub = xOnlyOf(s.data)
  const refundPub = xOnlyOf(refund[0])
  if (linkPub === refundPub) return null
  return { linkPub, refundPub, locktime: Number(locktimeText) }
}

/** The `max_sats` a locked secret carries, or null. */
function maxSatsOf(secret: string): number | null {
  const row = nut10(secret)?.rows.find((r) => r[0] === 'max_sats')
  return row && /^[1-9][0-9]{0,15}$/.test(row[1] ?? '') ? Number(row[1]) : null
}

// ─── Time window (gateway `LinkLock.timingProblem`, Q8) ─────────────────────

const HOUR_S = 60 * 60
const DAY_S = 24 * HOUR_S
/** Room for this device's clock and the gateway's to disagree, applied on the safe side. */
const CLOCK_SLACK_S = 5 * 60

export type WindowProblem = 'too_near' | 'too_far' | 'too_close_to_expiry'

/**
 * Why the gateway would refuse to lock a gift with this `x`, or null. Checked BEFORE anything is
 * burnt: a gift that cannot be locked must stay as it is, on its link, exactly as today.
 */
export function lockWindowProblem(x: number, couponExpiresAt: number | undefined, nowS: number): WindowProblem | null {
  if (x < nowS + HOUR_S + CLOCK_SLACK_S) return 'too_near'
  if (x > nowS + 30 * DAY_S) return 'too_far'
  if (couponExpiresAt !== undefined && x > couponExpiresAt - DAY_S - CLOCK_SLACK_S) return 'too_close_to_expiry'
  return null
}

// ─── Building the two proposals ─────────────────────────────────────────────

/** Tags that decide who can spend, or that the issuer sets. Never terms. */
const NOT_TERMS = new Set(['voucher_id', 'issuer_sig', 'issuer_pubkey', 'max_sats', 'locktime', 'refund', 'sigflag', 'n_sigs', 'n_sigs_refund', 'pubkeys'])

/** A ratio as cashu-lib writes it: a whole number as a long, a fraction as Java's `Double.toString`. */
function canonicalRatio(ratio: number): string {
  return Number.isInteger(ratio) ? String(ratio) : javaDoubleToString(ratio)
}

/**
 * The voucher's terms as tags, in the order `VoucherSecret.Builder.build()` writes them, with the
 * same omissions (no memo when blank, no decimals when 0, no ratio when 1, MINIMAL when no backing
 * strategy). The gateway compares terms as a map, so the order is for the reader, not the check.
 */
function termTags(v: SignedVoucherFields): string[][] {
  const rows: string[][] = [
    ['issuer', v.issuerId],
    ['unit', v.unit],
    ['face_value', String(Math.trunc(v.faceValue))],
  ]
  if (v.expiresAt !== undefined) rows.push(['expires_at', String(Math.trunc(v.expiresAt))])
  if (v.memo && v.memo.trim()) rows.push(['memo', v.memo])
  if (v.faceDecimals > 0) rows.push(['face_decimals', String(Math.trunc(v.faceDecimals))])
  rows.push(['backing_strategy', (v.backingStrategy && v.backingStrategy.trim() ? v.backingStrategy : 'MINIMAL').toUpperCase()])
  if (v.issuanceRatio !== 1) rows.push(['issuance_ratio', canonicalRatio(v.issuanceRatio)])
  if (v.issuanceWarrant && v.issuanceWarrant.trim()) rows.push(['issuance_warrant', v.issuanceWarrant])
  if (v.merchantMetadata && v.merchantMetadata.trim()) rows.push(['merchant_metadata', v.merchantMetadata])
  return rows
}

/** Why a gift proof cannot be locked as it is. Checked before anything is burnt. */
export type UnlockableReason = 'not_a_bearer_voucher' | 'unverified' | 'non_integer_terms' | 'whole_ratio'

/** The bearer voucher a gift proof carries, or why it cannot be locked. */
export function lockableVoucher(giftSecret: string): { voucher: SignedVoucherFields } | { problem: UnlockableReason } {
  const v = voucherOfSecret(giftSecret)
  if (!v || v.lockKey) return { problem: 'not_a_bearer_voucher' }
  // A float where Java reads a long (#194) would be re-spelled by the gateway's codec, and the
  // terms would no longer match: refused here, before the burn, rather than there, after it.
  if (v.integralAsFloat || ![v.faceValue, v.faceDecimals, v.expiresAt ?? 0].every(Number.isInteger)) {
    return { problem: 'non_integer_terms' }
  }
  // cashu-voucher#59: a whole-number ratio other than 1 does not verify yet (already left out of gifts).
  if (Number.isInteger(v.issuanceRatio) && v.issuanceRatio !== 1) return { problem: 'whole_ratio' }
  return { voucher: v }
}

export interface LinkLockProposal {
  giftSecret: string
  /** x-only. */
  linkPub: string
  /** x-only. */
  refundPub: string
  x: number
  /** The burnt proof's amount: the successor's sat bound (#141). */
  maxSats: number
  nonce: string
}

/**
 * The link-locked successor the sender proposes for one burnt gift proof (gateway
 * `POST /cashlink/lock`). The tag layout is `CashlinkFixtures.linkLock`'s: the lock first, then the
 * voucher id and terms, then the locktime, the ONE refund key and the sat bound.
 */
export function linkLockProposal(p: LinkLockProposal): string {
  const found = lockableVoucher(p.giftSecret)
  if ('problem' in found) throw new Error(`this gift cannot be locked: ${found.problem}`)
  if (xOnlyOf(p.refundPub) === xOnlyOf(p.linkPub)) throw new CashlinkInvariantError('the refund key must not be the link key')
  if (!Number.isSafeInteger(p.x) || p.x <= 0 || p.x > 2_147_483_647) throw new Error('the expiry is not a usable locktime')
  if (!Number.isSafeInteger(p.maxSats) || p.maxSats <= 0) throw new Error('the sat bound must be a positive integer')
  const secret = JSON.stringify([
    'P2PK_VOUCHER',
    {
      nonce: p.nonce,
      data: compressed(p.linkPub),
      tags: [
        ['n_sigs', '1'],
        ['sigflag', 'SIG_ALL'],
        ['voucher_id', found.voucher.voucherId],
        ...termTags(found.voucher),
        ['locktime', String(p.x)],
        ['refund', compressed(p.refundPub)],
        ['max_sats', String(p.maxSats)],
      ],
    },
  ])
  assertNotOpenAfterLocktime(secret)
  return secret
}

/**
 * The UNLOCKED successor of a spent link-locked gift (gateway `POST /cashlink/resign`, owner
 * decision Q4): the coupon's terms in tag form, unsigned, with the voucher id in `data`. The
 * gateway signs it into the blob form a gift has today. `CashlinkFixtures.unlockedSuccessor`.
 */
export function unlockedProposal(lockedSecret: string, nonce: string): string {
  const s = nut10(lockedSecret)
  const v = voucherOfSecret(lockedSecret)
  if (!s || s.kind !== 'P2PK_VOUCHER' || !v) throw new Error('not a locked voucher')
  const tags = s.rows.filter((r) => !NOT_TERMS.has(r[0]))
  return JSON.stringify(['VOUCHER', { nonce, data: bytesToHex(utf8(v.voucherId)), tags }])
}

/** The terms of a voucher, as a comparable string. */
function termsKey(v: SignedVoucherFields): string {
  return JSON.stringify([v.voucherId, ...termTags(v)])
}

/**
 * Whether the gateway's signed link lock is exactly what was asked for: our link key, our ONE refund
 * key, our locktime, `SIG_ALL`, the gift's terms, a sat bound of the burn, and a valid issuer
 * signature by the gift's own issuer key. Nothing is minted from an answer that fails this.
 */
export function isTheLockAskedFor(signed: string, gift: SignedVoucherFields, ask: Omit<LinkLockProposal, 'giftSecret' | 'nonce'>): boolean {
  try {
    if (isOpenAfterLocktime(signed)) return false
    const lock = readLinkLock(signed)
    const v = voucherOfSecret(signed)
    if (!lock || !v) return false
    return (
      lock.linkPub === xOnlyOf(ask.linkPub) &&
      lock.refundPub === xOnlyOf(ask.refundPub) &&
      lock.locktime === ask.x &&
      maxSatsOf(signed) === ask.maxSats &&
      v.issuerPublicKey.toLowerCase() === gift.issuerPublicKey.toLowerCase() &&
      termsKey(v) === termsKey(gift) &&
      verifySigned(v)
    )
  } catch {
    return false
  }
}

/** Whether the gateway's signed unlocked successor is the same coupon, unlocked, by the same issuer. */
export function isTheSuccessorAskedFor(signed: string, locked: SignedVoucherFields): boolean {
  try {
    const v = voucherOfSecret(signed)
    const s = nut10(signed)
    if (!v || !s || s.kind !== 'VOUCHER' || v.lockKey) return false
    return v.issuerPublicKey.toLowerCase() === locked.issuerPublicKey.toLowerCase() && termsKey(v) === termsKey(locked) && verifySigned(v)
  } catch {
    return false
  }
}

const verifySigned = (v: SignedVoucherFields): boolean => verifyVoucher(v).signatureValid && !verifyVoucher(v).legacyCanonical

// ─── Signatures ─────────────────────────────────────────────────────────────

export const CASHLINK_LOCK_TAG = 'imani/voucher-cashlink-lock/v1'
export const CASHLINK_RESIGN_TAG = 'imani/voucher-cashlink-resign/v1'

/** `sha256(TAG || u32be(len) || predecessor || u32be(len) || proposed)`, as `LockAuthorization`. */
export function cashlinkDigest(tag: string, predecessor: string, proposed: string): Uint8Array {
  const parts: Uint8Array[] = [utf8(tag)]
  for (const secret of [predecessor, proposed]) {
    const bytes = utf8(secret)
    const length = new Uint8Array(4)
    new DataView(length.buffer).setUint32(0, bytes.length, false)
    parts.push(length, bytes)
  }
  const message = new Uint8Array(parts.reduce((n, part) => n + part.length, 0))
  let at = 0
  for (const part of parts) {
    message.set(part, at)
    at += part.length
  }
  return sha256(message)
}

/** BIP-340 with auxiliary data derived from the key and the message: the same request, the same bytes. */
function deterministicSign(digest: Uint8Array, key: Uint8Array): Uint8Array {
  const aux = hmac(sha256, key, new Uint8Array([...utf8('imani-gift-aux/v1/'), ...digest]))
  return schnorr.sign(digest, key, aux)
}

/** The lock or re-sign request's `authorization`, hex. */
export function cashlinkAuthorization(key: Uint8Array, tag: string, predecessor: string, proposed: string): string {
  return bytesToHex(deterministicSign(cashlinkDigest(tag, predecessor, proposed), key))
}

/**
 * NUT-11 `SIG_ALL` for a one-input swap: `secret || C || amount_0 || B__0 || ...`, hex lowercased,
 * exactly as the mint's `SigAllMessage` and the gateway's `SpendingPathway.sigAllMessage` build it.
 */
export function sigAllMessage(secret: string, C: string, outputs: ReadonlyArray<{ amount: number; B_: string }>): string {
  return secret + C.toLowerCase() + outputs.map((o) => `${o.amount}${o.B_.toLowerCase()}`).join('')
}

/** The witness for a one-input `SIG_ALL` swap, as NUT-11 transports it (a JSON string). */
export function sigAllWitness(key: Uint8Array, secret: string, C: string, outputs: ReadonlyArray<{ amount: number; B_: string }>): string {
  const signature = deterministicSign(sha256(utf8(sigAllMessage(secret, C, outputs))), key)
  return JSON.stringify({ signatures: [bytesToHex(signature)] })
}

/** The relay's key for a proof: `sha256(secret)`, hex. */
export function secretHash(secret: string): string {
  return bytesToHex(sha256(utf8(secret)))
}
