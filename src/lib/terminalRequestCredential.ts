/**
 * The terminal credential an unlocked till acts under (#160 phase 5, spec 5.1 and 5.4).
 *
 * Two uses, both only while the till is unlocked:
 *
 * - **Every signed request names it.** A terminal signs NIP-98 under its own key `K`, which on
 *   its own says nothing about which stall it acts for. The portal's
 *   `TerminalCredentialAuthFilter` reads `X-Imani-Terminal-Credential: <voucherId>`, asks
 *   gateway-core what that credential grants the signer, and adds those grants as authorities.
 * - **Every `terminal` warrant carries it.** The credential's signed NUT-10 secret goes into the
 *   warrant (never the proof's `C`, so it is not spendable), so a customer can check offline
 *   that the stall's issuing service vouched for `K`.
 *
 * `unlockTerminal` sets it from the token's signed bytes (never the record's `voucherId` field),
 * and every lock clears it along with the signer. A module of its own so `nip98.ts` and
 * `warrantSigner.ts` can read it without importing the till (and so the Node services, which
 * load `nip98.ts`, never pull in the Vite-only credential reader).
 */
/** The request header naming the credential. */
export const TERMINAL_CREDENTIAL_HEADER = 'X-Imani-Terminal-Credential'

export interface HeldCredential {
  /** The credential's voucher id, from its signed bytes. */
  voucherId: string
  /** The stall the credential names, from its signed `issuer`. */
  stallPubkey: string
  /** The credential's NUT-10 secret, verbatim. */
  secret: string
}

let current: HeldCredential | null = null

/** Set when the till unlocks; `null` when it locks. */
export function setRequestCredential(credential: HeldCredential | null): void {
  current = credential
}

/** The credential this till acts under, or null on an owner's or customer's device. */
export function requestCredential(): HeldCredential | null {
  return current
}
