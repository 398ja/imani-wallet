/**
 * Gifts minted already locked (#410 G14, ADR 0016). The gifting site's Purchase Issuer mints the
 * gift as `P2PK_VOUCHER` proofs whose `readLinkLock` is `{linkPub: lock key, refundPub: R, x}`.
 * There is no relay deposit: the buyer takes an unclaimed gift back after `x` with `R` itself.
 *
 * Three roles, one module:
 *
 * - **Recipient by handle**: the lock key is this wallet's own key. The gift arrives as a
 *   `cashu_token_transfer` DM and is CLAIMED (link key's way, signed with the wallet key) into an
 *   unlocked coupon. Until then it is a pending gift row, never balance. A remote-signer account
 *   that cannot lend its key keeps it pending ("Claim by <date>") and claims when it can.
 * - **Signed-in buyer**: `R` is this wallet's key. The issuer sends an `imani_gift_sent` DM with the
 *   locked token; it is filed as an OUTGOING gift row (not balance) and, after `x`, taken back if
 *   still unspent (the refund key's way, no relay), then re-formed into an unlocked coupon.
 * - **Guest buyer**: the `/gift-return` page, with `R` from its fragment, does the same take-back.
 *
 * Nothing here logs a token or a key.
 */
import { assertNotOpenAfterLocktime, isOpenAfterLocktime, readLinkLock, secretHash, xOnlyPub } from './cashlinkLock'
import { claimLockedGift, OWN_KEY_CLAIM, settleLockedGift, type CashlinkPorts, type ReturnOutcome } from './cashlinkFlow'
import type { ProofState } from './giftLink'
import { checkTokenBacking } from './trustedMint'
import { creditableFaceValue, parseVoucherToken, tokenProofs, verifyVoucher } from './voucherToken'
import { lockedGiftMemo, type LockedGiftRecord } from './lockedGiftRecord'
import { encodePlainTokenV4 } from './plainToken'

export const GIFT_SENT_TYPE = 'imani_gift_sent'

export interface GiftSentMessage {
  type: typeof GIFT_SENT_TYPE
  v: 1
  token: string
  stall: string
  /** The recipient's email for an email gift, null for a handle gift. Never a key. */
  to: string | null
  claimBy: number
  /**
   * #410: `code` when the gift is a checkout code. Its parts sit at the code store and may have been
   * replaced by balance successors, so the return page reads the code's parts rather than `token`.
   */
  gift?: 'code'
}

/** The `imani_gift_sent` rumor content, or null for anything else. */
export function parseGiftSent(content: string): GiftSentMessage | null {
  let m: Record<string, unknown>
  try {
    m = JSON.parse(content) as Record<string, unknown>
  } catch {
    return null
  }
  if (!m || m.type !== GIFT_SENT_TYPE || m.v !== 1 || typeof m.token !== 'string') return null
  if (typeof m.claimBy !== 'number' || !Number.isSafeInteger(m.claimBy) || m.claimBy <= 0) return null
  const to = typeof m.to === 'string' && m.to.trim() !== '' && !/^[0-9a-f]{64}$/i.test(m.to) && !/^npub1/i.test(m.to) ? m.to.trim() : null
  return {
    type: GIFT_SENT_TYPE,
    v: 1,
    token: m.token,
    stall: typeof m.stall === 'string' ? m.stall.slice(0, 80) : '',
    to,
    claimBy: m.claimBy,
    ...(m.gift === 'code' ? { gift: 'code' as const } : {}),
  }
}

export type LockedRefusal = 'unreadable' | 'not_locked' | 'open_after_locktime' | 'wrong_key' | 'bad_signature' | 'untrusted_mint' | 'wrong_issuer'

/**
 * Whether a token is a minted-locked gift this wallet may act on, as `role`: every proof is the exact
 * link-lock shape (never open after its locktime), its key for that role is `ownPub`, all proofs
 * share one lock, the voucher issuer's signature verifies, and the mint is trusted.
 */
export function checkLockedGift(
  token: string,
  role: 'lock' | 'refund',
  ownPub: string,
  backing: (token: string) => { outcome: string } = checkTokenBacking,
): { ok: true; x: number; linkPub: string; refundPub: string } | { ok: false; why: LockedRefusal } {
  let proofs
  try {
    proofs = tokenProofs(token)
  } catch {
    return { ok: false, why: 'unreadable' }
  }
  if (proofs.length === 0) return { ok: false, why: 'unreadable' }
  // The hazard first, whatever else is wrong with it: a locktime with no refund key.
  if (proofs.some((p) => isOpenAfterLocktime(p.secret))) return { ok: false, why: 'open_after_locktime' }
  let parsed
  try {
    parsed = parseVoucherToken(token)
  } catch {
    return { ok: false, why: 'unreadable' }
  }
  const locks = proofs.map((p) => readLinkLock(p.secret))
  if (locks.some((l) => !l)) return { ok: false, why: 'not_locked' }
  const first = locks[0]!
  if (locks.some((l) => l!.linkPub !== first.linkPub || l!.refundPub !== first.refundPub || l!.locktime !== first.locktime)) {
    return { ok: false, why: 'not_locked' }
  }
  const mine = (role === 'lock' ? first.linkPub : first.refundPub).toLowerCase() === ownPub.toLowerCase()
  if (!mine) return { ok: false, why: 'wrong_key' }
  for (const p of proofs) {
    try {
      const one = parseVoucherToken(encodeOne(token, p))
      if (!verifyVoucher(one.voucher).signatureValid) return { ok: false, why: 'bad_signature' }
    } catch {
      return { ok: false, why: 'bad_signature' }
    }
  }
  if (!verifyVoucher(parsed.voucher).signatureValid) return { ok: false, why: 'bad_signature' }
  if (backing(token).outcome !== 'accept') return { ok: false, why: 'untrusted_mint' }
  return { ok: true, x: first.locktime, linkPub: first.linkPub, refundPub: first.refundPub }
}

// One proof's own token, so each proof's signature is checked, not only the first's.
function encodeOne(token: string, p: ReturnType<typeof tokenProofs>[number]): string {
  const mintUrl = parseVoucherToken(token).mintUrl
  return encodePlainTokenV4(mintUrl, 'sat', [{ amount: p.amount, id: p.id, secret: p.secret, C: p.C, ...(p.dleq ? { dleq: p.dleq } : {}) } as never])
}

/**
 * An `imani_gift_sent` DM, accepted only when every proof's refund key is `ownPub`, the voucher
 * signatures verify, the mint is trusted and (when the issuer's seal key is known) the seal is the
 * issuer's. `sealAuthor` is the verified seal author, never the unauthenticated rumor pubkey.
 */
export function acceptGiftSent(
  msg: GiftSentMessage,
  ownPub: string,
  sealAuthor: string | undefined,
  issuerKey: string | null,
  backing?: (token: string) => { outcome: string },
): { ok: true; x: number } | { ok: false; why: LockedRefusal } {
  if (!sealAuthor || (issuerKey && sealAuthor.toLowerCase() !== issuerKey.toLowerCase())) return { ok: false, why: 'wrong_issuer' }
  const c = checkLockedGift(msg.token, 'refund', ownPub, backing)
  if (!c.ok) return c
  return { ok: true, x: c.x }
}

// --- Records -----------------------------------------------------------------

export { asLockedGiftRecord, lockedGiftMemo, type LockedGiftRecord, type LockedGiftStatus } from './lockedGiftRecord'

export const lockedGiftRowId = (dir: 'in' | 'out', token: string): string => `locked-gift:${dir}:${secretHash(tokenProofs(token)[0].secret).slice(0, 32)}`

/** The history row for a gift (not a balance: no voucher row exists for it until it is claimed). */
export function lockedGiftRow(rec: LockedGiftRecord, nowMs: number): Record<string, unknown> {
  const parsed = parseVoucherToken(rec.token)
  const v = parsed.voucher
  const issuer = (/^[0-9a-f]{64}$/i.test(v.issuerId ?? '') ? v.issuerId : v.issuerPublicKey).toLowerCase()
  const id = lockedGiftRowId(rec.dir, rec.token)
  return {
    id,
    txId: id,
    type: rec.dir === 'out' ? 'gift_sent' : 'gift_pending',
    direction: rec.dir,
    timestamp: nowMs,
    amount: creditableFaceValue(parsed).faceValue,
    unit: v.unit,
    decimals: v.faceDecimals,
    merchantId: issuer,
    merchantName: rec.stall || null,
    // No voucherId ON PURPOSE: an `in` row with one would count towards that voucher's redemption
    // ceiling, and this row is not a redemption.
    lockedGift: rec,
    memo: lockedGiftMemo(rec),
  }
}

// --- Acting ------------------------------------------------------------------

/** Take an unclaimed gift back with the refund key (no link key, no relay). Never throws. */
export function takeBackLockedGift(ports: CashlinkPorts, refundSecret: Uint8Array, token: string, onReturning: () => Promise<void> = async () => {}): Promise<ReturnOutcome> {
  return settleLockedGift({ ports, refundSecret, lockedToken: token, noRelay: true, onReturning })
}

export type IncomingOutcome = 'claimed' | 'waiting' | 'gone'

/**
 * One run for a gift locked to this wallet's own key. `ownKey` lends the key (null: a remote
 * signer that cannot, so it waits). Claims whenever the proofs are unspent, even after `x` (until
 * the buyer takes it back the lock key still spends it). Spent and not by us: gone.
 */
export async function settleIncoming(ports: CashlinkPorts, pubkey: string, token: string, ownKey: () => Uint8Array | null): Promise<IncomingOutcome> {
  for (const p of tokenProofs(token)) assertNotOpenAfterLocktime(p.secret)
  const key = ownKey()
  if (!key) return 'waiting'
  try {
    if (xOnlyPub(key) !== readLinkLock(tokenProofs(token)[0].secret)?.linkPub) return 'waiting'
    const out = await claimLockedGift({ ports, pubkey, linkSecret: key, k: OWN_KEY_CLAIM, lockedTokens: [{ token, sentAt: 0 }] })
    if (out.kind === 'ok') return 'claimed'
    if (out.kind === 'claimed') return 'gone'
    return 'waiting'
  } finally {
    key.fill(0)
  }
}

/** The gift's state for the return page and the buyer: by NUT-07 and the clock. */
export type ReturnState = 'claimed' | 'waiting' | 'ready' | 'unknown'

export function returnStateOf(states: ProofState[], x: number, nowMs: number): ReturnState {
  if (states.length === 0 || states.some((s) => s === 'UNKNOWN' || s === 'PENDING')) return 'unknown'
  if (states.every((s) => s === 'SPENT')) return 'claimed'
  return nowMs / 1000 >= x ? 'ready' : 'waiting'
}

/** `#r=<64 hex>&t=<token>` (t optional). R is returned as bytes and never kept elsewhere. */
export function parseReturnFragment(hash: string): { r: Uint8Array; t?: string } | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''))
  const r = params.get('r') ?? ''
  if (!/^[0-9a-f]{64}$/i.test(r)) return null
  const bytes = new Uint8Array(32)
  for (let n = 0; n < 32; n++) bytes[n] = parseInt(r.slice(n * 2, n * 2 + 2), 16)
  if (bytes.every((b) => b === 0)) return null
  const t = params.get('t') ?? undefined
  return { r: bytes, ...(t ? { t } : {}) }
}

// --- #410 code gifts: the return page reads the code's parts as R --------------

/** One of R's codes, from the store's `GET /v1/checkout-codes/mine` (contract). */
export interface ReturnCode {
  code: string
  status: string
  /** What was deposited and what is left now, minor units. */
  amount: number
  remaining: number
  unit: string
  expiresAt: number
  /** S, x-only lower case. */
  shopKey: string
}

/** The rows of `/mine` that are well formed. Anything else is skipped, never guessed. */
export function parseMineCodes(body: unknown): ReturnCode[] {
  if (!Array.isArray(body)) return []
  const out: ReturnCode[] = []
  for (const row of body as Array<Record<string, unknown>>) {
    if (!row || typeof row !== 'object') continue
    const { code, status, amount, remaining, unit, expires_at: expiresAt, shop_key: shopKey } = row
    if (typeof shopKey !== 'string' || !/^[0-9a-f]{64}$/i.test(shopKey)) continue
    if (typeof code !== 'string' || !/^IMANI[0-9A-Z]{12}$/.test(code.replace(/-/g, ''))) continue
    if (typeof status !== 'string' || typeof unit !== 'string') continue
    if (![amount, remaining, expiresAt].every((n) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0)) continue
    out.push({ code: code.replace(/-/g, ''), status, amount: amount as number, remaining: remaining as number, unit, expiresAt: expiresAt as number, shopKey: shopKey.toLowerCase() })
  }
  return out
}

/** The tokens of `/{code}/parts` (`{"parts":[{"idx","token","amount"}]}`), unchecked. */
export function parsePartTokens(body: unknown): string[] {
  const parts = (body as { parts?: unknown } | null)?.parts
  if (!Array.isArray(parts)) return []
  return parts.map((p) => (p as { token?: unknown })?.token).filter((t): t is string => typeof t === 'string' && t.startsWith('cashuB'))
}

/** A code gift's state for the return page: by the store's answer and the clock. */
export type CodeReturnState = 'used' | 'waiting' | 'ready' | 'returned'

export function codeReturnStateOf(code: Pick<ReturnCode, 'remaining' | 'expiresAt' | 'status'>, unspentParts: number, nowMs: number): CodeReturnState {
  if (nowMs / 1000 < code.expiresAt) return code.remaining === 0 && code.status === 'redeemed' ? 'used' : 'waiting'
  if (unspentParts > 0) return 'ready'
  return code.remaining === 0 && code.status === 'redeemed' ? 'used' : 'returned'
}
