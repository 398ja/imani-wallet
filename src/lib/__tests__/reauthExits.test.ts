/**
 * The ways off the re-auth dialog, checked against what `Gate` actually does.
 *
 * `ReauthDialog.test.tsx` covers the dialog as markup — that each exit exists
 * and calls its callback. This file covers the half that matters more and is
 * invisible from there: whether the handler behind `onRestore` actually leaves
 * the app in a state the restore screen can be trusted with.
 *
 * The hazard is specific. `onLoggedOut` is only `setSession(null)`, a React
 * state change, while the nap session lives in a module singleton OUTSIDE React.
 * `createSession` returns the existing session and IGNORES the key it is passed
 * (see lib/nap.ts), so a restore that does not reset the singleton unlocks a new
 * account's key and then runs the app as the PREVIOUS identity — that identity's
 * roles, its wallet, its pubkey on every signature — with no error anywhere.
 * `onUnlock` in App.tsx guards the same hazard and names the same consequence.
 *
 * These are source assertions rather than a rendered `Gate`. Rendering it would
 * pull in the entire screen graph — IndexedDB, the relay, the mint, forty pages
 * — to observe six lines of teardown, and mocking enough of that to boot would
 * leave a test whose passing says more about the mocks than the app. What is
 * being protected here is the PRESENCE of four calls that a future edit could
 * silently drop, and reading the source is a direct check on exactly that.
 */
import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'

async function appSource(): Promise<string> {
  return readFile(new URL('../../App.tsx', import.meta.url), 'utf8')
}

/**
 * The `<ReauthDialog .../>` element inside `Gate`.
 *
 * Anchored to the element rather than searched for prop-by-prop across the whole
 * file: `name={...}` and `onLogout={onLogout}` also appear in the component's
 * own signature, and a bare `indexOf` finds those first — which is how the first
 * draft of this file asserted against a prop declaration and passed for the
 * wrong reason.
 */
function gateDialog(source: string): string {
  const start = source.indexOf('<ReauthDialog')
  expect(start, 'Gate no longer renders <ReauthDialog>').toBeGreaterThan(-1)
  const end = source.indexOf('/>', start)
  expect(end, '<ReauthDialog> is not self-closing as expected').toBeGreaterThan(start)
  return source.slice(start, end)
}

/**
 * The body of one handler on that element, with comments stripped.
 *
 * Stripping is essential, not tidiness. These handlers EXPLAIN themselves at
 * length, naming the very calls being asserted on — `resetSession()` appears in
 * `onRestore`'s comment as well as its code, and `forgetResume()` appears there
 * only to say why it is NOT called. A substring check against the raw text
 * therefore passes on the prose after the code has been deleted, which a
 * mutation of this file proved before the stripping was added.
 */
function handlerBody(source: string, prop: string, nextProp: string): string {
  const dialog = gateDialog(source)
  const start = dialog.indexOf(`${prop}={`)
  expect(start, `<ReauthDialog> has no ${prop} handler`).toBeGreaterThan(-1)
  const end = dialog.indexOf(`${nextProp}={`, start)
  const body = dialog.slice(start, end === -1 ? undefined : end)
  return body.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

describe('leaving the dialog to restore a backup', () => {
  it('offers no restore exit at all — logout is the one that works', async () => {
    const dialog = gateDialog(await appSource())

    // There WAS an `onRestore` here, and it was a dead end. `/restore` is
    // declared in `PublicRoutes`, which is not mounted while `Gate` is, so the
    // navigation fell through the authed catch-all (`path="*"` -> `/`) and the
    // user arrived at `/login` instead of the restore screen. Making it work
    // meant tearing the session down first — resetting the nap singleton,
    // stopping both pollers — which is logout with a gentler label and without
    // logout's confirmation.
    //
    // So the exit is gone and `/restore` is reached through logout, which ends
    // the session properly and lands on the login screen that links to it.
    expect(dialog).not.toContain('onRestore')
    expect(dialog).not.toContain("navigate('/restore')")
  })
})

describe('leaving the dialog to log out', () => {
  it('goes through runLogout, which confirms and erases', async () => {
    const handler = handlerBody(await appSource(), 'onLogout', 'NOTHING_FOLLOWS')

    // Logout is the destructive exit and must keep its confirmation. Calling
    // the teardown pieces directly here would erase the key with no prompt.
    expect(handler).toContain('runLogout(')
  })
})

describe('the greeting', () => {
  it('uses a chosen name or nothing, never a truncated npub', async () => {
    const source = await appSource()

    // `profileName` falls back through the handle to `npub1abc…` so the header
    // always has something to render. On this dialog that fallback reads as a
    // machine that does not know who you are, at the one moment trust matters.
    expect(source).toContain('knownProfile?.displayName')

    const dialog = gateDialog(source)
    expect(dialog).not.toContain('profileName(')
  })
})
