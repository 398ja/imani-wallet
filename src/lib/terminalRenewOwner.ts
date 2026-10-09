import { CREDENTIAL_STATE, credentialState, revokeCredential, type CredentialMintApi } from './credentialRevocation'
import {
  MAX_WAITING,
  allTerminals,
  liveTerminals,
  recordTerminal,
  updateTerminal,
  waitingTerminals,
  type TerminalCredentialEntry,
  type TerminalRecord,
} from './terminalRoster'
import {
  CredentialMintError,
  attestEnrolment,
  checkMinted,
  mintTerminalCredential,
  ownerTransport,
  type MintTransport,
} from './terminalMint'
import { grantFor } from './terminalRole'
import { isDefinitiveRefusal } from './terminalRevoke'
import { parseVoucherToken } from './voucherToken'
import { credentialFromToken } from './terminalLogin'
import { DEFAULT_IDLE_LOCK_MINUTES } from './terminalDelivery'
import { renewalMessageJson, type RenewRequest } from './terminalRenewal'
import type { StallSigner } from './ownerAttestation'
import type { PreparedCredential } from './terminalIssue'

/**
 * Renewal from the owner's phone (#160 phase 6, plan 2.3, S3 and S4).
 *
 * **Renew** mints a fresh, attested credential to the SAME device key, with the same name, role
 * and idle lock, and sends it as the credential DM with `renews` (spec 5.1). gateway-customer
 * needs no change: a renewal is an ordinary attested terminal mint (F6). It takes one of the
 * stall's two pending slots for up to 24 hours, as any mint does (Q6: the limit stays, and the
 * rest of a stall's renewals wait their turn).
 *
 * Renew is also the way out for a till minted before owner attestation (S4): the four re-enrol
 * steps are replaced by one tap, and the device needs no new passphrase or setup code.
 *
 * ## Persisted before the request
 *
 * As a `minting` row is (#160 review): the Idempotency-Key and the signed attestation are written
 * on the row's `renewal` before anything is sent, so `resumeRenewal` (on this phone or, through
 * the roster sync, the other) re-sends the identical body and the gateway replays the credential
 * it may already have minted.
 *
 * ## Retired only on the enrolled DM for the NEW voucher
 *
 * The device spends its own old credential once it has adopted the new one (Q2). The owner's
 * app makes the new credential current when the device's enrolled DM names it, and then revokes
 * the old one as the fallback, where `already-revoked` (the device got there first) counts as
 * done. An enrolled DM for the old voucher changes nothing.
 */

/** The gateway lapses an unadopted credential after this long (decision 4). */
export const RENEWAL_TTL_MS = 24 * 3600 * 1000

export type StartRenewalOutcome =
  | { started: true; delivered: boolean }
  | { started: false; reason: 'unknown' | 'not-renewable' | 'too-many-waiting' | 'in-progress' | 'refused' | 'pending'; message: string }

const REFUSAL_MESSAGES = {
  unknown: 'That terminal is not on your list.',
  'not-renewable': 'This terminal cannot be renewed from here. Add the device again instead.',
  'too-many-waiting':
    'Two terminals are already waiting for their device. Renew this one when one of them has picked up its renewal.',
  'in-progress': 'A renewal for this terminal is already on its way.',
  refused: 'The gateway refused the renewal.',
  pending: 'The renewal did not finish. It is picked up the next time you open Terminals with a connection.',
} as const

/** A row an owner may press Renew on: live, in service, holding its token, not renewing already. */
export function isRenewable(row: TerminalRecord): boolean {
  // No status: a row written before phase 2, which was in service by definition.
  const inService = row.status === undefined || row.status === 'in-service'
  return row.revokedAt === undefined && inService && typeof row.token === 'string' && !!row.voucherId
}

/** Unadopted renewals plus waiting rows: what counts against the two-waiting limit (Q6). */
function pendingSlots(stallPubkey: string): number {
  const renewing = liveTerminals(stallPubkey).filter((t) => t.renewal !== undefined).length
  return waitingTerminals(stallPubkey).length + renewing
}

export function canStartRenewal(stallPubkey: string): boolean {
  return pendingSlots(stallPubkey) < MAX_WAITING
}

/**
 * How many tills need renewing but must wait for a free slot (Q6: "3 more to renew"): rows in the
 * amber, red or expired band, or not attested to sell, that are not renewing yet, beyond the slots
 * free right now.
 */
export function renewalsQueued(stallPubkey: string, nowMs: number = Date.now()): number {
  const due = liveTerminals(stallPubkey).filter((t) => isRenewable(t) && !t.renewal && renewalDue(t, nowMs)).length
  return Math.max(0, due - Math.max(0, MAX_WAITING - pendingSlots(stallPubkey)))
}

/** The current credential's signed expiry, epoch seconds, read from the token the row holds. */
export function currentExpiry(row: TerminalRecord): number | undefined {
  if (!row.token) return undefined
  try {
    const at = parseVoucherToken(row.token).voucher.expiresAt
    return typeof at === 'number' ? at : undefined
  } catch {
    return undefined
  }
}

/** Within 30 days of expiry, past it, or a selling till the stall never attested. */
export function renewalDue(row: TerminalRecord, nowMs: number = Date.now()): boolean {
  const expiresAt = currentExpiry(row)
  if (expiresAt !== undefined && expiresAt - Math.floor(nowMs / 1000) <= 30 * 86_400) return true
  if (row.role === 'issue-and-redeem' && row.token) {
    const facts = credentialFromToken(row.token)
    if (facts && !facts.attested) return true
  }
  return false
}

function preparedFor(stallPubkey: string, row: TerminalRecord): PreparedCredential {
  const stall = stallPubkey.toLowerCase()
  return {
    name: row.name,
    stallPubkey: stall,
    role: row.role,
    lockedTo: row.terminalPubkey.toLowerCase(),
    permissions: grantFor(row.role, stall),
    ...(row.idleLockMinutes !== undefined ? { idleLockMinutes: row.idleLockMinutes } : {}),
  }
}

export interface RenewDeps {
  transport?: MintTransport
  api: CredentialMintApi
  /** Publishes the credential DM to the device, sealed by the stall. True when it landed. */
  send: (json: string, terminalPubkey: string) => Promise<boolean>
  now?: number
}

function spendAtOnce(api: CredentialMintApi) {
  return async (token: string) => {
    const metadata = parseVoucherToken(token).voucher.merchantMetadata
    const out = await revokeCredential(token, metadata, api)
    return out.revoked || out.reason === 'already-revoked'
  }
}

/** Mint (or resume) and deliver one row's renewal. The row's `renewal` is already persisted. */
async function runRenewal(stallPubkey: string, row: TerminalRecord, deps: RenewDeps): Promise<'done' | 'pending' | 'cleared'> {
  const renewal = row.renewal!
  const credential = { ...preparedFor(stallPubkey, row), attestation: renewal.attestation }
  const transport = deps.transport ?? ownerTransport
  try {
    const minted = renewal.voucherId
      ? await checkMinted(credential, renewal.voucherId, spendAtOnce(deps.api), transport)
      : await mintTerminalCredential(credential, spendAtOnce(deps.api), transport, {
          idempotencyKey: renewal.mintKey,
          onAccepted: (voucherId) =>
            updateTerminal(stallPubkey, row.terminalPubkey, (r) =>
              r.renewal ? { ...r, renewal: { ...r.renewal, voucherId } } : r,
            ),
        })
    const entry: TerminalCredentialEntry = {
      voucherId: minted.voucherId,
      issuedAt: deps.now ?? Date.now(),
      nonce: renewal.attestation.nonce,
      expiresAt: Number(renewal.attestation.expires_at),
      renews: row.voucherId,
      token: minted.token,
    }
    updateTerminal(stallPubkey, row.terminalPubkey, (r) => ({
      ...r,
      renewal: r.renewal ? { ...r.renewal, voucherId: minted.voucherId, token: minted.token } : r.renewal,
      credentials: [...(r.credentials ?? []).filter((c) => c.voucherId !== minted.voucherId), entry],
    }))
    const delivered = await deps
      .send(
        renewalMessageJson({
          voucherId: minted.voucherId,
          token: minted.token,
          stallPubkey: stallPubkey.toLowerCase(),
          name: row.name,
          idleLockMinutes: row.idleLockMinutes ?? DEFAULT_IDLE_LOCK_MINUTES,
          renews: row.voucherId!,
        }),
        row.terminalPubkey,
      )
      .catch(() => false)
    updateTerminal(stallPubkey, row.terminalPubkey, (r) =>
      r.renewal ? { ...r, renewal: { ...r.renewal, delivered } } : r,
    )
    return 'done'
  } catch (error) {
    // A definitive refusal, or a wrong credential that was spent: nothing live is left behind.
    if (
      error instanceof CredentialMintError &&
      ((error.defect && !error.unspentToken) || isDefinitiveRefusal(error.status))
    ) {
      updateTerminal(stallPubkey, row.terminalPubkey, (r) => ({ ...r, renewal: undefined }))
      return 'cleared'
    }
    return 'pending'
  }
}

/** The owner pressed Renew on a row. */
export async function startRenewal(
  stallPubkey: string,
  terminalPubkey: string,
  deps: RenewDeps & { stallSigner: StallSigner },
): Promise<StartRenewalOutcome> {
  const now = deps.now ?? Date.now()
  const row = allTerminals(stallPubkey).find((t) => t.terminalPubkey === terminalPubkey)
  const refuse = (reason: keyof typeof REFUSAL_MESSAGES): StartRenewalOutcome => ({
    started: false,
    reason,
    message: REFUSAL_MESSAGES[reason],
  })
  if (!row) return refuse('unknown')
  if (row.renewal) return refuse('in-progress')
  if (!isRenewable(row)) return refuse('not-renewable')
  if (!canStartRenewal(stallPubkey)) return refuse('too-many-waiting')

  // Signed once and persisted with the key BEFORE the request, so a resumed mint is identical.
  const attestation = attestEnrolment(preparedFor(stallPubkey, row), deps.stallSigner, now)
  const mintKey = crypto.randomUUID()
  updateTerminal(stallPubkey, terminalPubkey, (r) => ({
    ...r,
    renewal: { startedAt: now, mintKey, attestation },
    renewRequest: undefined,
  }))
  const persisted = allTerminals(stallPubkey).find((t) => t.terminalPubkey === terminalPubkey)!
  const out = await runRenewal(stallPubkey, persisted, deps)
  if (out === 'cleared') return refuse('refused')
  if (out === 'pending') return refuse('pending')
  const after = allTerminals(stallPubkey).find((t) => t.terminalPubkey === terminalPubkey)
  return { started: true, delivered: after?.renewal?.delivered === true }
}

/**
 * Finish every renewal that did not: mint resumed under the same key, or the DM sent again.
 * Called when Terminals opens, like `resumeMinting`.
 */
export async function resumeRenewal(
  stallPubkey: string,
  deps: RenewDeps,
): Promise<{ completed: number; cleared: number; pending: number }> {
  const out = { completed: 0, cleared: 0, pending: 0 }
  for (const row of liveTerminals(stallPubkey)) {
    if (!row.renewal || (row.renewal.token && row.renewal.delivered)) continue
    if (row.renewal.token && row.renewal.voucherId) {
      // Minted and checked; only the DM is missing.
      const ok = await deps
        .send(
          renewalMessageJson({
            voucherId: row.renewal.voucherId,
            token: row.renewal.token,
            stallPubkey: stallPubkey.toLowerCase(),
            name: row.name,
            idleLockMinutes: row.idleLockMinutes ?? DEFAULT_IDLE_LOCK_MINUTES,
            renews: row.voucherId!,
          }),
          row.terminalPubkey,
        )
        .catch(() => false)
      if (ok) {
        updateTerminal(stallPubkey, row.terminalPubkey, (r) =>
          r.renewal ? { ...r, renewal: { ...r.renewal, delivered: true } } : r,
        )
        out.completed += 1
      } else out.pending += 1
      continue
    }
    const result = await runRenewal(stallPubkey, row, deps)
    if (result === 'done') out.completed += 1
    else if (result === 'cleared') out.cleared += 1
    else out.pending += 1
  }
  return out
}

/**
 * The device confirmed it adopted a renewal: make the new credential current and retire the old.
 *
 * Matched on the device key AND the renewal's voucher id; a notice for any other voucher changes
 * nothing. The old credential is revoked as the fallback (Q2): `already-revoked` (the device
 * spent it first) counts as done; an unreachable mint leaves it in history with its token, and
 * `markSpentElsewhere` or the next open settles it.
 *
 * @returns how many renewals completed
 */
export async function completeRenewals(
  stallPubkey: string,
  notices: ReadonlyArray<{ voucherId: string; terminalPubkey: string }>,
  api: CredentialMintApi,
  now: number = Date.now(),
): Promise<number> {
  let done = 0
  for (const notice of notices) {
    const row = liveTerminals(stallPubkey).find(
      (t) =>
        t.terminalPubkey.toLowerCase() === notice.terminalPubkey.toLowerCase() &&
        t.renewal?.voucherId === notice.voucherId &&
        !!t.renewal.token,
    )
    if (!row) continue
    const oldId = row.voucherId!
    const oldToken = row.token
    let oldRetired = false
    if (oldToken) {
      const metadata = (() => {
        try {
          return parseVoucherToken(oldToken).voucher.merchantMetadata
        } catch {
          return null
        }
      })()
      const spent = await revokeCredential(oldToken, metadata, api)
      oldRetired = spent.revoked || spent.reason === 'already-revoked'
      // The device spends the old credential itself at unlock (Q2), so this spend can lose the
      // race ("Proof already used", found by the local gate, E8). Ask the mint once more.
      if (!spent.revoked && spent.reason === 'unreachable') {
        oldRetired = (await credentialState(oldToken, api)) === CREDENTIAL_STATE.REVOKED
      }
    }
    const renewal = row.renewal!
    updateTerminal(stallPubkey, row.terminalPubkey, (r) => ({
      ...r,
      voucherId: renewal.voucherId,
      token: renewal.token,
      attestation: renewal.attestation,
      credentialAt: now,
      renewal: undefined,
      renewRequest: undefined,
      // The device says it holds it; the gateway has not said so yet (#160 round 2).
      gatewayState: 'unconfirmed',
      confirmAttempts: undefined,
      nextConfirmAt: undefined,
      credentials: (r.credentials ?? []).map((c) =>
        c.voucherId === oldId && oldRetired ? { ...c, revokedAt: c.revokedAt ?? now, token: undefined } : c,
      ),
    }))
    done += 1
  }
  return done
}

/**
 * Renewals the device never picked up within 24 hours have lapsed at the gateway (decision 4).
 * Each lapsed credential is spent and dropped, and the old credential stays current.
 *
 * @returns the names of the terminals whose renewal lapsed, for the screen's message
 */
export async function cancelLapsedRenewals(
  stallPubkey: string,
  api: CredentialMintApi,
  now: number = Date.now(),
): Promise<string[]> {
  const lapsed: string[] = []
  for (const row of liveTerminals(stallPubkey)) {
    if (!row.renewal || now - row.renewal.startedAt < RENEWAL_TTL_MS) continue
    const { voucherId, token } = row.renewal
    if (token) {
      const ok = await spendAtOnce(api)(token).catch(() => false)
      if (!ok) continue
    }
    updateTerminal(stallPubkey, row.terminalPubkey, (r) => ({
      ...r,
      renewal: undefined,
      credentials: (r.credentials ?? []).map((c) =>
        c.voucherId === voucherId ? { ...c, revokedAt: c.revokedAt ?? now, token: undefined } : c,
      ),
    }))
    lapsed.push(row.name)
  }
  return lapsed
}

/** What the screen says about a lapsed renewal. */
export const lapsedRenewalMessage = (name: string): string =>
  `The renewal did not reach ${name}. Open the till, then renew again.`

/**
 * A till asked to be renewed (Q3). If the stall's roster has no row for it (logout used to wipe
 * the roster, F4), adopt its credential as a row, after the mint says it is UNSPENT, so the owner
 * can press Renew. Adopting gives the owner a revocation handle and nothing else.
 */
export async function adoptRenewRequest(
  stallPubkey: string,
  request: RenewRequest,
  api: Pick<CredentialMintApi, 'validateToken'>,
  now: number = Date.now(),
): Promise<'adopted' | 'already-listed' | 'spent' | 'unknown-state'> {
  const existing = allTerminals(stallPubkey).find(
    (t) => t.terminalPubkey.toLowerCase() === request.terminalPubkey && t.revokedAt === undefined,
  )
  if (existing) {
    updateTerminal(stallPubkey, existing.terminalPubkey, (r) => ({ ...r, renewRequest: { at: now } }))
    return 'already-listed'
  }
  const state = await credentialState(request.token, api)
  if (state === CREDENTIAL_STATE.REVOKED) return 'spent'
  if (state !== CREDENTIAL_STATE.LIVE) return 'unknown-state'
  recordTerminal(stallPubkey, {
    terminalPubkey: request.terminalPubkey,
    name: request.name,
    role: request.role,
    enrolledAt: now,
    status: 'in-service',
    voucherId: request.voucherId,
    token: request.token,
    renewRequest: { at: now },
    credentials: [
      {
        voucherId: request.voucherId,
        issuedAt: now,
        token: request.token,
        ...(request.expiresAt !== undefined ? { expiresAt: request.expiresAt } : {}),
      },
    ],
  })
  return 'adopted'
}
