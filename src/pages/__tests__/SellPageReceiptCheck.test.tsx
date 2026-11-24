/**
 * @vitest-environment jsdom
 *
 * Spec 049: Sell's scanner also checks receipts. The stall already points the camera at the
 * customer's phone here, so a receipt (`imrc1:`) scanned on Sell opens the check, and any other
 * code is still the customer to sell to. The QR moves in router state, never the URL.
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

describe('Sell checks receipts too (spec 049)', () => {
  it('says so where it asks for a scan', () => {
    show()
    expect(screen.getByText(/or a receipt to check it/i)).toBeTruthy()
  })

  it('owner: a scanned receipt opens the check, with the code in router state only', async () => {
    show()
    fireEvent.click(screen.getByText('scan-receipt'))
    expect((await screen.findByTestId('check')).textContent).toBe(`|${RECEIPT}`)
  })

  it('any other code is still the customer to sell to', async () => {
    show()
    fireEvent.click(screen.getByText('scan-customer'))
    expect(screen.queryByTestId('check')).toBeNull()
    // The amount step: the scan step's subtitle has gone.
    expect(screen.queryByText(/or a receipt to check it/i)).toBeNull()
  })

  it('a till with receipt:read in a live session checks it too', async () => {
    const actor = till(grantFor(TERMINAL_ROLES.ISSUE_AND_REDEEM, STALL))
    show({ actor, session: openSession(actor, SESSION_KIND.FULL) })
    fireEvent.click(screen.getByText('scan-receipt'))
    expect((await screen.findByTestId('check')).textContent).toBe(`|${RECEIPT}`)
  })

  it('a till without receipt:read is told, and does not sell to the receipt', async () => {
    const actor = till(
      grantFor(TERMINAL_ROLES.ISSUE_AND_REDEEM, STALL).filter((p) => !p.startsWith('receipt:read')),
    )
    show({ actor, session: openSession(actor, SESSION_KIND.FULL) })
    expect(screen.queryByText(/or a receipt to check it/i)).toBeNull()
    fireEvent.click(screen.getByText('scan-receipt'))
    expect(await screen.findByText(/cannot check receipts/i)).toBeTruthy()
    expect(screen.queryByTestId('check')).toBeNull()
  })
})
