/**
 * A gift as a checkout code for the stall's online shop (#410, payment-adapter#314,
 * docs/superpowers/specs/2026-11-05-410-code-gift-issuer-plan.md, option 1(a)).
 *
 * The voucher is MINTED locked by gateway-customer (`link_lock`) exactly as a G14 gift, but the lock
 * key is the shop's key S (pinned on the draft), the refund key is the buyer's fresh R, and the
 * locktime is the code's expiry x (pinned too). Contract §2 part shape: `P2PK_VOUCHER(data=02||S)`,
 * `sigflag SIG_ALL`, `n_sigs 1`, no `pubkeys`, R != S, and R != the depositor (this issuer).
 *
 * Then:
 * 1. deposit it at imani-checkout-codes `POST /v1/checkout-codes`, NIP-98 by this issuer's seal key
 *    (listed in the store's `CHECKOUT_CODES_ISSUER_DEPOSITORS`), idempotency `<draftId>:code`;
 * 2. mail the recipient the code (`gift-code`, idempotency `<draftId>:code-mail`);
 * 3. hand the buyer an `imani_gift_sent` wrap to R (the part and its code) for the return page;
 * 4. scrub the seal (the link secret is unused for a code).
 *
 * No relay arm: the issuer never holds R's secret, so it cannot make a refund. After x the buyer's
 * return link takes back whatever is still on the code (`settleLockedGift`, noRelay), as G14.
 *
 * Every step is idempotent, so crash recovery is "re-mint (gc replays the token) and re-deposit (the
 * store replays the code)". The code is never logged.
 */
import { finalizeEvent, getPublicKey } from 'nostr-tools'
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils'
import { sha256 } from '@noble/hashes/sha256'

import { lockWindowProblem, type WindowProblem } from '../../src/lib/cashlinkLock'
import { creditableFaceValue, parseVoucherToken, proofSecrets } from '../../src/lib/voucherToken'
import { verifyLockedGift, type GiftLock } from './giftLock'
import type { StepResult } from './giftDelivery'

export const CHECKOUT_CODES_PATH = '/v1/checkout-codes'
export const CODE_CHECK_PATH = '/v1/code-check'

/** An answer from the code store. `status` 0 means it could not be reached. */
export interface StoreAnswer {
  status: number
  body: Record<string, unknown> | null
}

/** What a code gift needs beyond the G14 gift ports. */
export interface CodeGiftPorts {
  /** POST the deposit, NIP-98 signed by `signer`. Never throws: unreachable is status 0. */
  deposit(signer: Uint8Array, body: DepositBody): Promise<StoreAnswer>
  /** The store's PUBLIC base, for the recipient's balance link. */
  publicBaseUrl: string
}

export interface DepositBody {
  idempotency_key: string
  stall_pubkey: string
  shop_key: string
  unit: string
  amount: number
  expires_at: number
  parts: Array<{ token: string; amount: number }>
}

export type CodeLockProblem = 'no_refund_key' | 'malformed_key' | 'refund_is_lock_key' | 'refund_is_depositor' | WindowProblem

const XONLY = /^[0-9a-f]{64}$/

/**
 * The lock for a code gift, or why it cannot be minted. Checked BEFORE minting. x is PINNED by
 * payment-adapter, never derived here, and must sit in the store's window (`lockWindowProblem`,
 * the same rule the wallet's own checkout codes use) against the coupon's expiry and NOW.
 */
export function codeLockFor(input: {
  shopKey: string
  refundPubkey: string | null
  depositorPubkey: string
  locktime: number
  nowMs: number
  couponExpiresAtMs: number | null
}): GiftLock | { problem: CodeLockProblem } {
  const lock = input.shopKey.toLowerCase()
  const refund = input.refundPubkey?.toLowerCase() ?? null
  if (refund === null) return { problem: 'no_refund_key' }
  if (!XONLY.test(lock) || !XONLY.test(refund)) return { problem: 'malformed_key' }
  if (refund === lock) return { problem: 'refund_is_lock_key' }
  if (refund === input.depositorPubkey.toLowerCase()) return { problem: 'refund_is_depositor' }
  const expiresAt = input.couponExpiresAtMs === null ? undefined : Math.floor(input.couponExpiresAtMs / 1000)
  const problem = lockWindowProblem(input.locktime, expiresAt, Math.floor(input.nowMs / 1000))
  if (problem !== null) return { problem }
  return { lockPubkey: lock, refundPubkey: refund, locktime: input.locktime }
}

/**
 * Null when the token is a valid code part (contract §2) for `lock`, otherwise why not. On top of
 * {@link verifyLockedGift} (lock S, refund R, x, SIG_ALL, no `pubkeys`, never open after x), every
 * proof must carry `n_sigs 1` explicitly, as the store's `StructuralPartVerifier.rawShape` asks.
 */
export function verifyCodePart(token: string, lock: GiftLock): string | null {
  const wrong = verifyLockedGift(token, lock)
  if (wrong !== null) return wrong
  for (const secret of proofSecrets(token)) {
    const tags = (JSON.parse(secret) as [string, { tags?: unknown[][] }])[1]?.tags ?? []
    const nSigs = tags.filter((t) => Array.isArray(t) && t[0] === 'n_sigs')
    if (nSigs.length !== 1 || nSigs[0].length !== 2 || nSigs[0][1] !== '1') return 'a minted proof does not carry n_sigs 1'
  }
  return null
}

/** The part's amount, as the store checks it: its credited face value. */
export function partAmount(token: string): number {
  return creditableFaceValue(parseVoucherToken(token)).faceValue
}

export function depositBody(input: { draftId: string; stallPubkey: string; lock: GiftLock; unit: string; tokens: string[] }): DepositBody {
  const parts = input.tokens.map((token) => ({ token, amount: partAmount(token) }))
  return {
    idempotency_key: `${input.draftId}:code`,
    stall_pubkey: input.stallPubkey.toLowerCase(),
    shop_key: input.lock.lockPubkey,
    unit: input.unit.toLowerCase(),
    amount: parts.reduce((n, p) => n + p.amount, 0),
    expires_at: input.lock.locktime,
    parts,
  }
}

/** `IMANIXXXXXXXXXXXX` (contract §1, compact), or null when the store's answer is not a code. */
export function canonicalCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const squeezed = raw.toUpperCase().replace(/[ \t\-_.]/g, '')
  return /^IMANI[0-9A-HJKMNP-TV-Z]{12}$/.test(squeezed) ? squeezed : null
}

/** `IMANI-XXXX-XXXX-XXXX`, as the recipient types it. */
export function displayCode(canonical: string): string {
  const b = canonical.slice(5)
  return `IMANI-${b.slice(0, 4)}-${b.slice(4, 8)}-${b.slice(8, 12)}`
}

export type DepositResult = { ok: true; code: string; amount: number } | ({ ok: false } & Extract<StepResult, { ok: false }>)

/**
 * Deposit the parts. A replay of the same key answers the same code. 409 (MINT_UNAVAILABLE and the
 * like), 429, 5xx and unreachable stay pending; `DUPLICATE_PART` too (the parts are locked to S
 * with refunds to this gift's R, so the code they back is this deposit's own and the same body
 * replays it). Any other 4xx refusal is permanent: parked for a person.
 */
export async function depositCode(ports: CodeGiftPorts, signer: Uint8Array, body: DepositBody): Promise<DepositResult> {
  const answer = await ports.deposit(signer, body)
  const code = canonicalCode(answer.body?.code)
  if ((answer.status === 200 || answer.status === 201) && code !== null) return { ok: true, code, amount: body.amount }
  const refusal = typeof answer.body?.refusal === 'string' ? answer.body.refusal.slice(0, 60) : `HTTP_${answer.status}`
  if (answer.status === 0 || answer.status === 409 || answer.status === 429 || answer.status >= 500 || refusal === 'DUPLICATE_PART') {
    return { ok: false, reason: `the code store did not take the deposit yet: ${refusal}`, permanent: false }
  }
  if (answer.status === 200 || answer.status === 201) {
    return { ok: false, reason: 'the code store answered with no readable code', permanent: false }
  }
  return { ok: false, reason: `the code store refused the deposit: ${refusal}`, permanent: true }
}

/** The recipient's balance link (`GET /v1/code-check/{code}`, public, no NIP-98). */
export function balanceUrl(publicBaseUrl: string, code: string): string {
  return `${publicBaseUrl.trim().replace(/\/+$/, '')}${CODE_CHECK_PATH}/${encodeURIComponent(code)}`
}

// ─── HTTP adapters ──────────────────────────────────────────────────────────

function nip98(key: Uint8Array, url: string, method: string, body: string): string {
  const event = finalizeEvent(
    {
      kind: 27235,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['u', url],
        ['method', method],
        ['payload', bytesToHex(sha256(new TextEncoder().encode(body)))],
        ['nonce', bytesToHex(randomBytes(16))],
      ],
      content: '',
    },
    key,
  )
  return `Nostr ${btoa(JSON.stringify(event))}`
}

const trim = (u: string) => u.trim().replace(/\/+$/, '')

/** `deposit` against imani-checkout-codes. */
export function httpDeposit(storeUrl: string, fetchImpl: typeof fetch = fetch) {
  return async (signer: Uint8Array, body: DepositBody): Promise<StoreAnswer> => {
    const url = `${trim(storeUrl)}${CHECKOUT_CODES_PATH}`
    const text = JSON.stringify(body)
    try {
      const r = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: nip98(signer, url, 'POST', text) },
        body: text,
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
      })
      let json: Record<string, unknown> | null = null
      try {
        json = (await r.json()) as Record<string, unknown>
      } catch {
        json = null
      }
      return { status: r.status, body: json }
    } catch {
      return { status: 0, body: null }
    }
  }
}

/** What `/v1/code-check/{code}` tells a holder (contract, imani-checkout-codes 0.3.0). */
export interface CodeCheck {
  status: 'active' | 'in_use' | 'used' | 'expired'
  remaining: number
}

/** `GET /v1/code-check/{code}`. Throws for anything but a well-formed 200. */
export function httpCodeCheck(storeUrl: string, fetchImpl: typeof fetch = fetch) {
  return async (code: string): Promise<CodeCheck> => {
    const r = await fetchImpl(`${trim(storeUrl)}${CODE_CHECK_PATH}/${encodeURIComponent(code)}`, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    })
    if (r.status !== 200) throw new Error(`code-check answered ${r.status}`)
    const json = (await r.json()) as Record<string, unknown>
    const status = json.status
    const remaining = json.remaining
    if (
      (status !== 'active' && status !== 'in_use' && status !== 'used' && status !== 'expired') ||
      typeof remaining !== 'number' ||
      !Number.isSafeInteger(remaining) ||
      remaining < 0
    ) {
      throw new Error('code-check answer is malformed')
    }
    return { status, remaining }
  }
}

/** The issuer's depositor key: the public key of its seal key. */
export const depositorOf = (sealSecretHex: string): string => getPublicKey(hexToBytes(sealSecretHex))
