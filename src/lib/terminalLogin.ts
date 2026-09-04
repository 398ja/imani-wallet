import { credentialActor, parseTerminalMetadata } from './terminalCredential'
import { openSession, SESSION_KIND, type TerminalSession } from './terminalSession'
import type { TerminalActor } from './actor'

/**
 * Terminal login: turn a stored credential back into a session.
 *
 * Terminals ticket 10. What a device does on launch, "without a person
 * present" — it holds a credential and its own key, and must decide what it may
 * do today.
 *
 * ## Permissions come from the CREDENTIAL, never from a stored record
 *
 * The ticket's third criterion, and the reason this module exists rather than
 * `storedTerminal()` being trusted directly. The record on disk is a
 * convenience; the credential is the authority. Anything editable by whoever
 * holds the device must not be able to widen what the device may do, so the
 * token is re-read and re-verified at every login and the permissions are
 * derived fresh from its role.
 *
 * ## Verification never spends
 *
 * The ticket's last criterion. Logging in re-reads bytes the device already
 * holds and checks a lock; it makes no call that could consume the credential.
 * A login that spent would mean a terminal could log in exactly once, and a
 * flat battery would cost an enrolment.
 *
 * ## Degraded login is redeem-only
 *
 * When the mint cannot be reached the credential's signature cannot be checked
 * against a live keyset, so the session opens REDUCED: redemption, never
 * issuance. A queue at a stall cannot wait for the network to agree, and
 * issuance is value-bearing. This is a deliberate, bounded weakening rather
 * than a bypass — the lock is still checked, because that check needs nobody.
 */

export const LOGIN_REFUSAL = {
  /** No credential on this device. It has never been enrolled, or was wiped. */
  NOT_ENROLLED: 'not-enrolled',
  /** The credential is not readable as a terminal credential at all. */
  UNREADABLE: 'unreadable',
  /** Not locked to this device, or not issued by the stall it names. */
  NOT_OURS: 'not-ours',
  /** The mint says the credential has been spent — the owner revoked it. */
  REVOKED: 'revoked',
} as const

export type LoginRefusal = (typeof LOGIN_REFUSAL)[keyof typeof LOGIN_REFUSAL]

export const LOGIN_MESSAGE: Record<LoginRefusal, string> = {
  [LOGIN_REFUSAL.NOT_ENROLLED]:
    'This device is not set up as a terminal yet. Ask the stall owner to add it.',
  [LOGIN_REFUSAL.UNREADABLE]:
    'This terminal’s authority cannot be read. Ask the stall owner to set it up again.',
  [LOGIN_REFUSAL.NOT_OURS]:
    'This authority is not for this device. Ask the stall owner to set it up again.',
  [LOGIN_REFUSAL.REVOKED]:
    'This terminal is no longer in service. Ask the stall owner to set it up again.',
}

export type LoginOutcome =
  | { admitted: true; actor: TerminalActor; session: TerminalSession }
  | { admitted: false; reason: LoginRefusal; message: string }

export interface LoginInput {
  /** The voucher's `merchant_metadata`, as stored. */
  merchantMetadata: unknown
  /**
   * The stall, from the voucher's `issuerId`.
   *
   * `issuerId`, NOT `issuerPublicKey`. The latter is the GATEWAY's signing key
   * and is identical on every voucher it mints, so checking the stall against
   * it refuses every real credential — found by minting one for real, and
   * invisible to fixtures this app wrote for itself.
   */
  issuerId: string
  /** This device's own public key. */
  devicePubkey: string
  /**
   * Whether the credential is still unspent, if we could ask.
   *
   * `null` means we could not reach the mint. That is NOT treated as revoked:
   * failing closed here would take a stall off the market every time its
   * connection dropped, which is the outcome the whole degraded-login design
   * exists to avoid. It opens a REDUCED session instead.
   */
  unspent: boolean | null
  openedAt?: number
}

/**
 * Admit this device, or say why not.
 *
 * The order is deliberate: cheap local checks first, and the mint's answer
 * last, so a device with a credential meant for another terminal is refused
 * without a network round trip.
 */
export function loginTerminal({
  merchantMetadata,
  issuerId,
  devicePubkey,
  unspent,
  openedAt = Date.now(),
}: LoginInput): LoginOutcome {
  if (merchantMetadata === null || merchantMetadata === undefined || merchantMetadata === '') {
    return refuse(LOGIN_REFUSAL.NOT_ENROLLED)
  }

  const metadata = parseTerminalMetadata(merchantMetadata)
  if (!metadata) return refuse(LOGIN_REFUSAL.UNREADABLE)

  // The lock and the issuer, checked together. Both need nothing but the bytes
  // in hand, which is why they still hold with the mint unreachable.
  const actor = credentialActor(metadata, devicePubkey, { issuerId })
  if (!actor) return refuse(LOGIN_REFUSAL.NOT_OURS)

  // Only a definite NO from the mint revokes. `null` is "we could not ask".
  if (unspent === false) return refuse(LOGIN_REFUSAL.REVOKED)

  return {
    admitted: true,
    actor: { ...actor, name: metadata.name } as TerminalActor,
    session: openSession(
      actor as TerminalActor,
      // Reduced when the mint could not confirm the credential is live. The
      // terminal still redeems, because a queue cannot wait; it does not issue,
      // because issuing on an authority nobody could check is money created on
      // a guess.
      unspent === true ? SESSION_KIND.FULL : SESSION_KIND.REDUCED,
      openedAt,
    ),
  }
}

function refuse(reason: LoginRefusal): LoginOutcome {
  return { admitted: false, reason, message: LOGIN_MESSAGE[reason] }
}
