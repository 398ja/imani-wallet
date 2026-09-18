/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { nip19 } from 'nostr-tools'

import { ProfilePage } from '../ProfilePage'
import { emptyProfile, type Profile } from '../../lib/profile'

/**
 * Your own profile page must not greet you with your own key.
 *
 * `App` seeds its profile state with `loadProfile(pubkey) ?? emptyProfile(...)`
 * and then awaits the relay. On a first login — or ANY login after `logout`,
 * which wipes localStorage wholesale — the stored copy is absent, so this screen
 * fell through to the npub and printed it at the full 18px weight a name gets.
 * The page whose entire job is telling you who you are was showing you a key.
 *
 * The npub is still the right answer for an account that has genuinely published
 * no name, which is allowed. The discriminator is `updatedAt`, not the absence
 * of a name: zero means nothing has ever been written for this pubkey.
 */

const PUBKEY = 'd'.repeat(64)
const NPUB = nip19.npubEncode(PUBKEY)

vi.mock('../../lib/merchant', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/merchant')>()),
  isMerchantPubkey: () => Promise.resolve(false),
}))

const draw = (profile: Profile) =>
  render(
    <MemoryRouter>
      <ProfilePage profile={profile} merchant={null} />
    </MemoryRouter>,
  )

afterEach(cleanup)

describe('the profile page before the record arrives', () => {
  it('shows a placeholder rather than the npub', () => {
    draw(emptyProfile(PUBKEY))

    expect(screen.queryByText(NPUB)).toBeNull()
    // Not even the shortened form, which is what `handleShown` falls back to.
    expect(document.body.textContent).not.toContain(NPUB.slice(0, 10))
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull()
    expect(document.querySelector('.animate-pulse')).not.toBeNull()
  })

  it('shows the name once the record lands', () => {
    draw({ ...emptyProfile(PUBKEY), displayName: 'Rosa', updatedAt: Date.now() })

    expect(screen.getByText('Rosa')).toBeTruthy()
    expect(document.querySelector('[aria-busy="true"]')).toBeNull()
  })

  /**
   * A SAVED record with no name is a real answer, not a wait — publishing no
   * kind-0 is allowed, and a page that pulsed forever for those accounts would
   * be a worse bug than the one this fixes, because it would never resolve.
   */
  it('shows the npub for an account that genuinely has no name', () => {
    draw({ ...emptyProfile(PUBKEY), updatedAt: Date.now() })

    expect(document.querySelector('[aria-busy="true"]')).toBeNull()
    expect(screen.getByText(NPUB.slice(0, 8), { exact: false })).toBeTruthy()
  })

  /** A stored handle renders at once — no flash on a reload. */
  it('does not wait when the handle is already known', () => {
    draw({ ...emptyProfile(PUBKEY), nip05: 'rosa@x.test', updatedAt: Date.now() })

    expect(screen.getByText('@rosa')).toBeTruthy()
    expect(document.querySelector('[aria-busy="true"]')).toBeNull()
  })
})
