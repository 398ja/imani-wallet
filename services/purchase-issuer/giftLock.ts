/**
 * The pure parts of delivering a gifting-site gift locked with a refund (#410 §4b, §4c, G4, G7, G11).
 *
 * What is HERE, tested, and used by the issuer:
 * - `claimWindowEnd`: x = 30 days (the draft's window), capped by the voucher's expiry minus 24 h.
 * - `openSeal`: the sealed link secret ℓ, opened with this issuer's key, and REFUSED unless it was
 *   sealed for this very purchase (stall, amount, recipient address). Never logged.
 * - `claimEmail`: the recipient's claim email, with ℓ only in the URL fragment (G-R4).
 *
 * What is NOT here yet: arming itself (lock the minted voucher to the recipient key or to ℓ's
 * public key with refund = [R] and locktime x, and deposit the pre-signed refund at the relay).
 * The wallet arms with `cashlinkFlow.armGift`, whose lock route authorises the lock with the
 * REFUND key's signature; a server that does not hold R (and must not, G-R3) needs the
 * issuer-authorised lock from #366. Until that lands, `discharge.ts` blocks handle and email gifts
 * before minting and payment-adapter does not sell them (`purchase.gifting.kinds`).
 */
import { nip44, getPublicKey } from 'nostr-tools'
import { hexToBytes } from '@noble/hashes/utils'

export const DAY_MS = 86_400_000

/** G11: the end of the claim window. `expiresAtMs` null means the voucher never expires. */
export function claimWindowEnd(mintedAtMs: number, windowDays: number, expiresAtMs: number | null): number {
  const window = mintedAtMs + windowDays * DAY_MS
  return expiresAtMs === null ? window : Math.min(window, expiresAtMs - DAY_MS)
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
  const claimUrl = `${input.walletOrigin.replace(/\/+$/, '')}/claim#${input.linkSecret}`
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
