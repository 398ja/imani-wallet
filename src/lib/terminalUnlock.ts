import { getPublicKey } from 'nostr-tools'
import { hexToBytes } from '@noble/hashes/utils'

import { installTerminalSigner, keyStore, lockTerminalSigner } from './nap'
import { storedTerminal, storedTerminalPubkey } from './terminalEnrol'
import { LOGIN_MESSAGE, LOGIN_REFUSAL, loginFromToken, type LoginRefusal } from './terminalLogin'
import { setRequestCredential, type HeldCredential } from './terminalRequestCredential'
import { credentialFromToken } from './terminalLogin'
import { tokenProofs } from './voucherToken'
import { credentialState, unspentForLogin, type CredentialMintApi } from './credentialRevocation'
import { sessionState, type TerminalSession } from './terminalSession'
import { terminalMintApi } from './terminalTill'
import type { TerminalActor } from './actor'

/**
 * Opening the till: the passphrase decrypts `K`, and the credential decides the rest (#160
 * phase 3, spec 2.3).
 *
 * ## No NAP, on purpose
 *
 * A terminal is not a customer and has no account. Its key would log in through NAP as a
 * customer with an empty wallet (the #160 follow-up showed exactly that), so unlocking never
 * calls `/api/v1/auth/*`. It builds an in-memory signer (`installTerminalSigner`) and nothing
 * else. Every request the till then makes is signed per request with NIP-98.
 *
 * ## The twelve-hour session survives a lock, not a reload
 *
 * The session is held in memory, in this module. The idle lock (decision 2) drops the signer
 * and keeps the session, so unlocking again within the twelve hours needs only the passphrase
 * and does not ask the mint. A reload clears the module, so the next unlock asks the mint
 * again: that is where an owner's revocation bites (spec 4.3, "next unlock").
 */

export type UnlockOutcome =
  | { unlocked: true; devicePubkey: string; actor: TerminalActor; session: TerminalSession }
  | { unlocked: false; reason: LoginRefusal | 'wrong-passphrase' | 'not-a-terminal-key'; message: string }

export const WRONG_PASSPHRASE = 'That passphrase does not open this terminal.'
export const NOT_A_TERMINAL_KEY =
  'That passphrase opens a wallet, not this terminal. Open the wallet instead.'

/** Read the voucher id and secret out of a credential token, or null if it is not one. */
function heldCredentialFrom(token: string): HeldCredential | null {
  const facts = credentialFromToken(token)
  if (!facts) return null
  try {
    const proofs = tokenProofs(token)
    return proofs.length === 1
      ? { voucherId: facts.voucherId, stallPubkey: facts.issuerId.toLowerCase(), secret: proofs[0].secret }
      : null
  } catch {
    return null
  }
}

/** The session the last unlock opened. In memory only: see the module comment. */
let held: { devicePubkey: string; actor: TerminalActor; session: TerminalSession } | null = null
/** The credential `held` was derived from. A renewal changes the stored token (#160 phase 6). */
let heldToken: string | null = null
/** Whether the signer is installed right now. False after a lock, while `held` survives it. */
let unlocked = false

export interface UnlockDeps {
  loadKey: (passphrase: string) => Promise<string>
  mint: Pick<CredentialMintApi, 'validateToken'>
  install: (privkeyHex: string) => unknown
  now: number
}

/**
 * Unlock this terminal with its passphrase, or say why not.
 *
 * Nothing is installed unless the device is admitted: a refused terminal holds no signer, so
 * nothing on the device can sign for it.
 */
export async function unlockTerminal(
  passphrase: string,
  {
    loadKey = (p) => keyStore.loadKey(p),
    mint = terminalMintApi(),
    install = installTerminalSigner,
    now = Date.now(),
  }: Partial<UnlockDeps> = {},
): Promise<UnlockOutcome> {
  // The device key comes from the raw record, so a record whose token is gone is still a terminal
  // (#160 review, LOW): it is refused below as unreadable, never treated as "not enrolled", which
  // used to send the device to /login as a customer.
  const terminalPubkey = storedTerminalPubkey()
  if (!terminalPubkey) {
    return { unlocked: false, reason: LOGIN_REFUSAL.NOT_ENROLLED, message: LOGIN_MESSAGE[LOGIN_REFUSAL.NOT_ENROLLED] }
  }

  let privkeyHex: string
  try {
    privkeyHex = await loadKey(passphrase)
  } catch {
    return { unlocked: false, reason: 'wrong-passphrase', message: WRONG_PASSPHRASE }
  }
  const devicePubkey = getPublicKey(hexToBytes(privkeyHex))

  // The key the passphrase opened is not the device the record names: this is a person's wallet
  // beside a stale or planted terminal record, not a terminal (spec 2.2, one account per device).
  // Nothing is installed and the mint is not asked, and the screen offers the wallet rather than
  // "Take out of service", whose wipe would erase that person's key.
  if (devicePubkey !== terminalPubkey) {
    return { unlocked: false, reason: 'not-a-terminal-key', message: NOT_A_TERMINAL_KEY }
  }

  // The terminal's own key, but no credential to read: nothing is installed and the mint is not
  // asked. The unlock screen offers to remove the terminal from this device.
  const stored = storedTerminal()
  if (!stored) {
    return { unlocked: false, reason: LOGIN_REFUSAL.UNREADABLE, message: LOGIN_MESSAGE[LOGIN_REFUSAL.UNREADABLE] }
  }

  // Within the twelve hours and for the same key, the idle lock's re-unlock needs no mint call.
  //
  // So a till revoked MID-DAY re-unlocks here without learning of it: the mint is asked only at
  // the session's first unlock. That is accepted, and bounded elsewhere. The revocation is a
  // NUT-07 spend of the credential, and the portal checks it at every issuance, so a revoked
  // till's Sell is refused there, whatever this device believes. What a revoked till can still
  // do until its session ends is redeem, which `canRedeemNow` already allows on an authority
  // nobody could check, because a wrong redemption is recoverable. The twelve-hour session is
  // the outer bound.
  // A renewal adopted since (#160 phase 6) changes the token: the actor is re-derived from it
  // below, keeping the session's twelve hours, so the renewed till sells with no reload.
  if (held && held.devicePubkey === devicePubkey && sessionState(held.session, { now }).live && heldToken === stored.token) {
    install(privkeyHex)
    setRequestCredential(heldCredentialFrom(stored.token))
    unlocked = true
    return { unlocked: true, ...held }
  }
  const keptSession = held && held.devicePubkey === devicePubkey && sessionState(held.session, { now }).live ? held.session : null
  held = null

  const unspent = unspentForLogin(await credentialState(stored.token, mint))
  // The device key is the unlocked key, never the record's (G9), and the stall, role and lock
  // come from the token's signed bytes (IW-15).
  const outcome = loginFromToken({ token: stored.token, devicePubkey, unspent, openedAt: now })
  if (!outcome.admitted) {
    return { unlocked: false, reason: outcome.reason, message: outcome.message }
  }

  install(privkeyHex)
  // The voucher id from the token's signed bytes, not the record's field (IW-15).
  setRequestCredential(heldCredentialFrom(stored.token))
  unlocked = true
  // A renewed credential in a live session keeps that session's clock (spec 2.3: twelve hours
  // from the first unlock), and takes the new answer's kind.
  const session = keptSession ? { ...keptSession, kind: outcome.session.kind } : outcome.session
  held = { devicePubkey, actor: outcome.actor, session }
  heldToken = stored.token
  return { unlocked: true, ...held }
}

/** The session kept across an idle lock, or null when none was opened in this page load. */
export function heldTerminalSession(): {
  devicePubkey: string
  actor: TerminalActor
  session: TerminalSession
} | null {
  return held
}

/** The till, if it is unlocked right now. Null while locked, even with a session held. */
export function openTill(): {
  devicePubkey: string
  actor: TerminalActor
  session: TerminalSession
} | null {
  return unlocked ? held : null
}

/**
 * Spec 049 FR-027d: the open till's authority for a receipt check, from the credential it unlocked
 * with: the signed `stall_pubkey`, `lock_key`, `role` and `owner_attestation`, plus the
 * credential's own expiry, so any of the stall's devices can rebuild the stall's signature. Null
 * while locked, or for a legacy till with no attestation (its checks then count only on the
 * owner's wallet, through the roster).
 */
export function tillCheckProof(): import('./receipts/checks').TerminalProof | null {
  if (!unlocked || !heldToken) return null
  const facts = credentialFromToken(heldToken)
  if (!facts?.attested || facts.expiresAt === undefined) return null
  try {
    const m = JSON.parse(facts.merchantMetadata) as Record<string, unknown>
    const a = m.owner_attestation
    if (typeof m.stall_pubkey !== 'string' || typeof m.lock_key !== 'string' || typeof m.role !== 'string' || !a) return null
    return {
      stall_pubkey: m.stall_pubkey,
      lock_key: m.lock_key,
      role: m.role,
      expires_at: String(facts.expiresAt),
      owner_attestation: a as import('./ownerAttestation').OwnerAttestation,
    }
  } catch {
    return null
  }
}

/** Lock the till: drop the signer, keep the twelve-hour session (spec 2.3). */
export function lockTerminal(): void {
  unlocked = false
  setRequestCredential(null)
  lockTerminalSigner()
}

/** Forget the session too. For tests, and for taking the device out of service. */
export function forgetTerminalSession(): void {
  held = null
  heldToken = null
  unlocked = false
  setRequestCredential(null)
  lockTerminalSigner()
}

/**
 * A renewal was adopted while the till is open (#160 phase 6, plan 2.3): re-derive the actor and
 * the request credential from the NEW token, so Sell lights up with no reload. The session keeps
 * its kind and its twelve hours; only what the credential says changes. Asks the mint, as unlock
 * does, so a renewal that was somehow spent already is not adopted into the session.
 *
 * @returns the refreshed till, or null when nothing changed
 */
export async function refreshAfterRenewal(
  { mint = terminalMintApi(), now = Date.now() }: { mint?: Pick<CredentialMintApi, 'validateToken'>; now?: number } = {},
): Promise<{ devicePubkey: string; actor: TerminalActor; session: TerminalSession } | null> {
  const stored = storedTerminal()
  if (!held || !stored) return null
  const unspent = unspentForLogin(await credentialState(stored.token, mint))
  const outcome = loginFromToken({ token: stored.token, devicePubkey: held.devicePubkey, unspent, openedAt: now })
  if (!outcome.admitted) return null
  held = { devicePubkey: held.devicePubkey, actor: outcome.actor, session: { ...held.session, kind: outcome.session.kind } }
  heldToken = stored.token
  if (unlocked) setRequestCredential(heldCredentialFrom(stored.token))
  return held
}
