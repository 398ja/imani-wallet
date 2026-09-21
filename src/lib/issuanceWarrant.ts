/**
 * Reading an issuance warrant: what, outside the issuing service, authorised a
 * coupon.
 *
 * A voucher carries one signature and it is the issuing *service's*. The stall
 * named in `issuerId` signs nothing, so "stall X issued this" is an assertion
 * nobody can verify against X — Finding 6 of
 * `docs/research/audit-double-spend-inflation-review.md`. A warrant carries
 * evidence from outside that service, bound to a digest that **covers the
 * amount**, because the harm was never that a coupon names the wrong stall but
 * that an unbacked claim exists against a stall that was never paid.
 *
 * ## A warrant attests a SALE, not a coupon
 *
 * One Sell action mints an unknown number of coupons: a quantity, each
 * auto-splitting again server-side when a coupon would be too large to receive.
 * None of those ids exist when the merchant signs, so the digest covers the
 * **sale total** and every coupon from that sale carries the same warrant.
 *
 * Verification is therefore a **ceiling test**: this coupon's face value must
 * not exceed the warranted total. That is also why splits keep working — a
 * coupon keeps its issued bytes and its value only ever falls, so the ceiling
 * stays true with nobody re-signing. Which matters, because the stall is not
 * present at split time and could not re-sign if asked.
 *
 * See `warrantCeiling.ts` for the rule and
 * `__tests__/warrantSplitBinding.test.ts` for why it cannot live in the digest.
 */
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'

/**
 * Separates fields in the digest preimage. Mirrors `IssuanceWarrant.java`.
 *
 * **Load-bearing, not tidiness.** Concatenated, `saleTotal=25, decimals=00` and
 * `saleTotal=2500, decimals=0` are the same bytes, so one warrant would verify
 * against a coupon worth a hundred times more. US (0x1f) cannot appear in any
 * field here: ids and keys are hex, amounts decimal, units alphabetic.
 */
const FIELD_SEPARATOR = '\u001f'

/** The forms a warrant can take, matching `IssuanceWarrant.Form` on the wire. */
export type WarrantForm = 'merchant' | 'processor' | 'delegated' | 'none'

/**
 * A warrant as read from a coupon.
 *
 * **Three absence states, deliberately not a nullable object.** A boolean or a
 * `| null` invites `if (!warrant)`, which collapses `absent-legacy` into
 * `declared-none` — and that conflation is exactly how a downgrade attack gets
 * in. A stripped warrant would read as a pre-warrant coupon.
 *
 * `invalid` is separate from all three: it means a warrant was present and we
 * could not make sense of it, which is a refusal rather than an absence.
 */
export type IssuanceWarrant =
  | {
      /** No tag at all. The coupon predates warrants; the issuer said nothing. */
      state: 'absent-legacy'
    }
  | {
      /**
       * The issuer SIGNED that nothing authorised this beyond itself.
       *
       * A positive statement, and the thing a policy can refuse. Absence
       * cannot be refused the same way, because refusing every pre-warrant
       * coupon is a migration decision rather than a security one.
       */
      state: 'declared-none'
    }
  | {
      state: 'present'
      form: Exclude<WarrantForm, 'none'>
      /** The sale total this warrant authorises, in minor units. The ceiling. */
      saleTotalMinor: number
      faceDecimals: number
      unit: string
      /** Per-sale nonce, so two identical sales do not share a digest. */
      saleNonce: string
      /** Signature hex, for `merchant` and `delegated`. Absent on `processor`. */
      signature?: string
      /** Processor reference, e.g. a charge id. Never a signature. */
      reference?: string
    }
  | {
      /**
       * Present and unreadable: bad JSON, unknown form, missing fields.
       *
       * Refused rather than treated as absent. A coupon carrying a shape this
       * build does not understand is not a coupon predating warrants, and
       * reading it as one would silently accept whatever the shape was hiding.
       */
      state: 'invalid'
      reason: string
    }

/** The digest a warrant signs. Mirrors `IssuanceWarrant.saleDigest`. */
export function warrantSaleDigest(
  issuerId: string,
  saleTotalMinor: number,
  faceDecimals: number,
  unit: string,
  saleNonce: string,
): Uint8Array {
  const preimage = [
    issuerId,
    String(saleTotalMinor),
    String(faceDecimals),
    unit,
    saleNonce,
  ].join(FIELD_SEPARATOR)
  return sha256(new TextEncoder().encode(preimage))
}

/**
 * Parses the raw warrant JSON off a coupon.
 *
 * `undefined` in means `absent-legacy` out — that is the whole reason this
 * takes an optional string rather than requiring the caller to pre-check.
 */
export function parseIssuanceWarrant(raw: string | undefined | null): IssuanceWarrant {
  if (raw == null || raw.length === 0) return { state: 'absent-legacy' }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { state: 'invalid', reason: 'warrant is not valid JSON' }
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { state: 'invalid', reason: 'warrant is not an object' }
  }

  const obj = parsed as Record<string, unknown>
  const form = obj.form

  if (form === 'none') return { state: 'declared-none' }

  // An unknown form is REFUSED, never defaulted. Treating it as `none` would
  // report "the issuer signed that nothing authorised this", a claim nobody
  // made, about a shape this build cannot read.
  if (form !== 'merchant' && form !== 'processor' && form !== 'delegated') {
    return { state: 'invalid', reason: `unknown warrant form: ${String(form)}` }
  }

  const saleTotalMinor = Number(obj.sale_total)
  if (!Number.isFinite(saleTotalMinor) || saleTotalMinor < 0) {
    return { state: 'invalid', reason: 'warrant sale_total is missing or not a number' }
  }
  const faceDecimals = Number(obj.face_decimals)
  if (!Number.isFinite(faceDecimals) || faceDecimals < 0) {
    return { state: 'invalid', reason: 'warrant face_decimals is missing or not a number' }
  }
  const unit = typeof obj.unit === 'string' ? obj.unit : undefined
  if (!unit) return { state: 'invalid', reason: 'warrant unit is missing' }

  const saleNonce = typeof obj.nonce === 'string' ? obj.nonce : undefined
  if (!saleNonce) return { state: 'invalid', reason: 'warrant nonce is missing' }

  // A merchant or delegated warrant without a signature is not a weaker
  // warrant, it is an unreadable one: the signature IS the evidence. A
  // processor warrant legitimately has none, because it references an external
  // record instead.
  const signature = typeof obj.sig === 'string' ? obj.sig : undefined
  if ((form === 'merchant' || form === 'delegated') && !signature) {
    return { state: 'invalid', reason: `${form} warrant carries no signature` }
  }

  return {
    state: 'present',
    form,
    saleTotalMinor,
    faceDecimals,
    unit,
    saleNonce,
    signature,
    reference: typeof obj.ref === 'string' ? obj.ref : undefined,
  }
}

/** What a verification concluded, and why. */
export type WarrantVerdict =
  /** Signature checked out and the coupon fits under the warranted total. */
  | { verdict: 'verified' }
  /** A recorded claim we cannot check here. `processor` only. */
  | { verdict: 'claimed'; reference?: string }
  /** Nothing to check. */
  | { verdict: 'absent' }
  /** The issuer signed that nothing authorised this. */
  | { verdict: 'unwarranted' }
  /** Present and refused. */
  | { verdict: 'failed'; reason: string }

/**
 * Verifies a warrant against the coupon carrying it.
 *
 * Offline for `merchant`. `processor` is recorded, never verified — the type
 * makes that impossible to confuse, because it returns a different verdict
 * rather than `verified` with a caveat a caller might drop.
 *
 * `delegated` is **not implemented yet** and returns `failed` rather than
 * something optimistic. Verifying it needs two steps — the signature against
 * the credential's lock key, then that the credential was minted by `issuerId`
 * — and doing only the first accepts a credential the attacker minted for
 * themselves. A half-check here would be worse than refusing.
 */
export function verifyIssuanceWarrant(
  warrant: IssuanceWarrant,
  issuerId: string,
  couponFaceMinor: number,
): WarrantVerdict {
  switch (warrant.state) {
    case 'absent-legacy':
      return { verdict: 'absent' }
    case 'declared-none':
      return { verdict: 'unwarranted' }
    case 'invalid':
      return { verdict: 'failed', reason: warrant.reason }
    case 'present':
      break
  }

  // The ceiling, checked BEFORE the signature and independently of it. A
  // genuine warrant from a real small sale, replayed onto a large coupon, has a
  // signature that verifies perfectly. Only this refuses it.
  if (!warrantCovers(warrant.saleTotalMinor, couponFaceMinor)) {
    return {
      verdict: 'failed',
      reason: `coupon face ${couponFaceMinor} exceeds warranted sale total ${warrant.saleTotalMinor}`,
    }
  }

  if (warrant.form === 'processor') {
    return { verdict: 'claimed', reference: warrant.reference }
  }

  if (warrant.form === 'delegated') {
    return { verdict: 'failed', reason: 'delegated warrants are not verifiable in this build' }
  }

  const digest = warrantSaleDigest(
    issuerId,
    warrant.saleTotalMinor,
    warrant.faceDecimals,
    warrant.unit,
    warrant.saleNonce,
  )

  try {
    const ok = schnorr.verify(hexToBytes(warrant.signature!), digest, hexToBytes(issuerId))
    return ok
      ? { verdict: 'verified' }
      : { verdict: 'failed', reason: 'warrant signature did not verify against the stall' }
  } catch (e) {
    // Malformed hex reaches here. Refuse rather than throw: the caller is
    // deciding whether to credit a merchant, not parsing a config file.
    return { verdict: 'failed', reason: `warrant signature unreadable: ${(e as Error).message}` }
  }
}

/**
 * Whether a warranted sale total covers a coupon's face value.
 *
 * **A ceiling, so this is `<=` and the direction is the point.** A coupon worth
 * less is the ordinary case — sales split into parts, and parts shrink as they
 * are spent. A coupon worth MORE than the sale it claims to come from is the
 * forgery the scheme exists to refuse.
 *
 * **Not `>=`, and not `===`.** `>=` reads as the safe form and is exactly
 * backwards: over-statement is the failure mode, so `>=` on the wrong operands
 * accepts every case of interest. `===` would be right if a warrant described
 * one coupon — but it describes a SALE, and a sale splits, so equality would
 * refuse every part of every multi-coupon sale.
 *
 * Duplicated deliberately from `IssuanceWarrant.coversFaceValue` in Java. Both
 * sides must agree and there is no shared implementation across the language
 * boundary, so the comment is the contract and
 * `__tests__/warrantDigestParity.test.ts` is the enforcement.
 */
export function warrantCovers(saleTotalMinor: number, couponFaceMinor: number): boolean {
  if (!Number.isFinite(saleTotalMinor) || !Number.isFinite(couponFaceMinor)) return false
  if (saleTotalMinor < 0 || couponFaceMinor < 0) return false
  return couponFaceMinor <= saleTotalMinor
}

/**
 * How much a warrant over-states a coupon by, in minor units.
 *
 * Zero when the warrant describes the coupon exactly. Positive on a split part
 * or a partly-spent coupon. Never negative: a coupon worth more than its sale
 * is not an over-statement, it is one `warrantCovers` refuses outright.
 *
 * Exists because the UI needs the figure and not just the verdict. A warranted
 * coupon that has been split must show the ISSUED amount rather than claiming
 * the held one — see `__tests__/warrantSplitBinding.test.ts`, which is the
 * executable form of that rule.
 */
export function warrantOverstatement(saleTotalMinor: number, couponFaceMinor: number): number {
  if (!Number.isFinite(saleTotalMinor) || !Number.isFinite(couponFaceMinor)) return 0
  return Math.max(0, saleTotalMinor - couponFaceMinor)
}

/** Signs a sale digest. Used at Sell time; see `issue.ts`. */
export async function signWarrantDigest(
  digest: Uint8Array,
  privateKeyHex: string,
): Promise<string> {
  return bytesToHex(await schnorr.sign(digest, hexToBytes(privateKeyHex)))
}
