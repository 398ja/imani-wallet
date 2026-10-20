/**
 * Let another tab have the wallet's store (#352).
 *
 * When another tab deletes this account's store (its logout) or opens it at a
 * newer version, this tab must close its connection, or that tab's delete and
 * every later open behind it wait for as long as this tab lives. On staging
 * 0.33.0 that was a login stuck on "Opening wallet…" until the user closed
 * every other wallet tab.
 *
 * Before letting go, the same order logout uses (logout.ts step 3): close the
 * receive AND send gates and stop every writer, then wait for a redemption
 * already past the mint swap to write its coupon, and for a send settling its
 * change. That write is mirrored to the backup as it lands (wallet.ts
 * `backUpWrites`), so the next login restores it even if the other tab's delete
 * then removes this device's copy. Nothing is restarted afterwards: the store
 * is going, and the tab asks for a reload.
 *
 * Unlike logout, this cannot refuse, so it does not give up either (review of
 * #353): a receive still running when the wait runs out would write its coupon
 * to a closed store after the mint swap, and that coupon is lost. Holding the
 * store a little longer only keeps the other tab on "Close your other wallet
 * tabs", which is honest and costs nothing.
 */
import { drainDmPoll, stopDmPoll } from './dmPoll'
import { stopIncomingNotifications } from './incomingNotifications'
import { DRAIN_TIMEOUT_MS } from './logout'
import { closeReceives, closeSpends, drainReceives, drainSpends, drainTokenRedemptions } from './receiveGate'
import { stopRosterSync } from './terminalRosterSyncNet'

export interface HandoverDeps {
  stop: () => void
  drain: (timeoutMs: number) => Promise<boolean>
}

const defaults: HandoverDeps = {
  stop: () => {
    closeReceives()
    closeSpends()
    stopDmPoll()
    stopRosterSync()
    stopIncomingNotifications()
  },
  drain: async (timeoutMs) => {
    const deadline = Date.now() + timeoutMs
    const left = () => Math.max(0, deadline - Date.now())
    return (
      (await drainDmPoll(left()).catch(() => false)) &&
      (await drainReceives(left()).catch(() => false)) &&
      (await drainTokenRedemptions(left()).catch(() => false)) &&
      (await drainSpends(left()).catch(() => false))
    )
  },
}

/** Pause between two waits, so a drain that answers at once cannot spin the page. */
export const HANDOVER_RETRY_MS = 1_000

export async function releaseWalletForOtherTab(
  deps: HandoverDeps = defaults,
  timeoutMs = DRAIN_TIMEOUT_MS,
  retryMs = HANDOVER_RETRY_MS,
): Promise<void> {
  deps.stop()
  while (!(await deps.drain(timeoutMs).catch(() => false))) {
    console.warn('[wallet] another tab asked for the store while a receive or a send was still running; waiting')
    await new Promise((resolve) => setTimeout(resolve, retryMs))
  }
}
