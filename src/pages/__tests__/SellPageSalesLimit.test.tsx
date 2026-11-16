/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

/**
 * A free stall past its allowance: the refusal is an error with an invitation to upgrade.
 *
 * A terminal's key is not the stall's, so its coupons could only carry a
 * signed `none` warrant, and every wallet receiving a coupon by DM refuses
 * that before the mint swap. The terminal reported success while the
 * customer's wallet showed "Coupon not authorised" and a balance of 0.
 *
 * So the screen stops a terminal on arrival, before a customer is scanned or
 * any money is taken, and the enforcement point refuses the same request made
 * around it (`issueActor.test.ts`). This file covers the screen, and that a
 * refusal from the enforcement point is shown as an error, never as success.
 */

const issued = vi.hoisted(() => ({
  calls: 0,
  args: undefined as unknown,
  impl: null as null | (() => Promise<unknown>),
}))

vi.mock('../../lib/issue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/issue')>()),
  issueAndDeliver: async (params: unknown) => {
    issued.calls += 1
    issued.args = params
    if (!issued.impl) throw new Error('issueAndDeliver not stubbed')
    return issued.impl()
  },
}))

// The camera. Replaced by a button that "scans" a fixed customer.
vi.mock('../../components/ScanRecipient', () => ({
  ScanRecipient: ({ onFound }: { onFound: (pubkey: string) => void }) => (
    <button type="button" onClick={() => onFound('e'.repeat(64))}>
      fake-scan
    </button>
  ),
}))

vi.mock('../../lib/identity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/identity')>()),
  useIdentity: () => undefined,
  useIdentityState: () => ({ identity: undefined, loading: false }),
}))
vi.mock('../../hooks/useIsMerchant', () => ({ useIsMerchant: () => false }))
vi.mock('../../lib/cashback', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/cashback')>()),
  useCashbackAvailable: () => false,
}))

const { SellPage } = await import('../SellPage')
const { TERMINAL_ROLES, grantFor } = await import('../../lib/terminalRole')
const { SESSION_KIND, openSession } = await import('../../lib/terminalSession')
import type { TerminalActor } from '../../lib/actor'
import type { MerchantProfile } from '../../lib/merchant'

const STALL = 'a'.repeat(64)
const DEVICE = 'c'.repeat(64)

const merchant = {
  pubkey: STALL,
  active: true,
  categories: [],
  issuanceCurrency: 'GBP',
  voucherValidityDays: 90,
} as unknown as MerchantProfile

const till: TerminalActor = {
  kind: 'terminal',
  stallPubkey: STALL,
  role: TERMINAL_ROLES.ISSUE_AND_REDEEM,
  terminalPubkey: DEVICE,
  permissions: grantFor(TERMINAL_ROLES.ISSUE_AND_REDEEM, STALL),
  // The stall attested this till at enrolment (#160 decision 5), so it may sell.
  attested: true,
}

function show(props: Partial<Parameters<typeof SellPage>[0]> = {}) {
  return render(
    <MemoryRouter>
      <SellPage pubkey={STALL} merchant={merchant} {...props} />
    </MemoryRouter>,
  )
}

const SUCCESS = /in their wallet now/

const { SalesLimitError, SALES_LIMIT_MESSAGE } = await import('../../lib/entitlement')

beforeEach(() => {
  issued.calls = 0
  issued.impl = null
})

afterEach(cleanup)

async function sell100(props: Partial<Parameters<typeof SellPage>[0]> = {}) {
  issued.impl = async () => {
    throw new SalesLimitError(SALES_LIMIT_MESSAGE)
  }
  show(props)
  fireEvent.click(screen.getByText('fake-scan'))
  fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '100' } })
  fireEvent.click(screen.getByRole('button', { name: /Send voucher/ }))
  await waitFor(() => expect(screen.getByTestId('sales-limit-reached')).toBeTruthy())
}

describe('a free stall at £30 selling £100', () => {
  it('shows the refusal, not success, with a link to the subscription screen', async () => {
    await sell100()
    expect(screen.queryByText(SUCCESS)).toBeNull()
    expect(screen.getByRole('alert').textContent).toMatch(/nothing was issued/)
    const link = screen.getByTestId('sales-limit-upgrade') as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('/settings/subscription')
    expect(link.textContent).toMatch(/Upgrade my plan/)
  })

  it('tells a till to ask the owner, since only the owner can buy a plan', async () => {
    await sell100({ actor: till, session: openSession(till, SESSION_KIND.FULL, Date.now()) })
    expect(screen.queryByTestId('sales-limit-upgrade')).toBeNull()
    expect(screen.getByRole('alert').textContent).toMatch(/Ask the stall owner to upgrade/)
  })

  it('shows any other failure without the upgrade link', async () => {
    issued.impl = async () => {
      throw new Error('The mint is down')
    }
    show()
    fireEvent.click(screen.getByText('fake-scan'))
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: /Send voucher/ }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/mint is down/))
    expect(screen.queryByTestId('sales-limit-upgrade')).toBeNull()
  })
})
