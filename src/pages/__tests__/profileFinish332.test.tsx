/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { useState } from 'react'

import { ProfilePage } from '../ProfilePage'
import { FinishProfilePrompt } from '../../components/FinishProfilePrompt'
import { emptyProfile, type Profile } from '../../lib/profile'
import type { TermsAcceptance } from '../../lib/terms'

/**
 * #332: an account with no handle met "No handle yet" on its own profile and had
 * no way to fix it. Every account must have a profile, so the card opens
 * Finish your profile (handle only) and shows the profile once it is claimed.
 */

vi.mock('../../lib/merchant', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/merchant')>()),
  isMerchantPubkey: () => Promise.resolve(false),
}))
vi.mock('../../lib/config', () => ({ gatewayConfig: async () => ({ nip05Domain: 'imani.local' }) }))

const PUBKEY = 'e'.repeat(64)
const handleless: Profile = { ...emptyProfile(PUBKEY), updatedAt: Date.now() }

function Harness({ onClaim }: { onClaim: (h: string, terms: TermsAcceptance) => Promise<Profile> }) {
  const [profile, setProfile] = useState(handleless)
  return (
    <MemoryRouter>
      <ProfilePage
        profile={profile}
        merchant={null}
        onFinishProfile={async (h, terms) => setProfile(await onClaim(h, terms))}
      />
    </MemoryRouter>
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
})
// Review of #358: Finish your profile claims the first handle, so it asks for the terms.
beforeEach(() => vi.stubEnv('VITE_WEBSITE_BASE_URL', 'https://www.imani.casa'))

describe('own profile with no handle (#332)', () => {
  it('offers Finish your profile instead of a dead "No handle yet"', () => {
    render(<Harness onClaim={vi.fn()} />)
    expect(screen.queryByText('No handle yet')).toBeNull()
    expect(screen.getByRole('button', { name: /finish your profile/i })).toBeTruthy()
  })

  it('asks only for a handle, then shows the profile without a reload', async () => {
    const onClaim = vi.fn(async (h: string) => ({
      ...handleless,
      nip05: `${h}@imani.local`,
      displayName: h,
    }))
    render(<Harness onClaim={onClaim} />)

    fireEvent.click(screen.getByRole('button', { name: /finish your profile/i }))
    const inputs = document.querySelectorAll('input')
    // The handle, and the Terms and Conditions box (review of #358).
    expect(inputs).toHaveLength(2)
    fireEvent.change(screen.getByLabelText('Handle'), { target: { value: 'amina' } })
    // Disabled until the box is ticked.
    expect((screen.getByRole('button', { name: /^finish$/i }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: /I accept the Terms and Conditions/ }))
    fireEvent.click(screen.getByRole('button', { name: /^finish$/i }))

    await waitFor(() => expect(screen.getByText('@amina')).toBeTruthy())
    expect(onClaim).toHaveBeenCalledWith('amina', {
      url: 'https://www.imani.casa/terms.html',
      acceptedAt: expect.any(Number),
    })
    expect(screen.getByText('amina')).toBeTruthy()
    expect(screen.queryByLabelText('Handle')).toBeNull()
    expect(screen.queryByRole('button', { name: /finish your profile/i })).toBeNull()
  })

  it('Back returns to the card having claimed nothing', () => {
    const onClaim = vi.fn()
    render(<Harness onClaim={onClaim} />)
    fireEvent.click(screen.getByRole('button', { name: /finish your profile/i }))
    fireEvent.click(screen.getByRole('button', { name: /not now/i }))
    expect(onClaim).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /finish your profile/i })).toBeTruthy()
  })

  it('shows nothing to finish while the record is still loading', () => {
    render(
      <MemoryRouter>
        <ProfilePage profile={emptyProfile(PUBKEY)} merchant={null} onFinishProfile={vi.fn()} />
      </MemoryRouter>,
    )
    expect(screen.queryByRole('button', { name: /finish your profile/i })).toBeNull()
  })
})

describe('the gentle prompt at app start (#332)', () => {
  const draw = (profile: Profile, path = '/') =>
    render(
      <MemoryRouter initialEntries={[path]}>
        <FinishProfilePrompt profile={profile} />
      </MemoryRouter>,
    )

  it('links a handle-less account to its profile, without blocking anything', () => {
    draw(handleless)
    const link = screen.getByRole('link', { name: /finish your profile/i })
    expect(link.getAttribute('href')).toBe('/profile')
    // A status line, not a dialog: money screens stay usable underneath.
    expect(document.querySelector('dialog')).toBeNull()
  })

  it('stays away for an account with a handle, a loading record, or on the profile itself', () => {
    draw({ ...handleless, nip05: 'amina@imani.local' })
    draw(emptyProfile(PUBKEY))
    draw(handleless, '/profile')
    expect(screen.queryByRole('link', { name: /finish your profile/i })).toBeNull()
  })
})
