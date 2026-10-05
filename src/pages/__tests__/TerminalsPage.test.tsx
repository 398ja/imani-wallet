/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { StrictMode } from 'react'

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
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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

/**
 * A real gateway-minted credential, so revoking runs `revokeCredential`'s own
 * "is this a terminal credential" check for real. Only the mint is faked.
 */
const TOKEN = readFileSync(
  join(__dirname, '../../lib/__tests__/fixtures/live-terminal-credential.token'),
  'utf8',
).trim()

/** Phase 2: what the device has confirmed, as `collectEnrolled` would find it. */
let confirmations: Array<{ terminalPubkey: string; voucherId: string }> = []
const collect = async (stall: string) => {
  const { markInService } = await import('../../lib/terminalRoster')
  return confirmations.filter((c) => markInService(stall, c.terminalPubkey, c.voucherId)).length
}

/** The owner's spend client, faked: UNSPENT until spent, and spending works unless told not to. */
let spendFails = false
const spent: string[] = []
const fakeMint = {
  validateToken: vi.fn(async (token: string) => ({ state: spent.includes(token) ? 'SPENT' : 'UNSPENT' })),
  receive: vi.fn(async (token: string) => {
    if (spendFails) throw new Error('offline')
    spent.push(token)
    return {}
  }),
}

function renderPage() {
  return render(
    <MemoryRouter>
      {/* The gateway confirms at once and there is no DM to send: the
          round 2 tests below inject their own. */}
      <TerminalsPage
        stallPubkey={STALL}
        spendApi={async () => fakeMint}
        collect={collect}
        confirm={async () => 204}
        deliver={async () => 0}
      />
    </MemoryRouter>,
  )
}

function enrol(over: Parameters<typeof recordTerminal>[1] | Record<string, unknown> = {}) {
  recordTerminal(STALL, {
    terminalPubkey: DOOR,
    name: 'Door',
    role: TERMINAL_ROLES.REDEEM_ONLY,
    enrolledAt: 1_000_000,
    token: TOKEN,
    voucherId: 'cred-door',
    ...(over as object),
  } as Parameters<typeof recordTerminal>[1])
}

beforeEach(() => {
  localStorage.clear()
  spendFails = false
  spent.length = 0
  confirmations = []
  fakeMint.receive.mockClear()
})
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

  it('revokes on confirmation and updates the list without a reload', async () => {
    enrol()
    renderPage()

    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))
    fireEvent.click(screen.getByRole('button', { name: /Revoke Door/ }))

    await waitFor(() => expect(isRevoked(STALL, DOOR)).toBe(true))
    expect(screen.getByText('No longer in service')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Revoke' })).toBeNull()
  })

  // #160 phase 1 (G10): Revoke used to mark a local row and nothing else, so a
  // "revoked" terminal kept its authority. It must now spend the credential at
  // the mint, with the stall's key, before the row says revoked.
  it('spends the credential at the mint before marking the row', async () => {
    enrol()
    renderPage()

    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))
    fireEvent.click(screen.getByRole('button', { name: /Revoke Door/ }))

    await waitFor(() => expect(isRevoked(STALL, DOOR)).toBe(true))
    expect(fakeMint.receive).toHaveBeenCalledWith(TOKEN)
  })

  // A revocation that did not land must not be shown as one: the owner of a
  // stolen till who believes it is dead, and is wrong, is worse off than one
  // who knows. The row stays in service, the screen says so, and Revoke is
  // offered again.
  it('leaves the row in service and says so when the spend does not land', async () => {
    spendFails = true
    enrol()
    renderPage()

    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))
    fireEvent.click(screen.getByRole('button', { name: /Revoke Door/ }))

    await waitFor(() => expect(screen.getByText(/did not reach the mint/)).toBeTruthy())
    expect(isRevoked(STALL, DOOR)).toBe(false)
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeTruthy()
  })

  // A row set up by hand before #160 holds no credential, so nothing can be
  // spent. Offering Revoke would mark the row while the device kept its
  // authority. It says how to replace it instead.
  it('offers no Revoke for a row set up before revocation existed', () => {
    enrol({ token: undefined, voucherId: undefined })
    renderPage()

    expect(screen.queryByRole('button', { name: 'Revoke' })).toBeNull()
    expect(screen.getByText(/Set up before revocation existed/)).toBeTruthy()
  })

  // A waiting row is cancelled, not revoked (spec 2.1), and Cancel is the
  // same spend.
  it('offers Cancel on a waiting row, and cancelling spends it', async () => {
    enrol({ status: 'waiting', waitingUntil: Date.now() + 3_600_000 })
    renderPage()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: /Cancel Door/ }))

    await waitFor(() => expect(isRevoked(STALL, DOOR)).toBe(true))
    expect(fakeMint.receive).toHaveBeenCalledWith(TOKEN)
  })

  // Decision 4: a waiting row nobody confirmed within 24 hours is cancelled
  // when the owner next opens the list, so an unconfirmed authority to the
  // stall is never left in a drawer.
  it('cancels a waiting row past its 24 hours when the list opens', async () => {
    enrol({ status: 'waiting', enrolledAt: 1_000, waitingUntil: 2_000 })
    renderPage()

    await waitFor(() => expect(isRevoked(STALL, DOOR)).toBe(true))
    expect(fakeMint.receive).toHaveBeenCalledWith(TOKEN)
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

describe('#160 review: rows left behind by earlier versions and lost answers', () => {
  // A phase 0 waiting row holds no token: nothing was minted for it, so it
  // cannot be cancelled at the mint and used to sit on the list for ever,
  // blocking Add once two existed. It now offers Remove, which takes it off.
  it('lets the owner remove a waiting row that was never minted', async () => {
    enrol({ status: 'waiting', token: undefined, voucherId: undefined })
    renderPage()

    expect(screen.getByText(/Nothing was ever sent to this device/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))

    await waitFor(() => expect(screen.queryByText('Door')).toBeNull())
    expect(fakeMint.receive).not.toHaveBeenCalled()
  })

  // A request whose answer was lost is finished when the list opens: the
  // credential is fetched by its voucher id, checked, and the row becomes an
  // ordinary waiting row with Cancel.
  it('finishes a credential request whose answer was lost', async () => {
    enrol({ status: 'minting', token: undefined, mintKey: 'k-1', voucherId: 'cred-door' })
    const resumeTransport = {
      post: vi.fn(async () => new Response('{}', { status: 500 })),
      get: vi.fn(async () => new Response(JSON.stringify({ status: 'ISSUED', token: TOKEN }), { status: 200 })),
      sleep: async () => {},
    }
    render(
      <MemoryRouter>
        <TerminalsPage stallPubkey={STALL} spendApi={async () => fakeMint} transport={resumeTransport} />
      </MemoryRouter>,
    )

    expect(screen.getByText(/Still being set up/)).toBeTruthy()
    // The live fixture is locked to its own device and stall, not to DOOR and
    // STALL, so the check refuses it and spends it. Either way the row is
    // settled and is no longer an unknown credential.
    await waitFor(() => expect(screen.queryByText(/Still being set up/)).toBeNull())
    expect(resumeTransport.get).toHaveBeenCalled()
  })
})

describe('#160 phase 2: the row turns In service when the device confirms', () => {
  // The owner adds a terminal; the row waits. When the device's enrolled DM
  // arrives the row turns In service, with no reload.
  it('promotes a waiting row when its device confirms, without a reload', async () => {
    enrol({ status: 'waiting', waitingUntil: Date.now() + 3_600_000 })
    renderPage()
    expect(screen.getByText(/Waiting for the device/)).toBeTruthy()

    confirmations = [{ terminalPubkey: DOOR, voucherId: 'cred-door' }]

    await waitFor(() => expect(screen.queryByText(/Waiting for the device/)).toBeNull(), {
      timeout: 8000,
    })
    expect(screen.getByText(/Never used/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeTruthy()
  })

  // The app runs under React StrictMode, which mounts every effect twice. The
  // first poll can promote the row after its effect was torn down, and the
  // second then finds nothing left to change. The list must still show the
  // row In service, because it re-reads the roster rather than trusting the count.
  it('turns In service under StrictMode, when the poll that promoted it was torn down', async () => {
    enrol({ status: 'waiting', waitingUntil: Date.now() + 3_600_000 })
    confirmations = [{ terminalPubkey: DOOR, voucherId: 'cred-door' }]
    render(
      <StrictMode>
        <MemoryRouter>
          <TerminalsPage
            stallPubkey={STALL}
            spendApi={async () => fakeMint}
            collect={collect}
            confirm={async () => 204}
            deliver={async () => 0}
          />
        </MemoryRouter>
      </StrictMode>,
    )

    await waitFor(() => expect(screen.queryByText(/Waiting for the device/)).toBeNull(), {
      timeout: 8000,
    })
  })

  // A confirmation naming another credential of the same device does not
  // promote this row: it might be an old one the owner already cancelled.
  it('ignores a confirmation for a different credential', async () => {
    const { markInService, allTerminals: rows } = await import('../../lib/terminalRoster')
    enrol({ status: 'waiting', waitingUntil: Date.now() + 3_600_000 })

    expect(markInService(STALL, DOOR, 'some-older-credential')).toBe(false)
    expect(rows(STALL)[0].status).toBe('waiting')
  })
})

describe('#160 round 2: the list shows what the gateway says', () => {
  function renderWith(confirm: (id: string) => Promise<number | null>, deliver = async () => 0) {
    return render(
      <MemoryRouter>
        <TerminalsPage
          stallPubkey={STALL}
          spendApi={async () => fakeMint}
          collect={collect}
          confirm={confirm}
          deliver={deliver}
        />
      </MemoryRouter>,
    )
  }

  // The device's own confirm was lost. Its enrolled DM arrives, the owner's
  // app confirms as the stall, and only then does the row stop saying it is
  // being confirmed. It never reads as a ready till while the gateway refuses.
  it('confirms a device whose own confirm was lost, then shows it confirmed', async () => {
    enrol({ status: 'waiting', waitingUntil: Date.now() + 60_000 })
    confirmations = [{ terminalPubkey: DOOR, voucherId: 'cred-door' }]
    let release!: () => void
    const answered = new Promise<void>((r) => (release = r))
    const confirm = vi.fn(async () => {
      await answered
      return 204
    })

    renderWith(confirm)

    expect(await screen.findByText(/Confirming with the gateway/)).toBeTruthy()
    release()
    await waitFor(() => expect(screen.queryByText(/Confirming with the gateway/)).toBeNull())
    expect(confirm).toHaveBeenCalledWith('cred-door')
    expect(screen.getByText(/Never used/)).toBeTruthy()
  })

  // 410 from the gateway: lapsed. The row says it cannot sell.
  it('shows a lapsed terminal as unable to sell', async () => {
    enrol({ status: 'in-service', gatewayState: 'unconfirmed' })

    renderWith(async () => 410)

    expect(await screen.findByText(/Lapsed before it was confirmed/)).toBeTruthy()
    expect(screen.getByText(/cannot sell\. Revoke it/)).toBeTruthy()
  })

  // A waiting row carries its setup code on the list, so a row finished by
  // resumeMinting (or one whose enrol screen was closed early) can still be
  // set up. And the list sends any DM that never went out.
  it('offers the setup code on a waiting row and sends its DM', async () => {
    enrol({ status: 'waiting', waitingUntil: Date.now() + 60_000 })
    const deliver = vi.fn(async () => 1)

    renderWith(async () => 204, deliver)

    expect((await screen.findByTestId('row-setup-code')).textContent).toContain('cred-door')
    await waitFor(() => expect(deliver).toHaveBeenCalledWith(STALL))
  })
})
