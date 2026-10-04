import { finalizeEvent, nip44, verifyEvent, type Event } from 'nostr-tools'
import { getPublicKey } from 'nostr-tools'

import { parseTerminalMetadata, type TerminalMetadata } from './terminalCredential'
import { checkCode } from './terminalMint'
import { parseVoucherToken, tokenProofs, verifyVoucher } from './voucherToken'
import { spendingKeys, xOnly } from './witness'

/**
 * Carrying a terminal's authority to its device, and the device's answer (#160 phase 2).
 *
 * Two NIP-17 messages (spec 5.1), both gift-wrapped kind-14 rumors:
 *
 * - **Credential DM**, owner → device, sealed by the stall, wrapped to the device key `K`:
 *   `{"type":"imani-terminal-credential/1","voucher_id","token","stall_pubkey","name","idle_lock_minutes"}`.
 * - **Enrolled DM**, device → owner, sealed by `K`, wrapped to the stall:
 *   `{"type":"imani-terminal-enrolled/1","voucher_id","terminal_pubkey"}`.
 *
 * ## Who sent it is read from the seal, and checked against the rumor
 *
 * A gift wrap's outer key is throwaway. The seal inside is signed by the sender, and the
 * rumor inside that is unsigned, so its `pubkey` is whatever the sender wrote. NIP-17 requires
 * the two to match, and `nostr-tools`' `unwrapEvent` does not check it. `unwrapSealed` does,
 * and verifies the seal's signature, so `sealer` is a fact rather than a claim.
 *
 * ## Why the device trusts nothing it is sent
 *
 * `K` is public by design: anyone watching the screen can DM it a credential for their own
 * stall. So an offer is accepted only if the credential's own signed bytes name the stall that
 * sealed the DM as issuer and stall, are locked to `K`, and verify. And the operator then
 * confirms the stall's name and the check code against the owner's screen (spec 4.2).
 */

export const CREDENTIAL_DM_TYPE = 'imani-terminal-credential/1'
export const ENROLLED_DM_TYPE = 'imani-terminal-enrolled/1'

/** A credential DM older than this is refused by the device (decision 4: 24 hours). */
export const OFFER_TTL_SECONDS = 24 * 3600

/** The idle lock's default, in minutes (decision 2). `0` means off. */
export const DEFAULT_IDLE_LOCK_MINUTES = 10

/** The idle-lock choices the owner is offered (decision 2). `0` means off. */
export const IDLE_LOCK_CHOICES = [0, 5, 10, 15, 30, 60] as const

const HEX64 = /^[0-9a-f]{64}$/

/** A kind-14 rumor, as unwrapped. Unsigned by design. */
export interface Rumor {
  kind: number
  pubkey: string
  created_at: number
  content: string
  tags: string[][]
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
    const rumor = JSON.parse(
      nip44.decrypt(seal.content, nip44.getConversationKey(key, seal.pubkey)),
    ) as Rumor
    if (rumor.pubkey !== seal.pubkey) return null
    return { rumor, sealer: seal.pubkey }
  } catch {
    return null
  }
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

/** What the owner sends the device. */
export interface CredentialMessage {
  voucherId: string
  token: string
  stallPubkey: string
  /** What the owner named the terminal. */
  name: string
  /** Decision 2. `0` is off. */
  idleLockMinutes: number
}

export function credentialMessageJson(m: CredentialMessage): string {
  return JSON.stringify({
    type: CREDENTIAL_DM_TYPE,
    voucher_id: m.voucherId,
    token: m.token,
    stall_pubkey: m.stallPubkey,
    name: m.name,
    idle_lock_minutes: m.idleLockMinutes,
  })
}

export function enrolledMessageJson(voucherId: string, terminalPubkey: string): string {
  return JSON.stringify({
    type: ENROLLED_DM_TYPE,
    voucher_id: voucherId,
    terminal_pubkey: terminalPubkey,
  })
}

/** A credential the device was sent and has checked. What the confirm screen shows. */
export interface CredentialOffer {
  voucherId: string
  token: string
  stallPubkey: string
  name: string
  idleLockMinutes: number
  /** Epoch seconds the owner sent it. */
  sentAt: number
  metadata: TerminalMetadata
  issuerId: string
  merchantMetadata: string
  /** Six digits, the same the owner's screen shows. */
  checkCode: string
}

/** Why an offer was refused. Tested one by one: each is an attack or an accident. */
export type OfferRefusal =
  | 'not-a-credential-dm'
  | 'stale'
  | 'sealed-by-another'
  | 'unreadable'
  | 'not-locked-to-this-device'
  | 'wrong-issuer'
  | 'bad-signature'

/**
 * Does this unwrapped DM carry a credential this device may accept?
 *
 * Every property is read from the credential's own signed bytes, and the stall it names must
 * be the key that sealed the DM.
 */
export function offerFromRumor(
  rumor: Rumor,
  sealer: string,
  devicePubkey: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): CredentialOffer | OfferRefusal {
  let m: Record<string, unknown>
  try {
    m = JSON.parse(rumor.content) as Record<string, unknown>
  } catch {
    return 'not-a-credential-dm'
  }
  if (m?.type !== CREDENTIAL_DM_TYPE || typeof m.token !== 'string' || typeof m.voucher_id !== 'string') {
    return 'not-a-credential-dm'
  }
  if (nowSeconds - rumor.created_at > OFFER_TTL_SECONDS) return 'stale'

  const stall = sealer.toLowerCase()
  if (typeof m.stall_pubkey !== 'string' || m.stall_pubkey.toLowerCase() !== stall) {
    return 'sealed-by-another'
  }

  let parsed: ReturnType<typeof parseVoucherToken>
  let secret: string
  try {
    const proofs = tokenProofs(m.token)
    if (proofs.length !== 1) return 'unreadable'
    secret = proofs[0].secret
    parsed = parseVoucherToken(m.token)
  } catch {
    return 'unreadable'
  }
  const voucher = parsed.voucher
  const metadata = parseTerminalMetadata(voucher.merchantMetadata)
  if (!metadata || voucher.voucherId !== m.voucher_id) return 'unreadable'

  const device = devicePubkey.toLowerCase()
  const lock = spendingKeys(secret)[0]
  if (!lock || xOnly(lock).toLowerCase() !== device || metadata.lock_key !== device) {
    return 'not-locked-to-this-device'
  }
  if (voucher.issuerId.toLowerCase() !== stall || metadata.stall_pubkey !== stall) {
    return 'wrong-issuer'
  }
  if (!verifyVoucher(voucher).signatureValid) return 'bad-signature'

  const idle = Number(m.idle_lock_minutes)
  return {
    voucherId: voucher.voucherId,
    token: m.token,
    stallPubkey: stall,
    name: typeof m.name === 'string' && m.name.trim() ? m.name.trim() : (metadata.name ?? 'Terminal'),
    idleLockMinutes: Number.isInteger(idle) && idle >= 0 && idle <= 24 * 60 ? idle : DEFAULT_IDLE_LOCK_MINUTES,
    sentAt: rumor.created_at,
    metadata,
    issuerId: voucher.issuerId,
    merchantMetadata: String(voucher.merchantMetadata),
    checkCode: checkCode(voucher.voucherId, stall, device),
  }
}

/** An enrolled DM, read from a rumor and its verified sealer. */
export interface EnrolledNotice {
  voucherId: string
  terminalPubkey: string
}

/**
 * The device's "I have it" message, if this rumor is one and its sealer is the device it names.
 * A notice claiming one device but sealed by another is ignored (spec 5.1).
 */
export function enrolledFromRumor(rumor: Rumor, sealer: string): EnrolledNotice | null {
  try {
    const m = JSON.parse(rumor.content) as Record<string, unknown>
    if (m?.type !== ENROLLED_DM_TYPE) return null
    if (typeof m.voucher_id !== 'string' || typeof m.terminal_pubkey !== 'string') return null
    const terminal = m.terminal_pubkey.toLowerCase()
    if (!HEX64.test(terminal) || terminal !== sealer.toLowerCase()) return null
    return { voucherId: m.voucher_id, terminalPubkey: terminal }
  } catch {
    return null
  }
}

/** Gift wraps addressed to `pubkey`, from the gateway's public query. Never throws. */
export async function giftWrapsFor(pubkey: string, sinceSeconds?: number): Promise<Event[]> {
  try {
    const response = await fetch('/api/v1/nostr/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // `pTags`, not `#p`: the gateway's DTO ignores the standard form (see dmPoll.ts).
      body: JSON.stringify({
        kinds: [1059],
        pTags: [pubkey],
        // Gift wraps carry a randomised created_at up to 10 minutes early.
        ...(sinceSeconds ? { since: sinceSeconds - 900 } : {}),
        limit: 200,
      }),
    })
    if (!response.ok) return []
    const body = (await response.json()) as { events?: Array<Record<string, unknown>> }
    return (body.events ?? []).map(
      (e) =>
        ({
          id: String(e.id),
          pubkey: String(e.pubkey),
          created_at: Number(e.createdAt ?? e.created_at),
          kind: Number(e.kind),
          tags: (e.tags ?? []) as string[][],
          content: String(e.content),
          sig: String(e.sig),
        }) as Event,
    )
  } catch {
    return []
  }
}

/** Where a wrap is published. Injected so tests need no relay or gateway. */
export interface WrapPublisher {
  /** Publish to the relay and mirror to the gateway's cache. True when either landed. */
  publish(wrap: Event): Promise<boolean>
}

/**
 * Send a terminal its credential, sealed by the stall (owner side, spec 2.1 step 2).
 *
 * @param sealWith borrows the stall's key for the wrap, the way `signer.withPrivkey` lends it
 */
export async function sendCredential(
  message: CredentialMessage,
  terminalPubkey: string,
  sealWith: <T>(borrow: (key: Uint8Array) => T) => T,
  publisher: WrapPublisher,
): Promise<boolean> {
  const wrap = sealWith((key) => wrapMessage(key, terminalPubkey, credentialMessageJson(message)))
  return publisher.publish(wrap)
}

/**
 * Enrolled notices addressed to the stall, verified (owner side, spec 2.1 step 4).
 *
 * @param openWith unwraps a gift wrap with the stall's key; null when it is not for the stall
 */
export function enrolledNotices(
  wraps: readonly Event[],
  openWith: (wrap: Event) => { rumor: Rumor; sealer: string } | null,
): EnrolledNotice[] {
  return wraps.flatMap((wrap) => {
    const opened = openWith(wrap)
    if (!opened) return []
    const notice = enrolledFromRumor(opened.rumor, opened.sealer)
    return notice ? [notice] : []
  })
}
