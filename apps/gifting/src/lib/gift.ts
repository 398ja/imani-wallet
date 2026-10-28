/**
 * The secrets of an email or handle gift, made in this browser at review time (#410 §4c, G3, G4).
 *
 * - `ℓ` (link secret): the claim key of an email gift. Never shown to the buyer (G8). Sealed to
 *   the Purchase Issuer's key so delivery can run from the Stripe webhook with the tab gone (G4).
 * - `R` (refund secret): for a GUEST, a fresh key whose pubkey is the gift's refund key. The
 *   buyer gets it back as the "return link" (option D). For a SIGNED-IN buyer the refund key is the
 *   wallet's own pubkey (option A), so nothing is generated.
 *
 * Sealing is NIP-44 v2 from a one-off key to the issuer's key, framed `v1.<ephemeralPub>.<payload>`.
 * The plaintext names what it is for (stall, amount, recipient), so the issuer refuses to use a
 * seal lifted from one purchase in another.
 */
import { bytesToHex } from '@noble/hashes/utils'
import { generateSecretKey, getPublicKey, nip44 } from 'nostr-tools'

export interface GiftSecrets {
  /** hex; email gifts only. */
  linkSecret?: string
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

export function newGiftSecrets(kind: 'self' | 'handle' | 'email', buyerPubkey: string | null): GiftSecrets {
  const linkSecret = kind === 'email' ? bytesToHex(generateSecretKey()) : undefined
  if (buyerPubkey) return { linkSecret, refundPubkey: buyerPubkey }
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
