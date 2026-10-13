/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const register = vi.fn<(...args: unknown[]) => Promise<void>>(async () => {})
vi.mock('../../lib/registration', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/registration')>()),
  register: (...args: unknown[]) => register(...args),
  isHandleAvailable: async () => true,
}))
vi.mock('../../lib/config', () => ({ gatewayConfig: async () => ({ nip05Domain: 'example.test' }) }))
// The banner fetches public metadata; its content is not what this file is about.
vi.mock('../../components/ParkedClaimBanner', () => ({ ParkedClaimBanner: () => null }))

import { OnboardingPage } from '../OnboardingPage'
import { MAX_AGE_MS, stashPendingClaim } from '../../lib/pendingClaim'

/**
 * A registration that starts from a claim link is a customer registration: only customers redeem
 * cashback and gifts. The merchant switch is hidden, and the submit refuses merchant even if the
 * switch was turned on before the claim was parked.
 */
describe('onboarding with a parked claim is customer-only', () => {
  beforeEach(() => {
    localStorage.clear()
    register.mockClear()
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  const renderAccount = () =>
    render(
      <MemoryRouter initialEntries={[{ pathname: '/onboarding', state: { step: 'account' } }]}>
        <OnboardingPage onUnlock={async () => {}} />
      </MemoryRouter>,
    )

  const fill = () => {
    fireEvent.change(screen.getByPlaceholderText('your-handle'), { target: { value: 'alice' } })
    fireEvent.change(screen.getByPlaceholderText('Passphrase'), { target: { value: 'correct horse battery staple' } })
    fireEvent.change(screen.getByPlaceholderText('Confirm passphrase'), { target: { value: 'correct horse battery staple' } })
  }

  const submitAndExpectCustomer = async () => {
    fill()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create account' }))
    })
    expect(register).toHaveBeenCalledTimes(1)
    expect(register.mock.calls[0][3]).toBeUndefined()
    expect(register.mock.calls[0][4]).toBeUndefined()
  }

  it('hides the switch for a parked cashback and creates a customer', async () => {
    stashPendingClaim('ref-cashback-1', 'k1', { kind: 'cashback' })
    renderAccount()
    expect(screen.queryByRole('switch')).toBeNull()
    expect(screen.queryByText('I am a merchant')).toBeNull()
    expect(screen.getByText(/You're redeeming a voucher, so this is a customer account\./)).toBeTruthy()
    await submitAndExpectCustomer()
  })

  it('does the same for a parked gift', async () => {
    stashPendingClaim('ref-gift-1', 'k1', { kind: 'gift', x: Math.floor(Date.now() / 1000) + 3600 })
    renderAccount()
    expect(screen.queryByRole('switch')).toBeNull()
    await submitAndExpectCustomer()
  })

  it('shows the switch as before with no parked claim', () => {
    renderAccount()
    expect(screen.getByText('I am a merchant')).toBeTruthy()
    expect(screen.queryByText(/You're redeeming a voucher/)).toBeNull()
  })

  it('shows the switch when the parked claim has aged out', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    stashPendingClaim('ref-old', 'k1')
    vi.setSystemTime(new Date(Date.parse('2026-01-01T00:00:00Z') + MAX_AGE_MS + 60_000))
    renderAccount()
    expect(screen.getByText('I am a merchant')).toBeTruthy()
  })

  it('overrides a merchant switch turned on before the claim was parked', async () => {
    renderAccount()
    fireEvent.click(screen.getByText('I am a merchant'))
    fill()
    expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy()
    // A second tab parks a claim; the next render and the submit must refuse merchant.
    stashPendingClaim('ref-late', 'k1')
    fireEvent.change(screen.getByPlaceholderText('your-handle'), { target: { value: 'alicia' } })
    expect(screen.queryByText('I am a merchant')).toBeNull()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create account' }))
    })
    expect(register).toHaveBeenCalledTimes(1)
    expect(register.mock.calls[0][3]).toBeUndefined()
  })

  it('renders the account form, not the merchant steps, when history holds a merchant step', () => {
    stashPendingClaim('ref-back', 'k1')
    render(
      <MemoryRouter initialEntries={[{ pathname: '/onboarding', state: { step: 'merchant' } }]}>
        <OnboardingPage onUnlock={async () => {}} />
      </MemoryRouter>,
    )
    expect(screen.queryByText('What you sell')).toBeNull()
    expect(screen.queryByText('Your business')).toBeNull()
  })
})
