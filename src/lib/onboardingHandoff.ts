/**
 * Carrying the new nsec from registration to the backup screen.
 *
 * Registration logs the user in as its second step, which remounts the whole app
 * from the public tree into the authenticated one. React state does not survive
 * that, so the key has to be parked somewhere the remount can find it.
 *
 * sessionStorage, not localStorage, and this is the whole design: the value must
 * not outlive the tab. A plaintext nsec in localStorage is exactly what nap's
 * encrypted keystore exists to avoid (RFC §1181), and it would still be there
 * next week. sessionStorage is scoped to the tab and cleared when it closes —
 * and `take` below removes it on first read, so the normal path holds it for the
 * few seconds between the claim and the user confirming they wrote it down.
 *
 * bottin does the same thing with the same storage for the same reason.
 */
const KEY = 'imani-wallet:onboarding-nsec'

/**
 * Stashed WITH its pubkey, so it can only be shown to the account it belongs to.
 *
 * Unkeyed, this goes wrong in a way that hands someone the wrong secret:
 * register A, leave the backup screen without ticking the box, refresh (the
 * session is in memory, so the app drops to /login), then "Use a different
 * account" and import key B. B's AuthedApp would find A's nsec still sitting in
 * the slot and render "You are all set" over B's handle — the user writes down
 * A's key believing it backs up B, while B's enrolment has already overwritten
 * A in the keystore. Both accounts are then unrecoverable.
 */
interface PendingBackup {
  pubkey: string
  nsec: string
}

export function stashPendingBackup(pubkey: string, nsec: string): void {
  sessionStorage.setItem(KEY, JSON.stringify({ pubkey, nsec } satisfies PendingBackup))
}

/**
 * Read without consuming.
 *
 * Deliberately NOT a read-and-remove `take()`. This is called from a useState
 * initialiser, and StrictMode invokes those twice in development: a mutating
 * read would hand the second call null and the backup screen would never
 * appear — in dev only, on the one screen whose entire purpose is showing a key
 * that cannot be recovered.
 *
 * Keeping it pure also means a mid-backup page refresh still shows the key.
 */
export function peekPendingBackup(pubkey: string): string | null {
  const raw = sessionStorage.getItem(KEY)
  if (!raw) return null
  try {
    const pending = JSON.parse(raw) as Partial<PendingBackup>
    // Belongs to someone else: show nothing rather than the wrong key.
    return pending.pubkey === pubkey && typeof pending.nsec === 'string' ? pending.nsec : null
  } catch {
    return null
  }
}

/** Called when the user confirms they have saved it — not before. */
export function clearPendingBackup(): void {
  sessionStorage.removeItem(KEY)
}
