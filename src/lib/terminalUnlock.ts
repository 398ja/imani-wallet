import { getPublicKey } from 'nostr-tools'
import { hexToBytes } from '@noble/hashes/utils'

import { installTerminalSigner, keyStore, lockTerminalSigner } from './nap'
import { storedTerminal, storedTerminalPubkey } from './terminalEnrol'
import { LOGIN_MESSAGE, LOGIN_REFUSAL, loginFromToken, type LoginRefusal } from './terminalLogin'
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

/** The session the last unlock opened. In memory only: see the module comment. */
let held: { devicePubkey: string; actor: TerminalActor; session: TerminalSession } | null = null
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
  if (held && held.devicePubkey === devicePubkey && sessionState(held.session, { now }).live) {
    install(privkeyHex)
    unlocked = true
    return { unlocked: true, ...held }
  }
  held = null

  const unspent = unspentForLogin(await credentialState(stored.token, mint))
  // The device key is the unlocked key, never the record's (G9), and the stall, role and lock
  // come from the token's signed bytes (IW-15).
  const outcome = loginFromToken({ token: stored.token, devicePubkey, unspent, openedAt: now })
  if (!outcome.admitted) {
    return { unlocked: false, reason: outcome.reason, message: outcome.message }
  }

  install(privkeyHex)
  unlocked = true
  held = { devicePubkey, actor: outcome.actor, session: outcome.session }
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

/** Lock the till: drop the signer, keep the twelve-hour session (spec 2.3). */
export function lockTerminal(): void {
  unlocked = false
  lockTerminalSigner()
}

/** Forget the session too. For tests, and for taking the device out of service. */
export function forgetTerminalSession(): void {
  held = null
  unlocked = false
  lockTerminalSigner()
}
