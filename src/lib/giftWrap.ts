/**
 * NIP-17 / NIP-59 gift wrap and unwrap, with no wallet dependencies, so a service image can use the
 * exact code the wallet reads with (subscription service, #407).
 *
 * `unwrapSealed` checks what `nostr-tools`' `unwrapEvent` does not: the seal's signature, and that
 * the seal and the rumor name the same author. So `sealer` is a fact rather than a claim.
 */
import { finalizeEvent, getPublicKey, nip44, verifyEvent, type Event } from 'nostr-tools'

export interface Rumor {
  kind: number
  pubkey: string
  created_at: number
  content: string
  tags: string[][]
}

/** Gift-wrap a kind-14 message from `senderKey` to `recipient` (NIP-17, NIP-59). */
export function wrapMessage(senderKey: Uint8Array, recipient: string, content: string): Event {
  const sender = getPublicKey(senderKey)
  const now = Math.floor(Date.now() / 1000)
  const rumor = { kind: 14, pubkey: sender, created_at: now, content, tags: [['p', recipient]] }
  const seal = finalizeEvent(
    {
      kind: 13,
      // NIP-59 tweaks `created_at` to blur timing. Kept within the 24-hour
      // window the device enforces, which it reads from the RUMOR anyway.
      created_at: now - Math.floor(Math.random() * 600),
      tags: [],
      content: nip44.encrypt(JSON.stringify(rumor), nip44.getConversationKey(senderKey, recipient)),
    },
    senderKey,
  )
  const throwaway = crypto.getRandomValues(new Uint8Array(32))
  return finalizeEvent(
    {
      kind: 1059,
      created_at: now - Math.floor(Math.random() * 600),
      tags: [['p', recipient]],
      content: nip44.encrypt(JSON.stringify(seal), nip44.getConversationKey(throwaway, recipient)),
    },
    throwaway,
  )
}

/**
 * Unwrap a NIP-17 gift wrap and verify who sealed it. NEVER THROWS.
 *
 * @returns the rumor and the seal's author, or null when the wrap is not for this key, the
 *   seal's signature fails, or the rumor claims a different author than the seal
 */
export function unwrapSealed(wrap: Event, key: Uint8Array): { rumor: Rumor; sealer: string } | null {
  try {
    const seal = JSON.parse(nip44.decrypt(wrap.content, nip44.getConversationKey(key, wrap.pubkey))) as Event
    if (seal.kind !== 13 || !verifyEvent(seal)) return null
    const rumor = JSON.parse(nip44.decrypt(seal.content, nip44.getConversationKey(key, seal.pubkey))) as Rumor
    if (rumor.pubkey !== seal.pubkey) return null
    return { rumor, sealer: seal.pubkey }
  } catch {
    return null
  }
}
