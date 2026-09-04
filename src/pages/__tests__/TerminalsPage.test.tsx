/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import { TerminalsPage } from '../TerminalsPage'
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
