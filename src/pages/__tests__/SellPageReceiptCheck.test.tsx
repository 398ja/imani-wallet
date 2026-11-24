/**
 * @vitest-environment jsdom
 *
 * Spec 049: Sell's scanner is for the customer. A receipt (`imrc1:`) scanned there is neither sold
 * to nor checked: it is pointed to the receipt scanner (owner: Transactions; till: its home), so
 * checking never depends on whether the stall may sell today.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'

const RECEIPT = 'imrc1:receipt-payload'

// The camera. Hands the screen's onText the code, and falls through to onFound as the real one does.
vi.mock('../../components/ScanRecipient', () => ({
  ScanRecipient: ({
    onText,
    onFound,
  }: {
    onText?: (t: string) => boolean
    onFound: (pubkey: string) => void
  }) => (
    <>
      <button type="button" onClick={() => (onText?.(RECEIPT) ? undefined : onFound('e'.repeat(64)))}>
        scan-receipt
      </button>
      <button type="button" onClick={() => (onText?.('cocoa@stall.example') ? undefined : onFound('e'.repeat(64)))}>
        scan-customer
      </button>
    </>
  ),
}))
vi.mock('../../lib/identity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/identity')>()),
  useIdentity: () => undefined,
  useIdentityState: () => ({ identity: undefined, loading: false }),
}))
vi.mock('../../hooks/useIsMerchant', () => ({ useIsMerchant: () => false }))
vi.mock('../../lib/salesAllowance', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/salesAllowance')>()),
  salesAllowance: async () => ({ kind: 'unlimited' }),
}))
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
const merchant = {
  pubkey: STALL,
  active: true,
  categories: [],
  issuanceCurrency: 'GBP',
  voucherValidityDays: 90,
} as unknown as MerchantProfile

const till = (permissions: readonly string[]): TerminalActor => ({
  kind: 'terminal',
  stallPubkey: STALL,
  role: TERMINAL_ROLES.ISSUE_AND_REDEEM,
  terminalPubkey: 'c'.repeat(64),
  permissions,
  attested: true,
})

function CheckProbe() {
  const state = useLocation().state as { qr?: string } | null
  return (
    <p data-testid="check">
      {useLocation().search}|{state?.qr}
    </p>
  )
}

function show(props: Partial<Parameters<typeof SellPage>[0]> = {}) {
  return render(
    <MemoryRouter initialEntries={['/sell']}>
      <Routes>
        <Route path="/sell" element={<SellPage pubkey={STALL} merchant={merchant} {...props} />} />
        <Route path="/receipt/check" element={<CheckProbe />} />
      </Routes>
    </MemoryRouter>,
  )
}

afterEach(cleanup)

describe('Sell is for the customer; a receipt has its own scanner (spec 049)', () => {
  it('asks only for the customer', () => {
    show()
    expect(screen.getByText("Scan the customer's code")).toBeTruthy()
    expect(screen.queryByText(/a receipt to check it/i)).toBeNull()
  })

  it('owner: a scanned receipt is not sold to and not checked here; it says where to check it', async () => {
    show()
    fireEvent.click(screen.getByText('scan-receipt'))
    expect(await screen.findByText(/payment receipt, not a customer.*Check a receipt on Transactions/)).toBeTruthy()
    expect(screen.queryByTestId('check')).toBeNull()
    // Still on the scan step: no customer was taken.
    expect(screen.getByText("Scan the customer's code")).toBeTruthy()
  })

  it('any other code is still the customer to sell to, and clears the note', async () => {
    show()
    fireEvent.click(screen.getByText('scan-receipt'))
    await screen.findByText(/payment receipt, not a customer/)
    fireEvent.click(screen.getByText('scan-customer'))
    expect(screen.queryByTestId('check')).toBeNull()
    expect(screen.queryByText(/payment receipt, not a customer/)).toBeNull()
    // The amount step: the scan step's subtitle has gone.
    expect(screen.queryByText("Scan the customer's code")).toBeNull()
  })

  it('a till: a receipt is pointed to the till’s own Check a receipt', async () => {
    const actor = till(grantFor(TERMINAL_ROLES.ISSUE_AND_REDEEM, STALL))
    show({ actor, session: openSession(actor, SESSION_KIND.FULL) })
    fireEvent.click(screen.getByText('scan-receipt'))
    expect(await screen.findByText(/Check a receipt on the till/)).toBeTruthy()
    expect(screen.queryByTestId('check')).toBeNull()
  })
})
