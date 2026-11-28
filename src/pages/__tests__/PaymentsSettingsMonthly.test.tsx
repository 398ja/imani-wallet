/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

/**
 * Card payments screen, monthly payments side: the OAuth route only when nothing is connected,
 * Open Stripe for an OAuth account, Stop blocked while plans run, and the switch gated on
 * eligibility with disclosure and terms before anything is published.
 */
const m = vi.hoisted(() => ({
  status: vi.fn(),
  refresh: vi.fn(),
  publish: vi.fn(),
  sign: vi.fn(),
  summary: vi.fn(),
  saveSettings: vi.fn(),
  readSettings: vi.fn(),
}))
vi.mock('../../lib/stripeAccount', async (orig) => ({
  ...(await orig<typeof import('../../lib/stripeAccount')>()),
  fetchStripeStatus: m.status,
  refreshStripe: m.refresh,
}))
vi.mock('../../lib/instalments', async (orig) => ({
  ...(await orig<typeof import('../../lib/instalments')>()),
  fetchStallInstalmentSummary: m.summary,
  saveStallInstalmentSettings: m.saveSettings,
  fetchStallInstalmentSettings: m.readSettings,
}))
const pp = vi.hoisted(() => ({ status: vi.fn() }))
vi.mock('../../lib/paypalAccount', async (orig) => ({
  ...(await orig<typeof import('../../lib/paypalAccount')>()),
  fetchPaypalStatus: pp.status,
  refreshPaypal: pp.status,
}))
vi.mock('../../lib/nap', () => ({ getSigner: () => ({ signEvent: m.sign }) }))
vi.mock('../../lib/relay', () => ({ publish: m.publish }))
vi.mock('../../components/CardSalesSection', () => ({ CardSalesSection: () => null }))
vi.mock('../../components/GiftingPageSection', () => ({ GiftingPageSection: () => null }))

import { PaymentsSettingsPage } from '../PaymentsSettingsPage'
import { disconnected, type StripeAccountStatus } from '../../lib/stripeAccount'
import type { MerchantProfile } from '../../lib/merchant'

const merchant: MerchantProfile = {
  pubkey: 'ab'.repeat(32),
  active: true,
  categories: [],
  issuanceCurrency: 'gbp',
  voucherValidityDays: 365,
  updatedAt: 0,
  acceptsCards: true,
}

const liveStatus = (extra: Partial<StripeAccountStatus> = {}): StripeAccountStatus => ({
  ...disconnected(),
  status: 'active',
  chargesEnabled: true,
  defaultCurrency: 'gbp',
  connectionType: 'CREATED',
  instalmentsEligible: true,
  instalmentsEligibilityKnown: true,
  ...extra,
})

function open(status: StripeAccountStatus, record: MerchantProfile = merchant) {
  m.status.mockResolvedValue({ kind: 'ok', status })
  const onSaved = vi.fn()
  render(
    <MemoryRouter initialEntries={['/settings/payments']}>
      <PaymentsSettingsPage merchant={record} onSaved={onSaved} />
    </MemoryRouter>,
  )
  return onSaved
}

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset()
  m.sign.mockImplementation(async (e: object) => ({ ...e, created_at: 1, id: 'x', sig: 'y', pubkey: merchant.pubkey }))
  m.publish.mockResolvedValue({ ok: 1 })
  m.summary.mockResolvedValue({ kind: 'ok', value: { activePlans: 7, monthlyTotals: [{ currency: 'gbp', amountMinor: 34000 }] } })
  m.saveSettings.mockImplementation(async (s: { enabled: boolean }) => ({ kind: 'ok', value: { enabled: s.enabled, intervals: ['month'] } }))
  m.readSettings.mockResolvedValue({ enabled: true, intervals: ['month'] })
  localStorage.clear()
})
afterEach(cleanup)

describe('PaymentsSettingsPage monthly payments', () => {
  it('offers both connect routes only when nothing is connected', async () => {
    open(disconnected())
    expect(await screen.findByRole('button', { name: /I already have a Stripe account/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Create a Stripe account/ })).toBeTruthy()
    cleanup()
    open(liveStatus())
    await screen.findByText('Taking card payments')
    expect(screen.queryByRole('button', { name: /I already have a Stripe account/ })).toBeNull()
  })

  it('an OAuth account not live gets Open Stripe, not Finish setting up', async () => {
    open(liveStatus({ status: 'pending', chargesEnabled: false, connectionType: 'OAUTH' }))
    const link = await screen.findByRole('link', { name: /Open Stripe/ })
    expect(link.getAttribute('href')).toBe('https://dashboard.stripe.com/')
    expect(screen.queryByRole('button', { name: /Finish setting up/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Check again' })).toBeTruthy()
  })

  it('disables Stop while plans run, with the reason described', async () => {
    open(liveStatus({ activePlans: true }))
    const stop = (await screen.findByRole('button', { name: 'Stop taking card payments' })) as HTMLButtonElement
    expect(stop.disabled).toBe(true)
    const reason = document.getElementById(stop.getAttribute('aria-describedby') ?? '')
    expect(reason?.textContent).toContain('You have monthly payments running.')
  })

  it('disables the switch when the account is not eligible', async () => {
    open(liveStatus({ instalmentsEligible: false }))
    expect(await screen.findByText(/setup means monthly payments aren/)).toBeTruthy()
    expect((screen.getByRole('switch') as HTMLInputElement).disabled).toBe(true)
  })

  // Review regression: reconcileInstalmentOffer withdraws the offer from a stall without cards, so
  // the switch must not let one opt in there (it would be published, then withdrawn on next read).
  it.each([
    ['cards are not offered', { ...merchant, acceptsCards: false }],
    ['sales are closed', { ...merchant, salesClosed: true }],
  ])('disables the switch when %s, even on an eligible live account', async (_why, record) => {
    open(liveStatus(), record as MerchantProfile)
    expect(await screen.findByText('Monthly payments are available.')).toBeTruthy()
    expect((screen.getByRole('switch') as HTMLInputElement).disabled).toBe(true)
  })

  // Merge regression (PayPal on main): monthly payments are Stripe only. A PayPal stall sees no switch, no
  // two-route connect, and a published offer it somehow carries is withdrawn on the first read.
  it('a PayPal stall gets no monthly payments, and a stray offer is withdrawn', async () => {
    const record: MerchantProfile = { ...merchant, cardProcessor: 'paypal', acceptsInstalments: true }
    m.status.mockResolvedValue({ kind: 'ok', status: disconnected() })
    pp.status.mockResolvedValue({ kind: 'ok', status: liveStatus({ instalmentsEligible: undefined, activePlans: undefined }) })
    const onSaved = vi.fn()
    render(
      <MemoryRouter initialEntries={['/settings/payments']}>
        <PaymentsSettingsPage merchant={record} onSaved={onSaved} paypal />
      </MemoryRouter>,
    )
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(onSaved.mock.calls.at(-1)?.[0].acceptsInstalments).toBe(false)
    expect(onSaved.mock.calls.at(-1)?.[0].acceptsCards).toBe(true)
    expect(screen.queryByRole('switch')).toBeNull()
    expect(screen.queryByTestId('monthly-eligibility')).toBeNull()
  })

  it('says it could not check when eligibility is unknown', async () => {
    open(liveStatus({ instalmentsEligible: false, instalmentsEligibilityKnown: false }))
    expect(await screen.findByText(/We couldn.t check your account yet/)).toBeTruthy()
  })

  it('needs the disclosure and the terms before publishing', async () => {
    const onSaved = open(liveStatus())
    const sw = (await screen.findByRole('switch')) as HTMLInputElement
    expect(sw.checked).toBe(false)
    fireEvent.click(sw)
    expect(screen.getByText(/You pay Stripe.s fees, not Imani/)).toBeTruthy()
    const turnOn = screen.getByRole('button', { name: 'Turn on monthly payments' }) as HTMLButtonElement
    expect(turnOn.disabled).toBe(true)
    expect(m.publish).not.toHaveBeenCalled()

    fireEvent.click(screen.getByLabelText(/accept the monthly payments terms/))
    fireEvent.click(turnOn)
    await waitFor(() => expect(m.publish).toHaveBeenCalledTimes(1))
    const content = JSON.parse(m.sign.mock.calls[0][0].content)
    expect(content.acceptsInstalments).toBe(true)
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ acceptsInstalments: true }))
  })

  it('shows the summary when the offer is on, and withdraws it on an ineligible read in one publish', async () => {
    open(liveStatus(), { ...merchant, acceptsInstalments: true })
    expect(await screen.findByText(/7 people pay you monthly, £340(\.00)? a month/)).toBeTruthy()
    cleanup()
    m.publish.mockClear()
    open(liveStatus({ chargesEnabled: false, status: 'pending' }), { ...merchant, acceptsInstalments: true })
    await waitFor(() => expect(m.publish).toHaveBeenCalledTimes(1))
    const content = JSON.parse(m.sign.mock.calls.at(-1)![0].content)
    expect(content.acceptsCards).toBeUndefined()
    expect(content.acceptsInstalments).toBeUndefined()
  })

  // The staging e2e found plans starting on a stall that never switched them on: the switch was only
  // published. Turning on now saves it where plan start enforces it, BEFORE publishing.
  it('turning on saves the enforced setting first, then publishes', async () => {
    open(liveStatus())
    fireEvent.click(await screen.findByRole('switch'))
    fireEvent.click(screen.getByLabelText(/accept the monthly payments terms/))
    fireEvent.click(screen.getByRole('button', { name: 'Turn on monthly payments' }))
    await waitFor(() => expect(m.publish).toHaveBeenCalledTimes(1))
    expect(m.saveSettings).toHaveBeenCalledWith({ enabled: true })
    expect(m.saveSettings.mock.invocationCallOrder[0]).toBeLessThan(m.publish.mock.invocationCallOrder[0])
  })

  // If the enforced save fails, "Pay monthly" must not be shown for plans that would be refused.
  it('a failed save on turning on publishes nothing and says why', async () => {
    m.saveSettings.mockResolvedValue({ kind: 'error', reason: 'Could not reach the payment service. Nothing was changed. Try again.' })
    const onSaved = open(liveStatus())
    fireEvent.click(await screen.findByRole('switch'))
    fireEvent.click(screen.getByLabelText(/accept the monthly payments terms/))
    fireEvent.click(screen.getByRole('button', { name: 'Turn on monthly payments' }))
    expect(await screen.findByText(/Could not reach the payment service/)).toBeTruthy()
    expect(m.publish).not.toHaveBeenCalled()
    expect(onSaved).not.toHaveBeenCalledWith(expect.objectContaining({ acceptsInstalments: true }))
  })

  // Turning off still hides the tab if the save fails, and says the switch-off must be retried.
  it('turning off publishes even if the save fails, and says so', async () => {
    m.saveSettings.mockResolvedValue({ kind: 'error', reason: 'Try again.' })
    open(liveStatus(), { ...merchant, acceptsInstalments: true })
    const sw = (await screen.findByRole('switch')) as HTMLInputElement
    await waitFor(() => expect(sw.checked).toBe(true))
    fireEvent.click(sw)
    await waitFor(() => expect(m.publish).toHaveBeenCalled())
    expect(m.saveSettings).toHaveBeenCalledWith({ enabled: false })
    expect(await screen.findByText(/could not be switched off everywhere/)).toBeTruthy()
  })

  // A stall that opted in before the switch was enforced is carried over on its next visit...
  it('carries over an opt-in published before the switch was enforced', async () => {
    m.readSettings.mockResolvedValue({ enabled: false, intervals: [] })
    open(liveStatus(), { ...merchant, acceptsInstalments: true })
    await waitFor(() => expect(m.saveSettings).toHaveBeenCalledWith({ enabled: true }))
    expect(m.publish).not.toHaveBeenCalled()
  })

  // ...but never when the read failed, nor when the offer is being withdrawn on that same read.
  it('does not carry over on an unreadable answer, nor while withdrawing', async () => {
    m.readSettings.mockResolvedValue(null)
    open(liveStatus(), { ...merchant, acceptsInstalments: true })
    await screen.findByRole('switch')
    await new Promise((r) => setTimeout(r, 20))
    expect(m.saveSettings).not.toHaveBeenCalled()
    cleanup()

    m.readSettings.mockResolvedValue({ enabled: false, intervals: [] })
    open(liveStatus({ instalmentsEligible: false }), { ...merchant, acceptsInstalments: true })
    await waitFor(() => expect(m.publish).toHaveBeenCalledTimes(1))
    expect(m.saveSettings).toHaveBeenCalledWith({ enabled: false })
    expect(m.saveSettings).not.toHaveBeenCalledWith({ enabled: true })
  })

  // A stall that switched off (saved), whose publish then failed, still shows the old offer: the
  // explicit opt-out stands, it is not "carried over" back on.
  it('never turns back on a stall that saved itself off', async () => {
    m.readSettings.mockResolvedValue({ enabled: false, intervals: ['month'] })
    open(liveStatus(), { ...merchant, acceptsInstalments: true })
    await screen.findByRole('switch')
    await waitFor(() => expect(m.readSettings).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 20))
    expect(m.saveSettings).not.toHaveBeenCalled()
  })
})
