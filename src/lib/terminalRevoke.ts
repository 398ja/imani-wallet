import { revokeCredential, type CredentialMintApi } from './credentialRevocation'
import {
  allTerminals,
  expiredWaiting,
  isRevocable,
  revokeTerminal,
  type TerminalRecord,
} from './terminalRoster'
import { parseVoucherToken } from './voucherToken'

/**
 * Revoking a terminal from the owner's phone, for real (#160 phase 1, spec 2.6).
 *
 * Before this, Revoke only marked a local row (G10): nothing reached the mint, so a revoked
 * terminal kept its authority until the credential expired a year later. Since phase 1 the
 * gateway mints every terminal credential with the stall as a co-spender, so the owner's
 * wallet can spend it with the stall's key, and the device is never consulted.
 *
 * ## The row is marked only when the spend landed
 *
 * An owner who believes a stolen till is dead, and is wrong, is worse off than one who knows
 * the revocation did not land. So the roster is changed only when the mint took the spend, or
 * reports the credential already spent. Anything else leaves the row live and says so.
 */

export type MintRevokeOutcome =
  | { revoked: true; record: TerminalRecord }
  | {
      revoked: false
      reason: 'unknown' | 'already-revoked' | 'not-revocable' | 'unreachable'
      message: string
    }

export const REVOKE_MESSAGES = {
  'not-revocable':
    'This terminal was set up before revocation existed, so it cannot be revoked from here. ' +
    'Add the device again to replace it.',
  unreachable:
    'The revocation did not reach the mint, so the terminal is still in service. Try again ' +
    'when you have a connection.',
  unknown: 'That terminal is not on your list.',
  'already-revoked': 'That terminal is already out of service.',
} as const

/**
 * Spend a terminal's credential with the stall's key, then mark its row.
 *
 * @param api the owner's spend client. Its `receive` must carry the NUT-11 witness, which the
 *   wallet's `witness.ts` signs for any secret whose `pubkeys` holds the owner's key.
 */
export async function revokeTerminalAtMint(
  stallPubkey: string,
  terminalPubkey: string,
  api: CredentialMintApi,
  at: number = Date.now(),
): Promise<MintRevokeOutcome> {
  const row = allTerminals(stallPubkey).find((t) => t.terminalPubkey === terminalPubkey)
  if (!row) return refused('unknown')
  if (row.revokedAt !== undefined) return refused('already-revoked')
  if (!isRevocable(row)) return refused('not-revocable')

  let metadata: unknown
  try {
    metadata = parseVoucherToken(row.token!).voucher.merchantMetadata
  } catch {
    return refused('not-revocable')
  }

  const spent = await revokeCredential(row.token!, metadata, api)
  // `already-revoked` from the mint means the credential is spent: the device
  // decommissioned itself, or an earlier attempt landed. Either way it is out
  // of service, which is what the row must now say.
  if (!spent.revoked && spent.reason !== 'already-revoked') {
    return refused(spent.reason === 'not-a-credential' ? 'not-revocable' : 'unreachable')
  }

  const marked = revokeTerminal(stallPubkey, terminalPubkey, at)
  return marked.revoked ? { revoked: true, record: marked.record } : refused(marked.reason)
}

/**
 * Cancel every waiting row past its 24 hours (decision 4 on #160).
 *
 * A credential nobody confirmed is spent, not left in a drawer: it is a live authority to the
 * stall for a device the owner may no longer be holding. Rows whose spend does not land stay
 * waiting and are tried again next time.
 *
 * @returns how many were cancelled
 */
export async function cancelExpiredWaiting(
  stallPubkey: string,
  api: CredentialMintApi,
  now: number = Date.now(),
): Promise<number> {
  let cancelled = 0
  for (const row of expiredWaiting(stallPubkey, now)) {
    const outcome = await revokeTerminalAtMint(stallPubkey, row.terminalPubkey, api, now)
    if (outcome.revoked) cancelled += 1
  }
  return cancelled
}

function refused(reason: keyof typeof REVOKE_MESSAGES): MintRevokeOutcome {
  return { revoked: false, reason, message: REVOKE_MESSAGES[reason] }
}
