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
/** When set, the send ends by throwing this instead of resolving `result`. */
let failure: Error | undefined
vi.mock('../../lib/pay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/pay')>()),
  sendVouchers: () => (failure ? Promise.reject(failure) : Promise.resolve(result)),
}))

import { SendPage } from '../SendPage'
import { SendOutcomeUnknownError } from '../../lib/pay'

afterEach(() => {
  cleanup()
  failure = undefined
})

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
    await waitFor(() => expect(screen.getByText(/Paid .* as 2 vouchers\./)).toBeTruthy())
  })

  it('says nothing extra for a single coupon', async () => {
    result = { id: 'x', requested: 100, delivered: 100, parts: 1 }
    await send()
    await waitFor(() => expect(screen.getByText('Done')).toBeTruthy())
    expect(screen.queryByText(/ as \d+ vouchers/)).toBeNull()
  })

  it('counts only what went when the bundle stopped short', async () => {
    result = { id: 'x', requested: 100, delivered: 50, parts: 2, shortfall: 'mint down' }
    await send()
    await waitFor(() => expect(screen.getByText(/2 vouchers went before the rest stopped\./)).toBeTruthy())
  })

  // #125: a part the gateway accepted but could not confirm may already have arrived, so the
  // screen says it is still going through and never tells the sender to send it again.
  it('never offers to resend a part that is still going through', async () => {
    result = { id: 'x', requested: 100, delivered: 50, inFlight: 50, parts: 2, shortfall: 'still going through' }
    await send()
    await waitFor(() => expect(screen.getByText(/Do not send it again/)).toBeTruthy())
    expect(screen.queryByText(/send\s+the difference again/)).toBeNull()
  })

  // #125 review: the parts after an unconfirmed one were never tried, and the sender is told so.
  it('says what was never sent after a part that is still going through', async () => {
    result = { id: 'x', requested: 100, delivered: 40, inFlight: 40, parts: 2, shortfall: 'still going through' }
    await send()
    await waitFor(() => expect(screen.getByText(/The last .*0\.20 was not sent/)).toBeTruthy())
  })

  // #128: a send whose outcome is unknown may already have arrived, so the button that would send
  // it again is locked and says why; only a real failure leaves it free to retry.
  it('locks the pay button after a send whose outcome is unknown', async () => {
    failure = new SendOutcomeUnknownError('This send is still going through at the gateway. It has NOT failed.', 'as_1')
    await send()
    const locked = await screen.findByRole('button', { name: 'Still going through' })
    expect((locked as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/has NOT failed/)).toBeTruthy()
  })

  // A send that really failed moved nothing, so trying again is safe and the button stays live.
  it('leaves the pay button live after a send that failed', async () => {
    failure = new Error('mint refused the split')
    await send()
    await screen.findByText('mint refused the split')
    expect((screen.getByRole('button', { name: 'Pay' }) as HTMLButtonElement).disabled).toBe(false)
  })
})
