/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import { OnboardingPage } from '../OnboardingPage'

/**
 * The end of the journey the re-auth dialog now sends people on.
 *
 * `ReauthDialog` used to carry its own "Restore from a backup" button, which was
 * a dead end: `/restore` is declared in `PublicRoutes`, unmounted while the
 * authed tree is up, so the navigation fell through the authed catch-all and
 * landed on `/login`. The button is gone, and the disclosure now tells a user
 * who has forgotten their passphrase to log out and restore from the screen that
 * follows.
 *
 * Which makes THIS screen load-bearing, and it is easy to miss why: logout
 * erases the key and reloads the document, so `Entry` finds no stored key and
 * routes to /onboarding — NOT /login, where the restore link already lived. The
 * first draft of that change pointed at logout without checking where logout
 * lands, and sent anyone holding a backup file to a screen offering only
 * "Register" and "Log in".
 *
 * So this asserts the promise the dialog makes is kept at the other end.
 */
describe('the onboarding start screen', () => {
  afterEach(cleanup)

  const noop = async () => {}

  it('links to /restore, because this is where logging out lands', () => {
    render(
      <MemoryRouter initialEntries={['/onboarding']}>
        <OnboardingPage onUnlock={noop} />
      </MemoryRouter>,
    )

    const restore = screen.getByRole('link', { name: 'Restore' })
    expect(restore.getAttribute('href')).toBe('/restore')
  })

  it('still offers the two ordinary ways in', () => {
    render(
      <MemoryRouter initialEntries={['/onboarding']}>
        <OnboardingPage onUnlock={noop} />
      </MemoryRouter>,
    )

    // Restore is the recovery path and must not crowd out the common ones: a
    // new user registers, and a user with an nsec logs in.
    expect(screen.getByRole('button', { name: 'Register' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Log in' })).toBeTruthy()
  })
})
