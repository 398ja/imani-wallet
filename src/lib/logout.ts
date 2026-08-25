import { getSession, keyStore, resetSession } from './nap'
import { stopDmPoll } from './dmPoll'
import { stopIncomingNotifications } from './incomingNotifications'
import { forget as forgetResume } from './resume'
import { wipeWallet } from './wallet'

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
 * back in with the nsec rebuilds all three. Held coupons are the exception —
 * they return through the DM pipeline as they are re-received, and a coupon
 * already spent does not come back, which is correct.
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
  'backup key (nsec) — they are stored under your key, not on this device. ' +
  'Vouchers you are holding are restored from the relay as they are received ' +
  'again.\n\nThe only way back in is your backup key or a backup file from ' +
  'Settings → Backup. There is no password reset.\n\nLog out anyway?'

/**
 * @param confirm injected so tests can exercise both answers without a DOM.
 * @param reload injected for the same reason — a test cannot navigate.
 * @returns whether the user went through with it
 */
export async function logout(
  pubkey: string,
  confirm: (message: string) => boolean = window.confirm.bind(window),
  reload: () => void = () => window.location.replace('/'),
): Promise<boolean> {
  if (!confirm(LOGOUT_WARNING)) return false

  // Order matters. Stop the poller first: it holds the unlocked key and writes
  // to the user-scoped IndexedDB, and letting it run past the session teardown
  // means a write landing after the identity it belongs to is gone.
  stopDmPoll()
  // Same reason: the drain loop signs NIP-98 with the session key and would keep
  // polling for payments addressed to the account being torn down.
  stopIncomingNotifications()

  try {
    // Zeroes the decrypted key, POSTs /auth/logout, and broadcasts to other tabs
    // so a second window does not keep acting as the logged-out user.
    await getSession()?.logout()
  } catch {
    // A gateway that will not answer must not strand the user in a session they
    // asked to leave. The local teardown below is the part that actually
    // protects them, so it happens either way.
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
  // and the stall are on the relay, the sales are on the relay encrypted, and
  // dm-poll's cursor is state we WANT reset — a stale "already processed" set is
  // exactly what silently drops the next account's coupons.
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith('imani-wallet:')) localStorage.removeItem(key)
  }

  // And the coupons, the transaction history and the issued-coupon records.
  // Recoverable: sales come back from the relay via restoreIssued(), and held
  // coupons arrive again through the DM pipeline.
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
  reload()
  return true
}
