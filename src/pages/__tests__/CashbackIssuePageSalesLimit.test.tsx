/**
 * @vitest-environment jsdom
 */
/**
 * Review of gc#317: a Cashlink is a sale too. A stall whose Free plan is used up is sent to the
 * upgrade screen (owner) or stopped (till) before an amount is typed, and a refusal at the mint sends
 * the owner there too instead of showing "try again".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'

const submitted = vi.hoisted(() => ({ calls: 0, impl: null as null | (() => Promise<unknown>) }))
vi.mock('../../lib/cashbackIssue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/cashbackIssue')>()),
  createCashbackIssuer: () => ({
    submit: async () => {
      submitted.calls += 1
      return submitted.impl ? submitted.impl() : null
    },
  }),
}))
vi.mock('../../lib/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/config')>()),
  gatewayConfig: () => new Promise(() => {}),
}))
const allowance = vi.hoisted(() => ({
  answer: { kind: 'unlimited' } as import('../../lib/salesAllowance').SalesAllowance,
}))
vi.mock('../../lib/salesAllowance', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/salesAllowance')>()),
  salesAllowance: async () => allowance.answer,
}))

const { CashbackIssuePage } = await import('../CashbackIssuePage')
const { CashbackGenerateError } = await import('../../lib/cashback')
const { TERMINAL_ROLES, grantFor } = await import('../../lib/terminalRole')
const { SESSION_KIND, openSession } = await import('../../lib/terminalSession')
import type { TerminalActor } from '../../lib/actor'
import type { MerchantProfile } from '../../lib/merchant'

const STALL = 'a'.repeat(64)
const merchant = {
  pubkey: STALL, active: true, categories: [], issuanceCurrency: 'EUR', voucherValidityDays: 90,
} as unknown as MerchantProfile
const till: TerminalActor = {
  kind: 'terminal', stallPubkey: STALL, role: TERMINAL_ROLES.ISSUE_AND_REDEEM, terminalPubkey: 'c'.repeat(64),
  permissions: grantFor(TERMINAL_ROLES.ISSUE_AND_REDEEM, STALL), attested: true,
}
const AT_LIMIT = { kind: 'limited', unit: 'EUR', usedMinor: 10000, allowanceMinor: 10000, remainingMinor: 0, reached: true } as const

function Probe() {
  return <p data-testid="subscription-screen">{useLocation().search}</p>
}
function show(actor?: TerminalActor) {
  const session = actor ? openSession(actor, SESSION_KIND.FULL, Date.now()) : null
  return render(
    <MemoryRouter initialEntries={['/sell/cashback']}>
      <Routes>
        <Route path="/sell/cashback" element={<CashbackIssuePage merchant={merchant} actor={actor} session={session} />} />
        <Route path="/settings/subscription" element={<Probe />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  submitted.calls = 0
  submitted.impl = null
  allowance.answer = { kind: 'unlimited' }
})
afterEach(cleanup)

describe('a free stall at its allowance opens Cashlink', () => {
  it('sends the owner to the subscription screen with the reason', async () => {
    allowance.answer = AT_LIMIT
    show()
    await waitFor(() => expect(screen.getByTestId('subscription-screen').textContent).toBe('?reason=sales-limit'))
    expect(submitted.calls).toBe(0)
  })

  it('stops a till and tells it to ask the owner', async () => {
    allowance.answer = AT_LIMIT
    show(till)
    await waitFor(() => expect(screen.getByTestId('sales-limit-reached-till')).toBeTruthy())
    expect(screen.queryByTestId('subscription-screen')).toBeNull()
  })

  it('sends the owner to the subscription screen when the mint refuses', async () => {
    submitted.impl = async () => {
      throw new CashbackGenerateError('past the Free plan', 422, 'SALES_LIMIT_REACHED')
    }
    show()
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: /Create Cashlink|Create/ }))
    await waitFor(() => expect(screen.getByTestId('subscription-screen').textContent).toBe('?reason=sales-limit'))
  })

  it('keeps any other failure on screen', async () => {
    submitted.impl = async () => {
      throw new CashbackGenerateError('The mint is down', 503, 'MINT_UNAVAILABLE')
    }
    show()
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: /Create Cashlink|Create/ }))
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(screen.queryByTestId('subscription-screen')).toBeNull()
  })
})
