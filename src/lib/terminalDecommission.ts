import { storedTerminal } from './terminalEnrol'
import { revokeCredential, type CredentialMintApi } from './credentialRevocation'
import { logout } from './logout'
import { confirmBackups, type BackupCheck } from './voucherRecords'
import { moneyInFlight } from './inFlightMoney'
import { credentialFromToken } from './terminalLogin'

/**
 * Taking a terminal out of service, from the device itself.
 *
 * Terminals ticket 08. A device leaving the stall — sold, returned, reassigned
 * — should be able to hand its authority back without the owner present.
 *
 * ## The order is the whole point
 *
 * Revoke, THEN erase. Wiping first would leave a live authority attached to a
 * device nobody controls any more: the credential would still be unspent, so
 * anyone who recovered the storage could trade with it, and the owner would
 * have no idea because their roster still shows the terminal as live.
 *
 * So a failed revocation stops everything. The device keeps its credential and
 * says so, which is worse for whoever wants to hand the device over and far
 * better than a wipe that silently leaves a working key in the world.
 *
 * ## It is not a logout
 *
 * The existing logout copy promises an account, a business and past sales all
 * come back with a backup key. None of that is true here: a terminal holds no
 * coupons, has no key its holder should ever write down, and returns only by
 * being enrolled again by the owner. Saying otherwise would send someone
 * hunting for a backup key that was never theirs.
 */

export const DECOMMISSION_REFUSAL = {
  /** Not a terminal. The caller should be offering logout instead. */
  NOT_A_TERMINAL: 'not-a-terminal',
  /** The revocation did not land. Nothing was erased — see above. */
  REVOKE_FAILED: 'revoke-failed',
  /**
   * Vouchers on this device are not confirmed as backed up (owner rule
   * 2026-10-18, review of #326). Checked BEFORE revoking: the wipe at the end
   * goes through `logout`, which would refuse, and a device revoked but not
   * wiped is the one state this file exists to avoid.
   */
  VOUCHERS_UNCONFIRMED: 'vouchers-unconfirmed',
} as const

export type DecommissionRefusal =
  (typeof DECOMMISSION_REFUSAL)[keyof typeof DECOMMISSION_REFUSAL]

export type DecommissionOutcome =
  | { done: true }
  | { done: false; reason: DecommissionRefusal; message: string }

/**
 * What this screen says, written for a terminal.
 *
 * No mention of a backup key, an account, or past sales, because a terminal
 * has none of those. The one thing it promises is the one thing that is true:
 * the owner can set it up again.
 */
export const DECOMMISSION_COPY = {
  title: 'Take this terminal out of service',
  /** Standing description, above the button. What the operation IS. */
  body:
    'This hands back the terminal’s authority and erases it from this device. ' +
    'The stall keeps every sale this terminal made. To use this device again, ' +
    'the stall owner adds it as a terminal.',
  /**
   * The confirmation, at the point of deciding. Deliberately NOT the body
   * repeated: showing the same sentence twice makes the second one furniture,
   * and the second is the one being read hardest. This one names the
   * irreversibility that the description does not need to lead with.
   */
  confirmBody:
    'This cannot be undone from this device. The terminal stops trading ' +
    'immediately and only the stall owner can bring it back.',
  confirm: 'Take out of service',
  /** Shown when revocation fails. Names what did NOT happen, which is the point. */
  failed:
    'Could not hand back this terminal’s authority, so nothing has been erased. ' +
    'Check the connection and try again, or ask the stall owner to revoke it.',
  /** Shown when this device holds vouchers that are not confirmed as backed up. */
  vouchersUnconfirmed:
    'This device holds vouchers that are not confirmed as backed up, so nothing has been ' +
    'erased and the terminal is still in service. Check the connection and try again.',
} as const

/**
 * Hand back this terminal's authority, then erase it.
 *
 * Returns rather than throwing, because every outcome here is something a
 * person is waiting to be told.
 */
export async function decommissionTerminal(
  api: CredentialMintApi,
  /** The device's own pubkey, for the wallet wipe. */
  pubkey: string,
  /**
   * Injected so a test can navigate without a DOM.
   *
   * There is deliberately no `confirm` parameter. The confirmation belongs to
   * the SCREEN, which shows the terminal's words; `logout`'s own copy promises
   * a backup key that a terminal's holder does not have, so this must never be
   * the thing that asks.
   */
  reload: () => void = () => window.location.replace('/'),
  /** Injected for tests. The same read-back check logout makes. */
  checkBackups: (pubkey: string) => Promise<BackupCheck> = confirmBackups,
): Promise<DecommissionOutcome> {
  const stored = storedTerminal()

  // The metadata comes from the token's own signed bytes, not from the record (#160 phase 3).
  const facts = stored?.token ? credentialFromToken(stored.token) : null
  if (!stored?.token || !facts) {
    // Not a terminal, or one enrolled before credentials were stored. Either
    // way there is no authority to hand back, and wiping here would be a
    // logout wearing a terminal's words.
    return {
      done: false,
      reason: DECOMMISSION_REFUSAL.NOT_A_TERMINAL,
      message: 'This device is not a terminal.',
    }
  }

  // Before revoking (see VOUCHERS_UNCONFIRMED). A terminal holds no coupons
  // in the normal case, so this is one empty read; if it ever does hold some,
  // they are money and the owner rule applies to them as to anyone's.
  const backups = await checkBackups(pubkey).catch(
    (): BackupCheck => ({ ok: false, reason: 'store-unreadable', unconfirmed: [], fingerprint: '' }),
  )
  const inFlight = moneyInFlight(pubkey)
  if (!backups.ok || inFlight.sends > 0 || inFlight.swaps > 0) {
    return {
      done: false,
      reason: DECOMMISSION_REFUSAL.VOUCHERS_UNCONFIRMED,
      message: DECOMMISSION_COPY.vouchersUnconfirmed,
    }
  }

  const revoked = await revokeCredential(stored.token, facts.merchantMetadata, api)

  // `already-revoked` counts as success: the owner has revoked it remotely and
  // the device is finishing the job. Refusing here would strand a device that
  // is already powerless, still holding a key.
  if (!revoked.revoked && revoked.reason !== 'already-revoked') {
    return {
      done: false,
      reason: DECOMMISSION_REFUSAL.REVOKE_FAILED,
      message: DECOMMISSION_COPY.failed,
    }
  }

  // Only now, and through the SAME teardown a logout uses.
  //
  // Reused rather than reimplemented because that function is where the hard
  // parts live: stopping the pollers before the key goes, clearing the resume
  // cache that would otherwise walk straight back in, and wiping every
  // `imani-wallet:*` key rather than a list that has already grown three
  // times. A second copy here would be the one that misses the fourth.
  //
  // The confirmation is passed as ALREADY GIVEN: this function's own caller
  // has shown the terminal's words, and `logout`'s copy promises a backup key
  // that a terminal's holder does not have.
  const wiped = await logout(pubkey, () => true, reload)
  if (!wiped) {
    // `logout` returns false when declined (ours always accepts) or when its
    // backup check refuses, which the check above makes unlikely but cannot
    // rule out (a voucher arriving in between). Reported, never ignored:
    // the device is revoked but its vouchers are kept, which is the safe half.
    return {
      done: false,
      reason: DECOMMISSION_REFUSAL.REVOKE_FAILED,
      message: DECOMMISSION_COPY.failed,
    }
  }

  return { done: true }
}
