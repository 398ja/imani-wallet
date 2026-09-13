import { getSession, keyStore } from './nap'
import { remember } from './resume'

/**
 * Re-establishing a lapsed session in place.
 *
 * This is the operation behind the passphrase dialog. It is deliberately NOT a
 * silent renewal, even though a silent one is usually possible: the wallet does
 * not configure nap's `autoLock`, so when the session cookie expires the key is
 * typically still sitting in the signer and `session.login()` would go straight
 * through with nothing asked of anyone.
 *
 * Asking anyway is the point. A session lifetime that any open tab renews by
 * itself is not a session lifetime, it is an infinite one — the phone left on a
 * café table stays a live wallet indefinitely. The passphrase is the evidence
 * that the person at the device is still the owner, and collecting it is what
 * the expiry is for.
 *
 * The three steps, in order, and why that order:
 *
 *   1. **Decrypt the stored key with the passphrase.** This is the check. There
 *      is no cheaper verifier anywhere in this app on purpose — a stored hash
 *      would be a second thing that can disagree with the key, and the keystore
 *      already fails closed on a wrong passphrase.
 *   2. **Put the key back, if it was evicted.** A lock zeroes it (RFC §28.6), so
 *      a login attempted before this throws `SessionLockedError` from inside
 *      nap rather than failing anywhere the user can see.
 *   3. **Log in.** A fresh NIP-98 signature for a fresh cookie. Nothing else
 *      renews it: `resume()` only reads the cookie that has just expired.
 *
 * Every failure throws, and the dialog shows what it says. The messages are
 * written for the person reading them, because "Invalid passphrase" arriving on
 * a dialog that appeared unannounced is the moment someone decides the app has
 * lost their money.
 */
export async function reauthenticate(passphrase: string): Promise<void> {
  const session = getSession()
  if (!session) {
    // The dialog is only rendered inside the authed tree, so this means the
    // session singleton was reset underneath it — a logout in another tab, most
    // likely. Nothing here can recover it; the app's own logout path will.
    throw new Error('Your session has ended. Please log in again.')
  }

  let privkeyHex: string
  try {
    privkeyHex = await keyStore.loadKey(passphrase)
  } catch {
    // Deliberately flattened. `loadKey` throws a DOMException from WebCrypto on
    // a wrong passphrase and an Error on a missing record, and neither message
    // means anything to a customer.
    throw new Error('That passphrase is not right. Try again.')
  }

  // A lock zeroed the key; put it back before asking nap to sign with it. Guarded
  // on `isLocked()` because `reunlock` on an unlocked session is a pointless
  // second decryption of a key that is already in the signer.
  if (session.isLocked()) {
    await session.reunlock(passphrase)
  }

  try {
    await session.login()
  } catch (e) {
    // Two very different failures land here and they need different advice:
    // the gateway being unreachable is worth retrying in a moment, and anything
    // else is not something the customer can act on from this dialog.
    const detail = e instanceof Error ? e.message : String(e)
    throw new Error(`Could not restore your session: ${detail}`)
  }

  // Refresh the tab's reload cache so a reload after this does not bounce back
  // to the passphrase screen. The key is unchanged, but the cache may have been
  // dropped by whatever ended the session.
  //
  // Best effort, like `remember` itself: it already swallows a browser that
  // refuses IndexedDB, and a cache that could not be written costs one
  // passphrase prompt on the next reload. Failing the whole re-authentication
  // over it would cost the session that has just been successfully restored.
  const pubkey = session.getSession()?.pubkey
  if (pubkey) await remember(pubkey, privkeyHex)
}
