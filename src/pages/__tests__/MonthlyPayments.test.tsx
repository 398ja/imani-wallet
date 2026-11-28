/**
 * @vitest-environment jsdom
 *
 * Monthly payments, buyer side (monthly payments spec, "Testing: Component" and "Accessibility"):
 * the Buy page's tabs and the hidden tab, disabled reasons wired with aria-describedby, the
 * return-page variant from the remembered kind, the list and detail, the Stop dialog (focus in,
 * trapped, returned), the home banner and the Settings row.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

const STALL = 'b'.repeat(64)
const BUYER = 'a'.repeat(64)

let stallStatus: { status: string; sellsByCard: boolean } = { status: 'open', sellsByCard: true }
vi.mock('../../lib/merchantStatus', async (orig) => ({
  ...(await orig<typeof import('../../lib/merchantStatus')>()),
  fetchStallStatus: async () => ({ ...stallStatus, eventId: 'e' }),
}))
let readiness = 'ready'
vi.mock('../../lib/cardSalesEnrolment', () => ({ cardSalesReadiness: async () => readiness }))
vi.mock('../../hooks/useBranding', () => ({
  useBranding: (pubkey: string | undefined) => ({
    branding: pubkey ? { organizationName: 'Green Acres' } : undefined,
    loading: false,
  }),
}))
let record: { acceptsInstalments?: boolean; issuanceCurrency: string } | null = null
vi.mock('../../lib/merchant', async (orig) => ({
  ...(await orig<typeof import('../../lib/merchant')>()),
  fetchMerchantRecord: async () => record,
}))
vi.mock('../../lib/identity', async (orig) => ({
  ...(await orig<typeof import('../../lib/identity')>()),
  useIdentity: () => undefined,
}))

const startInstalments = vi.fn()
const listInstalmentPlans = vi.fn()
const readInstalmentPlan = vi.fn()
const stopInstalmentPlan = vi.fn()
vi.mock('../../lib/instalments', async (orig) => ({
  ...(await orig<typeof import('../../lib/instalments')>()),
  startInstalments: (...a: unknown[]) => startInstalments(...a),
  listInstalmentPlans: (...a: unknown[]) => listInstalmentPlans(...a),
  readInstalmentPlan: (...a: unknown[]) => readInstalmentPlan(...a),
  stopInstalmentPlan: (...a: unknown[]) => stopInstalmentPlan(...a),
}))

import { BuyPage } from '../BuyPage'
import { BuyDonePage } from '../BuyReturnPages'
import { MonthlyPaymentDetailPage, MonthlyPaymentsPage } from '../MonthlyPaymentsPages'
import { SettingsPage } from '../SettingsPage'
import { PastDueBanner } from '../../components/MonthlyPaymentNotices'
import { invalidateInstalmentPlans } from '../../hooks/useInstalmentPlans'
import { PENDING_PURCHASE_KEY, rememberPurchase } from '../../lib/pendingPurchase'
import type { InstalmentPlan } from '../../lib/instalments'

function plan(over: Partial<InstalmentPlan> = {}): InstalmentPlan {
  return {
    planId: 'p1',
    stallPubkey: STALL,
    status: 'ACTIVE',
    amountMinor: 4000,
    currency: 'gbp',
    totalInstalments: 6,
    instalmentsPaid: 3,
    cancelRequested: false,
    ...over,
  }
}

beforeEach(() => {
  invalidateInstalmentPlans()
  record = { acceptsInstalments: true, issuanceCurrency: 'gbp' }
  readiness = 'ready'
  stallStatus = { status: 'open', sellsByCard: true }
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  sessionStorage.clear()
})

function buy(buyer: string | null = BUYER) {
  return render(
    <MemoryRouter initialEntries={[`/buy/${STALL}`]}>
      <Routes>
        <Route path="/buy/:pubkey" element={<BuyPage buyerPubkey={buyer} />} />
        <Route path="/login" element={<p>login</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('Buy page, Pay monthly', () => {
  it('hides the Pay monthly tab when the stall does not offer it', async () => {
    record = { issuanceCurrency: 'gbp' }
    buy()
    await screen.findByRole('button', { name: /Pay by card/ })
    // Let the record read land, then check: hidden, not disabled.
    await act(async () => {})
    expect(screen.queryByRole('tab', { name: 'Pay monthly' })).toBeNull()
  })

  it('hides it when the stall record cannot be read', async () => {
    record = null
    buy()
    await act(async () => {})
    expect(screen.queryByRole('tab', { name: 'Pay monthly' })).toBeNull()
  })

  it('offers One payment and Pay monthly, and shows the live summary and the consent line', async () => {
    buy()
    fireEvent.click(await screen.findByRole('tab', { name: 'Pay monthly' }))
    expect(screen.getByRole('tab', { name: 'Pay monthly' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByText("You can stop at any time. Vouchers you've already received stay yours.")).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Amount each month'), { target: { value: '40' } })
    expect(screen.getByText(/£40 a month for 6 months, £240 in total/)).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: 'Until I cancel' }))
    expect(screen.getByText('£40 a month until you cancel. First payment today.')).toBeTruthy()
  })

  it('starts the plan, remembers it as monthly, and hands the buyer to Stripe', async () => {
    startInstalments.mockResolvedValue({ kind: 'error', refusal: { kind: 'other', reason: 'stop here' } })
    buy()
    fireEvent.click(await screen.findByRole('tab', { name: 'Pay monthly' }))
    fireEvent.change(screen.getByLabelText('Amount each month'), { target: { value: '40' } })
    fireEvent.click(screen.getByRole('radio', { name: '3 months' }))
    fireEvent.click(screen.getByRole('button', { name: /Start monthly payments/ }))

    await screen.findByText('stop here')
    expect(startInstalments).toHaveBeenCalledWith({ stallPubkey: STALL, buyerPubkey: BUYER, amountMinor: 4000, term: 3 })
    expect(JSON.parse(sessionStorage.getItem(PENDING_PURCHASE_KEY) ?? '{}')).toEqual({ stallPubkey: STALL, kind: 'monthly' })
  })

  it('names the minimum from the refusal and wires it to the disabled button', async () => {
    startInstalments.mockResolvedValue({
      kind: 'error',
      refusal: { kind: 'below-minimum', minAmountMinor: 2000, reason: 'below' },
    })
    buy()
    fireEvent.click(await screen.findByRole('tab', { name: 'Pay monthly' }))
    fireEvent.change(screen.getByLabelText('Amount each month'), { target: { value: '10' } })
    fireEvent.click(screen.getByRole('button', { name: /Start monthly payments/ }))

    const reason = await screen.findByText('Monthly payments start at £20.')
    // Review regression: the refusal keeps what the buyer typed (the form is not unmounted while busy).
    expect((screen.getByLabelText('Amount each month') as HTMLInputElement).value).toBe('10')
    const button = screen.getByRole('button', { name: /Start monthly payments/ }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.getAttribute('aria-describedby')).toBe(reason.id)

    // Raising the amount past the minimum clears the reason and the button.
    fireEvent.change(screen.getByLabelText('Amount each month'), { target: { value: '25' } })
    expect(screen.queryByText('Monthly payments start at £20.')).toBeNull()
    expect(button.disabled).toBe(false)
  })

  it('a stall not ready to sell disables Start with the readiness words beside it', async () => {
    readiness = 'not-ready'
    buy()
    fireEvent.click(await screen.findByRole('tab', { name: 'Pay monthly' }))
    fireEvent.change(screen.getByLabelText('Amount each month'), { target: { value: '40' } })
    const button = screen.getByRole('button', { name: /Start monthly payments/ }) as HTMLButtonElement
    await waitFor(() => expect(button.disabled).toBe(true))
    const describedBy = button.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    expect(document.getElementById(describedBy!)?.textContent).toBeTruthy()
  })

  // Review regression: the monthly path re-asks at the tap exactly as the one-off does, so a stall
  // that closed or stopped card sales after the page loaded is never sent to Stripe.
  it('a stall that closed after the page loaded is never sent to Stripe', async () => {
    buy()
    fireEvent.click(await screen.findByRole('tab', { name: 'Pay monthly' }))
    fireEvent.change(screen.getByLabelText('Amount each month'), { target: { value: '40' } })
    stallStatus = { status: 'closed', sellsByCard: false }
    fireEvent.click(screen.getByRole('button', { name: /Start monthly payments/ }))

    // The page's own stall note wins over the tap's words, and Start stays disabled beside it.
    await screen.findByText(/closed right now/)
    expect((screen.getByRole('button', { name: /Start monthly payments/ }) as HTMLButtonElement).disabled).toBe(true)
    expect(startInstalments).not.toHaveBeenCalled()
    expect(sessionStorage.getItem(PENDING_PURCHASE_KEY)).toBeNull()
  })

  it('card sales that stopped after the page loaded disable Start and never reach Stripe', async () => {
    buy()
    fireEvent.click(await screen.findByRole('tab', { name: 'Pay monthly' }))
    fireEvent.change(screen.getByLabelText('Amount each month'), { target: { value: '40' } })
    const button = screen.getByRole('button', { name: /Start monthly payments/ }) as HTMLButtonElement
    await waitFor(() => expect(button.disabled).toBe(false))
    readiness = 'not-ready'
    fireEvent.click(button)

    await waitFor(() =>
      expect((screen.getByRole('button', { name: /Start monthly payments/ }) as HTMLButtonElement).disabled).toBe(true),
    )
    expect(startInstalments).not.toHaveBeenCalled()
    expect(sessionStorage.getItem(PENDING_PURCHASE_KEY)).toBeNull()
  })

  it('has no guest path: a visitor is sent to log in and come back', async () => {
    buy(null)
    fireEvent.click(await screen.findByRole('button', { name: 'Log in to pay monthly' }))
    await screen.findByText('login')
    expect(sessionStorage.getItem('imani:afterLogin')).toBe(`/buy/${STALL}`)
    expect(startInstalments).not.toHaveBeenCalled()
  })
})

describe('Buy return page, monthly', () => {
  it('uses the monthly words when this device remembered a monthly purchase', () => {
    rememberPurchase(STALL, 'monthly')
    render(
      <MemoryRouter>
        <BuyDonePage />
      </MemoryRouter>,
    )
    expect(screen.getByText(/Your first payment went through\. A voucher arrives with each payment/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'See monthly payments' }).getAttribute('href')).toBe('/settings/monthly-payments')
  })

  it('a one-off keeps its own words', () => {
    rememberPurchase(STALL)
    render(
      <MemoryRouter>
        <BuyDonePage />
      </MemoryRouter>,
    )
    expect(screen.getByText('Payment received')).toBeTruthy()
    expect(screen.queryByText(/Monthly payments started/)).toBeNull()
  })
})

describe('Monthly payments list and detail', () => {
  it('lists each plan with amount, progress and a chip in words', async () => {
    listInstalmentPlans.mockResolvedValue({ kind: 'ok', value: [plan(), plan({ planId: 'p2', status: 'PAST_DUE' })] })
    render(
      <MemoryRouter>
        <MonthlyPaymentsPage buyerPubkey={BUYER} />
      </MemoryRouter>,
    )
    expect((await screen.findAllByText(/£40 a month · 3 of 6 paid/)).length).toBe(2)
    expect(screen.getByText('Active')).toBeTruthy()
    expect(screen.getByText('Payment failed')).toBeTruthy()
  })

  function detail() {
    return render(
      <MemoryRouter initialEntries={['/settings/monthly-payments/p1']}>
        <Routes>
          <Route path="/settings/monthly-payments/:planId" element={<MonthlyPaymentDetailPage />} />
        </Routes>
      </MemoryRouter>,
    )
  }

  it('Stop asks first, keeps focus in the dialog, and returns it on Keep paying', async () => {
    readInstalmentPlan.mockResolvedValue({ kind: 'ok', value: { plan: plan(), voucherIds: ['v1'] } })
    detail()
    const stop = await screen.findByRole('button', { name: 'Stop monthly payments' })
    expect(screen.getByRole('link', { name: 'Payment 1' }).getAttribute('href')).toBe('/coupon/v1')

    fireEvent.click(stop)
    const dialog = screen.getByRole('alertdialog')
    expect(screen.getByText('Stop monthly payments to Green Acres?')).toBeTruthy()
    const keep = screen.getByRole('button', { name: 'Keep paying' })
    expect(document.activeElement).toBe(keep)

    // Shift+Tab from the first button wraps to the last: focus stays in the dialog.
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })
    expect(document.activeElement?.textContent).toBe('Stop')

    fireEvent.click(keep)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(document.activeElement).toBe(stop)
    expect(stopInstalmentPlan).not.toHaveBeenCalled()
  })

  it('Stop says "Stopped. No further payments." afterwards', async () => {
    readInstalmentPlan.mockResolvedValue({ kind: 'ok', value: { plan: plan(), voucherIds: [] } })
    stopInstalmentPlan.mockResolvedValue({ kind: 'ok', value: plan({ cancelRequested: true }) })
    detail()
    fireEvent.click(await screen.findByRole('button', { name: 'Stop monthly payments' }))
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))

    await screen.findByText('Stopped. No further payments.')
    expect(stopInstalmentPlan).toHaveBeenCalledWith('p1')
    expect(screen.queryByRole('button', { name: 'Stop monthly payments' })).toBeNull()
  })

  it('a Stripe failure says nothing was changed', async () => {
    readInstalmentPlan.mockResolvedValue({ kind: 'ok', value: { plan: plan(), voucherIds: [] } })
    stopInstalmentPlan.mockResolvedValue({ kind: 'error', reason: "We couldn't reach Stripe. Nothing was changed. Try again." })
    detail()
    fireEvent.click(await screen.findByRole('button', { name: 'Stop monthly payments' }))
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))

    expect((await screen.findByRole('alert')).textContent).toMatch(/Nothing was changed/)
  })

  it('a pending plan offers Try again, not Stop', async () => {
    readInstalmentPlan.mockResolvedValue({ kind: 'ok', value: { plan: plan({ status: 'PENDING', instalmentsPaid: 0 }), voucherIds: [] } })
    detail()
    expect((await screen.findByRole('link', { name: 'Try again' })).getAttribute('href')).toBe(`/buy/${STALL}`)
    expect(screen.queryByRole('button', { name: 'Stop monthly payments' })).toBeNull()
  })
})

describe('Home banner and Settings row', () => {
  it('shows the banner while a plan is past due, and nothing otherwise', async () => {
    listInstalmentPlans.mockResolvedValue({ kind: 'ok', value: [plan({ status: 'PAST_DUE' })] })
    render(
      <MemoryRouter>
        <PastDueBanner buyerPubkey={BUYER} />
      </MemoryRouter>,
    )
    expect(await screen.findByText("A monthly payment to Green Acres didn't go through.")).toBeTruthy()
    expect(screen.getByText(/Stripe will try again/)).toBeTruthy()
  })

  it('shows no banner when the plans cannot be read', async () => {
    listInstalmentPlans.mockResolvedValue({ kind: 'error', reason: 'x' })
    const { container } = render(
      <MemoryRouter>
        <PastDueBanner buyerPubkey={BUYER} />
      </MemoryRouter>,
    )
    await act(async () => {})
    expect(container.textContent).toBe('')
  })

  it('the Settings row appears only for someone with a monthly payment', async () => {
    listInstalmentPlans.mockResolvedValue({ kind: 'ok', value: [] })
    const { unmount } = render(
      <MemoryRouter>
        <SettingsPage merchant={false} pubkey={BUYER} />
      </MemoryRouter>,
    )
    await act(async () => {})
    expect(screen.queryByText('Monthly payments')).toBeNull()
    unmount()

    invalidateInstalmentPlans()
    listInstalmentPlans.mockResolvedValue({ kind: 'ok', value: [plan()] })
    render(
      <MemoryRouter>
        <SettingsPage merchant={false} pubkey={BUYER} />
      </MemoryRouter>,
    )
    expect(await screen.findByText('Monthly payments')).toBeTruthy()
  })
})
