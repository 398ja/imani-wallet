/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useEffect } from 'react'
import { MemoryRouter, useNavigate, type NavigateFunction } from 'react-router-dom'

const register = vi.fn<(...args: unknown[]) => Promise<void>>(async () => {})
vi.mock('../../lib/registration', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/registration')>()),
  register: (...args: unknown[]) => register(...args),
  isHandleAvailable: async () => true,
}))
vi.mock('../../lib/config', () => ({ gatewayConfig: async () => ({ nip05Domain: 'example.test' }) }))
vi.mock('../../components/ParkedClaimBanner', () => ({ ParkedClaimBanner: () => null }))
vi.mock('../../components/MerchantFieldset', () => ({ MerchantFieldset: () => null }))
vi.mock('../../lib/merchant', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/merchant')>()),
  merchantFieldsValid: () => true,
}))

import { OnboardingPage } from '../OnboardingPage'
import { stashPendingClaim } from '../../lib/pendingClaim'

/**
 * #357: an account is never created without accepting the Terms and Conditions. The box starts
 * unticked, the words link to `<VITE_WEBSITE_BASE_URL>/terms.html` in a new tab, and the
 * create / continue button stays disabled until it is ticked. Merchants accept on the first step,
 * before the business screens. A claim-driven registration needs it too.
 */
const TERMS = 'https://www.imani.casa/terms.html'

beforeEach(() => {
  localStorage.clear()
  register.mockClear()
  vi.stubEnv('VITE_WEBSITE_BASE_URL', 'https://www.imani.casa')
})
afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
})

const renderAccount = () =>
  render(
    <MemoryRouter initialEntries={[{ pathname: '/onboarding', state: { step: 'account' } }]}>
      <OnboardingPage onUnlock={async () => {}} />
    </MemoryRouter>,
  )

const fill = () => {
  fireEvent.change(screen.getByPlaceholderText('your_handle'), { target: { value: 'alice' } })
  fireEvent.change(screen.getByPlaceholderText('Passphrase'), { target: { value: 'correct horse battery staple' } })
  fireEvent.change(screen.getByPlaceholderText('Confirm passphrase'), {
    target: { value: 'correct horse battery staple' },
  })
}

const termsBox = () => screen.getByRole('checkbox', { name: /I accept the Terms and Conditions/ }) as HTMLInputElement
const button = (name: string | RegExp) => screen.getByRole('button', { name }) as HTMLButtonElement

describe('the Terms and Conditions on the account step (#357)', () => {
  it('starts unticked and links to <base>/terms.html in a new tab', () => {
    renderAccount()
    expect(termsBox().checked).toBe(false)
    const link = screen.getByRole('link', { name: 'Terms and Conditions' }) as HTMLAnchorElement
    expect(link.href).toBe(TERMS)
    expect(link.target).toBe('_blank')
    expect(link.rel.split(' ').sort()).toEqual(['noopener', 'noreferrer'])
  })

  it('uses the base URL the build names', () => {
    vi.stubEnv('VITE_WEBSITE_BASE_URL', 'https://staging.example.test/')
    renderAccount()
    expect((screen.getByRole('link', { name: 'Terms and Conditions' }) as HTMLAnchorElement).href).toBe(
      'https://staging.example.test/terms.html',
    )
  })

  it('keeps Create account disabled until the box is ticked, then passes the acceptance to register', async () => {
    renderAccount()
    fill()
    expect(button('Create account').disabled).toBe(true)
    fireEvent.click(termsBox())
    expect(button('Create account').disabled).toBe(false)
    // Unticking takes it away again.
    fireEvent.click(termsBox())
    expect(button('Create account').disabled).toBe(true)
    fireEvent.click(termsBox())

    const before = Date.now()
    await act(async () => {
      fireEvent.click(button('Create account'))
    })
    expect(register).toHaveBeenCalledTimes(1)
    const options = register.mock.calls[0][3] as { terms: { url: string; acceptedAt: number } }
    expect(options.terms.url).toBe(TERMS)
    expect(options.terms.acceptedAt).toBeGreaterThanOrEqual(before)
    expect(options.terms.acceptedAt).toBeLessThanOrEqual(Date.now())
  })

  it('a merchant accepts on the first step: Continue stays disabled until ticked', async () => {
    renderAccount()
    fill()
    fireEvent.click(screen.getByRole('switch'))
    expect(button('Continue').disabled).toBe(true)
    fireEvent.click(termsBox())
    expect(button('Continue').disabled).toBe(false)
    fireEvent.click(button('Continue'))
    // The business screens do not ask again.
    expect(screen.queryByRole('checkbox', { name: /Terms and Conditions/ })).toBeNull()
    fireEvent.click(button('Continue'))
    await act(async () => {
      fireEvent.click(button(/Create merchant account/))
    })
    expect(register).toHaveBeenCalledTimes(1)
    const options = register.mock.calls[0][3] as { terms: { url: string }; merchant?: unknown }
    expect(options.terms.url).toBe(TERMS)
    expect(options.merchant).toBeDefined()
  })

  it('a claim-driven registration (redeeming a voucher) requires it too', async () => {
    stashPendingClaim('ref-cashback-1', 'k1', { kind: 'cashback' })
    renderAccount()
    fill()
    expect(button('Create account').disabled).toBe(true)
    fireEvent.click(termsBox())
    await act(async () => {
      fireEvent.click(button('Create account'))
    })
    const options = register.mock.calls[0][3] as { terms: { url: string }; merchant?: unknown }
    expect(options.terms.url).toBe(TERMS)
    expect(options.merchant).toBeUndefined()
  })

  it('has a 44px tap target for the box and its words', () => {
    renderAccount()
    const label = termsBox().closest('label') as HTMLElement
    expect(label.className).toMatch(/min-h-11/)
  })

  it('opening the terms does not tick the box (review of #358)', () => {
    renderAccount()
    fireEvent.click(screen.getByRole('link', { name: 'Terms and Conditions' }))
    expect(termsBox().checked).toBe(false)
  })

  it('history cannot skip it: going forward to the business screens with the box unticked stays on the first step (review of #358)', () => {
    const navRef: { current?: NavigateFunction } = {}
    const Grab = ({ intoRef }: { intoRef: { current?: NavigateFunction } }) => {
      const navigate = useNavigate()
      useEffect(() => {
        intoRef.current = navigate
      })
      return null
    }
    render(
      <MemoryRouter
        initialEntries={[
          { pathname: '/onboarding', state: { step: 'account' } },
          { pathname: '/onboarding', state: { step: 'profile' } },
        ]}
        initialIndex={0}
      >
        <Grab intoRef={navRef} />
        <OnboardingPage onUnlock={async () => {}} />
      </MemoryRouter>,
    )
    fill()
    fireEvent.click(screen.getByRole('switch'))
    act(() => navRef.current!(1))
    // Still the account step: the box is there, unticked, and Continue is disabled.
    expect(termsBox().checked).toBe(false)
    expect(button('Continue').disabled).toBe(true)
  })

  it('with no base URL: no link, no box, the button stays disabled, and the copy is plain', () => {
    vi.stubEnv('VITE_WEBSITE_BASE_URL', '')
    renderAccount()
    fill()
    expect(screen.queryByRole('link', { name: 'Terms and Conditions' })).toBeNull()
    expect(screen.queryByRole('checkbox', { name: /Terms and Conditions/ })).toBeNull()
    expect(button('Create account').disabled).toBe(true)
    expect(screen.getByText(/New accounts can't be created in this version of the app/)).toBeTruthy()
  })
})
