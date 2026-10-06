/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

/**
 * Issue #159, the cashback half: a terminal cannot issue a coupon its own
 * stall's till will accept.
 *
 * Its key is not the stall's, so its cashback carries a signed `none`. The
 * cashback claim records that without refusing, so the customer would hold a
 * code worth nothing at the only stall that could honour it. The screen stops
 * a terminal on arrival; `cashbackIssue.test.ts` covers the refusal made
 * around the screen.
 */

const submitted = vi.hoisted(() => ({ calls: 0 }))

vi.mock('../../lib/cashbackIssue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/cashbackIssue')>()),
  createCashbackIssuer: () => ({
    submit: async () => {
      submitted.calls += 1
      return null
    },
  }),
}))
vi.mock('../../lib/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/config')>()),
  gatewayConfig: () => new Promise(() => {}),
}))

const { CashbackIssuePage } = await import('../CashbackIssuePage')
const { TERMINAL_ROLES, grantFor } = await import('../../lib/terminalRole')
const { SESSION_KIND, openSession } = await import('../../lib/terminalSession')
import type { TerminalActor } from '../../lib/actor'
import type { MerchantProfile } from '../../lib/merchant'

const STALL = 'a'.repeat(64)

const merchant = {
  pubkey: STALL,
  active: true,
  categories: [],
  issuanceCurrency: 'EUR',
  voucherValidityDays: 90,
} as unknown as MerchantProfile

const till: TerminalActor = {
  kind: 'terminal',
  stallPubkey: STALL,
  role: TERMINAL_ROLES.ISSUE_AND_REDEEM,
  terminalPubkey: 'c'.repeat(64),
  permissions: grantFor(TERMINAL_ROLES.ISSUE_AND_REDEEM, STALL),
}

function show(actor?: TerminalActor, kind: 'full' | 'reduced' | null = null) {
  const session = actor && kind ? openSession(actor, kind, Date.now()) : null
  return render(
    <MemoryRouter>
      <CashbackIssuePage merchant={merchant} actor={actor} session={session} />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  submitted.calls = 0
})

afterEach(cleanup)

describe('a terminal reaching /sell/cashback', () => {
  it('without a FULL session is stopped on arrival', () => {
    show(till, SESSION_KIND.REDUCED)

    const alert = screen.getByRole('alert')
    expect(alert.textContent).toMatch(/cannot issue cashback right now/)
  })

  it('offers no amount field, so no code can be minted', () => {
    show(till)

    expect(screen.queryByPlaceholderText('0.00')).toBeNull()
    expect(submitted.calls).toBe(0)
  })

  it('in a FULL session gets the amount field (#160 phase 5)', () => {
    show(till, SESSION_KIND.FULL)

    expect(screen.getByPlaceholderText('0.00')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('the owner’s own device', () => {
  it('still gets the amount field', () => {
    show()

    expect(screen.getByPlaceholderText('0.00')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
