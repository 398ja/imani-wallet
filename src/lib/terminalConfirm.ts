import { signedFetch } from './nip98'
import {
  awaitingGatewayConfirm,
  liveTerminals,
  updateTerminal,
  type GatewayState,
} from './terminalRoster'
import { DEFAULT_IDLE_LOCK_MINUTES, sendCredential, type WrapPublisher } from './terminalDelivery'

/**
 * The owner's app makes sure gateway-customer knows a terminal is in service (#160 round 2).
 *
 * Since V27 the gateway refuses Sell for a credential nobody confirmed, and refuses to confirm
 * one after 24 hours (410). The device confirms on setup, but best effort: if that call is
 * lost, the owner's list said "In service" while the gateway refused every sale. So when the
 * owner's app sees the device's enrolled DM, it confirms too, as the stall, and retries with
 * backoff until the gateway answers for good. The list shows the gateway's answer.
 */

/** First retry after 30 s, doubling, capped at an hour. */
export const CONFIRM_BACKOFF_MS = 30_000
export const CONFIRM_BACKOFF_CAP_MS = 60 * 60_000

export function confirmBackoff(attempts: number): number {
  return Math.min(CONFIRM_BACKOFF_MS * 2 ** Math.max(0, attempts - 1), CONFIRM_BACKOFF_CAP_MS)
}

/** `POST .../confirm` as the stall. Returns the HTTP status, or null when nothing came back. */
export type ConfirmCall = (voucherId: string) => Promise<number | null>

export const stallConfirm: ConfirmCall = async (voucherId) => {
  try {
    const r = await signedFetch(
      `/api/v1/wallet/terminal-credentials/${encodeURIComponent(voucherId)}/confirm`,
      'POST',
    )
    return r.status
  } catch {
    return null
  }
}

/** What one status means. Null: not definitive, try again later. */
export function stateFromConfirm(status: number | null): GatewayState | null {
  if (status === 204 || status === 200) return 'confirmed'
  // TERMINAL_CREDENTIAL_EXPIRED: past its 24 hours, or cancelled. It will never sell.
  if (status === 410) return 'lapsed'
  return null
}

/**
 * Confirm every in-service row the gateway has not confirmed yet and is due a try.
 *
 * @returns how many rows changed state
 */
export async function confirmEnrolled(
  stallPubkey: string,
  confirm: ConfirmCall = stallConfirm,
  now: number = Date.now(),
): Promise<number> {
  let changed = 0
  for (const row of awaitingGatewayConfirm(stallPubkey, now)) {
    const state = stateFromConfirm(await confirm(row.voucherId!))
    if (state) {
      updateTerminal(stallPubkey, row.terminalPubkey, (r) => ({
        ...r,
        gatewayState: state,
        confirmAttempts: undefined,
        nextConfirmAt: undefined,
      }))
      changed += 1
    } else {
      updateTerminal(stallPubkey, row.terminalPubkey, (r) => {
        const attempts = (r.confirmAttempts ?? 0) + 1
        return { ...r, confirmAttempts: attempts, nextConfirmAt: now + confirmBackoff(attempts) }
      })
    }
  }
  return changed
}

/**
 * Send the credential DM for every waiting row that has not had one (#160 round 2).
 *
 * A row finished by `resumeMinting`, or one whose send failed on the enrol screen, holds a
 * checked credential the device never received. This sends it the same way the enrol screen
 * does, so the operator only needs the setup code, which the list now shows.
 *
 * @returns how many were sent
 */
export async function deliverWaiting(
  stallPubkey: string,
  sealWith: <T>(borrow: (key: Uint8Array) => T) => T,
  publisher: WrapPublisher,
): Promise<number> {
  let sent = 0
  for (const row of liveTerminals(stallPubkey)) {
    if (row.status !== 'waiting' || !row.token || !row.voucherId || row.delivered) continue
    const ok = await sendCredential(
      {
        voucherId: row.voucherId,
        token: row.token,
        stallPubkey,
        name: row.name,
        idleLockMinutes: row.idleLockMinutes ?? DEFAULT_IDLE_LOCK_MINUTES,
      },
      row.terminalPubkey,
      sealWith,
      publisher,
    ).catch(() => false)
    if (ok) {
      updateTerminal(stallPubkey, row.terminalPubkey, (r) => ({ ...r, delivered: true }))
      sent += 1
    }
  }
  return sent
}
