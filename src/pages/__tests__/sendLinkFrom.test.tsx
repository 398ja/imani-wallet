/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'

/**
 * Send by link, arrived at from a merchant's page (owner report 2026-10-14): the merchant is
 * already chosen, so "Which voucher?" must not ask again.
 */

const COCOA = 'a'.repeat(64)
const TEA = 'c'.repeat(64)
const ME = 'e'.repeat(64)

vi.mock('../../lib/branding', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/branding')>()),
  merchantBranding: () =>
    Promise.resolve({ organizationName: 'Shop', nip05: undefined, logoUrl: undefined, bannerUrl: undefined, storeDescription: undefined }),
}))

vi.mock('../../lib/merchant', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/merchant')>()),
  merchantStatus: () => Promise.resolve('customer'),
  isMerchantPubkey: () => Promise.resolve(false),
}))

// Token contents are not under test here: the sender's own stall is the only exclusion.
vi.mock('../../lib/giftLink', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/giftLink')>()),
  giftExclusion: (_t: string | undefined, issuer: string | undefined, sender: string) =>
    (issuer ?? '').toLowerCase() === sender.toLowerCase() ? 'own_stall' : null,
}))

vi.mock('../../lib/giftLinks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/giftLinks')>()),
  outstandingLinkCount: () => Promise.resolve(0),
}))

const row = (id: string, merchant: string, unit: string, face: number) => ({
  token_id: id,
  merchant_id: merchant,
  issuer_id: merchant,
  token: 'cashuBfake',
  face_value: face,
  face_unit: unit,
  face_decimals: 2,
  token_amount: face,
  status: 'active',
  created_at: new Date().toISOString(),
})

vi.mock('../../lib/wallet', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/wallet')>()),
  listVouchers: () =>
    Promise.resolve([
      row('t1', COCOA, 'EUR', 1000),
      row('t2', TEA, 'EUR', 500),
      row('t3', TEA, 'USD', 700),
      row('t4', ME, 'EUR', 900),
    ]),
}))

import { SendByLinkOption, SendLinkPage } from '../SendLinkPage'

afterEach(cleanup)

const where = () => screen.getByTestId('where').textContent
function Where() {
  const l = useLocation()
  return <p data-testid="where">{l.pathname + l.search}</p>
}

const draw = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/send/link" element={<SendLinkPage pubkey={ME} />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  )

describe('send by link from a merchant', () => {
  it('skips "Which voucher?" when that merchant has one option', async () => {
    draw(`/send/link?from=${COCOA}`)
    await waitFor(() => expect(screen.getByText('How much?')).toBeTruthy())
    expect(screen.queryByText('Which voucher?')).toBeNull()
    expect(screen.getByText(/10\.00/)).toBeTruthy()
  })

  it('narrows the picker to that merchant when it has several units', async () => {
    draw(`/send/link?from=${TEA}`)
    await waitFor(() => expect(screen.getByText('Which voucher?')).toBeTruthy())
    expect(screen.getByText(/5\.00/)).toBeTruthy()
    expect(screen.getByText(/7\.00/)).toBeTruthy()
    expect(screen.queryByText(/10\.00/)).toBeNull()
  })

  it('takes the unit too when it is given', async () => {
    draw(`/send/link?from=${TEA}&unit=usd`)
    await waitFor(() => expect(screen.getByText('How much?')).toBeTruthy())
    expect(screen.getByText(/7\.00/)).toBeTruthy()
  })

  it('says why for the sender’s own stall, and offers another voucher', async () => {
    draw(`/send/link?from=${ME}`)
    await waitFor(() => expect(screen.getByText(/use Cashback/)).toBeTruthy())
    expect(screen.queryByText('Which voucher?')).toBeNull()
    expect(screen.queryByText('You have no vouchers to send.')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Choose another voucher' }))
    await waitFor(() => expect(screen.getByText('Which voucher?')).toBeTruthy())
    expect(screen.getByText(/10\.00/)).toBeTruthy()
  })

  it('says so for a merchant with nothing left', async () => {
    draw(`/send/link?from=${'d'.repeat(64)}`)
    await waitFor(() => expect(screen.getByText(/no vouchers left from this merchant/)).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Choose another voucher' })).toBeTruthy()
  })

  it('is unchanged without from: the full picker', async () => {
    draw('/send/link')
    await waitFor(() => expect(screen.getByText('Which voucher?')).toBeTruthy())
    expect(screen.getByText(/10\.00/)).toBeTruthy()
    expect(screen.getByText(/7\.00/)).toBeTruthy()
  })

  it('keeps from on the way back', async () => {
    draw(`/send/link?from=${COCOA}`)
    await waitFor(() => expect(screen.getByText('How much?')).toBeTruthy())
    const back = screen.getByRole('link', { name: /Back/ })
    expect(back.getAttribute('href')).toBe(`/send?from=${COCOA}`)
  })
})

describe('SendByLinkOption', () => {
  const tap = (props: Parameters<typeof SendByLinkOption>[0]) => {
    render(
      <MemoryRouter initialEntries={['/send']}>
        <Routes>
          <Route path="/send" element={<SendByLinkOption {...props} />} />
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByRole('button', { name: /Anyone, by link/ }))
  }

  it('carries from', () => {
    tap({ from: COCOA })
    expect(where()).toBe(`/send/link?from=${COCOA}`)
  })

  it('carries from and unit', () => {
    tap({ from: COCOA, unit: 'EUR' })
    expect(where()).toBe(`/send/link?from=${COCOA}&unit=EUR`)
  })

  it('carries nothing without from', () => {
    tap({})
    expect(where()).toBe('/send/link')
  })
})
