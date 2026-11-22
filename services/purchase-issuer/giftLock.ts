/**
 * The pure parts of delivering a gifting-site gift locked with a refund (#410 §4b, §4c, G4, G7, G11).
 *
 * What is HERE, tested, and used by the issuer:
 * - `claimWindowEnd`: x = 30 days (the draft's window), capped by the voucher's expiry minus 24 h.
 * - `openSeal`: the sealed link secret ℓ, opened with this issuer's key, and REFUSED unless it was
 *   sealed for this very purchase (stall, amount, recipient address). Never logged.
 * - `claimEmail`: the recipient's claim email, with ℓ only in the URL fragment (G-R4).
 *
 * - `giftLockFor` / `verifyLockedGift`: G14 (ADR 0016). The voucher is MINTED locked by
 *   gateway-customer (`link_lock` on the issuance request): lock key = the recipient's pinned key
 *   (handle) or getPublicKey(ℓ) (email), refund = the buyer's key, locktime = x. Nothing is burnt
 *   or re-locked, and no refund is deposited at a relay: after x the buyer takes it back.
 *   The minted token is checked proof by proof before anyone is handed it.
 * - `giftSentRumor`: what the buyer is handed after delivery, so they can take it back after x.
 */
import { nip17, nip44, getPublicKey } from 'nostr-tools'
import { hexToBytes } from '@noble/hashes/utils'

import { assertNotOpenAfterLocktime, readLinkLock } from '../../src/lib/cashlinkLock'
import { proofSecrets } from '../../src/lib/voucherToken'

export const DAY_MS = 86_400_000

/**
 * The wallet's gift link, `<origin>/g#v=1&k=<ℓ base64url>&x=<x>`: byte for byte
 * `src/lib/giftLink.ts` `formatGiftLink` (pinned by a test). Not imported: that module pulls the
 * browser signer (`./nap`) and Vite's `import.meta.env` into a Node service.
 */
export function formatGiftLink(walletOrigin: string, secret: Uint8Array, expiresAt: number): string | null {
  let origin: string
  try {
    const url = new URL(walletOrigin)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    origin = url.origin
  } catch {
    return null
  }
  if (!Number.isSafeInteger(expiresAt) || !/^[0-9]{9,11}$/.test(String(expiresAt)) || secret.length !== 32) return null
  const k = Buffer.from(secret).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${origin}/g#v=1&k=${k}&x=${expiresAt}`
}

/** `src/lib/cashlinkFlow.ts` `wrapForLink`, for the same reason (pinned by a test). */
export function wrapForLink(linkSecret: Uint8Array, token: string) {
  return nip17.wrapEvent(linkSecret, { publicKey: getPublicKey(linkSecret) }, linkWrapContent(token))
}

/** The rumor content of a link wrap, for the size budget (#532). */
export function linkWrapContent(token: string): string {
  return JSON.stringify({ type: 'cashu_token_transfer', token })
}

/** G17: the longest a gift waits to be claimed, whatever the draft asks for. */
export const MAX_CLAIM_WINDOW_DAYS = 14

/**
 * G11 + G17: the end of the claim window. Half the voucher's validity, and never more than
 * {@link MAX_CLAIM_WINDOW_DAYS} (nor more than `windowDays`), so a gift taken back unclaimed still
 * has at least half its life left to be spent: the voucher keeps its original expiry. `expiresAtMs`
 * null means the voucher never expires, and then only the day cap applies.
 */
export function claimWindowEnd(mintedAtMs: number, windowDays: number, expiresAtMs: number | null): number {
  const window = mintedAtMs + Math.min(windowDays, MAX_CLAIM_WINDOW_DAYS) * DAY_MS
  if (expiresAtMs === null) return window
  return Math.min(window, mintedAtMs + Math.floor((expiresAtMs - mintedAtMs) / 2))
}

/** True when the window is too short to be worth arming (expiry within a day of minting). */
export function windowTooShort(mintedAtMs: number, end: number): boolean {
  return end - mintedAtMs < DAY_MS
}

export class SealRefused extends Error {}

export interface SealBinding {
  stallPubkey: string
  amountMinor: number
  /** The recipient email (lower case) this seal may be used for. */
  recipient: string
}

/**
 * Open the gift's sealed link secret. Throws `SealRefused` for anything that is not a seal made
 * for THIS purchase, so a seal lifted from one draft cannot arm another (and the error never
 * carries the plaintext).
 */
export function openSeal(issuerSecretHex: string, sealed: string, expected: SealBinding): { linkSecret: string } {
  const [prefix, ephPub, payload] = sealed.split('.')
  if (prefix !== 'v1' || !/^[0-9a-f]{64}$/.test(ephPub ?? '') || !payload) throw new SealRefused('not a gift seal')
  let opened: Record<string, unknown>
  try {
    const key = nip44.v2.utils.getConversationKey(hexToBytes(issuerSecretHex), ephPub)
    opened = JSON.parse(nip44.v2.decrypt(payload, key)) as Record<string, unknown>
  } catch {
    throw new SealRefused('the seal does not open with this issuer key')
  }
  if (
    opened.stallPubkey !== expected.stallPubkey ||
    opened.amountMinor !== expected.amountMinor ||
    typeof opened.recipient !== 'string' ||
    opened.recipient !== expected.recipient.toLowerCase()
  ) {
    throw new SealRefused('the seal was made for another purchase')
  }
  const linkSecret = opened.linkSecret
  if (typeof linkSecret !== 'string' || !/^[0-9a-f]{64}$/.test(linkSecret)) throw new SealRefused('the seal holds no link secret')
  // A secret that is not a valid key would arm a lock nobody can open.
  getPublicKey(hexToBytes(linkSecret))
  return { linkSecret }
}

/** What the issuance request carries for a gift (contract §1). All keys x-only, lower case. */
export interface GiftLock {
  /** The key the voucher is locked to: the handle's pinned key, or getPublicKey(ℓ). */
  lockPubkey: string
  /** The buyer's key: their wallet key, or a guest's R. */
  refundPubkey: string
  /** x, unix seconds. */
  locktime: number
}

export type GiftLockProblem = 'window_too_short' | 'no_refund_key' | 'refund_is_lock_key' | 'malformed_key'

const XONLY = /^[0-9a-f]{64}$/

/**
 * The lock for a gift, or why it cannot be minted. Checked BEFORE minting: a gift that cannot be
 * locked is never minted at all (a plain one would be anyone-who-reads-it's money).
 */
export function giftLockFor(input: {
  lockPubkey: string
  refundPubkey: string | null
  mintedAtMs: number
  nowMs: number
  claimWindowDays: number
  couponExpiresAtMs: number | null
  /**
   * TEST MODE ONLY (`PURCHASE_TEST_CLAIM_WINDOW_SECONDS`, refused in live mode): a claim window in
   * seconds instead of days, so an end-to-end test can watch it end and the buyer take the gift
   * back. Skips the one-day minimum; the gateway still applies its own lead.
   */
  testWindowSeconds?: number | null
}): GiftLock | { problem: GiftLockProblem } {
  const lock = input.lockPubkey.toLowerCase()
  const refund = input.refundPubkey?.toLowerCase() ?? null
  if (refund === null) return { problem: 'no_refund_key' }
  if (!XONLY.test(lock) || !XONLY.test(refund)) return { problem: 'malformed_key' }
  if (refund === lock) return { problem: 'refund_is_lock_key' }
  if (input.testWindowSeconds) {
    return { lockPubkey: lock, refundPubkey: refund, locktime: Math.floor(input.mintedAtMs / 1000) + input.testWindowSeconds }
  }
  const end = claimWindowEnd(input.mintedAtMs, input.claimWindowDays, input.couponExpiresAtMs)
  // Measured from NOW: a retry days after the payment must still leave the recipient a real window.
  if (windowTooShort(input.nowMs, end)) return { problem: 'window_too_short' }
  return { lockPubkey: lock, refundPubkey: refund, locktime: Math.floor(end / 1000) }
}

/**
 * Null when EVERY proof of `token` is locked exactly as asked (lock key, refund key, x), and never
 * open to anyone after x; otherwise why not. A token that fails this is never delivered.
 */
export function verifyLockedGift(token: string, lock: GiftLock): string | null {
  let secrets: string[]
  try {
    secrets = proofSecrets(token)
  } catch {
    return 'the minted token could not be read'
  }
  if (secrets.length === 0) return 'the minted token has no proofs'
  for (const secret of secrets) {
    try {
      assertNotOpenAfterLocktime(secret)
    } catch {
      return 'a minted proof is open to anyone after its locktime'
    }
    const read = readLinkLock(secret)
    if (read === null) return 'a minted proof is not link-locked'
    if (read.linkPub !== lock.lockPubkey) return 'a minted proof is locked to another key'
    if (read.refundPub !== lock.refundPubkey) return 'a minted proof refunds to another key'
    if (read.locktime !== lock.locktime) return 'a minted proof has another locktime'
  }
  return null
}

/** The buyer's copy of the locked gift (contract §3 "Buyer take-back"), as rumor content. */
export function giftSentRumor(input: { token: string; stall: string; to: string | null; claimBy: number; gift?: 'code' }): string {
  // #410: a code gift's part sits at the code store and may be replaced by balance successors, so the
  // return page reads `/v1/checkout-codes/mine` as R for it rather than settle this token alone.
  return JSON.stringify({ type: 'imani_gift_sent', v: 1, token: input.token, stall: input.stall, to: input.to, claimBy: input.claimBy, ...(input.gift ? { gift: input.gift } : {}) })
}

export interface ClaimEmail {
  to: string
  subject: string
  text: string
  /** The claim URL, for the mailer's template. Contains ℓ in the fragment only. */
  claimUrl: string
}

/** The recipient's email (#410 §4c.3). No secret in the subject or preview text. */
export function claimEmail(input: {
  to: string
  walletOrigin: string
  linkSecret: string
  stallName: string
  amount: string
  claimBy: Date
  from: string | null
  message: string | null
}): ClaimEmail {
  // The wallet's own gift-link format (`/g#v=1&k=…&x=…`), the page that claims a locked gift.
  const claimUrl = formatGiftLink(input.walletOrigin, hexToBytes(input.linkSecret), Math.floor(input.claimBy.getTime() / 1000))
  if (claimUrl === null) throw new Error('the claim link could not be built (wallet origin or claim date malformed)')
  const who = input.from?.trim() || 'Someone'
  const lines = [
    `${who} sent you a ${input.amount} voucher for ${input.stallName}.`,
    ...(input.message ? ['', input.message] : []),
    '',
    `Claim it by ${input.claimBy.toUTCString().slice(0, 16)}:`,
    claimUrl,
    '',
    'Open the link, create or open an Imani wallet, and tap Claim.',
    "Anyone with this link can claim it. Don't forward it. Imani never asks for card details or passwords.",
  ]
  return { to: input.to, subject: `${who} sent you a voucher for ${input.stallName}`, text: lines.join('\n'), claimUrl }
}
