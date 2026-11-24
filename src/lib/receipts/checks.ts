/**
 * Spec 049 FR-027a-e: a merchant's receipt checks, remembered and shared.
 *
 * When a device of the payee (the owner's wallet or one of its tills) finds a receipt paid to it,
 * it publishes a CHECK: a regular, signed Nostr event saying "this device checked this payment at
 * this time". A later check of the same payment, on any of the payee's devices, reads those events
 * back through the gateway cache and shows "Already checked".
 *
 * Unlinkable to anyone without the receipt. The event carries only a locator tag
 * `x = sha256(LOCATOR_LABEL, payee, paymentId)` and content NIP-44 encrypted to a key derived the
 * same way (`KEY_LABEL`), so the relay sees neither the payee, the payment nor the device's
 * stall. Whoever holds the receipt (the payer, the payee, its tills) can find and read the checks.
 *
 * Trust (FR-027d): an event's signer is a fact, its content a claim. A check counts only when it
 * was signed by the payee key, by a terminal whose owner attestation (carried in the check,
 * signed by the payee) names that signer, or, on the owner's wallet, by a terminal in its roster.
 * Its time is the event's signed `created_at`. Append-only: every check is kept, and a
 * device that cannot read the cache says nothing rather than "first".
 */
import { finalizeEvent, getPublicKey, nip44, verifyEvent, type Event } from 'nostr-tools'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils'

import { checkOwnerAttestation, type OwnerAttestation } from '../ownerAttestation'

export const CHECK_KIND = 9741
export const CHECK_ALT = 'imani receipt check'
const LOCATOR_LABEL = 'imani-receipt-check-locator-v1'
const KEY_LABEL = 'imani-receipt-check-key-v1'
const US = '\u001f'
const HEX64 = /^[0-9a-f]{64}$/

/** Most own checks kept on this device, and most unsent ones. Oldest dropped first. */
export const MAX_LOCAL = 500
/** How far ahead of the reader's clock a check may be dated and still count. */
export const FUTURE_SKEW_SECONDS = 600

/** A terminal's authority, as its credential states it: enough for any verifier to rebuild the stall's signature. */
export interface TerminalProof {
  stall_pubkey: string
  lock_key: string
  role: string
  /** The credential's own signed `expires_at`, canonical decimal. */
  expires_at: string
  owner_attestation: OwnerAttestation
}

interface CheckBody {
  v: 1
  paymentId: string
  payee: string
  terminal?: TerminalProof
}

/** A check another device (or this one) made, as the checking device reads it. */
export interface KnownCheck {
  /** Epoch seconds, the event's signed time. */
  at: number
  /** The key that signed it: the payee (owner) or a terminal device. */
  device: string
}

const lower = (hex: string) => hex.toLowerCase()

function derive(label: string, payee: string, paymentId: string): Uint8Array {
  return sha256(utf8ToBytes([label, lower(payee), lower(paymentId)].join(US)))
}

/** The tag value a payment's checks are filed under. */
export function checkLocator(payee: string, paymentId: string): string {
  return bytesToHex(derive(LOCATOR_LABEL, payee, paymentId))
}

function conversationKey(payee: string, paymentId: string): Uint8Array {
  const sk = derive(KEY_LABEL, payee, paymentId)
  try {
    return nip44.getConversationKey(sk, getPublicKey(sk))
  } finally {
    sk.fill(0)
  }
}

/** Sign a check with the device's key. `terminal` is required on a till, absent on the owner's wallet. */
export function buildCheckEvent(
  args: { payee: string; paymentId: string; at: number; terminal?: TerminalProof },
  withKey: <T>(use: (key: Uint8Array) => T) => T,
): Event {
  const payee = lower(args.payee)
  const paymentId = lower(args.paymentId)
  if (!HEX64.test(payee) || !HEX64.test(paymentId)) throw new Error('check needs a payee key and a payment id')
  const body: CheckBody = { v: 1, paymentId, payee, ...(args.terminal ? { terminal: args.terminal } : {}) }
  const ck = conversationKey(payee, paymentId)
  try {
    const content = nip44.encrypt(JSON.stringify(body), ck)
    const tags = [
      ['x', checkLocator(payee, paymentId)],
      ['alt', CHECK_ALT],
    ]
    return withKey((key) => finalizeEvent({ kind: CHECK_KIND, created_at: args.at, tags, content }, key))
  } finally {
    ck.fill(0)
  }
}

function readBody(e: Event, ck: Uint8Array): CheckBody | null {
  try {
    const b = JSON.parse(nip44.decrypt(e.content, ck)) as Partial<CheckBody>
    if (!b || b.v !== 1 || typeof b.paymentId !== 'string' || typeof b.payee !== 'string') return null
    return b as CheckBody
  } catch {
    return null
  }
}

/** FR-027d: whether this signer may speak for the payee. */
function vouched(e: Event, body: CheckBody, payee: string, rosterKeys: ReadonlySet<string>): boolean {
  if (e.pubkey === payee) return true
  if (rosterKeys.has(e.pubkey)) return true
  const t = body.terminal
  if (!t || typeof t !== 'object') return false
  if (t.stall_pubkey !== payee || t.lock_key !== e.pubkey || typeof t.role !== 'string' || typeof t.expires_at !== 'string') {
    return false
  }
  const refusal = checkOwnerAttestation(
    { stall_pubkey: t.stall_pubkey, lock_key: t.lock_key, role: t.role, owner_attestation: t.owner_attestation },
    payee,
    t.expires_at,
  )
  if (refusal !== null) return false
  // A check dated after the stall's attestation ran out was not made with its authority.
  const until = Number(t.owner_attestation?.expires_at)
  return Number.isFinite(until) && e.created_at <= until
}

/**
 * The checks of one payment that count, oldest first. Events that do not verify, are filed under
 * another payment, or are signed by a key the payee never vouched for are ignored.
 *
 * @param rosterKeys terminal keys the payee's own wallet lists (owner side only; empty on a till)
 */
export function readChecks(
  events: readonly Event[],
  payee: string,
  paymentId: string,
  rosterKeys: ReadonlySet<string> = new Set(),
  /** Epoch seconds. Given, checks dated too far ahead of it are dropped. */
  now?: number,
): KnownCheck[] {
  const p = lower(payee)
  const id = lower(paymentId)
  const locator = checkLocator(p, id)
  const ck = conversationKey(p, id)
  const out = new Map<string, KnownCheck>()
  try {
    for (const e of events) {
      if (out.has(e.id) || e.kind !== CHECK_KIND) continue
      // A till with a fast clock would otherwise date a check in the future, and it would read as
      // "earlier" on every scan until that time. Allowed skew, as relays commonly allow.
      if (now !== undefined && e.created_at > now + FUTURE_SKEW_SECONDS) continue
      if (!e.tags.some((t) => t[0] === 'x' && t[1] === locator)) continue
      // On a fresh copy: nostr-tools caches "verified" on the object, and a spread of a verified
      // event carries that flag onto whatever was changed (the rule `relay.ts authentic` follows).
      const { id: eid, pubkey, created_at, kind, tags, content, sig } = e
      if (!verifyEvent({ id: eid, pubkey, created_at, kind, tags, content, sig })) continue
      const body = readBody(e, ck)
      if (!body || lower(body.payee) !== p || lower(body.paymentId) !== id) continue
      if (!vouched(e, body, p, rosterKeys)) continue
      out.set(e.id, { at: e.created_at, device: e.pubkey })
    }
  } finally {
    ck.fill(0)
  }
  return [...out.values()].sort((a, b) => a.at - b.at)
}

/** Who checked, in the words the viewing device may use (FR-027e). */
export type CheckedBy =
  | { kind: 'this_device' }
  | { kind: 'owner' }
  /** Owner side only: the till's name from the roster. */
  | { kind: 'named_till'; name: string }
  | { kind: 'another_till' }

export interface PriorCheck {
  at: number
  by: CheckedBy
}

/**
 * Label checks for the viewer. A till sees itself, the owner or "another till", never a colleague's
 * name. The owner sees each till's name (`nameOf`, from its roster), and its own devices as itself.
 */
export function labelChecks(
  checks: readonly KnownCheck[],
  viewer: { device: string; payee: string; nameOf?: (terminalPubkey: string) => string },
): PriorCheck[] {
  const payee = lower(viewer.payee)
  const me = lower(viewer.device)
  return checks.map((c) => {
    if (c.device === me) return { at: c.at, by: { kind: 'this_device' } }
    if (c.device === payee) return { at: c.at, by: { kind: 'owner' } }
    if (viewer.nameOf) return { at: c.at, by: { kind: 'named_till', name: viewer.nameOf(c.device) } }
    return { at: c.at, by: { kind: 'another_till' } }
  })
}

/** Telemetry outcome for a check whose history was known. */
export function repeatOutcome(prior: readonly PriorCheck[]): 'first' | 'repeat_this_device' | 'repeat_other_device' {
  if (prior.length === 0) return 'first'
  return prior.some((p) => p.by.kind !== 'this_device') ? 'repeat_other_device' : 'repeat_this_device'
}
