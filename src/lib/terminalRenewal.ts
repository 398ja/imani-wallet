import type { Event } from 'nostr-tools'

import { LOGIN_REFUSAL, readCredential, type CredentialFacts } from './terminalLogin'
import { parseTerminalMetadata } from './terminalCredential'
import { exactlyTheStall } from './terminalMint'
import { roleOf, type TerminalRole, TERMINAL_ROLES } from './terminalRole'
import { CREDENTIAL_DM_TYPE, type CredentialMessage, type Rumor } from './terminalDelivery'
import { spendingKeys, xOnly } from './witness'
import { tokenProofs } from './voucherToken'

/**
 * Renewing a terminal to the same key K (#160 phase 6, plan 2.3, spec 2.7, decision 1).
 *
 * A credential lives a year. The owner renews it from the Terminals list: a fresh attested
 * credential to the same K (gateway-customer needs no change, F6), sent to the device as the
 * ordinary credential DM with `"renews":"<old voucher_id>"` (spec 5.1). The device adopts it at
 * its next unlock, or within five minutes while open, with no new passphrase or setup code.
 *
 * This module holds the rules both sides apply; `terminalRenewalNet.ts` holds the network.
 *
 * ## What the device checks (spec 4.6.4)
 *
 * `K` is public, so anyone can DM it a credential. A renewal is accepted only when:
 *
 * - sealed by the stall the device already serves, and naming it;
 * - for exactly the credential the device holds (`renews` == stored voucher id), and new;
 * - locked to K, for the same stall, signed by a trusted issuer (`credentialFromToken`);
 * - for the same or a smaller role (`role-not-renewal` otherwise: a renewal never widens power);
 * - ATTESTED by the stall: renewing exists to get a till onto the attested path.
 *
 * ## Then, in order (Q2)
 *
 * 1. store the new token, keeping the old as `previousToken`;
 * 2. confirm the new credential at gateway-customer as the device;
 * 3. send the enrolled DM, which the owner's app reads to retire the old row;
 * 4. spend the OLD credential with K, then forget it.
 *
 * Step 4 is the device's, not the owner's (owner decision Q2, 2026-10-09): until the old
 * credential is spent, gateway-customer's free slot stays with it and an unlicensed stall's
 * renewed till gets 402 on Sell (F7). A failed spend is retried at the next unlock; the owner's
 * revoke on the enrolled DM is the fallback.
 */

export const RENEWAL_REFUSAL = {
  NOT_A_RENEWAL_DM: 'not-a-renewal-dm',
  SEALED_BY_ANOTHER: 'sealed-by-another',
  NOT_A_RENEWAL_OF_THIS: 'not-a-renewal-of-this',
  UNREADABLE: 'unreadable',
  NOT_LOCKED_TO_THIS_DEVICE: 'not-locked-to-this-device',
  WRONG_STALL: 'wrong-stall',
  UNTRUSTED_ISSUER: 'untrusted-issuer',
  ROLE_NOT_RENEWAL: 'role-not-renewal',
  UNATTESTED: 'unattested',
} as const
export type RenewalRefusal = (typeof RENEWAL_REFUSAL)[keyof typeof RENEWAL_REFUSAL]

/** The credential DM, with what it renews. */
export interface RenewalMessage extends CredentialMessage {
  renews: string
}

export function renewalMessageJson(m: RenewalMessage): string {
  return JSON.stringify({
    type: CREDENTIAL_DM_TYPE,
    voucher_id: m.voucherId,
    token: m.token,
    stall_pubkey: m.stallPubkey,
    name: m.name,
    idle_lock_minutes: m.idleLockMinutes,
    renews: m.renews,
  })
}

/** What the device holds, from its own stored record. */
export interface HeldCredentialFacts {
  stallPubkey: string
  voucherId: string
  role: TerminalRole
  terminalPubkey: string
}

/** A renewal the device has checked and may adopt. */
export interface AcceptedRenewal {
  voucherId: string
  token: string
  renews: string
  stallPubkey: string
  role: TerminalRole
  /** Epoch seconds, the new credential's signed expiry. */
  expiresAt?: number
  idleLockMinutes?: number
  name?: string
}

/** A smaller or equal role: the only direction a renewal may go. */
const ROLE_RANK: Record<TerminalRole, number> = {
  [TERMINAL_ROLES.REDEEM_ONLY]: 1,
  [TERMINAL_ROLES.ISSUE_AND_REDEEM]: 2,
}

/**
 * Whether an unwrapped DM is a renewal of the credential this device holds. NEVER THROWS.
 *
 * @param sealer the seal's verified author (`unwrapSealed`)
 */
export function renewalFromRumor(
  rumor: Rumor,
  sealer: string,
  held: HeldCredentialFacts,
): AcceptedRenewal | RenewalRefusal {
  let m: Record<string, unknown>
  try {
    m = JSON.parse(rumor.content) as Record<string, unknown>
  } catch {
    return RENEWAL_REFUSAL.NOT_A_RENEWAL_DM
  }
  if (m?.type !== CREDENTIAL_DM_TYPE || typeof m.renews !== 'string' || typeof m.token !== 'string' || typeof m.voucher_id !== 'string') {
    return RENEWAL_REFUSAL.NOT_A_RENEWAL_DM
  }
  const stall = held.stallPubkey.toLowerCase()
  if (sealer.toLowerCase() !== stall || String(m.stall_pubkey).toLowerCase() !== stall) {
    return RENEWAL_REFUSAL.SEALED_BY_ANOTHER
  }
  if (m.renews !== held.voucherId || m.voucher_id === held.voucherId) return RENEWAL_REFUSAL.NOT_A_RENEWAL_OF_THIS

  // The token's own signed bytes, through the same reader login uses: lock == metadata lock,
  // signature, trusted issuer, attestation verdict.
  let lock: string | undefined
  try {
    const proofs = tokenProofs(m.token)
    lock = proofs.length === 1 ? spendingKeys(proofs[0].secret)[0] : undefined
  } catch {
    return RENEWAL_REFUSAL.UNREADABLE
  }
  if (!lock || xOnly(lock).toLowerCase() !== held.terminalPubkey.toLowerCase()) {
    return RENEWAL_REFUSAL.NOT_LOCKED_TO_THIS_DEVICE
  }
  const facts = credentialFromTokenOrReason(m.token)
  if (typeof facts === 'string') return facts
  const metadata = parseTerminalMetadata(facts.merchantMetadata)
  if (!metadata || facts.voucherId !== m.voucher_id) return RENEWAL_REFUSAL.UNREADABLE
  if (metadata.lock_key !== held.terminalPubkey.toLowerCase()) return RENEWAL_REFUSAL.NOT_LOCKED_TO_THIS_DEVICE
  if (facts.issuerId.toLowerCase() !== stall || metadata.stall_pubkey !== stall) return RENEWAL_REFUSAL.WRONG_STALL
  const role = roleOf(metadata.role)
  if (!role || ROLE_RANK[role] > ROLE_RANK[held.role]) return RENEWAL_REFUSAL.ROLE_NOT_RENEWAL
  if (!facts.attested) return RENEWAL_REFUSAL.UNATTESTED

  const idle = Number(m.idle_lock_minutes)
  return {
    voucherId: facts.voucherId,
    token: m.token,
    renews: m.renews,
    stallPubkey: stall,
    role,
    ...(facts.expiresAt !== undefined ? { expiresAt: facts.expiresAt } : {}),
    ...(Number.isInteger(idle) && idle >= 0 && idle <= 24 * 60 ? { idleLockMinutes: idle } : {}),
    ...(typeof m.name === 'string' && m.name.trim() ? { name: m.name.trim() } : {}),
  }
}

/** The token's facts, or why login would refuse it, in renewal terms. */
function credentialFromTokenOrReason(token: string): CredentialFacts | RenewalRefusal {
  const read = readCredential(token)
  if ('facts' in read) return read.facts
  return read.refusal === LOGIN_REFUSAL.UNTRUSTED_ISSUER ? RENEWAL_REFUSAL.UNTRUSTED_ISSUER : RENEWAL_REFUSAL.UNREADABLE
}

/** The newest acceptable renewal among wraps to K, or null. */
export function findRenewal(
  wraps: readonly Event[],
  open: (wrap: Event) => { rumor: Rumor; sealer: string } | null,
  held: HeldCredentialFacts,
): AcceptedRenewal | null {
  const accepted: Array<{ at: number; r: AcceptedRenewal }> = []
  for (const wrap of wraps) {
    const opened = open(wrap)
    if (!opened) continue
    const out = renewalFromRumor(opened.rumor, opened.sealer, held)
    if (typeof out === 'string') {
      if (out !== RENEWAL_REFUSAL.NOT_A_RENEWAL_DM) console.warn('[renewal] refused', out)
      continue
    }
    accepted.push({ at: opened.rumor.created_at, r: out })
  }
  accepted.sort((a, b) => b.at - a.at)
  return accepted[0]?.r ?? null
}

export interface AdoptDeps {
  /** Step 1: store the new token, keeping `previous`. Synchronous, so it is never half done. */
  store(token: string, voucherId: string, previous: string, renewal: AcceptedRenewal): void
  /** Step 2: confirm the new credential at gateway-customer, as the device. */
  confirm(voucherId: string): Promise<void>
  /** Step 3: the enrolled DM to the stall. */
  announce(voucherId: string): Promise<boolean>
  /** Step 4: spend the OLD credential with K. True when spent (or already spent). */
  spendOld(previous: string): Promise<boolean>
  /** Forget `previous`, once spent. */
  clearPrevious(): void
}

/** Adopt a checked renewal, in the order spec 2.7 (as amended by Q2) gives. */
export async function adoptRenewal(
  renewal: AcceptedRenewal,
  previousToken: string,
  deps: AdoptDeps,
): Promise<{ adopted: true; oldSpent: boolean }> {
  deps.store(renewal.token, renewal.voucherId, previousToken, renewal)
  await deps.confirm(renewal.voucherId).catch(() => undefined)
  await deps.announce(renewal.voucherId).catch(() => false)
  const oldSpent = await deps.spendOld(previousToken).catch(() => false)
  if (oldSpent) deps.clearPrevious()
  return { adopted: true, oldSpent }
}

// ---- renew request: the till asks the owner (Q3) ----------------------------------------------

export const RENEW_REQUEST_DM_TYPE = 'imani-terminal-renew-request/1'

/** What the till sends, sealed by K, to its stall. */
export function renewRequestJson(voucherId: string, token: string): string {
  return JSON.stringify({ type: RENEW_REQUEST_DM_TYPE, voucher_id: voucherId, token })
}

export type RenewRequestRefusal =
  | 'not-a-renew-request'
  | 'unreadable'
  | 'wrong-issuer'
  | 'no-stall-co-key'
  | 'not-locked-to-sealer'
  | 'untrusted-issuer'

/** A till's own credential, adopted into the owner's roster so it can be renewed. */
export interface RenewRequest {
  terminalPubkey: string
  voucherId: string
  token: string
  role: TerminalRole
  name: string
  expiresAt?: number
  attested: boolean
}

/**
 * Whether a renew request is this stall's own credential, held by the till that sealed it.
 * The caller still asks the mint (NUT-07 UNSPENT) before adopting it.
 */
export function renewRequestFromRumor(rumor: Rumor, sealer: string, stallPubkey: string): RenewRequest | RenewRequestRefusal {
  let m: Record<string, unknown>
  try {
    m = JSON.parse(rumor.content) as Record<string, unknown>
  } catch {
    return 'not-a-renew-request'
  }
  if (m?.type !== RENEW_REQUEST_DM_TYPE || typeof m.token !== 'string' || typeof m.voucher_id !== 'string') {
    return 'not-a-renew-request'
  }
  const stall = stallPubkey.toLowerCase()
  let secret: string
  try {
    const proofs = tokenProofs(m.token)
    if (proofs.length !== 1) return 'unreadable'
    secret = proofs[0].secret
  } catch {
    return 'unreadable'
  }
  const lock = spendingKeys(secret)[0]
  const read = readCredential(m.token)
  if (!('facts' in read)) return read.refusal === LOGIN_REFUSAL.UNTRUSTED_ISSUER ? 'untrusted-issuer' : 'unreadable'
  const facts = read.facts
  const metadata = parseTerminalMetadata(facts.merchantMetadata)
  if (!metadata || facts.voucherId !== m.voucher_id) return 'unreadable'
  if (facts.issuerId.toLowerCase() !== stall || metadata.stall_pubkey !== stall) return 'wrong-issuer'
  if (!exactlyTheStall(secret, stall)) return 'no-stall-co-key'
  if (!lock || xOnly(lock).toLowerCase() !== sealer.toLowerCase()) return 'not-locked-to-sealer'
  const role = roleOf(metadata.role)
  if (!role) return 'unreadable'
  return {
    terminalPubkey: sealer.toLowerCase(),
    voucherId: facts.voucherId,
    token: m.token,
    role,
    name: metadata.name ?? 'Terminal',
    ...(facts.expiresAt !== undefined ? { expiresAt: facts.expiresAt } : {}),
    attested: facts.attested,
  }
}

// ---- expiry, as both sides show it (decision 1, Q4) -------------------------------------------

export const RENEW_AMBER_DAYS = 30
export const RENEW_RED_DAYS = 7

export type ExpiryBand = 'ok' | 'amber' | 'red' | 'expired'

/**
 * How close a credential is to its expiry. `expiresAt` is the last valid second, as everywhere:
 * expired only when `now > expiresAt`.
 */
export function expiryBand(expiresAtSeconds: number | undefined, nowMs: number = Date.now()): ExpiryBand {
  if (expiresAtSeconds === undefined) return 'ok'
  const now = Math.floor(nowMs / 1000)
  if (now > expiresAtSeconds) return 'expired'
  const left = expiresAtSeconds - now
  if (left <= RENEW_RED_DAYS * 86_400) return 'red'
  if (left <= RENEW_AMBER_DAYS * 86_400) return 'amber'
  return 'ok'
}
