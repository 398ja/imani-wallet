import { getSession, keyStore, resetSession } from './nap'
import { stopDmPoll } from './dmPoll'
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
  'Your account, your stall and your sales come back when you log in with your ' +
  'backup key (nsec) — they are stored under your key, not on this device. ' +
  'Coupons you are holding are restored from the relay as they are received ' +
  'again.\n\nThe only way back in is your backup key or a backup file from ' +
  'Settings → Backup. There is no password reset.\n\nLog out anyway?'

/**
 * @param confirm injected so tests can exercise both answers without a DOM.
 * @returns whether the user went through with it
 */
export async function logout(
  pubkey: string,
  confirm: (message: string) => boolean = window.confirm.bind(window),
): Promise<boolean> {
  if (!confirm(LOGOUT_WARNING)) return false

  // Order matters. Stop the poller first: it holds the unlocked key and writes
  // to the user-scoped IndexedDB, and letting it run past the session teardown
  // means a write landing after the identity it belongs to is gone.
  stopDmPoll()

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
  return true
}
