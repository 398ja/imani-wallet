/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import { MemoryRouter, useNavigate, type NavigateFunction } from 'react-router-dom'

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
  refreshAfterRenewal: vi.fn(async () => null),
}))
// The till's network side effects (#160 phase 6): stubbed, each has its own test file.
const renewRequests = vi.hoisted(() => ({ sent: 0 }))
vi.mock('../../lib/terminalRenewalNet', () => ({
  checkForRenewal: vi.fn(async () => null),
  sendRenewRequest: vi.fn(async () => ((renewRequests.sent += 1), true)),
  RENEWAL_POLL_MS: 300_000,
}))
vi.mock('../../lib/tillSalesNet', () => ({ openTillSales: () => () => undefined }))
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
vi.mock('../../lib/profile', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/profile')>()),
  refreshProfile: async (pubkey: string) => ({ pubkey, displayName: 'Test Stall' }),
}))
// The Redeem screen itself is covered in RedeemPageTerminal.test.tsx; here only its route.
vi.mock('../RedeemPage', () => ({ RedeemPage: () => <p>redeem-screen</p> }))
// Sell and cashback are covered in SellPageTerminal and CashbackIssuePageTerminal; here only
// which tills reach their routes.
vi.mock('../SellPage', () => ({ SellPage: () => <p>sell-screen</p> }))
vi.mock('../CashbackIssuePage', () => ({ CashbackIssuePage: () => <p>cashback-screen</p> }))

const { TerminalApp, TerminalUnlockPage } = await import('../TerminalApp')
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
  /** Whether the stall attested this till's credential (#160 decision 5). Current tills are. */
  attested = true,
) {
  const actor: TerminalActor = {
    kind: 'terminal',
    stallPubkey: STALL,
    role,
    terminalPubkey: DEVICE,
    permissions: grantFor(role, STALL),
    attested,
  }
  state.till = { devicePubkey: DEVICE, actor, session: openSession(actor, kind) }
}

// Lets a test move to another route inside the same mounted app, after the stall has loaded.
let navigateTo: NavigateFunction | null = null
function CaptureNavigate() {
  const navigate = useNavigate()
  useEffect(() => {
    navigateTo = navigate
  }, [navigate])
  return null
}

function at(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <CaptureNavigate />
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

  // A sell-and-redeem till on a FULL session signs the terminal warrant (phase 5), so it sells.
  it('sell-and-redeem, FULL: Sell and Redeem', async () => {
    enrol(TERMINAL_ROLES.ISSUE_AND_REDEEM)
    unlockedAs(TERMINAL_ROLES.ISSUE_AND_REDEEM)
    at('/')
    expect(await screen.findByRole('button', { name: /Sell/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Redeem/ })).toBeTruthy()
  })

  // REDUCED (mint unreachable at unlock): redemption only, and a line saying why.
  it('sell-and-redeem, REDUCED: Redeem only', async () => {
    enrol(TERMINAL_ROLES.ISSUE_AND_REDEEM)
    unlockedAs(TERMINAL_ROLES.ISSUE_AND_REDEEM, SESSION_KIND.REDUCED)
    at('/')
    expect(await screen.findByRole('button', { name: /Redeem/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Sell/ })).toBeNull()
    expect(screen.getByText(/Selling needs the network/)).toBeTruthy()
  })

  // A selling till the stall never attested (#160 decision 5, spec 4.6.5): FULL, yet Redeem
  // only, and the till tells the operator to ask for a renewal and how it is done today.
  // Phase 6 (Q3): no more four re-enrol steps. The till asks the owner, with one button that
  // sends its own credential to the stall so the owner can press Renew.
  it('sell-and-redeem, unattested: Redeem only, with "Ask the owner to renew"', async () => {
    enrol(TERMINAL_ROLES.ISSUE_AND_REDEEM)
    unlockedAs(TERMINAL_ROLES.ISSUE_AND_REDEEM, SESSION_KIND.FULL, false)
    at('/')
    expect(await screen.findByRole('button', { name: /Redeem/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Sell/ })).toBeNull()
    const notice = screen.getByTestId('renew-to-sell').textContent ?? ''
    expect(notice).toMatch(/Ask the owner to renew this terminal to sell/)
    expect(notice).not.toMatch(/take it out of service/)
    renewRequests.sent = 0
    fireEvent.click(screen.getByRole('button', { name: 'Ask the owner to renew' }))
    await waitFor(() => expect(renewRequests.sent).toBe(1))
    expect(await screen.findByText(/Sent\. The owner sees it on their Terminals list/)).toBeTruthy()
  })

  // Phase 6 (Q4): past its expiry an attested selling till opens Redeem only, says so, and
  // offers the same button. The route to /sell is gone too.
  it('sell-and-redeem, expired: Redeem only, the expiry notice, and no Sell route', async () => {
    enrol(TERMINAL_ROLES.ISSUE_AND_REDEEM)
    unlockedAs(TERMINAL_ROLES.ISSUE_AND_REDEEM)
    const t = state.till as { actor: TerminalActor }
    t.actor = { ...t.actor, expiresAt: 1_700_000_000, expired: true }
    at('/')
    expect(await screen.findByRole('button', { name: /Redeem/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Sell/ })).toBeNull()
    expect(screen.getByTestId('expiry-notice').textContent).toMatch(/authority ran out on .*Ask the owner to renew it\. Redeeming still works\./)
    expect(screen.getByRole('button', { name: 'Ask the owner to renew' })).toBeTruthy()
    act(() => navigateTo!('/sell'))
    expect(await screen.findByTestId('terminal-name')).toBeTruthy()
    expect(screen.queryByText('sell-screen')).toBeNull()
  })

  // A redeem-only till is not told to renew: it has nothing to sell.
  it('redeem-only, unattested: no renew notice', async () => {
    enrol(TERMINAL_ROLES.REDEEM_ONLY)
    unlockedAs(TERMINAL_ROLES.REDEEM_ONLY, SESSION_KIND.FULL, false)
    at('/')
    expect(await screen.findByRole('button', { name: /Redeem/ })).toBeTruthy()
    expect(screen.queryByTestId('renew-to-sell')).toBeNull()
  })
})

describe('the routes a terminal has', () => {
  // Phase 5: a selling till in a FULL session reaches /sell and /sell/cashback.
  it.each([
    ['/sell', 'sell-screen'],
    ['/sell/cashback', 'cashback-screen'],
  ])('a FULL selling till reaches %s', async (path, screenText) => {
    enrol(TERMINAL_ROLES.ISSUE_AND_REDEEM)
    unlockedAs(TERMINAL_ROLES.ISSUE_AND_REDEEM)
    at(path)
    expect(await screen.findByText(screenText)).toBeTruthy()
  })

  // A REDUCED selling till is refused before it could mint: /sell lands on the till.
  //
  // The stall record is read first, so the route's own gate is what refuses. Before the record
  // arrives, every till lands on the till regardless, which made this test pass with the gate
  // deleted (#196 review mutation run).
  it.each(['/sell', '/sell/cashback'])('a REDUCED selling till typing %s lands on the till', async (path) => {
    enrol(TERMINAL_ROLES.ISSUE_AND_REDEEM)
    unlockedAs(TERMINAL_ROLES.ISSUE_AND_REDEEM, SESSION_KIND.REDUCED)
    at('/')
    expect(await screen.findByText('Test Stall')).toBeTruthy()
    act(() => navigateTo!(path))
    expect(await screen.findByTestId('terminal-name')).toBeTruthy()
    expect(screen.queryByText(/sell-screen|cashback-screen/)).toBeNull()
  })

  // The same, for a redeem-only till with the stall record loaded.
  it.each(['/sell', '/sell/cashback'])('a redeem-only till typing %s lands on the till', async (path) => {
    enrol(TERMINAL_ROLES.REDEEM_ONLY)
    unlockedAs(TERMINAL_ROLES.REDEEM_ONLY)
    at('/')
    expect(await screen.findByText('Test Stall')).toBeTruthy()
    act(() => navigateTo!(path))
    expect(await screen.findByTestId('terminal-name')).toBeTruthy()
    expect(screen.queryByText(/sell-screen|cashback-screen/)).toBeNull()
  })

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

describe('a refused device is never stranded (#160 review, MEDIUM)', () => {
  /** The unlock screen alone, with an unlock that refuses and a local removal we can watch. */
  async function refusedWith(reason: string, message: string) {
    const removed = vi.fn(async () => undefined)
    const reload = vi.fn()
    render(
      <MemoryRouter>
        <TerminalUnlockPage
          name="Front counter"
          terminalPubkey={DEVICE}
          stallName="Test Stall"
          onUnlocked={() => {}}
          unlock={async () => ({ unlocked: false, reason: reason as never, message })}
          removeFromDevice={removed}
          reload={reload}
        />
      </MemoryRouter>,
    )
    fireEvent.change(screen.getByLabelText('Passphrase'), { target: { value: 'eight888' } })
    fireEvent.click(screen.getByRole('button', { name: 'Open the till' }))
    return { removed, reload }
  }

  // A credential that cannot be read, or is not this device's, can never be handed back: the
  // device holds nothing the mint would spend. Decommission fails and erases nothing, so before
  // the review the device was stuck on this screen for good. It now offers to remove the terminal
  // from this device, which clears everything logout clears, and says the owner must still revoke
  // it.
  it.each([
    ['unreadable', 'This terminal’s authority cannot be read. Ask the stall owner to set it up again.'],
    ['not-ours', 'This authority is not for this device. Ask the stall owner to set it up again.'],
    ['untrusted-issuer', 'This app cannot confirm who issued this terminal’s authority.'],
  ])('offers a local removal for a %s credential, and it clears the device', async (reason, message) => {
    const { removed, reload } = await refusedWith(reason, message)

    const remove = await screen.findByRole('button', { name: 'Remove this terminal from this device' })
    expect(screen.getByText(/stall owner should still revoke it/i)).toBeTruthy()
    fireEvent.click(remove)
    fireEvent.click(await screen.findByRole('button', { name: 'Remove it' }))

    await waitFor(() => expect(removed).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
  })

  // A revoked credential is already spent, so the normal decommission works and is what is shown.
  it('keeps Take out of service for a revoked credential', async () => {
    await refusedWith('revoked', 'This terminal is no longer in service. Ask the stall owner to set it up again.')

    expect(await screen.findByRole('button', { name: 'Take this terminal out of service' })).toBeTruthy()
  })
})

describe('a terminal record without a token (#160 review, LOW)', () => {
  // The record still names this device, so it is still a terminal: the unlock screen, never the
  // onboarding or customer screens.
  it('still shows the unlock screen', async () => {
    localStorage.setItem(
      'imani-wallet:terminal',
      JSON.stringify({ stallPubkey: STALL, role: TERMINAL_ROLES.REDEEM_ONLY, terminalPubkey: DEVICE, enrolledAt: 1 }),
    )
    at('/')
    expect(await screen.findByRole('button', { name: 'Open the till' })).toBeTruthy()
  })
})
