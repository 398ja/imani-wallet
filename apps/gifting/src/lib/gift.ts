/**
 * The secrets of an email gift, made in this browser at review time (#410 §4c, G3, G4).
 *
 * - `ℓ` (link secret): the claim key of an email gift. Never shown to the buyer (G8). Sealed to
 *   the Purchase Issuer's key so delivery can run from the Stripe webhook with the tab gone (G4).
 * - `R` (refund secret): a fresh key whose pubkey is the gift's refund key, for every buyer (the
 *   site is public, so every buyer is a guest). The buyer gets it back as the "return link".
 *
 * Sealing is NIP-44 v2 from a one-off key to the issuer's key, framed `v1.<ephemeralPub>.<payload>`.
 * The plaintext names what it is for (stall, amount, recipient), so the issuer refuses to use a
 * seal lifted from one purchase in another.
 */
import { bytesToHex } from '@noble/hashes/utils'
import { generateSecretKey, getPublicKey, nip44 } from 'nostr-tools'

export interface GiftSecrets {
  /** hex. */
  linkSecret: string
  /** hex; guests only. */
  refundSecret?: string
  refundPubkey: string
}

export interface SealBinding {
  stallPubkey: string
  amountMinor: number
  /** The recipient email or pubkey the seal may be used for. */
  recipient: string
}

/**
 * Every gift goes to an email, so every gift has a link secret. The site is public (owner,
 * 2026-11-05), so every buyer is a guest: R is always a fresh key, never an identity key, and comes
 * back to the buyer as the return link.
 */
export function newGiftSecrets(): GiftSecrets & { refundSecret: string } {
  const linkSecret = bytesToHex(generateSecretKey())
  const r = generateSecretKey()
  return { linkSecret, refundSecret: bytesToHex(r), refundPubkey: getPublicKey(r) }
}

export const SEAL_PREFIX = 'v1'

/** Seal `secrets` to the issuer. `issuerPubkey` is hex (x-only). */
export function seal(issuerPubkey: string, binding: SealBinding, secrets: Record<string, string>): string {
  const eph = generateSecretKey()
  const key = nip44.v2.utils.getConversationKey(eph, issuerPubkey)
  const payload = nip44.v2.encrypt(JSON.stringify({ ...binding, ...secrets }), key)
  return `${SEAL_PREFIX}.${getPublicKey(eph)}.${payload}`
}

/** The issuer's side, shared so both ends agree on the frame. */
export function unseal(issuerSecret: Uint8Array, sealed: string): SealBinding & Record<string, unknown> {
  const [prefix, ephPub, payload] = sealed.split('.')
  if (prefix !== SEAL_PREFIX || !/^[0-9a-f]{64}$/.test(ephPub ?? '') || !payload) throw new Error('not a gift seal')
  const key = nip44.v2.utils.getConversationKey(issuerSecret, ephPub)
  return JSON.parse(nip44.v2.decrypt(payload, key)) as SealBinding & Record<string, unknown>
}

/** The guest's return link (option D): opens the wallet, which takes the gift back with `R`. */
export function returnLink(walletOrigin: string, refundSecret: string): string {
  return `${walletOrigin.replace(/\/+$/, '')}/gift-return#r=${refundSecret}`
}
