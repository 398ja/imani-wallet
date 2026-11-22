/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import type { LicenceStatus } from '../../lib/licenceStatus'
import { emptyMerchant, type MerchantProfile } from '../../lib/merchant'

/** Settings › Card payments is Essentials and above: Starter sees the plan, not Connect Stripe. */

const stripe = vi.hoisted(() => ({ status: { kind: 'ok', status: { status: 'not_connected', chargesEnabled: false, requirementsDue: [] } } as unknown, connect: undefined as unknown }))
const published = vi.hoisted(() => ({ events: [] as unknown[], ok: 1 }))

vi.mock('../../lib/stripeAccount', () => ({
  fetchStripeStatus: async () => stripe.status,
  refreshStripe: async () => stripe.status,
  connectStripe: async () => stripe.connect ?? stripe.status,
  disconnectStripe: async () => stripe.status,
}))
vi.mock('../../lib/nap', () => ({ getSigner: () => ({ signEvent: async (e: object) => ({ ...e, created_at: 1 }) }) }))
vi.mock('../../lib/relay', () => ({
  publish: async (e: unknown) => {
    published.events.push(e)
    return { ok: published.ok }
  },
}))
vi.mock('../../components/CardSalesSection', () => ({ CardSalesSection: () => <div data-testid="card-sales" /> }))
vi.mock('../../components/GiftingPageSection', () => ({ GiftingPageSection: () => <div data-testid="gifting" /> }))

const { PaymentsSettingsPage } = await import('../PaymentsSettingsPage')

const STALL = 'a'.repeat(64)
const nowS = () => Math.floor(Date.now() / 1000)
const starter = async () => ({ checkedAt: nowS(), decision: { granted: false, reason: 'absent' }, grants: [] }) as unknown as LicenceStatus
const essentials = async () =>
  ({
    checkedAt: nowS(),
    decision: { granted: true, source: 'verified', grant: { tier: 'basic', features: ['terminals'], expiresAt: nowS() + 86_400 } },
    grants: [{ tier: 'basic', features: ['terminals'], expiresAt: nowS() + 86_400 }],
  }) as unknown as LicenceStatus

const liveStripe = { kind: 'ok', status: { status: 'enabled', chargesEnabled: true, defaultCurrency: 'gbp', requirementsDue: [] } }

function renderPage(status: () => Promise<LicenceStatus>, merchant: Partial<MerchantProfile> = {}) {
  const onSaved = vi.fn()
  render(
    <MemoryRouter>
      <PaymentsSettingsPage merchant={{ ...emptyMerchant(STALL), issuanceCurrency: 'GBP', ...merchant }} onSaved={onSaved} status={status} />
    </MemoryRouter>,
  )
  return onSaved
}

beforeEach(() => {
  localStorage.clear()
  published.events = []
  published.ok = 1
  stripe.connect = undefined
  stripe.status = { kind: 'ok', status: { status: 'not_connected', chargesEnabled: false, requirementsDue: [] } }
})
afterEach(cleanup)

describe('Card payments by plan', () => {
  it('shows Starter the plan instead of Connect Stripe', async () => {
    // Arrange / Act
    renderPage(starter)

    // Assert
    await waitFor(() => expect(screen.getByTestId('card-payments-locked')).toBeTruthy())
    expect(screen.getByText(/part of Essentials and above/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Connect Stripe/ })).toBeNull()
  })

  it('offers Connect Stripe on Essentials', async () => {
    // Arrange / Act
    renderPage(essentials)

    // Assert
    await waitFor(() => expect(screen.getByRole('button', { name: /Connect Stripe/ })).toBeTruthy())
    expect(screen.queryByTestId('card-payments-locked')).toBeNull()
  })

  it('withdraws a Starter stall’s card offer and says why, leaving Stop available', async () => {
    // Arrange
    stripe.status = liveStripe

    // Act
    const onSaved = renderPage(starter, { acceptsCards: true })

    // Assert
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(onSaved.mock.calls[0][0].acceptsCards).toBe(false)
    await waitFor(() => expect(published.events).toHaveLength(1))
    expect(screen.getByTestId('card-payments-not-in-plan')).toBeTruthy()
    expect(screen.queryByTestId('card-sales')).toBeNull()
    expect(screen.getByRole('button', { name: /Stop taking card payments/ })).toBeTruthy()
  })

  it('starts the offer on Essentials once Stripe can charge', async () => {
    // Arrange
    stripe.status = liveStripe

    // Act
    const onSaved = renderPage(essentials)

    // Assert
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(onSaved.mock.calls[0][0].acceptsCards).toBe(true)
    expect(screen.getByTestId('card-sales')).toBeTruthy()
  })

  it('changes nothing when the plan cannot be checked', async () => {
    // Arrange
    stripe.status = liveStripe

    // Act
    const onSaved = renderPage(() => Promise.reject(new Error('offline')), { acceptsCards: true })

    // Assert
    await waitFor(() => expect(screen.getByText('Taking card payments')).toBeTruthy())
    expect(onSaved).not.toHaveBeenCalled()
    expect(screen.queryByTestId('card-payments-not-in-plan')).toBeNull()
  })

  it('says Card payments are off, not Paid in GBP, for a Starter stall live on Stripe', async () => {
    // Arrange
    stripe.status = liveStripe

    // Act
    renderPage(starter)

    // Assert
    await waitFor(() => expect(screen.getByText('Stripe connected')).toBeTruthy())
    expect(screen.getByText('Card payments are off on your current plan.')).toBeTruthy()
    expect(screen.queryByText(/Paid in GBP/)).toBeNull()
  })
})

describe('Card payments review regressions', () => {
  const outage = async () =>
    ({ checkedAt: nowS(), decision: { granted: false, reason: 'never-verified', detail: 'the wallet could not be read' }, grants: [] }) as unknown as LicenceStatus

  it('keeps a paying stall’s offer when the licence store cannot be read', async () => {
    // Arrange
    stripe.status = liveStripe

    // Act
    const onSaved = renderPage(outage, { acceptsCards: true })

    // Assert
    await waitFor(() => expect(screen.getByText('Taking card payments')).toBeTruthy())
    expect(onSaved).not.toHaveBeenCalled()
    expect(published.events).toHaveLength(0)
    expect(screen.queryByTestId('card-payments-not-in-plan')).toBeNull()
  })

  it('tells a Starter stall that its disconnect was not sent, on the locked screen', async () => {
    // Arrange: offering cards; the plan reads as Starter by the time the stall disconnects, and
    // the relays refuse the withdrawal.
    stripe.status = liveStripe
    published.ok = 0
    let plan: () => Promise<LicenceStatus> = outage
    renderPage(() => plan(), { acceptsCards: true })
    await waitFor(() => expect(screen.getByRole('button', { name: /Stop taking card payments/ })).toBeTruthy())
    plan = starter
    stripe.status = { kind: 'ok', status: { status: 'not_connected', chargesEnabled: false, requirementsDue: [] } }

    // Act
    fireEvent.click(screen.getByRole('button', { name: /Stop taking card payments/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Stop$/ }))

    // Assert
    await waitFor(() => expect(screen.getByTestId('card-payments-locked')).toBeTruthy())
    expect(screen.getByTestId('card-payments-note').textContent).toMatch(/not sent yet/)
  })

  it('shows a failed Stripe read as an error, not an upgrade prompt, on Starter', async () => {
    // Arrange
    stripe.status = { kind: 'error', reason: 'The merchant service is unreachable.' }

    // Act
    renderPage(starter)

    // Assert
    await waitFor(() => expect(screen.getByText('The merchant service is unreachable.')).toBeTruthy())
    expect(screen.queryByTestId('card-payments-locked')).toBeNull()
    expect(screen.queryByRole('button', { name: /Connect Stripe/ })).toBeNull()
  })

  it('does not claim to take cards while the plan is unchecked and nothing is published', async () => {
    // Arrange
    stripe.status = liveStripe

    // Act
    const onSaved = renderPage(outage)

    // Assert
    await waitFor(() => expect(screen.getByTestId('card-payments-plan-unchecked')).toBeTruthy())
    expect(screen.queryByText('Taking card payments')).toBeNull()
    expect(screen.queryByTestId('card-sales')).toBeNull()
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('does not hang on Loading when the licence check never settles', async () => {
    // Arrange
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      renderPage(() => new Promise<LicenceStatus>(() => {}))

      // Act
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000)
      })

      // Assert
      await waitFor(() => expect(screen.getByRole('button', { name: /Connect Stripe/ })).toBeTruthy())
    } finally {
      vi.useRealTimers()
    }
  })

  it('unlocks with Check again after the merchant upgrades, without a reload', async () => {
    // Arrange
    let plan = starter
    renderPage(() => plan())
    await waitFor(() => expect(screen.getByTestId('card-payments-locked')).toBeTruthy())
    plan = essentials

    // Act
    fireEvent.click(screen.getByRole('button', { name: /Check again/ }))

    // Assert
    await waitFor(() => expect(screen.getByRole('button', { name: /Connect Stripe/ })).toBeTruthy())
    expect(screen.queryByTestId('card-payments-locked')).toBeNull()
  })

  // The server refuses Stripe Connect for a Starter stall (merchant-service, 403). When the app could
  // not tell the plan itself and offered Connect, the merchant reads the server's own words.
  it('shows the server’s refusal when connecting on a plan without card payments', async () => {
    // Arrange
    stripe.connect = {
      kind: 'refused',
      reason: 'Card payments are part of Essentials and above. Upgrade your plan to connect Stripe. Nothing was changed.',
    }
    renderPage(outage)
    await waitFor(() => expect(screen.getByRole('button', { name: /Connect Stripe/ })).toBeTruthy())

    // Act
    fireEvent.click(screen.getByRole('button', { name: /Connect Stripe/ }))

    // Assert
    await waitFor(() => expect(screen.getByText(/Upgrade your plan to connect Stripe/)).toBeTruthy())
  })
})
