import { isKeptAcrossLogout } from './unsavedReceipt'
import { getSession, keyStore, resetSession } from './nap'
import { drainDmPoll, startDmPoll, stopDmPoll } from './dmPoll'
import { startRosterSync, stopRosterSync } from './terminalRosterSyncNet'
import { stopOnlineShopSync } from './onlineShopPublisher'
import { startIncomingNotifications, stopIncomingNotifications } from './incomingNotifications'
import { disableNotifications } from './notifications/manager'
import { forgetResume } from './resume'
import { openWallet, voucherWriteCount, wipeWallet } from './wallet'
import {
  confirmBackups,
  heldFingerprint,
  type BackupCheck,
  type ConfirmOptions,
  type UnconfirmedCoupon,
} from './voucherRecords'
import { sweepAppStorage } from './appStorage'
import { carryPendingClaimsAcrossLogout } from './pendingClaim'
import { moneyInFlight } from './inFlightMoney'
import { strandedCashlinks } from './transactions'
import { confirmStashBackup, stashFingerprint, type StashCheck } from './cashbackStash'
import {
  closeReceives,
  closeSpends,
  drainReceives,
  drainSpends,
  drainTokenRedemptions,
  openReceives,
  openSpends,
  receivesInFlight,
  spendsInFlight,
  tokenRedemptionsInFlight,
} from './receiveGate'
import { pauseOtherTabs, type PauseResult } from './logoutTabs'

/**
 * Log out: end the session and erase the key from this browser.
 *
 * This is bottin's logout, and it is destructive in the same way — but it means
 * more here. bottin erases a directory identity; this wallet's key also decrypts
 * the coupons in IndexedDB, which are bearer tokens. Erasing the key without the
 * nsec or a backup file makes them unspendable. Hence the confirmation, and
 * hence its wording naming the coupons rather than only "your key".
 *
 * It now erases the DATA as well as the key. That is only defensible because
 * nothing here is unique to the device any more: the profile and the stall are
 * addressable events on the relay, and every sale is published there too,
 * NIP-44 encrypted to the merchant's own key (lib/issuedRecords.ts). Logging
 * back in with the nsec rebuilds all three. Held coupons come back from their
 * kind-7375 records (voucherRecords.ts), NOT from the DM pipeline: a received
 * coupon's DM carried a token the mint swap has already spent. A coupon whose
 * record cannot be READ BACK is money that exists only on this device, so
 * logout is refused until every one is confirmed (`attemptLogout`, owner rule
 * 2026-10-18).
 *
 * Leaving the data behind was the older, weaker promise: a shared or borrowed
 * device kept a readable ledger of someone else's takings long after they had
 * "logged out".
 *
 * There is no non-destructive alternative wired to this button on purpose: nap
 * supports locking (the key is zeroed but the encrypted copy stays), and if a
 * "lock" affordance is ever wanted it should be a separate action, not a
 * softening of this one.
 */
export const LOGOUT_WARNING =
  'This erases your key AND all your data from this browser.\n\n' +
  'Your account, your business and your sales come back when you log in with your ' +
  'backup key: they are stored under your account, not on this device. ' +
  'Vouchers you are holding are backed up under your account and come back when ' +
  'you log in again. This wallet has just checked every one of them.\n\nThe only way back in is your backup key, a backup file, or a Google ' +
  'Drive backup — you MAKE those under Settings → Backup, and you USE them from ' +
  'the screen this lands on. There is no password reset.\n\n' +
  'Log out?'

/**
 * Why logout is refused, in plain words (owner rule 2026-10-18 17:52Z, review
 * of #326). Shown with the count and value of what is not confirmed and a
 * Retry. There is NO "log out anyway": this is a refusal, not a warning.
 */
export const LOGOUT_BLOCKED_COPY = {
  title: 'You can’t log out yet',
  unconfirmed: (count: number, value: string) =>
    `${count} voucher${count === 1 ? '' : 's'} worth ${value} ${count === 1 ? 'is' : 'are'} not ` +
    'confirmed as backed up. Logging out would delete ' +
    (count === 1 ? 'it' : 'them') +
    ' from this browser for good, so logging out stays off until every voucher is safe. ' +
    'Nothing has been erased. Check your connection and try again.',
  locked:
    'Unlock your wallet first. Your vouchers can only be checked and backed up while it is unlocked, ' +
    'and logging out stays off until every voucher is confirmed safe. Nothing has been erased.',
  unreadable:
    'This wallet could not read its vouchers to check them, so logging out stays off. ' +
    'Nothing has been erased. Reload the page and try again.',
  changed:
    'A voucher arrived while you were logging out. It is not confirmed as backed up yet, so ' +
    'logging out stays off. Nothing has been erased. Try again in a moment.',
  cashbackUnconfirmed: (count: number) =>
    `${count} cashback voucher${count === 1 ? '' : 's'} waiting to be added to this wallet ` +
    `${count === 1 ? 'is' : 'are'} not confirmed as backed up, so logging out stays off until ` +
    `${count === 1 ? 'it is' : 'they are'} safe. Nothing has been erased. Check your connection and try again.`,
  inFlight:
    'A payment or a Cashlink is still going through. Logging out now could lose it, so ' +
    'logging out stays off until it finishes. Nothing has been erased. Try again in a moment.',
  otherTab:
    'This wallet is open in another tab or window, and it could not be paused safely. ' +
    'Close the other tabs of this wallet, or wait for them to finish, then try again. Nothing has been erased.',
  retry: 'Try again',
  close: 'Not now',
} as const

/** What a logout attempt did. `blocked` erased NOTHING. */
export type LogoutOutcome =
  | { status: 'done' }
  | { status: 'cancelled' }
  | {
      status: 'blocked'
      reason:
        | 'unconfirmed'
        | 'locked'
        | 'store-unreadable'
        | 'changed'
        | 'in-flight'
        | 'cashback-unconfirmed'
        | 'other-tab'
      unconfirmed: UnconfirmedCoupon[]
      /** For 'cashback-unconfirmed': how many stashed cashback tokens are not confirmed. */
      cashback?: number
    }

export interface LogoutDeps {
  /** The read-back check. Injected for tests. Must never answer ok on a failure. */
  checkBackups?: (pubkey: string, options?: ConfirmOptions) => Promise<BackupCheck>
  /** Restart what logout stopped, when the final check refuses. */
  restartWriters?: (pubkey: string) => void
  /** Wait for in-flight redemptions after the poller stops. Resolves whether drained. */
  drainWriters?: (timeoutMs: number) => Promise<boolean>
  /** The current held set's fingerprint, for the race check. */
  heldNow?: (pubkey: string) => Promise<string>
  /** Bumped on every coupon write; the race check compares it. */
  writeCount?: () => number
  /**
   * Live entries in the pending-send and swap-intent ledgers, which hold value
   * no coupon row describes and which the sweep below would delete.
   */
  inFlight?: (pubkey: string) => { sends: number; swaps: number; cashlinks?: number }
  /** Try to finish pending sends first, so a settled one does not block. Bounded, never throws. */
  settleInFlight?: (pubkey: string) => Promise<void>
  /** The read-back check of the cashback stash (#331). Must never answer ok on a failure. */
  checkStash?: (pubkey: string) => Promise<StashCheck>
  /** The stash's current identity, for the race check. */
  stashNow?: () => string
  /**
   * #379: Cashlinks whose value only this wallet can still bring back (an unconfirmed "claimed", one
   * being locked or on its way back, one locked to its expired link). Must count unreadable as one.
   */
  strandedLinks?: (pubkey: string) => Promise<number>
  /**
   * Wait for receives that do not go through dm-poll (cashback, gift links) and
   * for every redeem the coordinator has in flight (#331). Resolves whether drained.
   */
  drainReceives?: (timeoutMs: number) => Promise<boolean>
  /** Receives still running anywhere in this tab, read synchronously just before the wipe. */
  receivesNow?: () => number
  /**
   * Take the logout lock and pause every other tab of this wallet (#335). A
   * tab that is busy, does not answer, or cannot be reached refuses the logout.
   */
  pauseTabs?: () => Promise<PauseResult>
}

/** How long logout gives the pending sends to settle before it checks them. */
export const SETTLE_IN_FLIGHT_TIMEOUT_MS = 20_000

async function defaultSettleInFlight(pubkey: string): Promise<void> {
  if (moneyInFlight(pubkey).sends === 0) return
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await openWallet(pubkey)
    const { reconcilePendingSends } = await import('./pay')
    await Promise.race([
      reconcilePendingSends(pubkey),
      new Promise((resolve) => (timer = setTimeout(resolve, SETTLE_IN_FLIGHT_TIMEOUT_MS))),
    ])
  } catch {
    // The ledger is read again below; whatever is left in it refuses the logout.
  } finally {
    clearTimeout(timer)
  }
}

function hasMoneyInFlight(read: (pubkey: string) => { sends: number; swaps: number; cashlinks?: number }, pubkey: string): boolean {
  try {
    const { sends, swaps, cashlinks } = read(pubkey)
    // #295 phase 4: a Cashlink claim part way, or a Cashlink whose value is moving, is value no
    // coupon row describes yet, and the sweep below would delete its only record.
    return sends > 0 || swaps > 0 || (cashlinks ?? 0) > 0
  } catch {
    return true
  }
}

/** How long to wait for a redemption already inside the mint swap to write. */
export const DRAIN_TIMEOUT_MS = 20_000

async function defaultStrandedLinks(pubkey: string): Promise<number> {
  const wallet = await openWallet(pubkey)
  return strandedCashlinks(await wallet.getAllTransactions())
}

async function safeStranded(read: (pubkey: string) => Promise<number>, pubkey: string): Promise<number> {
  try {
    return await read(pubkey)
  } catch {
    // Rows that cannot be read cannot be shown to hold no such link.
    return 1
  }
}

/**
 * Re-open what logout closed. The gates first, and each writer on its own: one
 * that throws must not leave receiving or sending paused until a reload (#335).
 */
function defaultRestart(pubkey: string): void {
  openReceives()
  openSpends()
  for (const start of [startDmPoll, startRosterSync, startIncomingNotifications]) {
    try {
      start(pubkey)
    } catch {
      // The next login starts it again. The gates are open either way.
    }
  }
}

async function defaultHeldNow(pubkey: string): Promise<string> {
  return heldFingerprint(await (await openWallet(pubkey)).getAllVouchers())
}

async function defaultDrainReceives(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  const left = () => Math.max(0, deadline - Date.now())
  if (!(await drainReceives(timeoutMs))) return false
  if (!(await drainTokenRedemptions(left()))) return false
  return drainSpends(left())
}

function defaultReceivesNow(): number {
  return receivesInFlight() + tokenRedemptionsInFlight() + spendsInFlight()
}

function stashBlocked(check: Extract<StashCheck, { ok: false }>): LogoutOutcome {
  if (check.reason === 'locked') return { status: 'blocked', reason: 'locked', unconfirmed: [] }
  if (check.reason === 'store-unreadable') return { status: 'blocked', reason: 'store-unreadable', unconfirmed: [] }
  return { status: 'blocked', reason: 'cashback-unconfirmed', unconfirmed: [], cashback: check.count }
}

async function safeStash(check: NonNullable<LogoutDeps['checkStash']>, pubkey: string): Promise<StashCheck> {
  try {
    return await check(pubkey)
  } catch {
    return { ok: false, reason: 'store-unreadable', count: 0, fingerprint: '\u0000unreadable' }
  }
}

function blocked(check: Extract<BackupCheck, { ok: false }>): LogoutOutcome {
  return { status: 'blocked', reason: check.reason, unconfirmed: check.unconfirmed }
}

/**
 * Log out, ONLY once every held voucher is verifiably backed up (owner rule
 * 2026-10-18 17:52Z: "Never allow a logout until we have verifiable
 * confirmation that the vouchers were backed up").
 *
 * 1. `confirmBackups` reads each held voucher's record BACK (relay ∪ gateway),
 *    checks it is signed by this user, decrypts it, and requires the token
 *    bytes to equal IndexedDB's. Gaps are re-published and re-read, bounded.
 *    Not confirmed: BLOCKED, nothing stopped, nothing erased, key kept.
 * 2. The ordinary confirmation. Declined: cancelled, nothing touched.
 * 3. Stop the DM poller and the other writers, and wait (bounded) for a
 *    redemption already past the mint swap to write its coupon.
 * 4. If the held set or the write counter moved since step 1, check again.
 * 5. That check refuses: restart what step 3 stopped and return BLOCKED.
 *    Otherwise, and only then, tear down and wipe.
 *
 * There is no override parameter, flag or path: the terminal decommission
 * runs the same check before it revokes anything (terminalDecommission.ts).
 */
export async function attemptLogout(
  pubkey: string,
  confirm: (message: string) => boolean = window.confirm.bind(window),
  reload: () => void = () => window.location.replace('/'),
  deps: LogoutDeps = {},
): Promise<LogoutOutcome> {
  const check = deps.checkBackups ?? confirmBackups
  const restart = deps.restartWriters ?? defaultRestart
  const drain = deps.drainWriters ?? drainDmPoll
  const heldNow = deps.heldNow ?? defaultHeldNow
  const writes = deps.writeCount ?? voucherWriteCount
  const inFlight = deps.inFlight ?? moneyInFlight
  const settleInFlight = deps.settleInFlight ?? defaultSettleInFlight
  const checkStash = deps.checkStash ?? confirmStashBackup
  const stashNow = deps.stashNow ?? stashFingerprint
  const drainOthers = deps.drainReceives ?? defaultDrainReceives
  const receivesNow = deps.receivesNow ?? defaultReceivesNow
  const pauseTabs = deps.pauseTabs ?? (() => pauseOtherTabs())

  // 0. A pending send that has finished at the gateway is settled now, so it
  // does not refuse the logout for no reason (second check of #326).
  await settleInFlight(pubkey).catch(() => undefined)

  // 1. Before anything is asked or stopped.
  const first = await safeCheck(check, pubkey)
  if (!first.ok) return blocked(first)
  // 1b. The cashback stash, backed up and read back (#331, owner decision
  // 2026-10-19). Claimed cashback not yet banked is money too.
  const firstStash = await safeStash(checkStash, pubkey)
  if (!firstStash.ok) return stashBlocked(firstStash)
  // A send or swap still in flight holds value outside every coupon row, and
  // the sweep below would delete its only record (second check of #326).
  if (hasMoneyInFlight(inFlight, pubkey)) return { status: 'blocked', reason: 'in-flight', unconfirmed: [] }
  // #379: and no Cashlink whose gift only this wallet can still take back. Its only record is the
  // History row and this device's key; a logout before the next run would leave it at the mint.
  if ((await safeStranded(deps.strandedLinks ?? defaultStrandedLinks, pubkey)) > 0) {
    return { status: 'blocked', reason: 'in-flight', unconfirmed: [] }
  }
  const writesAtConfirm = writes()

  // 2.
  if (!confirm(LOGOUT_WARNING)) return { status: 'cancelled' }

  // 2b. Every other tab of this wallet pauses first, or nothing happens (#335).
  // Asked after the confirmation, so a declined logout never disturbs them.
  const tabs = await pauseTabs().catch((): PauseResult => ({ ok: false }))
  if (!tabs.ok) return { status: 'blocked', reason: 'other-tab', unconfirmed: [] }
  const others = tabs.tabs

  // From here on anything that refuses, or throws, re-opens what was closed:
  // the gates, the writers, and the other tabs (#335). Only once the wipe has
  // begun is nothing restarted.
  let wiping = false
  let completed = false
  let restarted = false
  const reopen = () => {
    if (restarted) return
    restarted = true
    try {
      restart(pubkey)
    } catch {
      // An injected restart that throws: the gates still open below.
    }
    openReceives()
    openSpends()
    others.resume()
  }
  try {
    const outcome = await stopCheckAndWipe()
    if (outcome.status !== 'done') reopen()
    return outcome
  } finally {
    // A wipe that threw part way: nothing is restarted, but the paused tabs
    // are told, so they reload rather than wait on a wallet that is half gone.
    if (!wiping) reopen()
    else if (!completed) others.done()
  }

  async function stopCheckAndWipe(): Promise<LogoutOutcome> {

  // 3. Order matters. Stop the poller first: it holds the unlocked key and
  // writes to the user-scoped IndexedDB, and letting it run past the session
  // teardown means a write landing after the identity it belongs to is gone.
  // Close the receive gate first, synchronously with the poller's own
  // (#331): from here a cashback claim, a stash replay or a gift link is
  // refused BEFORE anything is claimed or swapped, and stays for the next try.
  closeReceives()
  closeSpends()
  stopDmPoll()
  // A debounced roster publish must not fire after the key is gone (#160 phase 6).
  stopRosterSync()
  stopOnlineShopSync()
  // Same reason: the drain loop signs NIP-98 with the session key and would keep
  // polling for payments addressed to the account being torn down.
  stopIncomingNotifications()
  const drainStart = Date.now()
  const drained =
    (await drain(DRAIN_TIMEOUT_MS).catch(() => false)) &&
    (await drainOthers(Math.max(0, DRAIN_TIMEOUT_MS - (Date.now() - drainStart))).catch(() => false))

  // A redemption that did not finish inside the bound may still write a
  // coupon after any check made now, so no check made now can be final.
  if (!drained) {
    return { status: 'blocked', reason: 'changed', unconfirmed: [] }
  }

  // 4b. The stash: a receive that ran before the gate closed may have stashed
  // or banked a token. Checked again (published and read back) if it moved.
  if (stashNow() !== firstStash.fingerprint) {
    const finalStash = await safeStash(checkStash, pubkey)
    if (!finalStash.ok) {
      return stashBlocked(finalStash)
    }
    if (stashNow() !== finalStash.fingerprint) {
      return { status: 'blocked', reason: 'changed', unconfirmed: [] }
    }
  }

  // 4. Re-verify only if the held set changed since step 1.
  if ((await safeHeld(() => heldNow(pubkey))) !== first.fingerprint || writes() !== writesAtConfirm) {
    const writesBeforeFinal = writes()
    const final = await safeCheck(check, pubkey)
    // 5. Refused, or something still wrote DURING the check (the writers are
    // stopped, so that would be a writer this list does not know about):
    // restart what was stopped, erase nothing.
    if (!final.ok) {
      return blocked(final)
    }
    if (writes() !== writesBeforeFinal || (await safeHeld(() => heldNow(pubkey))) !== final.fingerprint) {
      return { status: 'blocked', reason: 'changed', unconfirmed: [] }
    }
  }

  // Last, with the writers stopped: nothing may have started a send or a swap
  // since step 1 (a second tab can). From here on nothing is checked again.
  if (hasMoneyInFlight(inFlight, pubkey)) {
    return { status: 'blocked', reason: 'in-flight', unconfirmed: [] }
  }
  // And no receive is running (#331). With the gate closed and the poller's
  // generation bumped none can START, so this only catches one this list does
  // not know about. Synchronous, and nothing below awaits a receive.
  let busy: number
  try {
    busy = receivesNow()
  } catch {
    busy = 1
  }
  if (busy > 0) {
    return { status: 'blocked', reason: 'changed', unconfirmed: [] }
  }
  // And every other tab is still the one this logout paused: a tab opened
  // since, or one that resumed on its own, refuses the wipe.
  if (!(await others.stillPaused().catch(() => false))) {
    return { status: 'blocked', reason: 'other-tab', unconfirmed: [] }
  }
  wiping = true

  // And cancel the push subscription, which is the one piece of this account's
  // state that localStorage cannot reach: it lives in the browser's push
  // service and in the gateway's push_subscription table. Left behind, the
  // server keeps pushing this account's coupon events to a device that has
  // just erased the key, so a shared phone shows the previous user's activity
  // on its lock screen — the same failure the wholesale localStorage wipe
  // below exists to prevent, by a different door.
  //
  // Before session.logout(), deliberately: deregistering at the gateway is a
  // NIP-98 signed DELETE, so it needs the session key that logout is about to
  // zero.
  try {
    await disableNotifications(pubkey)
  } catch {
    // Best effort, for the same reason the session teardown below is: an
    // unreachable gateway must not strand someone in a session they asked to
    // leave. The local unsubscribe is the half that stops THIS device
    // rendering anything, and a row the server cannot reach stops mattering
    // the moment the browser subscription is gone.
  }

  // Asked AGAIN, after the network teardown above and before anything that
  // cannot be undone (review of #335). `disableNotifications` can await a
  // gateway for as long as it takes, and a tab opened during it is a tab the
  // first re-ping never saw: it would be receiving and sending while the store
  // is deleted under it. Nothing local is gone yet, so refusing here still
  // erases nothing and keeps the key (the push subscription, at worst, is off).
  if (!(await others.stillPaused().catch(() => false))) {
    wiping = false
    return { status: 'blocked', reason: 'other-tab', unconfirmed: [] }
  }

  try {
    // Zeroes the decrypted key, POSTs /auth/logout, and broadcasts to other tabs
    // so a second window does not keep acting as the logged-out user.
    await getSession()?.logout()
  } catch {
    // A gateway that will not answer must not strand the user in a session they
    // asked to leave. The local teardown below is the part that actually
    // protects them, so it happens either way.
  }

  // And once more, after the POST and before the first local erase (second
  // check of #340, F). `session.logout()` awaits POST /auth/logout with no
  // timeout and only broadcasts nap's `logout` once it answers, so a tab that
  // logged in during that POST is fully live and was never asked. Refusing here
  // still erases nothing and keeps the key: the sessions are ended, so the
  // tabs ask for the passphrase again, and the wallet is all still here.
  if (!(await others.stillPaused().catch(() => false))) {
    wiping = false
    return { status: 'blocked', reason: 'other-tab', unconfirmed: [] }
  }

  // The point of the whole operation. session.logout() zeroes the key held in
  // memory, but the encrypted copy at rest outlives it — without this the
  // passphrase would still unlock the wallet after "logging out", which is the
  // opposite of what the confirmation promised.
  await keyStore.clear()

  // And the tab-scoped reload cache (lib/resume.ts). It holds a wrapped copy of
  // the very key just erased, so leaving it would let the reload below walk
  // straight back into the session the user asked to leave — the same failure as
  // skipping keyStore.clear(), by a different door.
  forgetResume()

  // Everything this app has written for anyone, not just the named keys. Logout
  // now promises the device is left clean, and a leftover key under a pubkey
  // this loop does not know about would quietly break that promise — the list of
  // `imani-wallet:*` keys has grown three times already (profile, merchant,
  // payment requests) and will grow again.
  //
  // Safe to do wholesale because none of it is unique to the device: the profile
  // and the stall are on the relay, the sales are on the relay encrypted, the
  // terminal list (with every revocation handle) is on the relay encrypted since
  // #160 phase 6 (`terminalRosterSync`, kind 30078 `imani:terminals`), and
  // dm-poll's cursor is state we WANT reset — a stale "already processed" set is
  // exactly what silently drops the next account's coupons.
  //
  // Before #160 phase 6 that was false for the terminal list (F4): logging out
  // erased the only copy of the stall's revocation handles.
  //
  // Except the parked claim links (claim links phase 3, spec 2.5): an unspent
  // link opened on this device belongs to whoever logs in next to add it, which
  // is the whole "Switch account" journey (CL-SWITCH). The cashback token stash
  // (`imani:cashback:pending`) is outside the `imani-wallet:` prefix and was
  // never swept.
  //
  // And the settled-but-unsaved record (#112): its receive id exists nowhere
  // else, and it is keyed by pubkey so only that account reads it.
  carryPendingClaimsAcrossLogout(() => sweepAppStorage(isKeptAcrossLogout))

  // And the coupons, the transaction history and the issued-coupon records.
  // Recoverable: sales come back via restoreIssued(), and every held coupon was
  // read back from its backup above before anything here ran.
  await wipeWallet(pubkey)

  // Without this, createSession() hands the next login the shut-down session.
  resetSession()

  // And now throw the document away, rather than routing to the login screen in
  // place. Everything above erases what was STORED; a SPA transition leaves
  // every module-level cache of the logged-out user alive in the page, and one
  // of them silently costs the next user money.
  //
  // legacyBridge memoises loadLegacyRedemption() for the life of the document,
  // and that memo pointed walletStorageIntegration at the exact WalletStorage
  // instance wipeWallet() has just closed and deleted. The next login builds a
  // NEW instance for the UI, so an arriving coupon got swapped at the mint and
  // then written to the dead one:
  //
  //   WalletStorageNotInitializedError: atomicallyWrite() called before init()
  //   RedemptionSaveError: Voucher swap succeeded but local save failed
  //
  // — proofs burnt, coupon nowhere, no kind-7375 backup published, nothing on
  // any relay to restore from. That is why a wallet that logged out and back in
  // showed no balance however often it was refreshed. lib/branding.ts's merchant
  // cache is the same class of residue, holding the previous user's profiles
  // (and their failed lookups) until the page goes.
  //
  // Rebinding the bridge would fix the write and still leave that module's own
  // voucher cache full of the previous account's rows. A document that has held
  // one identity does not host the next one — the reload is what makes "erases
  // all your data from this browser" true of memory as well as of disk.
  // The paused tabs reload too: the wallet they were showing is gone.
  completed = true
  others.done()
  reload()
  return { status: 'done' }
  }
}

/** The held fingerprint, or null when the store cannot be read (never equal to a real one). */
async function safeHeld(heldNow: () => Promise<string>): Promise<string | null> {
  try {
    return await heldNow()
  } catch {
    return null
  }
}

/** A check that throws is a check that did not confirm. */
async function safeCheck(
  check: NonNullable<LogoutDeps['checkBackups']>,
  pubkey: string,
): Promise<BackupCheck> {
  try {
    return await check(pubkey)
  } catch {
    return { ok: false, reason: 'store-unreadable', unconfirmed: [], fingerprint: '' }
  }
}

/**
 * `attemptLogout` as a yes/no, for callers that only need to know whether the
 * page is going away. A BLOCKED logout is `false`, exactly like a cancelled
 * one: nothing was erased either way.
 */
export async function logout(
  pubkey: string,
  confirm?: (message: string) => boolean,
  reload?: () => void,
  deps?: LogoutDeps,
): Promise<boolean> {
  return (await attemptLogout(pubkey, confirm, reload, deps)).status === 'done'
}
