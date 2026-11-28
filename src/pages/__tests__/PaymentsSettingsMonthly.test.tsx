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
}))
vi.mock('../../lib/stripeAccount', async (orig) => ({
  ...(await orig<typeof import('../../lib/stripeAccount')>()),
  fetchStripeStatus: m.status,
  refreshStripe: m.refresh,
}))
vi.mock('../../lib/instalments', async (orig) => ({
  ...(await orig<typeof import('../../lib/instalments')>()),
  fetchStallInstalmentSummary: m.summary,
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
})
