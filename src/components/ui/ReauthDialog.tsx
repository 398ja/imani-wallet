import { useEffect, useRef, useState } from 'react'

import { Button, Input, Alert } from './index'
import { userMessage } from '../../lib/userMessage'

/**
 * The passphrase dialog that appears when the session lapses.
 *
 * The problem it solves is narrow and was very visible: when the NAP session
 * expired, `Gate` kept rendering "Signing in…" forever. `isAuthenticated` had
 * gone false while the session object was still held, so the app sat on a dead
 * screen with no affordance on it, and the only way back in was for the user to
 * work out for themselves that a page refresh would fix it. This dialog is what
 * a refresh used to do, done in place.
 *
 * **Modal, but never a dead end.** Escape and backdrop clicks do not dismiss it,
 * because behind it is an authenticated screen showing balances and coupons and
 * a dismissed dialog would leave the user looking at a wallet that cannot act.
 * But "cannot dismiss" is not "cannot leave": every way out of this state is on
 * the dialog — unlock, or log out — which is the wayfinding rule that a screen
 * must always answer "how do I get out?". The first draft failed that, offering
 * only a passphrase nobody who had forgotten it could produce.
 *
 * **There is no restore button here.** There was one, and it was a dead end:
 * `/restore` is declared in `PublicRoutes`, so it is only reachable once the
 * session has been dropped and the app has handed itself back to the public
 * tree — which is precisely what logging out does. A second button that had to
 * tear the session down before it could navigate was a slower, less honest
 * spelling of the logout already on this dialog, and it landed people on
 * `/login` when the teardown and the navigation raced.
 *
 * Logout reaches the same screens, but note WHICH one: it erases the key and
 * reloads the document, so `Entry` finds no stored key and routes to
 * `/onboarding`, not `/login`. Its "Log in" step is where a backup is opened
 * (Google Drive, a backup file, or the backup key behind a small link, #325),
 * which is why this dialog sends people to "Log in" after logging out.
 *
 * **The passphrase is never stored.** It lives in this component's state while
 * the user types, goes straight to `onSubmit`, and is cleared on success. It is
 * never logged, never written to storage, never attached to an error.
 *
 * The visual treatment is the app's own `.material` — the same translucent layer
 * as the header and the menus, so this reads as part of the app rather than as a
 * foreign object. The scrim dims the content behind it and the surface settles
 * down onto its resting size (see `.modal-surface` in index.css): a modal task
 * pairs a dimmed background with a surface that is clearly above it.
 */
export function ReauthDialog({
  onSubmit,
  onLogout,
  name,
}: {
  /**
   * Verify the passphrase and restore the session. Resolve to re-enter the app;
   * reject to show the error against the field. Rejecting must leave the dialog
   * open — a failed attempt is not an exit.
   */
  onSubmit: (passphrase: string) => Promise<void>
  /**
   * Leave, erasing the key and this browser's data. Destructive and
   * irreversible without a backup, so the caller confirms before acting — this
   * component only reports the intent.
   */
  onLogout: () => void
  /**
   * Who is being asked, when the app knows.
   *
   * Reassurance, not identification: it answers "is this my wallet asking".
   * Pass a real name or nothing — a truncated npub is not reassurance, and
   * `Welcome back, npub1abc\u2026` reads like a machine that does not know who you
   * are, on the one dialog where trust is the whole point. `Gate` resolves this
   * and passes undefined rather than a fallback.
   */
  name?: string
}) {
  const [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showOptions, setShowOptions] = useState(false)
  // Counted rather than a boolean: the caret has to return after EVERY failed
  // attempt, and a flag that is already true does not re-fire the effect below.
  const [failures, setFailures] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  // The dialog arrives unannounced, over whatever the user was doing, so the
  // caret goes in the field without a second tap. Without this the first thing
  // they type on a desktop keyboard goes nowhere.
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const submit = async () => {
    if (!passphrase || busy) return
    setBusy(true)
    setError(null)
    try {
      await onSubmit(passphrase)
      // Only on success. A wrong passphrase keeps what was typed so a one-letter
      // typo is one backspace away rather than a retype.
      setPassphrase('')
    } catch (e) {
      setError(userMessage(e))
      setFailures((n) => n + 1)
    } finally {
      setBusy(false)
    }
  }

  // Put the caret back where the fix happens, after a failed attempt.
  //
  // This has to be an effect keyed on the failure count, not a line in the
  // `catch`. The field is `disabled` while `busy`, and `busy` is only cleared in
  // the `finally` that runs AFTER the catch — so focusing there would call
  // `.focus()` on a disabled input, which silently does nothing. By the time
  // this effect runs the re-render has enabled the field again.
  useEffect(() => {
    if (failures === 0) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [failures])

  return (
    <div
      // `dialog` with `aria-modal` so a screen reader treats everything behind
      // it as inert, which matches what the scrim does visually.
      role="dialog"
      aria-modal="true"
      aria-labelledby="reauth-title"
      aria-describedby="reauth-body"
      className="fixed inset-0 z-[100] flex items-center justify-center p-5"
    >
      {/*
        Dim to focus. A modal task pushes its background back rather than
        letting it compete, and the blur is what makes the layer above read as
        floating rather than pasted on. `aria-hidden` because it is decoration
        with no content of its own.
      */}
      <div
        aria-hidden="true"
        className="modal-scrim absolute inset-0 bg-mono-950/40 backdrop-blur-md dark:bg-mono-950/60"
      />

      {/*
        `.material` is the app's one floating-surface treatment, shared with the
        header and the menus. A bigger surface reads as thicker, so this takes a
        deeper shadow than a toast does — and the shadow is what separates it
        from the busy, text-heavy screen underneath.
      */}
      <div className="modal-surface material relative w-full max-w-sm rounded-3xl border border-mono-900/5 p-6 shadow-2xl shadow-mono-950/25 dark:border-mono-50/10 dark:shadow-black/50">
        {/*
          Tracking tightens as type grows, and over a translucent surface text
          needs more weight and more contrast than it would on a flat one. Flat
          mid-grey is what goes illegible here, which is why the body copy is
          mono-600 rather than the mono-500 used on opaque screens.
        */}
        <h2
          id="reauth-title"
          className="text-[17px] font-semibold leading-snug tracking-[-0.01em] text-mono-900 dark:text-mono-50"
        >
          Session expired
        </h2>
        <p id="reauth-body" className="mt-1 text-[13px] leading-snug text-mono-600 dark:text-mono-300">
          {name
            ? `Welcome back, ${name}. Enter your passphrase to carry on.`
            : 'Enter your passphrase to carry on where you left off.'}
        </p>

        <div className="mt-5 space-y-3">
          <Input
            ref={inputRef}
            type="password"
            placeholder="Passphrase"
            value={passphrase}
            disabled={busy}
            autoComplete="current-password"
            onChange={(e) => setPassphrase(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit()
            }}
          />
          <Button
            size="lg"
            className="w-full"
            disabled={busy || !passphrase}
            onClick={() => void submit()}
          >
            {busy ? 'Unlocking…' : 'Unlock'}
          </Button>
        </div>

        {error && (
          <div className="mt-3">
            <Alert>{error}</Alert>
          </div>
        )}

        <p className="mt-4 text-center text-[12px] leading-snug text-mono-500 dark:text-mono-400">
          Your coupons and history are safe on this device.
        </p>

        {/*
          The other ways out, one level deeper.
          
          They are behind a disclosure rather than sitting beside Unlock for two
          reasons. Showing the common path first is the rule — almost everyone
          here just types their passphrase — and one of these buttons ERASES the
          key and the data from this browser (lib/logout.ts), which is the most
          destructive action in the app. Putting that next to the button people
          mean to press, on a dialog that arrived unannounced mid-task, is how
          someone taps it by accident. imani-apps' reauth modal hides it the same
          way.

          The disclosure is still *findable*, which is the half the first draft
          got wrong by offering nothing but a passphrase: its label names the
          problem the user actually has rather than the mechanism, so someone who
          has forgotten theirs recognises their own situation in it.
        */}
        <div className="mt-4 border-t border-mono-200/70 pt-3 dark:border-mono-800/70">
          <button
            type="button"
            aria-expanded={showOptions}
            className="pressable text-[13px] text-mono-500 hover:text-mono-900 dark:text-mono-400 dark:hover:text-mono-50"
            onClick={() => setShowOptions((open) => !open)}
          >
            Forgotten your passphrase, or using a different account?
          </button>

          {showOptions && (
            <div className="expand-row mt-3 space-y-3">
              <p className="text-[12px] leading-relaxed text-mono-600 dark:text-mono-300">
                There is no passphrase reset — your key is encrypted with it, and
                nothing on our side can read it. You can get back in with your
                backup key, a backup file, or a Google Drive backup.
              </p>
              {/*
                Says the order out loud, because the button below does not look
                like a route to a restore screen and the two steps cannot be
                swapped: restoring runs on the PUBLIC side of the router, which
                this session is holding the app off. Naming the erase in the
                same breath is what stops this reading as a soft "continue" —
                someone with no backup must not learn the cost after tapping.
              */}
              <p className="text-[12px] leading-relaxed text-mono-600 dark:text-mono-300">
                To use one, log out first: that clears this device. Then choose
                Log in on the next screen and open your backup. Make sure you
                have your backup before you do.
              </p>
              {/*
                Last, separated, and in the warning ink. It is the only
                irreversible option on this dialog, and now the only exit other
                than unlocking, so it is labelled with what it actually does
                rather than with the softer "restore" that used to sit above it.
              */}
              <button
                type="button"
                onClick={onLogout}
                className="pressable w-full rounded-xl border border-red-200 px-3 py-2 text-[13px] font-medium text-red-600 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950"
              >
                Log out and erase this device
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
