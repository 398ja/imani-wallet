/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { nip19 } from 'nostr-tools'

import { Header } from '../Header'
import { emptyProfile, type Profile } from '../../../lib/profile'

/**
 * The header must not greet you with your own key.
 *
 * `App` seeds its profile state with `loadProfile(pubkey) ?? emptyProfile(pubkey)`
 * and then awaits `refreshProfile`, which is two network round trips. On a first
 * login — or any login on a device that has been wiped, which is every login
 * after `logout`, since it erases localStorage wholesale — the stored copy is
 * absent, so for those seconds the header ran `profileName` over an empty record
 * and printed `npub1abc…`. The one name the app has no excuse for fumbling is
 * the user's own.
 */

const PUBKEY = 'c'.repeat(64)

vi.mock('../../../lib/merchant', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/merchant')>()),
  isMerchantPubkey: () => Promise.resolve(false),
}))

// The bell polls; it is not what these assert.
vi.mock('../NotificationBell', () => ({ NotificationBell: () => null }))

const draw = (profile: Profile) =>
  render(
    <MemoryRouter>
      <Header profile={profile} onLogout={() => {}} />
    </MemoryRouter>,
  )

afterEach(cleanup)

describe('the header before the profile arrives', () => {
  it('shows a placeholder rather than the user’s own npub', () => {
    draw(emptyProfile(PUBKEY))

    expect(screen.queryByText(/^npub1/)).toBeNull()
    expect(document.body.textContent).not.toContain(nip19.npubEncode(PUBKEY).slice(0, 10))
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull()
  })

  it('shows the name once there is one', () => {
    draw({ ...emptyProfile(PUBKEY), displayName: 'Rosa', updatedAt: Date.now() })

    expect(screen.getByText('Rosa')).toBeTruthy()
    expect(document.querySelector('[aria-busy="true"]')).toBeNull()
  })

  /**
   * A SAVED record with no name is a real answer, not a wait. Publishing no
   * kind-0 is allowed, and a header that pulsed forever for those users would be
   * a worse bug than the one this fixes — it would never resolve.
   */
  it('stops waiting for someone who simply has no name', () => {
    draw({ ...emptyProfile(PUBKEY), updatedAt: Date.now() })

    expect(document.querySelector('[aria-busy="true"]')).toBeNull()
    // The npub is the honest answer here: it is who they are, and it is final.
    expect(screen.getByText(/^npub1/)).toBeTruthy()
  })

  /** A stored profile renders immediately — no flash of anything on a reload. */
  it('does not wait when the handle is already known', () => {
    draw({ ...emptyProfile(PUBKEY), nip05: 'rosa@x.test', updatedAt: Date.now() })

    expect(screen.getByText('@rosa')).toBeTruthy()
    expect(document.querySelector('[aria-busy="true"]')).toBeNull()
  })
})
