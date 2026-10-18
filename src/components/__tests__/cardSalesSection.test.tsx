/**
 * @vitest-environment jsdom
 *
 * Settings › Card payments, the "Turn on card sales" step (imani-wallet#298).
 *
 * A stall with Stripe connected but no enrolled issuer could take card payments and never issue
 * the vouchers. This step is where the merchant turns issuing on, and sees whether it is on.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { CardSalesSection } from '../CardSalesSection'
import type { CardSalesResult, CardSalesStatus } from '../../lib/cardSalesEnrolment'

afterEach(cleanup)

const ON: CardSalesStatus = { enrolled: true, confirmation: 'confirmed', delegationExpiresAt: 2_000_000_000, delegationValid: true, ready: true }
const NOT_ENROLLED: CardSalesStatus = {
  enrolled: false,
  confirmation: null,
  delegationExpiresAt: null,
  delegationValid: false,
  ready: false,
  reason: 'Card sales are not set up for this stall.',
}

const ok = (status: CardSalesStatus) => async (): Promise<CardSalesResult> => ({ kind: 'ok', status })

describe('the card-sales step', () => {
  // On: says so, offers nothing to press.
  it('shows "Card sales: on" for an enrolled stall', async () => {
    render(<CardSalesSection deps={{ status: ok(ON) }} />)
    expect(await screen.findByText('Card sales: on')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /turn on card sales/i })).toBeNull()
  })

  // Needs setup: one primary button, which enrols, and then the state reads on.
  it('turns card sales on for a stall that needs setup', async () => {
    const turnOn = vi.fn(ok(ON))
    render(<CardSalesSection deps={{ status: ok(NOT_ENROLLED), turnOn }} />)
    expect(await screen.findByText('Card sales: needs setup')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Turn on card sales' }))
    expect(await screen.findByText('Card sales: on')).toBeTruthy()
    expect(turnOn).toHaveBeenCalledTimes(1)
  })

  // An error turning on: shown in its own words, as an alert, and the button stays to try again.
  it('shows the error clearly and lets the merchant try again', async () => {
    const turnOn = vi.fn(async (): Promise<CardSalesResult> => ({ kind: 'error', reason: 'the gateway did not confirm the credential; try again in a moment' }))
    render(<CardSalesSection deps={{ status: ok(NOT_ENROLLED), turnOn }} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Turn on card sales' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('did not confirm the credential')
    expect(screen.getByText('Card sales: needs setup')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Turn on card sales' }) as HTMLButtonElement).disabled).toBe(false)
  })

  // Could not check: not claimed to be off, and Check again is offered.
  it('says it could not check, rather than off, when the status cannot be read', async () => {
    const status = vi
      .fn<() => Promise<CardSalesResult>>()
      .mockResolvedValueOnce({ kind: 'error', reason: 'Could not reach the card-sales service. Check your connection.' })
      .mockResolvedValueOnce({ kind: 'ok', status: ON })
    render(<CardSalesSection deps={{ status }} />)
    expect(await screen.findByText("Couldn't check card sales")).toBeTruthy()
    expect((await screen.findByRole('alert')).textContent).toContain('Could not reach')
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    expect(await screen.findByText('Card sales: on')).toBeTruthy()
  })

  // An enrolled stall whose credential expired reads as needing setup, with the reason.
  it('offers to set up again when the credential expired', async () => {
    render(
      <CardSalesSection
        deps={{
          status: ok({ ...ON, confirmation: 'expired', ready: false, reason: 'The card-sales credential expired or was cancelled. Turn card sales on again.' }),
        }}
      />,
    )
    expect(await screen.findByText('Card sales: needs setup')).toBeTruthy()
    expect(screen.getByText(/expired or was cancelled/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Set up card sales again' })).toBeTruthy()
  })
})

describe('#312: card sales need a voucher validity', () => {
  // The rule is said plainly, with a link to the validity setting, so a stall is never surprised.
  it('says card sales need a validity, and links to the setting', async () => {
    render(<CardSalesSection deps={{ status: async () => ({ kind: 'ok', status: NEVER }) }} />)
    expect(await screen.findByText(/Vouchers that never expire can.t be sold by card/)).toBeTruthy()
    const link = screen.getByRole('link', { name: 'Voucher validity' }) as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('/settings/merchant')
  })

  // A never-expiring stall reads why Buy is off, in the issuer's words.
  it('shows the issuer\u2019s reason for a never-expiring stall', async () => {
    render(<CardSalesSection deps={{ status: async () => ({ kind: 'ok', status: NEVER }) }} />)
    expect(await screen.findByText(/need a voucher validity/)).toBeTruthy()
  })
})

const NEVER: CardSalesStatus = {
  enrolled: true,
  confirmation: 'confirmed',
  delegationExpiresAt: 4_000_000_000,
  delegationValid: false,
  ready: false,
  reason: 'Card sales need a voucher validity: vouchers that never expire can\u2019t be sold by card.',
  reasonCode: 'validity_never_expires',
}
