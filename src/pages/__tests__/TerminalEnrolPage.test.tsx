/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

/**
 * The enrolment form, driven as a screen.
 *
 * `terminalIssue.ts` has the rules and its own tests. What only a rendered
 * screen can be wrong about is whether the form can be made to produce
 * authority the rules would have refused — so most of these assert that the
 * button STAYS disabled, and one drives the whole flow to check the owner's
 * roster ends up holding what revocation later needs.
 *
 * The camera component is stubbed to a button, because jsdom has no camera.
 * Nothing else is: the real `checkEnrolment`, `prepareEnrolment` and roster all
 * run, since they are the part the wiring could get wrong.
 */

const STALL = 'a'.repeat(64)
const DEVICE = 'c'.repeat(64)

vi.mock('../../components/ScanRecipient', () => ({
  ScanRecipient: ({ onFound }: { onFound: (k: string) => void }) => (
    <button onClick={() => onFound(DEVICE)}>scan</button>
  ),
}))

/**
 * Only the CHECK is stubbed, not the module. `mayEnrol` reads `grants` from
 * here too, and replacing that as well would leave the free-allowance rule
 * untested at exactly the point this screen depends on it.
 */
let granted = true
vi.mock('../../lib/licenceStatus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/licenceStatus')>()
  return {
    ...actual,
    licenceStatus: async () => ({
      checkedAt: Date.now(),
      decision: granted
        ? { granted: true as const, source: 'verified' as const, grant: { features: ['terminals'] } }
        : { granted: false as const, reason: 'no-licence' as const },
    }),
  }
})

const { TerminalEnrolPage } = await import('../TerminalEnrolPage')
const { allTerminals, recordTerminal } = await import('../../lib/terminalRoster')
const { TERMINAL_ROLES } = await import('../../lib/terminalRole')

function renderPage() {
  return render(
    <MemoryRouter>
      <TerminalEnrolPage stallPubkey={STALL} />
    </MemoryRouter>,
  )
}

/** The form filled in correctly, so each test can remove exactly one thing. */
async function fillEverything() {
  renderPage()
  await waitFor(() => expect(screen.getByRole('button', { name: 'Add terminal' })).toBeTruthy())
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Front counter' } })
  fireEvent.click(screen.getByRole('button', { name: /Redemption only/ }))
  fireEvent.click(screen.getByRole('button', { name: 'scan' }))
}

const addButton = () => screen.getByRole('button', { name: 'Add terminal' }) as HTMLButtonElement

beforeEach(() => {
  localStorage.clear()
  granted = true
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('nothing goes live without the three answers', () => {
  it('refuses a terminal with no role, however complete the rest is', async () => {
    // The ticket's first criterion. There is no default role, so this is the
    // state an owner reaches by simply not choosing — the likeliest way a door
    // device would end up able to sell.
    renderPage()
    await waitFor(() => expect(addButton()).toBeTruthy())

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Front counter' } })
    fireEvent.click(screen.getByRole('button', { name: 'scan' }))

    expect(addButton().disabled).toBe(true)
    expect(allTerminals(STALL)).toEqual([])
  })

  it('refuses a terminal with no name', async () => {
    renderPage()
    await waitFor(() => expect(addButton()).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /Redemption only/ }))
    fireEvent.click(screen.getByRole('button', { name: 'scan' }))

    expect(addButton().disabled).toBe(true)
  })

  it('refuses before anything has been scanned', async () => {
    renderPage()
    await waitFor(() => expect(addButton()).toBeTruthy())

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Front counter' } })
    fireEvent.click(screen.getByRole('button', { name: /Redemption only/ }))

    expect(addButton().disabled).toBe(true)
  })

  it('does not scold an untouched form', async () => {
    // Empty is not yet a mistake. A form that opens already complaining reads
    // as broken.
    renderPage()
    await waitFor(() => expect(addButton()).toBeTruthy())

    expect(screen.queryByText(/Give this terminal a name/)).toBeNull()
  })

  it('names what is missing once the owner has started', async () => {
    renderPage()
    await waitFor(() => expect(addButton()).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /Redemption only/ }))

    expect(screen.getByText(/Give this terminal a name/)).toBeTruthy()
  })
})

describe('scanning does not enrol', () => {
  it('creates no authority from a scan alone', async () => {
    /**
     * The enrolment QR is safe to observe, which is only true if seeing one
     * cannot create authority. A camera catching a code across a market must
     * fill the field and stop there.
     */
    renderPage()
    await waitFor(() => expect(addButton()).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'scan' }))

    expect(allTerminals(STALL)).toEqual([])
    expect(screen.queryByText(/Terminal added/)).toBeNull()
  })
})

describe('the subscription gate is on the screen, not behind it', () => {
  it('refuses in words rather than hiding the form', async () => {
    // Subscriptions ticket 07: refused AT enrolment, not by a missing button.
    // A hidden button leaves an owner with no idea what to fix.
    granted = false
    // One terminal already out, so the free allowance is used up.
    recordTerminal(STALL, {
      terminalPubkey: 'd'.repeat(64),
      name: 'Existing',
      role: TERMINAL_ROLES.REDEEM_ONLY,
      enrolledAt: 1,
    })

    await fillEverything()

    expect(addButton().disabled).toBe(true)
    // The form is still there to be read, and a sentence explains the refusal.
    expect(screen.getByLabelText('Name')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toBeTruthy()
  })

  it('allows the first terminal without a subscription', async () => {
    // The free allowance. A stall trying the product must reach a working
    // terminal, or nobody ever sees what they would be paying for.
    granted = false
    await fillEverything()

    expect(addButton().disabled).toBe(false)
  })
})

describe('connectivity is stated before the attempt', () => {
  it('says so up front, before the form is filled in', async () => {
    // Enrolment has no offline path and pre-issuing is ruled out, so the owner
    // should learn this before typing, not after.
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    renderPage()
    await waitFor(() => expect(addButton()).toBeTruthy())

    expect(screen.getByText(/needs a connection/)).toBeTruthy()
  })

  it('will not enrol while offline', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    await fillEverything()

    expect(addButton().disabled).toBe(true)
    expect(allTerminals(STALL)).toEqual([])
  })
})

describe('enrolling', () => {
  it('records what revocation will later need, on the OWNER’s device', async () => {
    /**
     * Ticket 06's third criterion depends on this happening HERE. If the
     * roster row were only written by the terminal, a lost device could never
     * be revoked — which is the case that matters most.
     */
    await fillEverything()
    fireEvent.click(addButton())

    const [row] = allTerminals(STALL)
    expect(row.terminalPubkey).toBe(DEVICE)
    expect(row.name).toBe('Front counter')
    expect(row.role).toBe(TERMINAL_ROLES.REDEEM_ONLY)
    expect(row.revokedAt).toBeUndefined()
  })

  it('records the role the owner chose, not a default', async () => {
    // Reads the DELIVERED record rather than the form state, so a screen that
    // showed one role and stored another would fail here.
    renderPage()
    await waitFor(() => expect(addButton()).toBeTruthy())
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Till' } })
    fireEvent.click(screen.getByRole('button', { name: /Sell and redeem/ }))
    fireEvent.click(screen.getByRole('button', { name: 'scan' }))
    fireEvent.click(addButton())

    expect(allTerminals(STALL)[0].role).toBe(TERMINAL_ROLES.ISSUE_AND_REDEEM)
  })

  it('tells the owner the job is not finished on this device', async () => {
    // The terminal still needs a passphrase entered on IT. An owner who walks
    // away here has a device that cannot open, and no reason to know why.
    await fillEverything()
    fireEvent.click(addButton())

    expect(screen.getByText(/Terminal added/)).toBeTruthy()
    expect(screen.getByText(/passphrase/)).toBeTruthy()
  })
})

describe('a wrong scan can be corrected', () => {
  it('lets the owner rescan without leaving the screen', async () => {
    // Two devices on a counter showing similar codes is the ordinary case.
    // Without a way back, the remedy for a wrong scan is to abandon the form —
    // or to shrug and enrol the wrong device.
    await fillEverything()
    expect(addButton().disabled).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Rescan' }))

    // Back to not-yet-scanned: the scanner returns and enrolling is refused
    // again, so a stale key cannot be issued to.
    expect(addButton().disabled).toBe(true)
    expect(screen.getByRole('button', { name: 'scan' })).toBeTruthy()
    expect(allTerminals(STALL)).toEqual([])
  })
})
