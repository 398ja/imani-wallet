import { useEffect } from 'react'

import type { CredentialMintApi } from '../lib/credentialRevocation'
import { confirmEnrolled, type ConfirmCall } from '../lib/terminalConfirm'
import type { MintTransport } from '../lib/terminalMint'
import { cancelExpiredWaiting, markSpentElsewhere, resumeMinting } from '../lib/terminalRevoke'
import { hasUnconfirmed, type TerminalRecord } from '../lib/terminalRoster'

/**
 * The roster upkeep a screen that shows terminals runs while it is open (#160): once on opening,
 * and a poll while something waits for its device.
 *
 * Lifted out of `TerminalsPage` unchanged in order so the Online shop screen (#402) runs exactly
 * the same pass for a shop: a shop is a terminal, and a duty this pass does that its screen skipped
 * (resending a credential DM that did not land, collecting a renewal's pickup, noticing a revoke
 * from another phone) would quietly let the shop lapse.
 */
export interface TerminalUpkeepDeps {
  spendApi: () => Promise<CredentialMintApi>
  transport: MintTransport
  /** Phase 2: promotes waiting rows (and renewals) whose device confirmed. */
  collect: (stallPubkey: string) => Promise<number>
  /** Round 2: the stall's `/confirm` call. */
  confirm: ConfirmCall
  /** Sends the credential DM to waiting devices that never got one. */
  deliver: (stallPubkey: string) => Promise<number>
  /** Phase 6: merges the roster the owner's other devices published. */
  sync: (stallPubkey: string) => Promise<boolean>
  /** Phase 6: resumes, cancels and adopts renewals. */
  renewals: (stallPubkey: string, api: CredentialMintApi, transport: MintTransport) => Promise<{ changed: number; lapsed: string[] }>
}

/** How often a screen looks for a device's "I have it" while something is waiting. */
export const ENROLLED_POLL_MS = 5_000

export function useTerminalUpkeep(
  stallPubkey: string,
  rows: readonly TerminalRecord[],
  deps: TerminalUpkeepDeps,
  refresh: () => void,
  onLapsed?: (names: string[]) => void,
): void {
  const { spendApi, transport, collect, confirm, deliver, sync, renewals } = deps

  // Phase 2: while a row waits, look for its device's enrolled DM, so the row
  // turns In service without a reload (spec 2.1 step 4).
  // Round 2: and while a row is in service by the device's word but not yet confirmed at the
  // gateway, confirm it as the stall, with backoff, so a lost device confirm cannot leave a
  // till the list calls in service and the gateway refuses.
  const hasWaiting = rows.some((t) => (t.status === 'waiting' || t.renewal !== undefined) && t.revokedAt === undefined)
  const needsConfirm = hasUnconfirmed(stallPubkey) || rows.some((t) => t.gatewayState === 'unconfirmed')
  useEffect(() => {
    if (!hasWaiting && !needsConfirm) return
    let stopped = false
    const tick = async () => {
      try {
        await collect(stallPubkey)
      } catch {
        // Offline or locked. Try again on the next tick.
      }
      // Show the promotion now, not after the confirm below answers.
      if (!stopped) refresh()
      try {
        await confirmEnrolled(stallPubkey, confirm)
      } catch {
        // Retried on the next tick, after its backoff.
      }
      // Re-read the roster whatever the count said. Under StrictMode the first
      // effect's poll can promote the row after it was torn down, and the
      // second then reports nothing changed: trusting the count left the row
      // showing Waiting for good.
      if (!stopped) refresh()
    }
    void tick()
    const timer = setInterval(() => void tick(), ENROLLED_POLL_MS)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [hasWaiting, needsConfirm, stallPubkey, collect, confirm, refresh])

  // Waiting rows past their 24 hours are cancelled when the screen opens
  // (decision 4 on #160). Best effort: one that does not land stays waiting and
  // is tried again next time, and nothing here blocks the screen from showing.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        // The list from the owner's other devices first (#160 phase 6), merged into this one,
        // so a terminal added or revoked on another phone shows here.
        if (await sync(stallPubkey).catch(() => false)) {
          if (!cancelled) refresh()
        }
        const api = await spendApi()
        // Settle any credential request that did not finish (#160 review)
        // before expiring waiting rows, so a request that is resumed now and
        // turns out to be past its 24 hours is cancelled in the same pass.
        const resumed = await resumeMinting(stallPubkey, api, transport)
        const n = await cancelExpiredWaiting(stallPubkey, api)
        // Renewals (#160 phase 6): finish any that did not, cancel any the device never picked up
        // in 24 hours, and adopt renew requests from tills this list lost (Q3).
        const { changed, lapsed: gone } = await renewals(stallPubkey, api, transport).catch(() => ({ changed: 0, lapsed: [] as string[] }))
        if (gone.length > 0 && !cancelled) onLapsed?.(gone)
        if (changed > 0 && !cancelled) refresh()
        // A credential spent somewhere else (the device took itself out of service, or another
        // of the owner's phones revoked it) reads as revoked here too (#160 phase 4).
        const elsewhere = await markSpentElsewhere(stallPubkey, api).catch(() => 0)
        // A row resumeMinting finished, or whose DM did not land, gets its DM now, the same
        // one the enrol screen sends (#160 round 2).
        const sent = await deliver(stallPubkey).catch(() => 0)
        if ((n > 0 || elsewhere > 0 || sent > 0 || resumed.completed > 0 || resumed.cleared > 0) && !cancelled) refresh()
      } catch {
        // Offline, or the wallet is locked. The rows stay waiting.
      }
    })()
    return () => {
      cancelled = true
    }
    // `onLapsed` is a notice sink, not an input: a new one must not re-run the pass.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stallPubkey, spendApi, transport, deliver, sync, renewals, refresh])
}
