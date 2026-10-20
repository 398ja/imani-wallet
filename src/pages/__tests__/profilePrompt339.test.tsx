// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import { ProfilePage } from '../ProfilePage'
import { FinishProfilePrompt } from '../../components/FinishProfilePrompt'
import { emptyProfile, type Profile } from '../../lib/profile'

/**
 * #339: the app-start Finish your profile prompt shows on Home only and can be
 * hidden, per account. Hiding it never hides the card's own Finish control.
 */

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const handleless = (pk: string): Profile => ({ ...emptyProfile(pk), updatedAt: Date.now() })
const PROMPT = { name: /finish your profile/i }

const draw = (profile: Profile, path = '/') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <FinishProfilePrompt profile={profile} />
    </MemoryRouter>,
  )

beforeEach(() => localStorage.clear())
afterEach(cleanup)

describe('Home only (#339)', () => {
  it('shows on Home', () => {
    draw(handleless(A), '/')
    expect(screen.getByRole('link', PROMPT)).toBeTruthy()
  })

  it.each(['/pay', '/send', '/receive', '/coupons', '/transactions', '/settings', '/profile', '/sell'])(
    'stays away on %s',
    (path) => {
      draw(handleless(A), path)
      expect(screen.queryByRole('link', PROMPT)).toBeNull()
    },
  )
})

describe('dismiss (#339)', () => {
  it('has a plainly labelled close button with a 44px tap target', () => {
    draw(handleless(A))
    const close = screen.getByRole('button', { name: 'Hide this reminder' })
    expect(close.className).toMatch(/\bh-11\b/)
    expect(close.className).toMatch(/\bw-11\b/)
  })

  it('hides the prompt and keeps it hidden after a reload', () => {
    draw(handleless(A))
    fireEvent.click(screen.getByRole('button', { name: 'Hide this reminder' }))
    expect(screen.queryByRole('link', PROMPT)).toBeNull()
    cleanup()
    draw(handleless(A))
    expect(screen.queryByRole('link', PROMPT)).toBeNull()
  })

  it('is per account: another account on the same device still sees it', () => {
    draw(handleless(A))
    fireEvent.click(screen.getByRole('button', { name: 'Hide this reminder' }))
    cleanup()
    draw(handleless(B))
    expect(screen.getByRole('link', PROMPT)).toBeTruthy()
  })

  it('never hides the card: Finish your profile stays on the own profile', () => {
    draw(handleless(A))
    fireEvent.click(screen.getByRole('button', { name: 'Hide this reminder' }))
    cleanup()
    render(
      <MemoryRouter>
        <ProfilePage profile={handleless(A)} merchant={null} onFinishProfile={async () => {}} />
      </MemoryRouter>,
    )
    expect(screen.getByRole('button', PROMPT)).toBeTruthy()
  })
})

describe('the card Finish control (#339)', () => {
  it('has a 44px tap target', () => {
    render(
      <MemoryRouter>
        <ProfilePage profile={handleless(A)} merchant={null} onFinishProfile={async () => {}} />
      </MemoryRouter>,
    )
    expect(screen.getByRole('button', PROMPT).className).toMatch(/\bmin-h-11\b/)
  })
})
