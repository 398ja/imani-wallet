/**
 * Cashlinks for automated senders (#366): what wallet-api answers BEFORE a caller sends.
 *
 * Employers sending gifts to staff through an integration need three answers the app works out on
 * its own: how many links they may have open (their account type's limit), whether one more (or a
 * batch) fits right now given the links they already have, and whether each coupon they mean to put
 * on a link can be made to come back on its own (#295: locked to the link with a pre-signed refund).
 *
 * ## The same rules as the rest of this service
 *
 * ADR 0001 and 0002: wallet-api holds no key, and cannot sign or spend. Sending a Cashlink means
 * burning a coupon, asking the gateway to lock its successor and signing a refund swap, all with the
 * sender's refund key, so ALL of it happens on the caller's side (`@imani/cashlink-sender`). This
 * module only reads: the caller's link records (Y points or coupons, never a link secret, the same
 * refusal as `/v1/links/status`), the mint's NUT-07 states, and the limits for the signer's pubkey.
 *
 * ## Why the limit is answered here
 *
 * Counted by the caller alone, a limit is advice. Counted here, from the mint's own states of the
 * caller's links, it is at least a consistent answer that does not depend on the caller's
 * arithmetic. It is still the caller who sends, so the gateway's lock route is where a server-side
 * cap must eventually live (see the README, "Where the limit is enforced").
 */
import { secp256k1 } from '@noble/curves/secp256k1.js'

import { limitsForSender, linkAllowance, parseBusinessSenders, type BusinessSenders, type LinkLimits, type LinkAllowance } from '@imani/wallet-core'

import { parseVoucherToken, tokenProofs, verifyVoucher } from '../../src/lib/voucherToken.js'
import { checkStates, hashToCurveHex, KEY_REFUSAL, keyLikeField, type LinkRecord } from './links.js'

type Parsed<T> = { ok: true; value: T } | { ok: false; error: { field: string; detail: string } }
const fail = (field: string, detail: string): Parsed<never> => ({ ok: false, error: { field, detail } })

// ─── Configuration ───────────────────────────────────────────────────────────

/**
 * The business senders, from `WALLET_API_BUSINESS_SENDERS` or the file named by
 * `WALLET_API_BUSINESS_SENDERS_FILE` (never both). Read once at start-up by the server, which refuses
 * to start when it is malformed rather than giving every employer the individual limit.
 */
export function businessSendersFrom(env: NodeJS.ProcessEnv, readFile: (p: string) => string): BusinessSenders {
  const inline = env.WALLET_API_BUSINESS_SENDERS?.trim()
  const file = env.WALLET_API_BUSINESS_SENDERS_FILE?.trim()
  if (inline && file) throw new Error('set WALLET_API_BUSINESS_SENDERS or WALLET_API_BUSINESS_SENDERS_FILE, not both')
  return parseBusinessSenders(file ? readFile(file) : inline)
}

// ─── The lock window (gateway LinkLock.timingProblem, Q8) ────────────────────

const HOUR_S = 3600
const DAY_S = 24 * HOUR_S
const CLOCK_SLACK_S = 5 * 60

export type WindowProblem = 'too_near' | 'too_far' | 'too_close_to_expiry'

/**
 * Why the gateway would refuse to lock a gift expiring at `x`: at least an hour away, at most 30
 * days, and at least a day before the coupon itself expires. The same numbers as the wallet's
 * `lockWindowProblem` (a test pins them together), checked here so a batch learns before anything
 * is burnt.
 */
export function windowProblem(x: number, couponExpiresAt: number | undefined, nowS: number): WindowProblem | null {
  if (x < nowS + HOUR_S + CLOCK_SLACK_S) return 'too_near'
  if (x > nowS + 30 * DAY_S) return 'too_far'
  if (couponExpiresAt !== undefined && x > couponExpiresAt - DAY_S - CLOCK_SLACK_S) return 'too_close_to_expiry'
  return null
}

/** The latest `x` a coupon may be locked with, or null when none fits (it expires too soon). */
export function latestX(couponExpiresAt: number | undefined, nowS: number): number | null {
  const cap = nowS + 30 * DAY_S
  const x = couponExpiresAt === undefined ? cap : Math.min(cap, couponExpiresAt - DAY_S - CLOCK_SLACK_S)
  return windowProblem(x, couponExpiresAt, nowS) === null ? x : null
}

// ─── Can this coupon come back on its own? ───────────────────────────────────

export type ArmBlocker =
  /** Not a plain bearer voucher (locked, a licence, a credential), or not one of this mint's. */
  | 'not_a_bearer_voucher'
  /** The issuer's signature does not verify. */
  | 'unverified'
  /** The lock route proves the burnt amount by NUT-12 DLEQ; a proof without one is never burnt. */
  | 'no_amount_proof'
  | WindowProblem
  /** The coupon's own issuer is the sender: a stall's Cashlinks lapse and are never armed (Q3). */
  | 'own_stall'

export interface CouponVerdict {
  index: number
  /** Whether a link holding this coupon can be locked so it comes back on its own. */
  armable: boolean
  blockers: ArmBlocker[]
  stallId: string | null
  faceValue: number | null
  unit: string | null
  expiresAt: number | null
}

const P2PK = /^\["P2PK/

export function couponVerdict(token: string, index: number, x: number, nowS: number, sender: string): CouponVerdict {
  const blockers: ArmBlocker[] = []
  let stallId: string | null = null
  let faceValue: number | null = null
  let unit: string | null = null
  let expiresAt: number | null = null
  try {
    const parsed = parseVoucherToken(token)
    const v = parsed.voucher
    stallId = (/^[0-9a-f]{64}$/i.test(v.issuerId) ? v.issuerId : v.issuerPublicKey).toLowerCase()
    faceValue = v.faceValue
    unit = v.unit
    expiresAt = v.expiresAt ?? null
    const proofs = tokenProofs(token)
    if (proofs.length === 0 || v.lockKey || proofs.some((p) => P2PK.test(p.secret))) blockers.push('not_a_bearer_voucher')
    if (!verifyVoucher(v).signatureValid) blockers.push('unverified')
    if (proofs.some((p) => !p.dleq)) blockers.push('no_amount_proof')
    const w = windowProblem(x, v.expiresAt, nowS)
    if (w) blockers.push(w)
    if (stallId === sender.toLowerCase()) blockers.push('own_stall')
  } catch {
    blockers.push('not_a_bearer_voucher')
  }
  return { index, armable: blockers.length === 0, blockers, stallId, faceValue, unit, expiresAt }
}

// ─── POST /v1/links/plan ─────────────────────────────────────────────────────

export const MAX_PLAN_COUPONS = 200
export const MAX_PLAN_LINKS = 5000
export const MAX_PLAN_YS = 20_000

export interface LinksPlanInput {
  /** The caller's own open link records: Y points only (or coupons, turned into Y points here). */
  links: LinkRecord[]
  /** The coupons the caller means to send, one link each. Optional: a limit check alone needs none. */
  coupons: string[]
  /** The expiry the caller means to use, unix seconds. Required when coupons are given. */
  x: number | null
  /** How many new links the caller wants (defaults to the number of coupons, else 1). */
  wanted: number
  now: number
}

const Y_HEX = /^0[23][0-9a-f]{64}$/i
const LINK_FIELDS = new Set(['id', 'x', 'ys', 'tokens'])

function isPoint(hex: string): boolean {
  try {
    secp256k1.Point.fromHex(hex)
    return true
  } catch {
    return false
  }
}

function sameMint(a: string, b: string): boolean {
  return a.trim().replace(/\/+$/, '').toLowerCase() === b.trim().replace(/\/+$/, '').toLowerCase()
}

export function parseLinksPlanRequest(body: unknown, mintUrl: string, nowS: number): Parsed<LinksPlanInput> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return fail('body', 'expected a JSON object')
  // A key in ANY field is refused before anything else, exactly as /v1/links/status does.
  const keyAt = keyLikeField(body)
  if (keyAt) return fail(keyAt, KEY_REFUSAL)
  const b = body as Record<string, unknown>
  for (const name of Object.keys(b)) {
    if (!['links', 'coupons', 'x', 'wanted'].includes(name)) return fail(name, 'unknown field; expected links, coupons, x or wanted')
  }

  const links: LinkRecord[] = []
  let ysTotal = 0
  const rawLinks = b.links === undefined ? [] : b.links
  if (!Array.isArray(rawLinks)) return fail('links', 'expected an array of your open link records')
  if (rawLinks.length > MAX_PLAN_LINKS) return fail('links', `at most ${MAX_PLAN_LINKS} links per request`)
  for (let n = 0; n < rawLinks.length; n++) {
    const at = (f: string) => `links[${n}].${f}`
    const raw = rawLinks[n]
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return fail(`links[${n}]`, 'expected an object')
    const r = raw as Record<string, unknown>
    for (const name of Object.keys(r)) if (!LINK_FIELDS.has(name)) return fail(at(name), 'unknown field; expected id, x, ys or tokens')
    const id = r.id === undefined ? String(n) : r.id
    if (typeof id !== 'string' || !/^[A-Za-z0-9:._-]{1,64}$/.test(id)) return fail(at('id'), 'expected 1 to 64 letters, digits or : . _ -')
    if (typeof r.x !== 'number' || !Number.isSafeInteger(r.x) || r.x <= 0 || r.x > 1e11) return fail(at('x'), 'expected the expiry in unix seconds')
    const ys: string[] = []
    if (r.ys !== undefined) {
      if (!Array.isArray(r.ys)) return fail(at('ys'), 'expected an array of hex points')
      for (let i = 0; i < r.ys.length; i++) {
        const y = r.ys[i]
        if (typeof y !== 'string' || !Y_HEX.test(y) || !isPoint(y)) return fail(`${at('ys')}[${i}]`, 'expected a 33-byte compressed point in hex')
        ys.push(y.toLowerCase())
      }
    }
    if (r.tokens !== undefined) {
      if (!Array.isArray(r.tokens)) return fail(at('tokens'), 'expected an array of coupons')
      for (let i = 0; i < r.tokens.length; i++) {
        const t = r.tokens[i]
        const field = `${at('tokens')}[${i}]`
        if (typeof t !== 'string' || !t.startsWith('cashuB')) return fail(field, 'expected a coupon (cashuB…)')
        try {
          if (!sameMint(parseVoucherToken(t).mintUrl, mintUrl)) return fail(field, 'this coupon is not from the mint this service checks')
          for (const p of tokenProofs(t)) ys.push(hashToCurveHex(p.secret))
        } catch {
          return fail(field, 'could not read this coupon')
        }
      }
    }
    if (ys.length === 0) return fail(at('ys'), 'expected the proofs\u2019 Y points, or the coupons')
    ysTotal += ys.length
    if (ysTotal > MAX_PLAN_YS) return fail('links', `at most ${MAX_PLAN_YS} proofs per request`)
    links.push({ id, kind: 'customer', x: r.x, ys })
  }

  const coupons: string[] = []
  if (b.coupons !== undefined) {
    if (!Array.isArray(b.coupons)) return fail('coupons', 'expected an array of coupons, one per link')
    if (b.coupons.length > MAX_PLAN_COUPONS) return fail('coupons', `at most ${MAX_PLAN_COUPONS} coupons per request`)
    for (let i = 0; i < b.coupons.length; i++) {
      const t = b.coupons[i]
      if (typeof t !== 'string' || !t.startsWith('cashuB')) return fail(`coupons[${i}]`, 'expected a coupon (cashuB…)')
      try {
        if (!sameMint(parseVoucherToken(t).mintUrl, mintUrl)) return fail(`coupons[${i}]`, 'this coupon is not from the mint this service checks')
      } catch {
        return fail(`coupons[${i}]`, 'could not read this coupon')
      }
      coupons.push(t)
    }
  }

  let x: number | null = null
  if (b.x !== undefined) {
    if (typeof b.x !== 'number' || !Number.isSafeInteger(b.x) || b.x <= 0) return fail('x', 'expected the expiry in unix seconds')
    if (b.x > 1e11) return fail('x', 'expected unix SECONDS, not milliseconds')
    x = b.x
  } else if (coupons.length > 0) {
    return fail('x', 'expected the expiry you mean to use, so the lock window can be checked')
  }

  const wanted = b.wanted === undefined ? Math.max(1, coupons.length) : b.wanted
  if (typeof wanted !== 'number' || !Number.isSafeInteger(wanted) || wanted < 1 || wanted > MAX_PLAN_COUPONS) {
    return fail('wanted', `expected a whole number from 1 to ${MAX_PLAN_COUPONS}`)
  }
  if (coupons.length > 0 && wanted !== coupons.length) return fail('wanted', 'must equal the number of coupons when coupons are sent')

  return { ok: true, value: { links, coupons, x, wanted, now: nowS } }
}

export interface LinksPlanAnswer {
  limits: LinkLimits
  counts: { outstanding: number; expiredUnreturned: number; claimed: number; unknown: number }
  allowance: LinkAllowance
  coupons: CouponVerdict[]
  /** The latest expiry every armable coupon could share, or null when none can be armed. */
  latestCommonX: number | null
  /** Links the mint could not answer for: counted as outstanding, so an unanswered link never frees a slot. */
  unknownLinks: string[]
}

/**
 * The plan. Counts the caller's links from the MINT's states (an unanswered or pending one counts as
 * outstanding: the safe direction for a limit), applies the signer's limits, and judges each coupon.
 */
export async function linksPlan(
  input: LinksPlanInput,
  sender: string,
  business: BusinessSenders,
  mintUrl: string,
  fetchImpl: typeof fetch,
): Promise<LinksPlanAnswer> {
  const limits = limitsForSender(sender, business)
  const ys = input.links.flatMap((l) => l.ys)
  const states = ys.length > 0 ? await checkStates(mintUrl, ys, fetchImpl) : new Map()
  let outstanding = 0
  let expiredUnreturned = 0
  let claimed = 0
  const unknownLinks: string[] = []
  for (const link of input.links) {
    const each = link.ys.map((y) => states.get(y) ?? 'UNKNOWN')
    if (each.every((s) => s === 'SPENT')) {
      claimed += 1
      continue
    }
    if (each.includes('UNKNOWN')) unknownLinks.push(link.id)
    if (input.now < link.x || each.includes('UNKNOWN') || each.includes('PENDING')) outstanding += 1
    else expiredUnreturned += 1
  }
  const coupons = input.coupons.map((t, i) => couponVerdict(t, i, input.x as number, input.now, sender))
  const armable = coupons.filter((c) => c.armable)
  const latest = armable.map((c) => latestX(c.expiresAt ?? undefined, input.now))
  const latestCommonX = latest.length > 0 && latest.every((v) => v !== null) ? Math.min(...(latest as number[])) : null
  return {
    limits,
    counts: { outstanding, expiredUnreturned, claimed, unknown: unknownLinks.length },
    allowance: linkAllowance({ outstanding, expiredUnreturned }, limits, input.wanted),
    coupons,
    latestCommonX,
    unknownLinks,
  }
}
