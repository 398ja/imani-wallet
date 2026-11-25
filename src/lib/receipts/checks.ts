/**
 * Spec 049 FR-027a-e: a merchant's receipt checks, remembered and shared.
 *
 * When a device of the payee (the owner's wallet or one of its tills) finds a receipt paid to it,
 * it publishes a CHECK: a regular Nostr event saying "this device checked this payment at this
 * time". A later check of the same payment, on any of the payee's devices, reads those events
 * back through the gateway cache and shows "Already checked".
 *
 * What a relay learns: nothing it could tie to a stall. The event is signed by a ONE-TIME key and
 * carries only a locator tag `x = sha256(LOCATOR_LABEL, payee, paymentId)`; its content is NIP-44
 * encrypted to a key derived the same way. Only a holder of the receipt (payer, payee, its tills)
 * can find or read a payment's checks. The device that checked signs INSIDE the encrypted body.
 *
 * Trust (FR-027d): the inner signature is the fact, everything else a claim. A check counts only
 * when its inner signer is the payee key, a terminal whose owner attestation (carried in the
 * check, signed by the payee) names that signer and was in force, or, on the owner's wallet, a
 * terminal in its roster that was not revoked by then. Its time is the signed inner time, never
 * far ahead of the reader's clock nor before the payment. Append-only: every check is kept.
 */
import { finalizeEvent, generateSecretKey, getPublicKey, nip44, type Event } from 'nostr-tools'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils'

import { checkOwnerAttestation, type OwnerAttestation } from '../ownerAttestation'
import { roleOf } from '../terminalRole'

export const CHECK_KIND = 9741
const LOCATOR_LABEL = 'imani-receipt-check-locator-v1'
const KEY_LABEL = 'imani-receipt-check-key-v1'
const SIG_DOMAIN = 'imani-receipt-check-sig-v1'
const US = '\u001f'
const HEX64 = /^[0-9a-f]{64}$/
const HEX128 = /^[0-9a-f]{128}$/
const DEVICE_ID = /^[0-9a-f]{32}$/

/** Most own checks kept on this device, and most unsent ones. Oldest dropped first. */
export const MAX_LOCAL = 500
/** How far ahead of the reader's clock a check may be dated and still count. */
export const FUTURE_SKEW_SECONDS = 600
/** How far before the payment's own date a check may be dated (the payer's clock may be slow). */
export const PAST_SKEW_SECONDS = 600

/** A terminal's authority, as its credential states it: enough for any verifier to rebuild the stall's signature. */
export interface TerminalProof {
  stall_pubkey: string
  lock_key: string
  role: string
  /** The credential's own signed `expires_at`. Informational: the bound is the attestation's. */
  expires_at: string
  owner_attestation: OwnerAttestation
}

interface CheckBody {
  v: 2
  paymentId: string
  payee: string
  /** The device key that checked: the payee's on the owner's wallet, the till's own on a till. */
  device: string
  /** Random per install, so the owner's phone and laptop are told apart. */
  deviceId: string
  /** Epoch seconds, signed. */
  at: number
  /** BIP-340 by `device` over `checkDigest`. */
  sig: string
  terminal?: TerminalProof
}

/** A check another device (or this one) made, as the checking device reads it. */
export interface KnownCheck {
  /** The event that carried it: the identity for dedupe. */
  id: string
  /** Epoch seconds, the signed time. */
  at: number
  /** The key that signed it: the payee (owner) or a terminal device. */
  device: string
  deviceId: string
}

const lower = (hex: string) => hex.toLowerCase()

function derive(label: string, payee: string, paymentId: string): Uint8Array {
  return sha256(utf8ToBytes([label, lower(payee), lower(paymentId)].join(US)))
}

/** The tag value a payment's checks are filed under. */
export function checkLocator(payee: string, paymentId: string): string {
  return bytesToHex(derive(LOCATOR_LABEL, payee, paymentId))
}

function checkDigest(locator: string, at: number, device: string, deviceId: string): Uint8Array {
  return sha256(utf8ToBytes([SIG_DOMAIN, locator, String(at), lower(device), deviceId].join(US)))
}

function conversationKey(payee: string, paymentId: string): Uint8Array {
  const sk = derive(KEY_LABEL, payee, paymentId)
  try {
    return nip44.getConversationKey(sk, getPublicKey(sk))
  } finally {
    sk.fill(0)
  }
}

/** Sign a check with the device's key, wrapped in an event signed by a one-time key. */
export function buildCheckEvent(
  args: { payee: string; paymentId: string; at: number; device: string; deviceId: string; terminal?: TerminalProof },
  withKey: <T>(use: (key: Uint8Array) => T) => T,
): Event {
  const payee = lower(args.payee)
  const paymentId = lower(args.paymentId)
  const device = lower(args.device)
  if (!HEX64.test(payee) || !HEX64.test(paymentId) || !HEX64.test(device)) throw new Error('check needs a payee, a payment id and a device key')
  if (!DEVICE_ID.test(args.deviceId)) throw new Error('check needs a device id')
  const locator = checkLocator(payee, paymentId)
  const digest = checkDigest(locator, args.at, device, args.deviceId)
  const sig = withKey((key) => {
    if (bytesToHex(schnorr.getPublicKey(key)) !== device) throw new Error('the signing key is not this device')
    return bytesToHex(schnorr.sign(digest, key))
  })
  const body: CheckBody = { v: 2, paymentId, payee, device, deviceId: args.deviceId, at: args.at, sig, ...(args.terminal ? { terminal: args.terminal } : {}) }
  const ck = conversationKey(payee, paymentId)
  const once = generateSecretKey()
  try {
    const content = nip44.encrypt(JSON.stringify(body), ck)
    return finalizeEvent({ kind: CHECK_KIND, created_at: args.at, tags: [['x', locator]], content }, once)
  } finally {
    ck.fill(0)
    once.fill(0)
  }
}

function readBody(e: Event, ck: Uint8Array): CheckBody | null {
  try {
    const b = JSON.parse(nip44.decrypt(e.content, ck)) as Partial<CheckBody>
    if (!b || b.v !== 2) return null
    if (typeof b.paymentId !== 'string' || typeof b.payee !== 'string' || typeof b.device !== 'string') return null
    if (typeof b.deviceId !== 'string' || !DEVICE_ID.test(b.deviceId)) return null
    if (!Number.isSafeInteger(b.at) || typeof b.sig !== 'string' || !HEX128.test(b.sig) || !HEX64.test(b.device)) return null
    return b as CheckBody
  } catch {
    return null
  }
}

/** The owner's view of its own tills: key, and when (epoch seconds) it was revoked, if it was. */
export interface RosterView {
  keys: ReadonlyMap<string, number | undefined>
}

/** FR-027d: whether this device may speak for the payee at the check's time. */
function vouched(body: CheckBody, payee: string, roster: RosterView | undefined): boolean {
  if (body.device === payee) return true
  // The owner knows its tills and when it revoked them: a revoked till's later checks never count.
  if (roster?.keys.has(body.device)) {
    const revokedAt = roster.keys.get(body.device)
    return revokedAt === undefined || body.at < revokedAt
  }
  const t = body.terminal
  if (!t || typeof t !== 'object') return false
  if (t.stall_pubkey !== payee || t.lock_key !== body.device || roleOf(t.role) === null) return false
  const until = t.owner_attestation?.expires_at
  if (typeof until !== 'string') return false
  // The stall's signature over (stall, till, role, until) is the authority; `until` bounds it.
  const refusal = checkOwnerAttestation(
    { stall_pubkey: t.stall_pubkey, lock_key: t.lock_key, role: t.role, owner_attestation: t.owner_attestation },
    payee,
    until,
  )
  if (refusal !== null) return false
  return body.at <= Number(until)
}

export interface ReadOptions {
  /** Owner side only: its roster. */
  roster?: RosterView
  /** Epoch seconds. Checks dated too far ahead of it are dropped. */
  now?: number
  /** Epoch seconds, the payment's date. Checks dated too far before it are dropped. */
  paidAt?: number
}

/**
 * The checks of one payment that count, oldest first. Events filed under another payment, whose
 * inner signature does not verify, or whose device the payee never vouched for, are ignored.
 */
export function readChecks(events: readonly Event[], payee: string, paymentId: string, opts: ReadOptions = {}): KnownCheck[] {
  const p = lower(payee)
  const id = lower(paymentId)
  const locator = checkLocator(p, id)
  const ck = conversationKey(p, id)
  const out = new Map<string, KnownCheck>()
  try {
    for (const e of events) {
      if (out.has(e.id) || e.kind !== CHECK_KIND) continue
      if (!e.tags.some((t) => t[0] === 'x' && t[1] === locator)) continue
      const body = readBody(e, ck)
      if (!body || lower(body.payee) !== p || lower(body.paymentId) !== id) continue
      if (opts.now !== undefined && body.at > opts.now + FUTURE_SKEW_SECONDS) continue
      if (opts.paidAt !== undefined && opts.paidAt > 0 && body.at < opts.paidAt - PAST_SKEW_SECONDS) continue
      try {
        if (!schnorr.verify(hexToBytes(body.sig), checkDigest(locator, body.at, body.device, body.deviceId), hexToBytes(body.device))) continue
      } catch {
        continue
      }
      if (!vouched(body, p, opts.roster)) continue
      out.set(e.id, { id: e.id, at: body.at, device: body.device, deviceId: body.deviceId })
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
  /** Owner side only: the owner's own key, from another install (phone, laptop). */
  | { kind: 'owner_other_device' }
  /** Owner side only: the till's name from the roster. */
  | { kind: 'named_till'; name: string }
  | { kind: 'another_till' }

export interface PriorCheck {
  at: number
  by: CheckedBy
}

/**
 * Label checks for the viewer. A till sees itself, the owner or "another till", never a colleague's
 * name. The owner sees each till's name (`nameOf`, from its roster), and tells this install from
 * its other ones.
 */
export function labelChecks(
  checks: readonly KnownCheck[],
  viewer: { device: string; deviceId: string; payee: string; nameOf?: (terminalPubkey: string) => string },
): PriorCheck[] {
  const payee = lower(viewer.payee)
  const me = lower(viewer.device)
  const owner = me === payee
  return checks.map((c) => {
    if (c.device === me && c.deviceId === viewer.deviceId) return { at: c.at, by: { kind: 'this_device' } }
    if (c.device === payee) return { at: c.at, by: { kind: owner ? 'owner_other_device' : 'owner' } }
    // A till's key is its own: the same key is the same till, whatever install id it reports.
    if (c.device === me) return { at: c.at, by: { kind: 'this_device' } }
    if (viewer.nameOf) return { at: c.at, by: { kind: 'named_till', name: viewer.nameOf(c.device) } }
    return { at: c.at, by: { kind: 'another_till' } }
  })
}

/** Telemetry outcome for a check. */
export function repeatOutcome(prior: readonly PriorCheck[], known = true): 'first' | 'repeat_this_device' | 'repeat_other_device' | 'unknown' {
  if (prior.some((p) => p.by.kind !== 'this_device')) return 'repeat_other_device'
  if (prior.length > 0) return 'repeat_this_device'
  return known ? 'first' : 'unknown'
}
