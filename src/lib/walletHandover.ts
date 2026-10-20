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
 * receive gate and stop every writer, then wait, bounded, for a redemption
 * already past the mint swap to write its coupon. That write is mirrored to the
 * backup as it lands (wallet.ts `backUpWrites`), so the next login restores it
 * even if the other tab's delete then removes this device's copy. Nothing is
 * restarted afterwards: the store is going, and the tab asks for a reload.
 */
import { drainDmPoll, stopDmPoll } from './dmPoll'
import { stopIncomingNotifications } from './incomingNotifications'
import { DRAIN_TIMEOUT_MS } from './logout'
import { closeReceives, drainReceives, drainTokenRedemptions } from './receiveGate'
import { stopRosterSync } from './terminalRosterSyncNet'

export interface HandoverDeps {
  stop: () => void
  drain: (timeoutMs: number) => Promise<boolean>
}

const defaults: HandoverDeps = {
  stop: () => {
    closeReceives()
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
      (await drainTokenRedemptions(left()).catch(() => false))
    )
  },
}

export async function releaseWalletForOtherTab(
  deps: HandoverDeps = defaults,
  timeoutMs = DRAIN_TIMEOUT_MS,
): Promise<void> {
  deps.stop()
  const drained = await deps.drain(timeoutMs).catch(() => false)
  if (!drained) console.warn('[wallet] another tab asked for the store while a receive was still running')
}
