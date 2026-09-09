import { parseTerminalMetadata } from './terminalCredential'

/**
 * Revocation by spending, and the check that must never spend.
 *
 * Terminals ticket 10's last two criteria. ADR 0005 keeps no per-terminal
 * record on the gateway, so there is nothing to delete and nothing to poll.
 * The credential IS the authority, and the only way to withdraw it is to make
 * it unusable — which for a Cashu proof means spending it.
 *
 * ## Why spending is the right primitive
 *
 * It is irreversible and it is global. A revoked terminal cannot come back
 * "anywhere", because the mint will refuse the same proof to any device that
 * presents it, on any network, forever. No revocation list has to be
 * distributed and no device has to be reachable — which is what makes revoking
 * a lost or stolen terminal possible at all.
 *
 * ## The asymmetry that makes this safe
 *
 * Checking state (NUT-07) and spending are different operations, and this
 * module keeps them apart deliberately:
 *
 *   `credentialState` reads.  It is called at every login, forever.
 *   `revokeCredential` spends. It is called once, by the owner, on purpose.
 *
 * If login spent, a terminal could open exactly once and a flat battery would
 * cost a re-enrolment. The two are separate functions with separate names
 * precisely so that a future edit cannot slide one into the other.
 */

/** NUT-07's answer about a proof. */
export const CREDENTIAL_STATE = {
  /** Still good. The terminal may log in. */
  LIVE: 'live',
  /** Spent — the owner revoked it. The terminal is finished, everywhere. */
  REVOKED: 'revoked',
  /**
   * We could not ask.
   *
   * Deliberately NOT 'revoked'. Treating an unreachable mint as revocation
   * would close a stall every time its connection dropped, which is exactly
   * what degraded login exists to prevent.
   */
  UNKNOWN: 'unknown',
} as const

export type CredentialState = (typeof CREDENTIAL_STATE)[keyof typeof CREDENTIAL_STATE]

/** What this module needs of the mint client. Narrow on purpose — see below. */
export interface CredentialMintApi {
  /** NUT-07 checkstate. Reads; never consumes. */
  validateToken(token: string): Promise<{ valid?: boolean; state?: string } | null>
  /** Spends the proof. The revocation itself. */
  receive(token: string, options?: { idempotencyKey?: string }): Promise<unknown>
}

/**
 * Is this credential still good?
 *
 * Takes only the READING half of the mint API in its own right — see
 * `readOnly` below — so the function that runs at every login cannot spend even
 * by accident.
 *
 * `UNKNOWN` on any failure. The caller decides what to do with that, and
 * `terminalLogin` deliberately admits on reduced authority rather than
 * refusing.
 */
export async function credentialState(
  token: string,
  api: Pick<CredentialMintApi, 'validateToken'>,
): Promise<CredentialState> {
  try {
    const answer = await api.validateToken(token)
    if (!answer) return CREDENTIAL_STATE.UNKNOWN

    // SPENT is the only state that means revoked. PENDING is a proof mid-swap,
    // which is a transient the mint resolves — treating it as revoked would
    // retire a terminal over a race.
    if (answer.state === 'SPENT') return CREDENTIAL_STATE.REVOKED
    if (answer.state === 'UNSPENT') return CREDENTIAL_STATE.LIVE
    if (answer.valid === true) return CREDENTIAL_STATE.LIVE
    if (answer.valid === false) return CREDENTIAL_STATE.REVOKED

    return CREDENTIAL_STATE.UNKNOWN
  } catch {
    // The mint was unreachable, or answered something we cannot read. Either
    // way we did not learn that this credential is spent, and inventing that
    // answer would be the failure mode this whole design avoids.
    return CREDENTIAL_STATE.UNKNOWN
  }
}

/**
 * Convert a state into the argument `terminalLogin` takes.
 *
 * `true` live, `false` revoked, `null` we could not ask. Exists so the mapping
 * from "unknown" to "not revoked" is written once, in a place a test can point
 * at, rather than being re-derived by every caller — and re-derived wrongly
 * once, which is all it would take.
 */
export function unspentForLogin(state: CredentialState): boolean | null {
  if (state === CREDENTIAL_STATE.LIVE) return true
  if (state === CREDENTIAL_STATE.REVOKED) return false
  return null
}

export type RevokeOutcome =
  | { revoked: true }
  | { revoked: false; reason: 'already-revoked' | 'unreachable' | 'not-a-credential' }

/**
 * Withdraw a terminal's authority by spending its credential.
 *
 * Irreversible by design: "withdrawing a terminal is revocation, and bringing
 * it back is enrolling it again". There is no unspend, which is the same reason
 * there is no pause.
 *
 * Refuses anything that is not a terminal credential. Spending an arbitrary
 * token here would destroy a customer's coupon, and the owner would have asked
 * to revoke a till.
 *
 * `already-revoked` is a SUCCESS in every sense the owner cares about — the
 * terminal cannot trade — so it is reported distinctly rather than as a
 * failure, and never retried.
 */
export async function revokeCredential(
  token: string,
  metadata: unknown,
  api: CredentialMintApi,
): Promise<RevokeOutcome> {
  // Checked BEFORE spending. The mint cannot tell a terminal credential from a
  // coupon, so this is the only place that distinction can be made, and getting
  // it wrong destroys money rather than authority.
  if (!parseTerminalMetadata(metadata)) {
    return { revoked: false, reason: 'not-a-credential' }
  }

  const before = await credentialState(token, api)
  if (before === CREDENTIAL_STATE.REVOKED) {
    return { revoked: false, reason: 'already-revoked' }
  }

  try {
    await api.receive(token)
    return { revoked: true }
  } catch {
    // Spending failed. The credential is still live, so the owner must be able
    // to try again — reported as unreachable rather than swallowed, because an
    // owner who believes a stolen terminal is dead and is wrong is worse off
    // than one who knows the revocation did not land.
    return { revoked: false, reason: 'unreachable' }
  }
}
