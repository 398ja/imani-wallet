/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

/**
 * Only the licence CHECK is stubbed. `lapseService` — which decides which
 * tills a lapse stops — runs for real, because it is the thing being wired.
 */
let subscribed = true
vi.mock('../../lib/licenceStatus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/licenceStatus')>()
  return {
    ...actual,
    licenceStatus: async () => ({
      checkedAt: Date.now(),
      decision: subscribed
        ? { granted: true as const, source: 'verified' as const, grant: { features: ['terminals'] } }
        : { granted: false as const, reason: 'expired' as const },
    }),
  }
})

const { TerminalsPage } = await import('../TerminalsPage')
import { recordTerminal, revokeTerminal, isRevoked, REVOCATION_DELAY_HOURS } from '../../lib/terminalRoster'
import { TERMINAL_ROLES } from '../../lib/terminalRole'

/**
 * The terminal list, driven as a screen.
 *
 * The roster module has its own tests. What only a rendered screen can be wrong
 * about is whether the owner is TOLD the things the ticket requires: that the
 * delay appears before the decision rather than after it, that a revoked
 * terminal is still visible, and that nothing anywhere offers a pause.
 *
 * The real roster runs — stubbing it would leave the wiring untested, and the
 * wiring is the part that has not been proven yet.
 */

const STALL = 'a'.repeat(64)
const DOOR = 'c'.repeat(64)

function renderPage() {
  return render(
    <MemoryRouter>
      <TerminalsPage stallPubkey={STALL} />
    </MemoryRouter>,
  )
}

function enrol(over: Parameters<typeof recordTerminal>[1] | Record<string, unknown> = {}) {
  recordTerminal(STALL, {
    terminalPubkey: DOOR,
    name: 'Door',
    role: TERMINAL_ROLES.REDEEM_ONLY,
    enrolledAt: 1_000_000,
    revocationSecret: 'secret',
    ...(over as object),
  } as Parameters<typeof recordTerminal>[1])
}

beforeEach(() => localStorage.clear())
afterEach(cleanup)

describe('what the list shows', () => {
  it('names each terminal, its role and its last use', () => {
    enrol({ lastUsedAt: Date.parse('2024-03-02T10:00:00Z') })
    renderPage()

    expect(screen.getByText('Door')).toBeTruthy()
    expect(screen.getByText(/Redemption only/)).toBeTruthy()
    expect(screen.getByText(/Last used/)).toBeTruthy()
  })

  it('says "never used" rather than leaving a blank', () => {
    // The useful answer when an owner is deciding which of two forgotten
    // devices to retire. A blank where a date belongs reads as a bug.
    enrol()
    renderPage()
    expect(screen.getByText(/Never used/)).toBeTruthy()
  })

  it('tells an owner with no terminals what to do', () => {
    renderPage()
    expect(screen.getByText(/No terminals yet/)).toBeTruthy()
  })
})

describe('the delay is stated before the decision, not after', () => {
  it('shows the hours only once revoking is being considered', () => {
    enrol()
    renderPage()

    // Not shouted at an owner who is only looking at the list.
    expect(screen.queryByText(new RegExp(`${REVOCATION_DELAY_HOURS} hours`))).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))

    // Present at the moment of choosing, which is when "is that good enough, or
    // do I close the stall?" is actually being decided.
    expect(screen.getByText(new RegExp(`${REVOCATION_DELAY_HOURS} hours`))).toBeTruthy()
    expect(screen.getByText(/close your stall/)).toBeTruthy()
  })

  it('does not revoke on the first tap', () => {
    // There is no undo from this screen; the way back is a whole enrolment.
    enrol()
    renderPage()

    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))

    expect(isRevoked(STALL, DOOR)).toBe(false)
  })

  it('leaves the terminal alone when the owner backs out', () => {
    enrol()
    renderPage()

    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))
    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }))

    expect(isRevoked(STALL, DOOR)).toBe(false)
    expect(screen.queryByText(/close your stall/)).toBeNull()
  })

  it('revokes on confirmation and updates the list without a reload', () => {
    enrol()
    renderPage()

    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))
    fireEvent.click(screen.getByRole('button', { name: /Revoke Door/ }))

    expect(isRevoked(STALL, DOOR)).toBe(true)
    expect(screen.getByText('No longer in service')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Revoke' })).toBeNull()
  })
})

describe('revoking withdraws authority without erasing', () => {
  it('keeps a revoked terminal on the list, marked', () => {
    // Its movements are still in the stall's records. A list that dropped the
    // row would leave those pointing at a name with nothing behind it.
    enrol()
    revokeTerminal(STALL, DOOR, Date.parse('2024-03-02T10:00:00Z'))
    renderPage()

    expect(screen.getByText('Door')).toBeTruthy()
    expect(screen.getByText(/Revoked/)).toBeTruthy()
    expect(screen.getByText(/stops trading by/)).toBeTruthy()
  })

  it('offers no way to revoke it a second time', () => {
    enrol()
    revokeTerminal(STALL, DOOR)
    renderPage()

    expect(screen.queryByRole('button', { name: /Revoke/ })).toBeNull()
  })

  it('does not list another stall’s terminals', () => {
    recordTerminal('b'.repeat(64), {
      terminalPubkey: DOOR,
      name: 'Not mine',
      role: TERMINAL_ROLES.REDEEM_ONLY,
      enrolledAt: 1,
    })
    renderPage()

    expect(screen.queryByText('Not mine')).toBeNull()
  })
})

describe('there is no pause', () => {
  it('offers no control that suspends, and says how to bring one back', () => {
    /**
     * The sixth acceptance criterion, asserted over what the owner can actually
     * see and press. A suspend would need exactly the server-side record ADR
     * 0005 removes, so the absence is a design decision worth failing a build
     * over — and the sentence about re-enrolling is what stops the absence
     * reading as a missing button.
     */
    enrol()
    const { container } = renderPage()

    for (const banned of [/pause/i, /resume/i, /suspend/i, /disable/i, /deactivate/i]) {
      expect(container.textContent).not.toMatch(banned)
    }
    expect(screen.getByText(/add it again from the device/i)).toBeTruthy()
  })

  it('says how to bring one back even when the confirmation is open', () => {
    enrol()
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))

    expect(screen.getByText(/add it again from the device/i)).toBeTruthy()
  })
})

describe('what a lapse shows the owner', () => {
  const two = () => {
    enrol()
    recordTerminal(STALL, {
      terminalPubkey: 'e'.repeat(64),
      name: 'Second',
      role: TERMINAL_ROLES.REDEEM_ONLY,
      enrolledAt: 2_000_000,
    })
  }

  it('says nothing about lapses while the subscription is live', async () => {
    // The common case. An owner in good standing must never see a word about
    // tills stopping.
    two()
    renderPage()

    await waitFor(() => expect(screen.getByText('Second')).toBeTruthy())
    expect(screen.queryByText(/subscription is inactive/)).toBeNull()
  })

  it('marks only the tills a lapse actually stopped', async () => {
    /**
     * The free one keeps serving, so exactly one of these two is marked. A
     * screen that marked both would tell an owner their stall had stopped
     * trading over a billing problem, which is the thing the whole design
     * refuses.
     */
    subscribed = false
    two()
    renderPage()

    await waitFor(() =>
      expect(screen.getAllByText(/subscription is inactive/)).toHaveLength(1),
    )
  })

  it('keeps the marked till on the list, not in "no longer in service"', async () => {
    // Stopped by a bill is not retired by the owner. Moving it would imply the
    // owner did something, and would put it beside terminals that need
    // re-enrolling — which this one does not.
    subscribed = false
    two()
    renderPage()

    await waitFor(() => expect(screen.getByText(/subscription is inactive/)).toBeTruthy())
    expect(screen.getByText('In service')).toBeTruthy()
    expect(screen.queryByText('No longer in service')).toBeNull()
  })

  it('promises renewal restores it with nothing to set up', async () => {
    // The kind half of the design, said out loud. An owner who thinks renewal
    // means re-enrolling every device may not bother renewing.
    subscribed = false
    two()
    renderPage()

    await waitFor(() =>
      expect(screen.getByText(/nothing needs setting up on the device/)).toBeTruthy(),
    )
  })

  it('never calls it paused', async () => {
    // There is no pause in this system, and unlike a revocation this needs no
    // action on the device to undo.
    subscribed = false
    two()
    const { container } = renderPage()

    await waitFor(() => expect(screen.getByText(/subscription is inactive/)).toBeTruthy())
    expect(container.textContent).not.toMatch(/paused|suspended/i)
  })
})
