/**
 * @vitest-environment jsdom
 *
 * The sender's own screen for a payment drawn from several coupons (#94):
 * "Sent as 2 vouchers", so what the sender sees matches the recipient's
 * "€6.00 received (2 vouchers)". A single coupon says nothing extra.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const MERCHANT = 'a'.repeat(64)
const ME = 'e'.repeat(64)

vi.mock('../../lib/branding', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/branding')>()),
  merchantBranding: () =>
    Promise.resolve({
      organizationName: 'Cocoa Roasters',
      nip05: 'cocoa@staging.398ja.xyz',
      logoUrl: undefined,
      bannerUrl: undefined,
      storeDescription: undefined,
    }),
}))

vi.mock('../../lib/merchant', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/merchant')>()),
  merchantStatus: () => Promise.resolve('customer'),
  isMerchantPubkey: () => Promise.resolve(false),
}))

vi.mock('../../lib/wallet', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/wallet')>()),
  listVouchers: () =>
    Promise.resolve([
      {
        token_id: 't1',
        issuer_id: MERCHANT,
        merchant_id: MERCHANT,
        face_value: 1000,
        face_unit: 'EUR',
        face_decimals: 2,
        token_amount: 1000,
        status: 'active',
        created_at: new Date().toISOString(),
      },
    ]),
}))

let result = { id: 'x', requested: 100, delivered: 100, parts: 2 } as Record<string, unknown>
vi.mock('../../lib/pay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/pay')>()),
  sendVouchers: () => Promise.resolve(result),
}))

import { SendPage } from '../SendPage'

afterEach(cleanup)

async function send() {
  render(
    <MemoryRouter initialEntries={[`/send?to=${MERCHANT}`]}>
      <SendPage pubkey={ME} />
    </MemoryRouter>,
  )
  await waitFor(() => expect(screen.getAllByText('Cocoa Roasters').length).toBeGreaterThan(0))
  fireEvent.change(screen.getByLabelText(/Amount/), { target: { value: '1' } })
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Pay' })).toBeTruthy())
  fireEvent.click(screen.getByRole('button', { name: 'Pay' }))
}

describe('the sender sees one payment in several coupons', () => {
  it('says how many vouchers carried it', async () => {
    result = { id: 'x', requested: 100, delivered: 100, parts: 2 }
    await send()
    await waitFor(() => expect(screen.getByText('Sent as 2 vouchers.')).toBeTruthy())
  })

  it('says nothing extra for a single coupon', async () => {
    result = { id: 'x', requested: 100, delivered: 100, parts: 1 }
    await send()
    await waitFor(() => expect(screen.getByText('Done')).toBeTruthy())
    expect(screen.queryByText(/Sent as/)).toBeNull()
  })

  it('counts only what went when the bundle stopped short', async () => {
    result = { id: 'x', requested: 100, delivered: 50, parts: 2, shortfall: 'mint down' }
    await send()
    await waitFor(() => expect(screen.getByText('2 vouchers went before the rest stopped.')).toBeTruthy())
  })
})
