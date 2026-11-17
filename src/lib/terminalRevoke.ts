import { CREDENTIAL_STATE, credentialState, revokeCredential, type CredentialMintApi } from './credentialRevocation'
import {
  WAITING_TTL_MS,
  allTerminals,
  expiredWaiting,
  forgetTerminal,
  isRevocable,
  mintingTerminals,
  revokeTerminal,
  unmintedWaiting,
  updateTerminal,
  type TerminalRecord,
} from './terminalRoster'
import {
  CredentialMintError,
  checkMinted,
  mintTerminalCredential,
  ownerTransport,
  type MintTransport,
} from './terminalMint'
import { grantFor } from './terminalRole'
import { signedFetch } from './nip98'
import { EMPTY_JSON_BODY } from './terminalConfirm'
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

  // A renewal out is a second live credential to the same K, already sent to the device. Revoking
  // the till must spend it too, first, or a stolen device adopts it and keeps selling (review rv6
  // H1). Not revoked until it is spent: the owner is told the revocation did not land.
  const renewal = row.renewal
  if (renewal?.token) {
    let renewalMetadata: unknown
    try {
      renewalMetadata = parseVoucherToken(renewal.token).voucher.merchantMetadata
    } catch {
      renewalMetadata = null
    }
    const out = await revokeCredential(renewal.token, renewalMetadata, api)
    if (!out.revoked && out.reason !== 'already-revoked') return refused('unreachable')
    updateTerminal(stallPubkey, terminalPubkey, (r) => ({
      ...r,
      renewal: undefined,
      credentials: (r.credentials ?? []).map((c) =>
        c.voucherId === renewal.voucherId ? { ...c, revokedAt: c.revokedAt ?? at, token: undefined } : c,
      ),
    }))
    if (renewal.voucherId) await releasePending(renewal.voucherId)
  }

  const spent = await revokeCredential(row.token!, metadata, api)
  // `already-revoked` from the mint means the credential is spent: the device
  // decommissioned itself, or an earlier attempt landed. Either way it is out
  // of service, which is what the row must now say.
  if (!spent.revoked && spent.reason !== 'already-revoked') {
    return refused(spent.reason === 'not-a-credential' ? 'not-revocable' : 'unreachable')
  }

  const marked = revokeTerminal(stallPubkey, terminalPubkey, at)
  // Tell the gateway a waiting credential is gone, so its count of pending
  // credentials for this stall frees the slot now rather than after 24 hours
  // (gateway-customer#187). Best effort: the spend is what revokes.
  if (marked.revoked && row.status === 'waiting' && row.voucherId) {
    await releasePending(row.voucherId)
  }
  return marked.revoked ? { revoked: true, record: marked.record } : refused(marked.reason)
}

/**
 * `POST /api/v1/wallet/terminal-credentials/{id}/cancel`, signed by the stall.
 * Never throws: the gateway's pending count also expires on its own after 24 hours.
 */
export let releasePending = async (voucherId: string): Promise<void> => {
  try {
    await signedFetch(
      `/api/v1/wallet/terminal-credentials/${encodeURIComponent(voucherId)}/cancel`,
      'POST',
      // A body, so the signature carries the `payload` tag the gateway requires on a POST.
      EMPTY_JSON_BODY,
    )
  } catch {
    // Offline. The gateway's own 24-hour expiry frees the slot.
  }
}

/** Swapped by tests, which have no gateway. */
export function setReleasePending(fn: typeof releasePending): void {
  releasePending = fn
}

/**
 * Remove a phase 0 waiting row (#160 review).
 *
 * Phase 0 recorded a waiting row without minting anything, so the row holds no
 * token, cannot be cancelled at the mint, and has nothing to revoke. It is
 * removed locally. Refuses any row that holds a token or is not waiting.
 */
export function removeUnmintedWaiting(stallPubkey: string, terminalPubkey: string): boolean {
  const row = unmintedWaiting(stallPubkey).find((t) => t.terminalPubkey === terminalPubkey)
  if (!row) return false
  forgetTerminal(stallPubkey, terminalPubkey)
  return true
}

/**
 * Whether an HTTP status is the gateway refusing for good (#160 round 2).
 *
 * Only a 4xx says "nothing was minted and asking again will not change that". A 5xx, a
 * proxy 502/504, 408 (timeout) and 429 (slow down) say nothing about whether the gateway
 * minted before it failed, so they are not definitive.
 */
export function isDefinitiveRefusal(status: number | undefined, code?: string): boolean {
  // The same Idempotency-Key still being minted (found by the local gate, #160 phase 6 E8): the
  // other request is minting, so something may exist. Not a refusal; retried later.
  if (code === 'IDEMPOTENCY_IN_PROGRESS') return false
  return status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429
}

/**
 * What a `minting` row becomes when its mint did not finish cleanly. Shared by the enrol
 * screen and `resumeMinting`, so the two cannot drift.
 *
 * - A wrong credential whose spend did not land: keep the token and defect, retry the spend.
 * - A wrong credential that was spent: the row goes, and the gateway slot is released.
 * - A definitive 4xx refusal: nothing was minted, so the row goes.
 * - Anything else (5xx, timeout, network): it may have been minted, so the row stays
 *   `minting` with its Idempotency-Key and is resumed later.
 */
export async function settleMintFailure(
  stallPubkey: string,
  terminalPubkey: string,
  error: unknown,
): Promise<'kept' | 'cleared' | 'pending'> {
  if (error instanceof CredentialMintError && error.unspentToken) {
    const token = error.unspentToken
    updateTerminal(stallPubkey, terminalPubkey, (r) => ({ ...r, token, defect: error.defect }))
    return 'kept'
  }
  if (error instanceof CredentialMintError && error.defect) {
    await forgetSpentDefect(stallPubkey, terminalPubkey)
    return 'cleared'
  }
  if (error instanceof CredentialMintError && isDefinitiveRefusal(error.status, error.code)) {
    forgetTerminal(stallPubkey, terminalPubkey)
    return 'cleared'
  }
  return 'pending'
}

/** A wrong credential was spent: drop its row, and give its gateway slot back at once. */
async function forgetSpentDefect(stallPubkey: string, terminalPubkey: string): Promise<void> {
  const voucherId = allTerminals(stallPubkey).find((t) => t.terminalPubkey === terminalPubkey)?.voucherId
  forgetTerminal(stallPubkey, terminalPubkey)
  if (voucherId) await releasePending(voucherId)
}

/** What `resumeMinting` did with each unsettled row. */
export interface ResumeOutcome {
  /** Rows that now hold a checked credential and wait for their device. */
  completed: number
  /** Rows removed because nothing live was left behind them. */
  cleared: number
  /** Rows left as they were, to try again next time. */
  pending: number
}

/**
 * Finish or clean up every credential request that did not settle (#160 review).
 *
 * The enrol screen writes a `minting` row before it asks the gateway for a
 * credential. A row still `minting` when the owner next opens Terminals is one
 * whose answer, or token, never arrived, or whose wrong credential could not be
 * cancelled. Each is settled here:
 *
 * - a defective credential still held: spend it again; on success the row goes;
 * - a voucher id known: fetch and check the token, then the row waits for its
 *   device, or the wrong credential is spent and the row goes;
 * - only the Idempotency-Key known: send the same request again, so the gateway
 *   replays what it minted (or mints it now), then check as above;
 * - the gateway refuses with a definitive 4xx: nothing was minted, the row goes. A 5xx,
 *   408, 429 or no answer leaves the row, because the gateway may have minted.
 *
 * Anything that cannot reach the network leaves the row for next time.
 */
export async function resumeMinting(
  stallPubkey: string,
  api: CredentialMintApi,
  transport: MintTransport = ownerTransport,
  now: number = Date.now(),
): Promise<ResumeOutcome> {
  const out: ResumeOutcome = { completed: 0, cleared: 0, pending: 0 }
  const spendAtOnce = async (token: string) => {
    const metadata = parseVoucherToken(token).voucher.merchantMetadata
    const spent = await revokeCredential(token, metadata, api)
    return spent.revoked || spent.reason === 'already-revoked'
  }

  for (const row of mintingTerminals(stallPubkey)) {
    try {
      if (row.token && row.defect) {
        if (await spendAtOnce(row.token)) {
          await forgetSpentDefect(stallPubkey, row.terminalPubkey)
          out.cleared += 1
        } else {
          out.pending += 1
        }
        continue
      }

      // Exactly what the enrol screen sent: the same idle lock and the same signed attestation,
      // read back off the row, never signed afresh (spec 4.6.2). A different body under the same
      // Idempotency-Key is refused by the gateway as a different request.
      const credential = {
        name: row.name,
        stallPubkey: stallPubkey.toLowerCase(),
        role: row.role,
        lockedTo: row.terminalPubkey.toLowerCase(),
        permissions: grantFor(row.role, stallPubkey.toLowerCase()),
        ...(row.idleLockMinutes !== undefined ? { idleLockMinutes: row.idleLockMinutes } : {}),
        ...(row.attestation ? { attestation: row.attestation } : {}),
        ...(row.enrolmentProof ? { enrolmentProof: row.enrolmentProof } : {}),
        // A shop's resumed first mint carries the same marker the connect screen sent.
        ...(row.shop ? { onlineShop: true } : {}),
      }
      const minted = row.voucherId
        ? await checkMinted(credential, row.voucherId, spendAtOnce, transport)
        : await mintTerminalCredential(credential, spendAtOnce, transport, {
            idempotencyKey: row.mintKey,
            onAccepted: (voucherId) =>
              updateTerminal(stallPubkey, row.terminalPubkey, (r) => ({ ...r, voucherId })),
          })
      updateTerminal(stallPubkey, row.terminalPubkey, (r) => ({
        ...r,
        status: 'waiting',
        token: minted.token,
        voucherId: minted.voucherId,
        waitingUntil: r.waitingUntil ?? now + WAITING_TTL_MS,
        mintKey: undefined,
      }))
      out.completed += 1
    } catch (e) {
      const settled = await settleMintFailure(stallPubkey, row.terminalPubkey, e)
      if (settled === 'cleared') out.cleared += 1
      else out.pending += 1
    }
  }
  return out
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

/**
 * Mark rows revoked whose credential the mint already reports spent (#160 phase 4, spec 2.6).
 *
 * A credential can be spent without this phone: the device took itself out of service, or the
 * owner revoked it from another phone. The mint is the authority on that, so the Terminals screen
 * asks it about every live row with a token, and a `SPENT` answer marks the row revoked. Only a
 * definite `SPENT` does: an unreachable mint leaves the row exactly as it was, because marking a
 * live till as revoked would hide the one handle that can still revoke it.
 *
 * Read-only at the mint: this never spends.
 *
 * @returns how many rows were marked
 */
export async function markSpentElsewhere(
  stallPubkey: string,
  api: Pick<CredentialMintApi, 'validateToken'>,
  now: number = Date.now(),
): Promise<number> {
  let marked = 0
  for (const row of allTerminals(stallPubkey)) {
    // A credential renewed away whose spend this phone lost to the device's own (Q2, found by the
    // local gate, E8) is still open in the history, token and all. Once the mint says it is spent,
    // the history says so. The till itself is not touched: its current credential answers for it.
    for (const c of row.credentials ?? []) {
      if (!c.token || c.revokedAt !== undefined || c.voucherId === row.voucherId || c.voucherId === row.renewal?.voucherId) continue
      if ((await credentialState(c.token, api)) !== CREDENTIAL_STATE.REVOKED) continue
      updateTerminal(stallPubkey, row.terminalPubkey, (r) => ({
        ...r,
        credentials: (r.credentials ?? []).map((e) =>
          e.voucherId === c.voucherId ? { ...e, revokedAt: e.revokedAt ?? now, token: undefined } : e,
        ),
      }))
    }
    if (row.revokedAt !== undefined || !isRevocable(row) || row.status === 'minting') continue
    if ((await credentialState(row.token!, api)) !== CREDENTIAL_STATE.REVOKED) continue
    // A renewal out (#160 phase 6, Q2): the device spends its OLD credential itself once it has
    // adopted the new one, before this phone has collected the enrolled DM. So the old one being
    // spent is the renewal landing. The renewal's credential is the live handle then; only that
    // one being spent too says the till was revoked.
    if (row.renewal?.token && (await credentialState(row.renewal.token, api)) !== CREDENTIAL_STATE.REVOKED) continue
    if (!revokeTerminal(stallPubkey, row.terminalPubkey, now).revoked) continue
    marked += 1
    // A waiting row still holds one of the stall's pending slots at the gateway. Give it back,
    // as revoking it from this phone does (#160 review), rather than leave the owner blocked
    // from adding a terminal until the gateway's own 24-hour expiry.
    if (row.status === 'waiting' && row.voucherId) await releasePending(row.voucherId)
  }
  return marked
}
