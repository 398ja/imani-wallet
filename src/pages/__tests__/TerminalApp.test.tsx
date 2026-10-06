/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

/**
 * The till a terminal runs (#160 phase 3, spec 2.4).
 *
 * `TerminalApp` is mounted the way `App` mounts it on an enrolled device, with the unlocked
 * session supplied by `terminalUnlock` and the stall read from its public record. Each case is a
 * row of the spec's screen table.
 */

const STALL = 'a'.repeat(64)
const DEVICE = 'c'.repeat(64)

const state = vi.hoisted(() => ({ till: null as unknown }))
vi.mock('../../lib/terminalUnlock', () => ({
  openTill: () => state.till,
  lockTerminal: vi.fn(),
  forgetTerminalSession: vi.fn(),
  unlockTerminal: vi.fn(),
}))
vi.mock('../../lib/merchant', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/merchant')>()),
  fetchMerchantRecord: async () => ({
    pubkey: STALL,
    name: 'Test Stall',
    active: true,
    categories: [],
    issuanceCurrency: 'GBP',
  }),
}))
// The Redeem screen itself is covered in RedeemPageTerminal.test.tsx; here only its route.
vi.mock('../RedeemPage', () => ({ RedeemPage: () => <p>redeem-screen</p> }))

const { TerminalApp } = await import('../TerminalApp')
const { TERMINAL_ROLES, grantFor } = await import('../../lib/terminalRole')
const { SESSION_KIND, openSession } = await import('../../lib/terminalSession')
import type { TerminalActor } from '../../lib/actor'

function enrol(role: string) {
  localStorage.setItem(
    'imani-wallet:terminal',
    JSON.stringify({ stallPubkey: STALL, role, terminalPubkey: DEVICE, name: 'Front counter', enrolledAt: 1, token: 'cashuBx' }),
  )
}

function unlockedAs(
  role: (typeof TERMINAL_ROLES)[keyof typeof TERMINAL_ROLES],
  kind: (typeof SESSION_KIND)[keyof typeof SESSION_KIND] = SESSION_KIND.FULL,
) {
  const actor: TerminalActor = {
    kind: 'terminal',
    stallPubkey: STALL,
    role,
    terminalPubkey: DEVICE,
    permissions: grantFor(role, STALL),
  }
  state.till = { devicePubkey: DEVICE, actor, session: openSession(actor, kind) }
}

function at(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <TerminalApp />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  localStorage.clear()
  state.till = null
})
afterEach(() => cleanup())

describe('a locked terminal', () => {
  // Every path asks for the passphrase first, the owner's screens included.
  it('shows only the unlock screen, whatever the path', async () => {
    enrol(TERMINAL_ROLES.REDEEM_ONLY)
    at('/merchant/dashboard')
    expect(await screen.findByRole('button', { name: 'Open the till' })).toBeTruthy()
    expect(screen.getByText('Front counter')).toBeTruthy()
  })
})

describe('the till, per role', () => {
  // Home names the terminal and the stall, and a redeem-only till offers Redeem, Settings and
  // Lock, and no Sell.
  it('redeem-only: Redeem, Settings and Lock, no Sell', async () => {
    enrol(TERMINAL_ROLES.REDEEM_ONLY)
    unlockedAs(TERMINAL_ROLES.REDEEM_ONLY)
    at('/')
    expect(await screen.findByText('Test Stall')).toBeTruthy()
    expect(screen.getByTestId('terminal-name').textContent).toBe('Front counter')
    expect(screen.getByRole('button', { name: /Redeem/ })).toBeTruthy()
    expect(screen.getByRole('link', { name: /Settings/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Lock/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Sell/ })).toBeNull()
  })

  // A sell-and-redeem till on a FULL session is told selling arrives with phase 5, not offered a
  // Sell that every customer wallet would refuse.
  it('sell-and-redeem, FULL: Redeem, and a line saying Sell is not available yet', async () => {
    enrol(TERMINAL_ROLES.ISSUE_AND_REDEEM)
    unlockedAs(TERMINAL_ROLES.ISSUE_AND_REDEEM)
    at('/')
    expect(await screen.findByText(/Selling from a terminal is not available yet/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Sell/ })).toBeNull()
  })

  // REDUCED (mint unreachable at unlock): redemption only, and no line about selling.
  it('sell-and-redeem, REDUCED: Redeem only', async () => {
    enrol(TERMINAL_ROLES.ISSUE_AND_REDEEM)
    unlockedAs(TERMINAL_ROLES.ISSUE_AND_REDEEM, SESSION_KIND.REDUCED)
    at('/')
    expect(await screen.findByRole('button', { name: /Redeem/ })).toBeTruthy()
    expect(screen.queryByText(/Selling from a terminal/)).toBeNull()
  })
})

describe('the routes a terminal has', () => {
  // A redeem-only terminal has no Sell route: typing it lands on the till.
  it('has no /sell: it lands on the till', async () => {
    enrol(TERMINAL_ROLES.REDEEM_ONLY)
    unlockedAs(TERMINAL_ROLES.REDEEM_ONLY)
    at('/sell')
    expect(await screen.findByTestId('terminal-name')).toBeTruthy()
  })

  // The owner's business has no route on a terminal at all.
  it.each(['/merchant/dashboard', '/merchant/coupons', '/settings/terminals', '/settings/backup', '/profile'])(
    'sends %s to the till',
    async (path) => {
      enrol(TERMINAL_ROLES.ISSUE_AND_REDEEM)
      unlockedAs(TERMINAL_ROLES.ISSUE_AND_REDEEM)
      at(path)
      expect(await screen.findByTestId('terminal-name')).toBeTruthy()
    },
  )

  // Redeem is reachable once the stall's record is read.
  it('opens Redeem', async () => {
    enrol(TERMINAL_ROLES.REDEEM_ONLY)
    unlockedAs(TERMINAL_ROLES.REDEEM_ONLY)
    at('/redeem')
    expect(await screen.findByText('redeem-screen')).toBeTruthy()
  })

  // Settings → Security offers only taking the terminal out of service.
  it('offers Take out of service under Settings → Security', async () => {
    enrol(TERMINAL_ROLES.REDEEM_ONLY)
    unlockedAs(TERMINAL_ROLES.REDEEM_ONLY)
    at('/settings/security')
    expect(await screen.findByRole('button', { name: 'Take this terminal out of service' })).toBeTruthy()
    expect(screen.queryByText(/Log out/)).toBeNull()
  })
})
