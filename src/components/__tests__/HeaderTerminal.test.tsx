/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import { Header } from '../ui/Header'

/**
 * A terminal does not see the stall's books.
 *
 * "A redemption-only terminal has no Sell button and no dashboard." The Sell
 * half was built in ticket 07; the dashboard half was not, and a terminal
 * could read the stall's turnover, its issued coupons and its reconciliation
 * gaps from the menu — on a device that is, by design, in someone else's
 * hands.
 *
 * This is the courtesy half. The routes are guarded too, in App.
 */

const profile = {
  pubkey: 'a'.repeat(64),
  npub: 'npub1' + 'a'.repeat(58),
  displayName: 'Test Stall',
  nip05: 'stall@imani.local',
} as never

afterEach(cleanup)

const show = (props: Record<string, unknown>) =>
  render(
    <MemoryRouter>
      <Header profile={profile} onLogout={() => {}} {...props} />
    </MemoryRouter>,
  )

describe('the menu on a terminal', () => {
  it('offers the owner their dashboard and transactions', () => {
    show({ merchant: true })
    expect(screen.getByText('Dashboard')).toBeTruthy()
    expect(screen.getByText('Transactions')).toBeTruthy()
  })

  it('offers a terminal neither', () => {
    // A full till may sell and still has no business reading the books, so
    // this is gated on being a terminal at all rather than on the role.
    show({ merchant: true, terminal: true })
    expect(screen.queryByText('Dashboard')).toBeNull()
    expect(screen.queryByText('Transactions')).toBeNull()
  })

  it('still lets whoever holds it reach settings and sign out', () => {
    // Not a dead end: staff must be able to hand the device back, and an owner
    // must be able to reach the terminal list from the device itself.
    show({ merchant: true, terminal: true })
    expect(screen.getByText('Settings')).toBeTruthy()
  })

  it('leaves a customer’s menu alone', () => {
    show({})
    expect(screen.queryByText('Dashboard')).toBeNull()
  })
})
