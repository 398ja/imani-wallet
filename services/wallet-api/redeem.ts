import { checkCeiling, checkPart, type PriorRedemption } from '@imani/redemption'

import {
  parseVoucherToken,
  verifyVoucher,
  creditableFaceValue,
  exactFaceValue,
  type ParsedVoucherToken,
} from '../../src/lib/voucherToken.js'
import { effectiveNow } from './testSeams'

/**
 * Taking a coupon a customer presents.
 *
 * Three questions, and they are genuinely different: is this coupon real, would
 * this amount fit inside what was issued, and what do I sign to accept it.
 *
 * ## The same reader the wallet uses
 *
 * `src/lib/voucherToken.ts` is imported directly rather than reimplemented. It
 * is pure — schnorr, sha256, hex, and no DOM — and the precedent is
 * `src/lib/audit.ts`, which `tsconfig.services.json` includes for exactly this
 * reason: the audit API's argument is that it runs the same reader the wallet
 * does. A second voucher parser would be a second opinion about whether a
 * customer's money is genuine.
 *
 * ## What this cannot do
 *
 * Spend anything. Accepting a coupon means swapping it at the mint, which needs
 * a signature this service cannot produce (ADR 0001/0002). So the accept step
 * is a courier: it returns the bytes to sign, and the caller signs them.
 */

type Parsed<T> = { ok: true; value: T } | { ok: false; error: { field: string; detail: string } }

const fail = (field: string, detail: string): Parsed<never> => ({ ok: false, error: { field, detail } })

function describe(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'an array'
  return typeof v
}

/** Why a coupon cannot be taken. Each has a different fix, so each is named. */
export const REFUSAL = {
  /** Not a voucher token at all — plain ecash, or something else entirely. */
  NOT_A_VOUCHER: 'not-a-voucher',
  /** The issuer's signature does not check out over the canonical bytes. */
  BAD_SIGNATURE: 'bad-signature',
  /** Genuine, and past its expiry. */
  EXPIRED: 'expired',
  /** Genuine, and issued by a stall this caller is not. */
  ANOTHER_STALL: 'another-stall',
} as const

export type Refusal = (typeof REFUSAL)[keyof typeof REFUSAL]

export interface VerifyInput {
  token: string
  /** Epoch seconds. Supplied, so expiry is testable to the second. */
  now: number
  /**
   * The stall the caller is acting as. Defaults to the signing key.
   *
   * Checked because a coupon is a claim on ONE stall, honoured by that stall
   * alone. Accepting another stall's coupon is money that simply stops: the
   * customer has paid and the taker holds something they cannot redeem.
   */
  stallPubkey: string
}

export function parseVerifyInput(body: unknown, callerPubkey: string, defaultNow: number): Parsed<VerifyInput> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return fail('body', `expected a JSON object, got ${describe(body)}`)
  }
  const b = body as Record<string, unknown>

  const token = typeof b.token === 'string' ? b.token.trim() : ''
  if (!token) return fail('token', 'required')

  // IW-05: the server clock decides expiry, not the caller. `now` in the body was a test seam
  // wired into the production parser, and it drives the expired-coupon branch below — so any
  // caller could redeem a coupon that expired last year, and /v1/redeem/prepare gates on this
  // verdict before handing a till the receive URL and body.
  const now = effectiveNow(b.now, defaultNow)
  if (!Number.isFinite(now)) return fail('now', 'expected epoch seconds')

  return { ok: true, value: { token, now, stallPubkey: callerPubkey } }
}

export interface Verdict {
  ok: boolean
  refusal?: Refusal
  detail?: string
  voucher?: {
    voucherId: string
    issuerId: string
    unit: string
    /** The issuer-signed ceiling, in minor units. */
    signedFaceValue: number
    faceDecimals: number
    expiresAt?: number
    /** True when the signature only checked out against the pre-fix form. */
    legacyCanonical: boolean
    /** Present on a P2PK-locked voucher: the key a spender must sign for. */
    lockKey?: string
  }
}

/**
 * Is this coupon real, unexpired, and mine to honour?
 *
 * Deliberately says nothing about whether it has been SPENT. That is the mint's
 * answer, not ours, and asking here would make a read into a network call —
 * see the ticket. What this establishes is that the bytes are genuine, which is
 * the part a caller cannot do for itself.
 */
export function verifyCoupon(input: VerifyInput): Verdict {
  let parsed: ParsedVoucherToken
  try {
    parsed = parseVoucherToken(input.token)
  } catch (e) {
    return {
      ok: false,
      refusal: REFUSAL.NOT_A_VOUCHER,
      detail: e instanceof Error ? e.message : 'the token could not be read',
    }
  }

  const verification = verifyVoucher(parsed.voucher)
  if (!verification.signatureValid) {
    return {
      ok: false,
      refusal: REFUSAL.BAD_SIGNATURE,
      detail: "the issuer's signature does not check out over this voucher",
    }
  }

  const voucher = {
    voucherId: parsed.voucher.voucherId,
    issuerId: parsed.voucher.issuerId,
    unit: parsed.voucher.unit,
    // From `creditableFaceValue`, which clamps a rewritten issuance ratio down
    // to the signed face. That clamp is the only bound holding against a
    // tampered ratio, and it needs no network.
    signedFaceValue: creditableFaceValue(parsed).faceValue,
    faceDecimals: parsed.voucher.faceDecimals,
    expiresAt: parsed.voucher.expiresAt,
    legacyCanonical: verification.legacyCanonical,
    lockKey: parsed.voucher.lockKey,
  }

  if (voucher.expiresAt !== undefined && voucher.expiresAt <= input.now) {
    return { ok: false, refusal: REFUSAL.EXPIRED, detail: 'this coupon has expired', voucher }
  }

  if (voucher.issuerId.toLowerCase() !== input.stallPubkey.toLowerCase()) {
    return {
      ok: false,
      refusal: REFUSAL.ANOTHER_STALL,
      detail: 'this coupon is a claim on another stall, which is the only one that can honour it',
      voucher,
    }
  }

  return { ok: true, voucher }
}

export interface CheckInput extends VerifyInput {
  requested: number
  priorRedemptions: PriorRedemption[]
}

export function parseCheckInput(body: unknown, callerPubkey: string, defaultNow: number): Parsed<CheckInput> {
  const base = parseVerifyInput(body, callerPubkey, defaultNow)
  if (!base.ok) return base

  const b = body as Record<string, unknown>

  const requested = Number(b.requested)
  if (!Number.isFinite(requested) || requested <= 0) {
    return fail('requested', 'expected a number greater than zero, in minor units')
  }
  if (!Number.isInteger(requested)) {
    return fail('requested', 'expected a whole number of minor units')
  }

  // IW-06: required, not defaulted. An integrator who omits the field got a silently empty
  // history and a ceiling that always fits — the failure looks exactly like success, which is
  // the worst shape for a check documented as "the only one that sees ACROSS redemptions".
  if (b.priorRedemptions === undefined) {
    return fail(
      'priorRedemptions',
      'required - send every redemption you have recorded for this coupon, or [] if none',
    )
  }
  const rows = b.priorRedemptions
  if (!Array.isArray(rows)) {
    return fail('priorRedemptions', `expected an array, got ${describe(rows)}`)
  }

  const priorRedemptions: PriorRedemption[] = []
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      return fail(`priorRedemptions[${i}]`, `expected an object, got ${describe(row)}`)
    }
    const r = row as Record<string, unknown>

    const amount = Number(r.amount)
    // IW-06: whole and non-negative. This checked only Number.isFinite, while `requested` right
    // above is checked as a positive integer — so a negative amount was accepted here and
    // nowhere else. A negative `in` SUBTRACTS consumed value, so one request could manufacture
    // headroom far above the signed face value:
    //   {"requested":10000,"priorRedemptions":[{"amount":-999999,"direction":"in"}]}
    // and the endpoint would answer that taking it breaches nothing.
    if (!Number.isInteger(amount) || amount < 0) {
      return fail(
        `priorRedemptions[${i}].amount`,
        'expected a whole number of minor units, zero or greater',
      )
    }
    if (amount > Number.MAX_SAFE_INTEGER) {
      return fail(`priorRedemptions[${i}].amount`, 'implausibly large')
    }

    const direction = r.direction
    if (direction !== 'in' && direction !== 'out') {
      // Required rather than defaulted: guessing 'in' would consume a ceiling
      // that nothing had spent, and guessing 'out' would disable it entirely.
      return fail(`priorRedemptions[${i}].direction`, "expected 'in' or 'out'")
    }

    // Optional: the part's value before rounding, as the till stores it. Same
    // validation as `amount` minus the whole-number rule, for the same reason.
    let exact: number | undefined
    if (r.exact !== undefined) {
      exact = Number(r.exact)
      if (!Number.isFinite(exact) || exact < 0 || exact > Number.MAX_SAFE_INTEGER) {
        return fail(`priorRedemptions[${i}].exact`, 'expected a finite number, zero or greater')
      }
    }

    priorRedemptions.push(exact === undefined ? { amount, direction } : { amount, direction, exact })
  }

  return { ok: true, value: { ...base.value, requested, priorRedemptions } }
}

/**
 * Would taking `requested` breach what the issuer signed?
 *
 * The bound comes from the VERIFIED voucher, never from the caller. A ceiling
 * the presenter chose is not a ceiling — which is why this verifies the token
 * again rather than trusting a face value in the body.
 */
export function checkRedemption(input: CheckInput) {
  const verdict = verifyCoupon(input)
  if (!verdict.ok || !verdict.voucher) return { verdict, ceiling: null }

  // The till's rule exactly (`checkPart` in @imani/redemption): the part is
  // taken only if its exact value fits, and may book at most its CUMULATIVE
  // credit. Per-part rounding let a voucher split into many tiny parts book
  // half a unit on each; asking for more than `creditable` is refused however
  // much room the ceiling has.
  //
  // Bounded by the voucher's SIGNED face, as the till is (dmCrypto's
  // `validation.signedFaceValue`), not by `verdict.voucher.signedFaceValue`,
  // which is this token's own clamped value: bounding by that refused the later
  // parts of every split, since each part's value is less than the face.
  const parsed = parseVoucherToken(input.token)
  const face = parsed.voucher.faceValue
  const part = checkPart({
    signedFaceValue: face,
    exact: exactFaceValue(parsed),
    priorRedemptions: input.priorRedemptions,
  })
  const ceiling = checkCeiling({
    signedFaceValue: face,
    requested: input.requested,
    priorRedemptions: input.priorRedemptions,
  })

  return {
    verdict,
    ceiling: {
      ...ceiling,
      allowed: ceiling.allowed && part.check.allowed && input.requested <= part.credit,
      creditable: part.credit,
    },
    /**
     * IW-06: says out loud whose history this is.
     *
     * The ceiling is computed over the redemptions the CALLER supplied. This service holds none
     * (ADR 0001), so `fits: true` is not a promise that the coupon is unspent — only the mint's
     * swap settles that. Callers treat a 200 as authority unless the response says otherwise,
     * and a courier that is mistaken for a ledger is how a double-spend gets approved politely.
     *
     * Concurrency is the caller's too. Two checks for two parts of one voucher, made against
     * the same `priorRedemptions`, are each answered as if the other did not exist. A caller
     * that redeems in parallel must serialise check, swap and write per voucher, as the till
     * does with a Web Lock (`imani-redeem:<voucherId>` in dmPoll).
     */
    historySource: 'caller-supplied' as const,
  }
}

/**
 * Where redemption happens, which is NOT where a split happens.
 *
 * `/api/v1/wallet/receive` is customer-wallet's (28082 on the test stack);
 * `/api/v1/atomic/vouchers/split` is gateway-core's (28081). The two courier
 * paths in this service therefore read different environment variables, and
 * conflating them would send a caller to sign a URL the gateway never serves —
 * a 404 from a host they did not choose to address.
 */
const CUSTOMER_URL = process.env.WALLET_API_CUSTOMER_URL ?? 'http://gateway-customer:8082'

/**
 * The gateway path a caller signs to accept a coupon.
 *
 * Exported so a test cannot drift from what the endpoint actually tells
 * callers to sign — a mismatch there surfaces at the GATEWAY as a
 * payload-mismatch, from a service the caller never addressed directly, which
 * is a confusing afternoon.
 */
export const RECEIVE_PATH = '/api/v1/wallet/receive'

/** The full URL a caller signs when accepting a coupon. */
export function receiveUrl(): string {
  return `${CUSTOMER_URL.replace(/\/$/, '')}${RECEIVE_PATH}`
}

/**
 * The exact body to sign, serialised ONCE.
 *
 * Byte for byte: NIP-98 commits to a sha256 of the body, so re-serialising with
 * a different key order produces a different hash and the gateway refuses the
 * request. Callers are told to sign this string rather than rebuild it.
 */
export function receiveBody(token: string): string {
  return JSON.stringify({ token })
}
