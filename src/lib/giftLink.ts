/**
 * Gift links (claim links phase 4, imani-docs/wallet/spec-claim-links.md 3.3, 4.2, 4.3, 5.3, 5.4).
 *
 *   https://<wallet-origin>/g#v=1&k=<linkSecret>&x=<expiresAtUnix>
 *
 * A customer sends a voucher to a fresh **link key** through the ordinary atomic send, then hands
 * the link key's secret to anyone as a link or QR. Whoever opens it fetches the gift wrap addressed
 * to the link key, unwraps it with the secret, verifies the token, and only on **Add** receives it.
 * The sender can take it back (receive it themselves) until it is claimed, and does so
 * automatically after `x`.
 *
 * ## The secret
 *
 * `k` is a bearer secret of bounded value. It lives in the URL fragment (never sent in a request or
 * a `Referer`), in the parked claim, and in the sender's own `sent` row on the sender's device, as
 * spec 3.3 allows. Nothing in this module logs it, puts it in a path or query string, or sends it
 * anywhere: requests carry only the derived public key and a NIP-98 signature by it.
 */
import { hmac } from '@noble/hashes/hmac'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { hashToCurve } from '@cashu/crypto/modules/common'
import { finalizeEvent, getPublicKey, nip17 } from 'nostr-tools'

import { asChunk, offerChunkFrom } from './dmChunks'
import { nip98Header, type RequestSigner } from './nip98'
import { checkTokenBacking } from './trustedMint'
import { readLinkLock } from './cashlinkLock'
import { checkIssuer } from './issuerAllowlist'
import { licenceFromToken } from './licences'
import { terminalCredentialFromToken } from './notMoney'
import {
  creditableFaceValue,
  parseVoucherToken,
  tokenProofs,
  verifyVoucher,
  type ParsedVoucherToken,
} from './voucherToken'
import { splitTokenByVoucher } from './tokenSplit'

// ─── Link keys ──────────────────────────────────────────────────────────────

/** The secp256k1 group order. */
const N = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141')

/** The HMAC label, spec 3.3: `"imani-gift-link/v1/" || i`. */
export const LINK_LABEL = 'imani-gift-link/v1/'

/**
 * `linkSecret_i = HMAC-SHA256(identitySecret, "imani-gift-link/v1/" || i) mod n`, retried on 0.
 *
 * Deterministic, so a restored wallet re-derives every link key it ever made and can find, watch
 * and reclaim its outstanding gifts (spec 2.4, "Sender's device dies"). A zero result (probability
 * about 2^-256) is retried over the label with `/r<n>` appended, so the rule is total.
 */
export function deriveLinkSecret(identitySecret: Uint8Array, i: number): Uint8Array {
  if (!Number.isSafeInteger(i) || i < 0) throw new Error('link index must be a non-negative integer')
  for (let retry = 0; ; retry++) {
    const label = retry === 0 ? `${LINK_LABEL}${i}` : `${LINK_LABEL}${i}/r${retry}`
    const mac = hmac(sha256, identitySecret, new TextEncoder().encode(label))
    const scalar = BigInt('0x' + bytesToHex(mac)) % N
    if (scalar !== 0n) return hexToBytes(scalar.toString(16).padStart(64, '0'))
  }
}

/** A random link secret, for an account whose key this wallet cannot read (spec 3.3). */
export function randomLinkSecret(): Uint8Array {
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(32))
    const scalar = BigInt('0x' + bytesToHex(bytes))
    if (scalar !== 0n && scalar < N) return bytes
  }
}

/** The x-only public key of a link secret. */
export function linkPubOf(secret: Uint8Array): string {
  return getPublicKey(secret)
}

// ─── The link ───────────────────────────────────────────────────────────────

/** 32 bytes, base64url, unpadded. */
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/
/** Unix seconds: ten digits until 2286, nine allowed for tests and clocks set to 1990. */
const EXPIRY_RE = /^[0-9]{9,11}$/

export function secretToText(secret: Uint8Array): string {
  let bin = ''
  for (const b of secret) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** The secret in `k`, or null when it is not a whole, valid secp256k1 secret. */
export function secretFromText(text: string): Uint8Array | null {
  if (!SECRET_RE.test(text)) return null
  try {
    const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='
    const bin = atob(padded)
    if (bin.length !== 32) return null
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
    // Canonical only: a 43-character string has 2 spare bits, and two spellings of one key must
    // not both parse.
    if (secretToText(bytes) !== text) return null
    const scalar = BigInt('0x' + bytesToHex(bytes))
    return scalar !== 0n && scalar < N ? bytes : null
  } catch {
    return null
  }
}

/** The gift link, or null when any part is malformed. `walletOrigin` is this wallet's own origin. */
export function formatGiftLink(walletOrigin: string, secret: Uint8Array, expiresAt: number): string | null {
  let origin: string
  try {
    const url = new URL(walletOrigin)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    origin = url.origin
  } catch {
    return null
  }
  if (!Number.isSafeInteger(expiresAt) || !EXPIRY_RE.test(String(expiresAt))) return null
  return `${origin}/g#v=1&k=${secretToText(secret)}&x=${expiresAt}`
}

export type GiftFragment =
  | { kind: 'gift'; secret: Uint8Array; key: string; x: number }
  | { kind: 'incomplete' }

/**
 * Read `#v=1&k=…&x=…`. Strict: an unknown version, a key of the wrong length or a missing expiry
 * is an incomplete link, never a guess. Only the fragment is read, never a path or a query.
 */
export function parseGiftFragment(hash: string): GiftFragment {
  const body = hash.startsWith('#') ? hash.slice(1) : hash
  if (!body) return { kind: 'incomplete' }
  const fields = new Map<string, string>()
  for (const part of body.split('&')) {
    const eq = part.indexOf('=')
    if (eq <= 0) return { kind: 'incomplete' }
    const name = part.slice(0, eq)
    if (fields.has(name)) return { kind: 'incomplete' }
    fields.set(name, part.slice(eq + 1))
  }
  if (fields.get('v') !== '1') return { kind: 'incomplete' }
  const key = fields.get('k') ?? ''
  const secret = secretFromText(key)
  const xText = fields.get('x') ?? ''
  if (!secret || !EXPIRY_RE.test(xText)) return { kind: 'incomplete' }
  return { kind: 'gift', secret, key, x: Number(xText) }
}

// ─── Expiry (Q3, and pre-check build item 3) ─────────────────────────────────

/** Q3: the choices, in days. */
export const EXPIRY_CHOICES_DAYS = [1, 7, 30] as const
export const DEFAULT_EXPIRY_DAYS = 7
const DAY_S = 24 * 60 * 60
/** The longest a gift may wait: relay retention is sized for this (spec 6.6). */
export const MAX_EXPIRY_S = 30 * DAY_S

/**
 * #295 Q8 (owner, 2026-10-21): a link ends at least this long before the coupon itself.
 *
 * Once the link expires the coupon has to come back to the sender, and a coupon past its own expiry
 * is refused by everyone, the sender included. A link ending at the coupon's last second would leave
 * nothing to take back.
 */
export const GIFT_EXPIRY_MARGIN_S = DAY_S

/** The soonest coupon expiry, unix seconds, or undefined when none expires. */
function soonestExpiryS(couponExpiriesMs: Array<number | undefined>): number | undefined {
  let soonest: number | undefined
  for (const ms of couponExpiriesMs) {
    if (typeof ms === 'number' && Number.isFinite(ms)) {
      const s = Math.floor(ms / 1000)
      soonest = soonest === undefined ? s : Math.min(soonest, s)
    }
  }
  return soonest
}

/**
 * `x = min(chosen, the coupon's own expiry − 24 h, 30 d)` in unix seconds.
 *
 * A gift that outlives its coupon would be offered to a recipient after the coupon itself lapsed,
 * and the sender's reclaim would come too late to be worth anything. The 24 h margin (#295 Q8)
 * leaves a day to take it back. The screen offers only the choices `expiryChoices` allows, so the
 * clamp here is a backstop, not the usual path.
 */
export function giftExpiry(nowMs: number, chosenDays: number, couponExpiriesMs: Array<number | undefined>): number {
  const now = Math.floor(nowMs / 1000)
  const days = (EXPIRY_CHOICES_DAYS as readonly number[]).includes(chosenDays) ? chosenDays : DEFAULT_EXPIRY_DAYS
  let x = Math.min(now + days * DAY_S, now + MAX_EXPIRY_S)
  const soonest = soonestExpiryS(couponExpiriesMs)
  if (soonest !== undefined) x = Math.min(x, soonest - GIFT_EXPIRY_MARGIN_S)
  return x
}

/**
 * The expiry choices (in days) these coupons allow: those that end at least 24 h before the soonest
 * coupon's own expiry (#295 Q8). Empty when even one day does not fit; the picker already leaves
 * such coupons out (`giftExclusion`, `'expires_soon'`).
 */
export function expiryChoices(nowMs: number, couponExpiriesMs: Array<number | undefined>): number[] {
  const now = Math.floor(nowMs / 1000)
  const soonest = soonestExpiryS(couponExpiriesMs)
  return EXPIRY_CHOICES_DAYS.filter((d) => soonest === undefined || now + d * DAY_S + GIFT_EXPIRY_MARGIN_S <= soonest)
}

/** Shown under the choices when some are not offered. Plain words, no internals. */
export function expiryLimitCopy(couponExpiresMs: number, formatDate: (ms: number) => string): string {
  return `This voucher expires on ${formatDate(couponExpiresMs)}. A Cashlink has to end at least a day before that, so you have time to take it back if nobody claims it.`
}

// ─── Fetching the gift ──────────────────────────────────────────────────────

/** A NIP-98 signer that is the link key itself (spec 3.3 claim step 2). Never the visitor. */
export function linkKeySigner(secret: Uint8Array): RequestSigner {
  return {
    signEvent: async (template) => finalizeEvent(template as never, secret) as never,
  }
}

export interface GiftWrap {
  id: string
  kind: number
  pubkey: string
  created_at: number
  content: string
  tags: string[][]
  sig: string
}

const QUERY_PATH = '/api/v1/nostr/query'

/**
 * Every kind-1059 wrap addressed to the link key, through the gateway.
 *
 * NO `since` (pre-check build item 2): NIP-59 back-dates a wrap's `created_at` by up to about two
 * days (35 h measured on a send made seconds earlier), so dm-poll's rolling 7-day window would lose
 * a gift opened on day 6 and every gift opened after day 8. The link key is fresh, so its set of
 * wraps is tiny and needs no window.
 *
 * Signed with the LINK key, `credentials: 'omit'`: the visitor's session and identity are never
 * attached to a query about somebody else's link.
 */
export async function fetchGiftWraps(secret: Uint8Array, fetchImpl: typeof fetch = fetch): Promise<GiftWrap[]> {
  return (await fetchGiftWrapsAnswer(secret, fetchImpl)).wraps
}

/**
 * #381: the relay's answer for a link, with `emptyAnswer` true only when it was well formed (an
 * `events` array) and held no event at all. Anything it could not decode, a partial chunked offer or
 * an odd body is NOT "the relay holds no wrap".
 */
export async function fetchGiftWrapsAnswer(secret: Uint8Array, fetchImpl: typeof fetch = fetch): Promise<{ wraps: GiftWrap[]; emptyAnswer: boolean }> {
  const linkPub = linkPubOf(secret)
  const body = JSON.stringify({ kinds: [1059], pTags: [linkPub], limit: 50 })
  const authorization = await nip98Header(QUERY_PATH, 'POST', body, linkKeySigner(secret))
  const response = await fetchImpl(QUERY_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: authorization },
    body,
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  })
  if (!response.ok) throw new GiftUnreachableError(`nostr/query answered ${response.status}`)
  const json = (await response.json()) as { events?: Array<Record<string, unknown>> }
  const events = Array.isArray(json?.events) ? json.events : []
  const wraps = events
    .map((e) => ({
      id: String(e.id ?? ''),
      kind: Number(e.kind),
      pubkey: String(e.pubkey ?? ''),
      created_at: Number(e.created_at ?? e.createdAt ?? 0),
      content: String(e.content ?? ''),
      tags: Array.isArray(e.tags) ? (e.tags as string[][]) : [],
      sig: String(e.sig ?? ''),
    }))
    .filter((e) => e.kind === 1059 && e.tags.some((t) => t[0] === 'p' && t[1] === linkPub))
  return { wraps, emptyAnswer: Array.isArray(json?.events) && json.events.length === 0 }
}

export class GiftUnreachableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GiftUnreachableError'
  }
}

/** One coupon found in the link's wraps, with what the transfer said about it. */
export interface GiftToken {
  token: string
  /** Who sent it, as the gateway's transfer says (display only). */
  senderPubkey?: string
  /** The rumor's `created_at`, seconds. */
  sentAt: number
}

/**
 * Unwrap the link's wraps with its secret and return every coupon in them, reassembling chunked
 * transfers with the same parser dm-poll uses (`dmChunks`). An ADR 0014 transfer signature, or any
 * other message, is ignored. A wrap that does not open is skipped: it is not ours.
 */
export async function giftTokensFrom(secret: Uint8Array, wraps: GiftWrap[]): Promise<GiftToken[]> {
  const found = new Map<string, GiftToken>()
  for (const wrap of wraps) {
    let rumor: { content: string; created_at: number }
    try {
      rumor = nip17.unwrapEvent(wrap as never, secret) as { content: string; created_at: number }
    } catch {
      continue
    }
    let content = rumor.content
    const chunk = asChunk(content)
    if (chunk) {
      const offer = await offerChunkFrom(chunk, wrap.id)
      if (offer.kind !== 'complete') continue
      content = offer.payload
    }
    const payload = asTransfer(content)
    if (!payload) continue
    // A link armed by v0.55.2 or older can hold ONE locked token mixing several coupons, which
    // every reader refused. Cut per voucher, so such a link is claimed and taken back like any.
    for (const token of splitTokenByVoucher(payload.token)) {
      if (found.has(token)) continue
      found.set(token, {
        token,
        senderPubkey: typeof payload.sender_pubkey === 'string' && /^[0-9a-f]{64}$/.test(payload.sender_pubkey)
          ? payload.sender_pubkey
          : undefined,
        sentAt: rumor.created_at,
      })
    }
  }
  return [...found.values()]
}

function asTransfer(content: string): { token: string; sender_pubkey?: unknown } | null {
  try {
    const parsed = JSON.parse(content) as { type?: unknown; token?: unknown; sender_pubkey?: unknown }
    return parsed?.type === 'cashu_token_transfer' && typeof parsed.token === 'string' && parsed.token.startsWith('cashu')
      ? { token: parsed.token, sender_pubkey: parsed.sender_pubkey }
      : null
  } catch {
    return null
  }
}

// ─── NUT-07 ─────────────────────────────────────────────────────────────────

export type ProofState = 'UNSPENT' | 'PENDING' | 'SPENT' | 'UNKNOWN'

/**
 * NUT-07 checkstate for a token, straight at its mint. Reads only; never spends.
 *
 * Only the proofs' `Y` points leave the device, never the token: sending the token to the gateway's
 * validate endpoint would hand a server enough to claim the gift (spec 2.1, rule 1).
 *
 * Asked ONLY of a mint this wallet trusts: a link is input from anyone, and a request to the mint
 * it names would tell that mint who opened it. The caller checks backing first; this checks again.
 *
 * `SPENT` when any proof is spent, `PENDING` when any is pending, `UNSPENT` only when all are.
 */
export async function tokenState(token: string, fetchImpl: typeof fetch = fetch): Promise<ProofState> {
  if (checkTokenBacking(token).outcome !== 'accept') return 'UNKNOWN'
  const proofs = tokenProofs(token)
  const mint = parseMintUrl(token)
  if (!mint || proofs.length === 0) return 'UNKNOWN'
  const Ys = proofs.map((p) => hashToCurve(new TextEncoder().encode(p.secret)).toHex(true))
  try {
    const response = await fetchImpl(`${mint}/v1/checkstate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ Ys }),
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    })
    if (!response.ok) return 'UNKNOWN'
    const json = (await response.json()) as { states?: Array<{ state?: string }> }
    const states = (json.states ?? []).map((s) => s.state)
    if (states.length !== Ys.length) return 'UNKNOWN'
    if (states.includes('SPENT')) return 'SPENT'
    if (states.includes('PENDING')) return 'PENDING'
    return states.every((s) => s === 'UNSPENT') ? 'UNSPENT' : 'UNKNOWN'
  } catch {
    return 'UNKNOWN'
  }
}

function parseMintUrl(token: string): string | null {
  try {
    return parseVoucherToken(token).mintUrl.trim().replace(/\/+$/, '') || null
  } catch {
    return null
  }
}

/** The state of a whole gift: claimed when every coupon is spent, unclaimed while any is unspent. */
export function combinedState(states: ProofState[]): ProofState {
  if (states.length === 0) return 'UNKNOWN'
  if (states.every((s) => s === 'SPENT')) return 'SPENT'
  if (states.includes('UNKNOWN')) return 'UNKNOWN'
  if (states.includes('PENDING')) return 'PENDING'
  return states.includes('UNSPENT') ? 'UNSPENT' : 'SPENT'
}

// ─── Verifying a gift before anything is spent (spec 3.3 claim step 4) ───────

export type GiftVerdict =
  /** `tokens` is what Add may redeem: the coupons that passed every check and are still unspent. */
  | { kind: 'ok'; summary: GiftSummary; tokens: GiftToken[] }
  | { kind: 'not_money' }
  | { kind: 'untrusted_mint' }
  | { kind: 'unverified' }
  | { kind: 'expired'; at: number; summary: GiftSummary | null }
  | { kind: 'claimed' }
  | { kind: 'unreachable' }

export interface GiftSummary {
  /** Issuer x-only pubkey, from the signed voucher. */
  issuer: string
  /** Total face value, minor units. */
  faceMinor: number
  unit: string
  decimals: number
  /** Who sent it (display only). */
  senderPubkey?: string
  /** The coupon's own expiry, unix seconds, when it has one. */
  couponExpiresAt?: number
}

/**
 * Everything checked from the token itself, in the spec's order, before the prompt offers Add:
 * not a licence or terminal credential; the issuer signature (and a known issuer key where this
 * deployment lists them); a trusted mint; not past `x` nor past the coupon's own expiry; and every
 * proof UNSPENT by NUT-07, otherwise "already claimed".
 */
export async function verifyGift(
  found: GiftToken[],
  x: number,
  nowMs: number,
  state: (token: string) => Promise<ProofState> = (t) => tokenState(t),
  /** The link's own key, so a gift locked to this link (#295 phase 4) is read as the gift. */
  linkPub?: string,
): Promise<GiftVerdict> {
  if (found.length === 0) return { kind: 'unreachable' }
  // Anyone can gift-wrap something to a link's PUBLIC key (the gateway learns it from the send, and
  // the wrap's p tag is public). So a token that fails its own checks, or that is already spent or
  // past its own expiry (free for anyone to wrap), is noise and never a reason to refuse the coupon
  // that passes (review of #247, F1). Only when NOTHING passes is the refusal explained.
  const usable = giftCandidates(found, linkPub)
  if (usable.length === 0) return explainRefusal(found)
  // A locked gift's own locktime is the mint's expiry for ITS claim (after it the sender's refund
  // can take it): it ends that token, never the others. Lowering `x` for the whole link would let a
  // stranger who locks a coupon of their own to this public key with a near locktime make the real
  // gift read "expired" (rev-wallet377 M1).
  const lockEnd = (t: GiftToken): number | undefined => {
    try {
      return readLinkLock(tokenProofs(t.token)[0].secret)?.locktime
    } catch {
      return undefined
    }
  }

  const now = Math.floor(nowMs / 1000)
  const parsedOf = new Map(usable.map((t) => [t.token, parseVoucherToken(t.token)]))
  const expiryOf = (t: GiftToken) => {
    const e = parsedOf.get(t.token)!.voucher.expiresAt
    const coupon = typeof e === 'number' && e > 0 ? toSeconds(e) : undefined
    const lock = lockEnd(t)
    return lock === undefined ? coupon : coupon === undefined ? lock : Math.min(coupon, lock)
  }
  const live = usable.filter((t) => {
    const e = expiryOf(t)
    return e === undefined || now < e
  })
  if (now >= x || live.length === 0) {
    const at = now >= x ? x : Math.min(...usable.map((t) => expiryOf(t) ?? Infinity))
    return { kind: 'expired', at, summary: summaryOf(usable, usable.map((t) => parsedOf.get(t.token)!), expiryOf) }
  }

  const states = await Promise.all(live.map((t) => state(t.token)))
  if (states.includes('UNKNOWN')) return { kind: 'unreachable' }
  // What is still unspent is still the recipient's to add, even when an earlier Add took part of a
  // multi-coupon gift and then failed (review of #247, F4). Claimed only when nothing is left.
  const tokens = live.filter((_, n) => states[n] === 'UNSPENT')
  if (tokens.length === 0) return { kind: 'claimed' }
  const parsed = tokens.map((t) => parsedOf.get(t.token)!)
  const issuer = stallOf(parsed[0])
  const unit = parsed[0].voucher.unit
  if (parsed.some((p) => stallOf(p) !== issuer || p.voucher.unit !== unit)) {
    return { kind: 'unverified' }
  }
  return { kind: 'ok', summary: summaryOf(tokens, parsed, expiryOf), tokens }
}

// The STALL is the voucher's signed `issuerId`; `issuerPublicKey` is the key that signed it, which
// for cashback is the gateway's (as dmCrypto and the cashback prompt name the stall).
function stallOf(p: ParsedVoucherToken): string {
  const id = (p.voucher.issuerId ?? '').toLowerCase()
  return /^[0-9a-f]{64}$/.test(id) ? id : p.voucher.issuerPublicKey.toLowerCase()
}

function summaryOf(tokens: GiftToken[], parsed: ParsedVoucherToken[], expiryOf: (t: GiftToken) => number | undefined): GiftSummary {
  const expiries = tokens.map(expiryOf).filter((e): e is number => e !== undefined)
  return {
    issuer: stallOf(parsed[0]),
    faceMinor: parsed.reduce((sum, p) => sum + exactFaceOf(p), 0),
    unit: parsed[0].voucher.unit,
    decimals: parsed[0].voucher.faceDecimals,
    senderPubkey: tokens.find((t) => t.senderPubkey)?.senderPubkey,
    couponExpiresAt: expiries.length ? Math.min(...expiries) : undefined,
  }
}

/** Why a link with NO usable coupon is refused, in the spec's order (4.3 states). */
function explainRefusal(tokens: GiftToken[]): GiftVerdict {
  for (const { token } of tokens) {
    if (licenceFromToken(token) || terminalCredentialFromToken(token)) return { kind: 'not_money' }
    let p: ParsedVoucherToken
    try {
      p = parseVoucherToken(token)
    } catch {
      return { kind: 'unverified' }
    }
    if (!verifyVoucher(p.voucher).signatureValid || checkIssuer(p) === 'unknown-issuer') return { kind: 'unverified' }
    if (p.voucher.lockKey) return { kind: 'not_money' }
  }
  for (const { token } of tokens) {
    if (checkTokenBacking(token).outcome !== 'accept') return { kind: 'untrusted_mint' }
  }
  return { kind: 'not_money' }
}

/**
 * The tokens that pass every per-token check on their own: readable, a valid issuer signature from
 * a known issuer, money (not a licence, credential or locked voucher), at a trusted mint. Used to
 * drop what a third party gift-wrapped to the link's public key (review of #247, F1).
 */
export function giftCandidates(tokens: GiftToken[], linkPub?: string): GiftToken[] {
  return tokens.filter(({ token }) => {
    try {
      if (licenceFromToken(token) || terminalCredentialFromToken(token)) return false
      const p = parseVoucherToken(token)
      if (!verifyVoucher(p.voucher).signatureValid || checkIssuer(p) === 'unknown-issuer') return false
      // #295 phase 4: a gift locked to THIS link (the Cashlink shape, one refund key, SIG_ALL) is
      // the link's own coupon: whoever holds the link key can claim it. Any other lock is not.
      const proofs = tokenProofs(token)
      const lockedHere = linkPub !== undefined && proofs.length > 0 && proofs.every((proof) => readLinkLock(proof.secret)?.linkPub === linkPub)
      if (!lockedHere) {
        if (p.voucher.lockKey) return false
        if (proofs.some((proof) => /^\["P2PK/.test(proof.secret))) return false
      }
      return checkTokenBacking(token).outcome === 'accept'
    } catch {
      return false
    }
  })
}

/** What a receiver will credit for this token: the same rule every receive uses. */
function exactFaceOf(p: ParsedVoucherToken): number {
  return creditableFaceValue(p).faceValue
}

/** Seconds, from a voucher expiry stored in seconds or milliseconds. */
function toSeconds(value: number): number {
  return value > 1e12 ? Math.floor(value / 1000) : value
}

// ─── What may go in a gift (spec 4.2 step 2) ─────────────────────────────────

export type GiftExclusion = 'not_money' | 'locked' | 'own_stall' | 'not_yet' | 'expires_soon'

/** The picker's copy for a sender's own coupons (spec 3.2, 4.2). */
export const OWN_STALL_COPY = 'To give away your own stall’s vouchers, create a Cashlink from Sell.'

/**
 * The picker's copy for coupons that cannot go in a Cashlink yet (#295 phase 0, cashu-voucher#59).
 * Plain words: the reason is a fault in how some stalls' coupons are checked, which the customer
 * cannot act on, so it says what still works instead.
 */
export const GIFT_NOT_YET_COPY =
  'Some of your vouchers can’t be sent as a Cashlink yet. You can still spend them, or send them to someone’s handle.'

/** The picker's copy for coupons too close to their own expiry to leave in a link (#295 Q8). */
export const GIFT_EXPIRES_SOON_COPY =
  'Vouchers that expire within two days can’t be sent as a Cashlink: there would be no time to take one back. Spend them, or send them to someone’s handle.'

/**
 * A whole-number ratio other than 1 (2, 50, 700): cashu-voucher#59. These coupons fail the issuer
 * signature check at the mint and at the re-sign route today, so a gift of one could be neither
 * claimed nor taken back. Excluded until #59 lands (design-295 §6). 1 and fractional ratios are fine.
 */
function wholeNumberRatio(ratio: number): boolean {
  return Number.isInteger(ratio) && ratio !== 1
}

/**
 * Why this coupon may not go in a gift link, or null when it may. Licences and terminal credentials
 * are not money; a locked voucher is bound to a key the link holder does not have; a coupon the
 * sender issued is cashback, which has its own flow (spec 3.2); a whole-number-ratio coupon cannot be
 * checked today (cashu-voucher#59); and a coupon expiring within two days leaves no room for a
 * one-day link that ends a day before it (#295 Q8).
 */
export function giftExclusion(
  token: string | undefined,
  issuerId: string | undefined,
  sender: string,
  nowMs = Date.now(),
): GiftExclusion | null {
  if (!token) return 'not_money'
  if (licenceFromToken(token) || terminalCredentialFromToken(token)) return 'not_money'
  if ((issuerId ?? '').toLowerCase() === sender.toLowerCase()) return 'own_stall'
  let parsed: ParsedVoucherToken | undefined
  try {
    parsed = parseVoucherToken(token)
  } catch {
    // Plain ecash or unreadable: no voucher lock, ratio or expiry to speak of.
  }
  if (parsed?.voucher.lockKey) return 'locked'
  try {
    if (tokenProofs(token).some((p) => /^\["P2PK/.test(p.secret))) return 'locked'
  } catch {
    // Unreadable: the send itself refuses it at the gateway, as for any other send.
  }
  if (parsed && wholeNumberRatio(parsed.voucher.issuanceRatio)) return 'not_yet'
  const exp = parsed?.voucher.expiresAt
  if (typeof exp === 'number' && Number.isFinite(exp) && exp > 0) {
    if (expiryChoices(nowMs, [toSeconds(exp) * 1000]).length === 0) return 'expires_soon'
  }
  return null
}
