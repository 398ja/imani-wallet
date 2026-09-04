/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import { MerchantHomePage } from '../MerchantHomePage'
import { TERMINAL_ROLES, grantFor, type TerminalRole } from '../../lib/terminalRole'
import { SESSION_KIND, canIssueNow, canRedeemNow, openSession } from '../../lib/terminalSession'
import type { OwnerActor, TerminalActor } from '../../lib/actor'

/**
 * The till, as each kind of device sees it.
 *
 * The rules are tested in `terminalSession.test.ts` and the ENFORCEMENT in
 * `issueActor.test.ts`. What only this file can show is that the screen and the
 * enforcement point agree — a screen offering Sell to a terminal that would be
 * refused is a queue-side failure with a customer watching.
 */

const STALL = 'a'.repeat(64)
const DEVICE = 'c'.repeat(64)
const HOUR = 3600 * 1000

const owner: OwnerActor = { kind: 'owner', stallPubkey: STALL }

function terminal(role: TerminalRole = TERMINAL_ROLES.ISSUE_AND_REDEEM): TerminalActor {
  return {
    kind: 'terminal',
    stallPubkey: STALL,
    role,
    terminalPubkey: DEVICE,
    permissions: grantFor(role, STALL),
  }
}

function show(props: Parameters<typeof MerchantHomePage>[0] = {}) {
  return render(
    <MemoryRouter>
      <MerchantHomePage {...props} />
    </MemoryRouter>,
  )
}

const sell = () => screen.queryByRole('button', { name: /Sell/ })
const redeem = () => screen.queryByRole('button', { name: /Redeem/ })

afterEach(cleanup)

describe('a stall on its own device sees no change', () => {
  it('shows both buttons with no actor at all', () => {
    // The ticket's fifth criterion. This is the overwhelmingly common case and
    // the one a regression here would hurt most.
    show()
    expect(sell()).toBeTruthy()
    expect(redeem()).toBeTruthy()
  })

  it('shows both buttons for an owner actor, session or not', () => {
    show({ actor: owner, session: null })
    expect(sell()).toBeTruthy()
    expect(redeem()).toBeTruthy()
  })
})

describe('a terminal shows only what its role permits', () => {
  it('gives a full till both buttons', () => {
    show({
      actor: terminal(),
      session: openSession(terminal(), SESSION_KIND.FULL, Date.now()),
    })
    expect(sell()).toBeTruthy()
    expect(redeem()).toBeTruthy()
  })

  it('gives a redemption-only terminal no Sell', () => {
    const actor = terminal(TERMINAL_ROLES.REDEEM_ONLY)
    show({ actor, session: openSession(actor, SESSION_KIND.FULL, Date.now()) })

    expect(sell()).toBeNull()
    expect(redeem()).toBeTruthy()
  })
})

describe('reduced authority', () => {
  it('keeps Redeem and drops Sell, because the queue cannot wait', () => {
    // The mint was unreachable at login. Redemption must never need the network
    // to authorise; issuance is value-bearing and does wait.
    const actor = terminal()
    show({ actor, session: openSession(actor, SESSION_KIND.REDUCED, Date.now()) })

    expect(redeem()).toBeTruthy()
    expect(sell()).toBeNull()
  })

  it('is not treated as a lapse', () => {
    const actor = terminal()
    show({ actor, session: openSession(actor, SESSION_KIND.REDUCED, Date.now()) })

    expect(screen.queryByText('Not trading')).toBeNull()
  })
})

describe('a lapsed terminal says so once and stops offering to serve', () => {
  const expired = () => {
    const actor = terminal()
    return { actor, session: openSession(actor, SESSION_KIND.FULL, Date.now() - 13 * HOUR) }
  }

  it('offers nothing at all', () => {
    /**
     * The alternative — leaving the buttons up and failing on each press — is
     * what the ticket rules out. It leaves staff guessing whether to retry with
     * a customer waiting.
     */
    show(expired())
    expect(sell()).toBeNull()
    expect(redeem()).toBeNull()
  })

  it('says what happened and who to ask', () => {
    show(expired())
    expect(screen.getByText('Not trading')).toBeTruthy()
    expect(screen.getByText(/signing in again/)).toBeTruthy()
    expect(screen.getByText(/stall owner/)).toBeTruthy()
  })

  it('announces itself, rather than changing silently', () => {
    // Staff may be looking at the customer rather than the screen when the day
    // rolls over. `role="status"` is polite, not assertive: it waits for a
    // pause instead of interrupting.
    show(expired())
    expect(screen.getByRole('status')).toBeTruthy()
  })

  it('offers nothing when there is no session at all', () => {
    show({ actor: terminal(), session: null })
    expect(sell()).toBeNull()
    expect(redeem()).toBeNull()
  })
})

describe('the screen and the enforcement point never disagree', () => {
  /**
   * The property behind "the hiding is the courtesy, not the control".
   *
   * Enumerated across every role and every session state rather than spot
   * checked, because the failure that matters is the one combination somebody
   * forgot. A visible Sell that would be refused is a queue-side failure with a
   * customer watching; a hidden Sell that would have worked is a till that
   * quietly stopped earning.
   */
  it('offers Sell exactly when issuance would be allowed', () => {
    const cases = [
      ['full', SESSION_KIND.FULL, Date.now()],
      ['reduced', SESSION_KIND.REDUCED, Date.now()],
      ['expired', SESSION_KIND.FULL, Date.now() - 13 * HOUR],
    ] as const

    for (const role of Object.values(TERMINAL_ROLES)) {
      for (const [label, kind, openedAt] of cases) {
        const actor = terminal(role)
        const session = openSession(actor, kind, openedAt)

        cleanup()
        show({ actor, session })
        const offered = sell() !== null

        // The enforcement point's own answer, asked directly.
        const allowed = canIssueNow(actor, session)

        expect(offered, `${role} on a ${label} session`).toBe(allowed)
      }
    }
  })

  it('offers Redeem exactly when redemption would be allowed', () => {
    for (const role of Object.values(TERMINAL_ROLES)) {
      for (const kind of Object.values(SESSION_KIND)) {
        const actor = terminal(role)
        const session = openSession(actor, kind, Date.now())

        cleanup()
        show({ actor, session })

        expect(redeem() !== null, `${role} on a ${kind} session`).toBe(
          canRedeemNow(actor, session),
        )
      }
    }
  })
})

describe('the lapse mark matches the reason', () => {
  it('distinguishes a day that rolled over from authority that was withdrawn', () => {
    // One icon for both would make the routine case (every terminal, every
    // day, fixes itself) look permanent, and the permanent case look like
    // something to wait out.
    //
    // lucide stamps its component name into a class, so the ICON itself is
    // asserted rather than "the markup differs somehow" — which would pass on
    // any difference at all, including the message text below it.
    const actor = terminal()
    const iconName = () =>
      screen.getByRole('status').querySelector('svg')?.getAttribute('class') ?? ''

    show({ actor, session: openSession(actor, SESSION_KIND.FULL, Date.now() - 13 * HOUR) })
    expect(iconName()).toMatch(/clock/i)

    cleanup()
    show({ actor, session: null })
    expect(iconName()).toMatch(/shield/i)
  })
})

describe('a refused terminal is not mistaken for the owner', () => {
  /**
   * The hole this closes, found by re-reading the wiring rather than by any
   * test: "no actor" was doing two opposite jobs. A device with no credential
   * is the stall's own and gets the full till. A device whose credential was
   * REJECTED — revoked, or locked to another device — also produced no actor,
   * and so was handed that same full till.
   *
   * A revoked terminal could sell. Nothing in 1873 unit tests, 33 browser
   * checks or a live-mint probe covered it, because none of them asked what a
   * refused terminal RENDERS.
   */
  const REFUSAL = 'This terminal is no longer in service. Ask the stall owner.'

  it('offers nothing at all when the credential was refused', () => {
    show({ refusal: REFUSAL })

    expect(sell()).toBeNull()
    expect(redeem()).toBeNull()
  })

  it('says why, in the words the refusal chose', () => {
    show({ refusal: REFUSAL })
    expect(screen.getByText(REFUSAL)).toBeTruthy()
  })

  it('refuses even when an actor and a healthy session are also present', () => {
    // The refusal wins over everything. A device holding a rejected credential
    // must not be able to trade because some other field looked fine.
    const actor = terminal()
    show({
      refusal: REFUSAL,
      actor,
      session: openSession(actor, SESSION_KIND.FULL, Date.now()),
    })

    expect(sell()).toBeNull()
    expect(redeem()).toBeNull()
  })

  it('leaves the owner’s own device untouched', () => {
    // The owner holds no credential, so nothing can refuse them.
    show({ refusal: null })
    expect(sell()).toBeTruthy()
    expect(redeem()).toBeTruthy()
  })
})
