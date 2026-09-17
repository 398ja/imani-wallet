/**
 * @vitest-environment jsdom
 *
 * The word the CUSTOMER sees when their voucher goes back to the merchant.
 *
 * "Redeem" is the merchant's word for it — value coming back off their books —
 * and it stays that way on the till (see MerchantHomePage.test). But the person
 * standing at the stall is doing the ordinary thing of paying for something,
 * and a button asking them to "Redeem" makes them adopt the counterparty's
 * accounting language for their own purchase. It also reads like claiming a
 * prize rather than handing money over.
 *
 * The operation is unchanged and deliberately so: this is wording, not
 * behaviour, and these tests assert that the send still goes through the
 * merchant path while SAYING the customer's word for it.
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
        // `issuer_id` is what VoucherGrouper keys the merchant on (see
        // `toVoucher`), and matching it to the recipient is exactly what makes
        // this send a redemption — the condition the wording hangs off.
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

import { SendPage } from '../SendPage'

afterEach(cleanup)

/**
 * Send TO the merchant who issued the voucher, which is what makes this a
 * redemption internally and a payment in the customer's eyes.
 */
const draw = () =>
  render(
    <MemoryRouter initialEntries={[`/send?to=${MERCHANT}`]}>
      <SendPage pubkey={ME} />
    </MemoryRouter>,
  )

/** Through the amount step to the confirm screen, where the button lives. */
async function reachConfirm() {
  draw()
  await waitFor(() => expect(screen.getAllByText('Cocoa Roasters').length).toBeGreaterThan(0))
  fireEvent.change(screen.getByLabelText(/Amount/), { target: { value: '1' } })
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  await waitFor(() => expect(screen.getByText(/From your vouchers with/)).toBeTruthy())
}

describe('paying a merchant back with their own voucher', () => {
  it('labels the commit button "Pay", not "Redeem"', async () => {
    await reachConfirm()

    expect(screen.getByRole('button', { name: 'Pay' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Redeem' })).toBeNull()
  })

  it('titles the confirm screen as a payment', async () => {
    // A "Pay" button under a "Confirm redemption" heading would just relocate
    // the merchant's word rather than remove it.
    await reachConfirm()

    expect(screen.getByText('Confirm payment')).toBeTruthy()
    expect(screen.queryByText('Confirm redemption')).toBeNull()
  })

  it('says "Pay" on the way there too', async () => {
    // The amount screen's subtitle — "Pay Cocoa Roasters" — is the same verb
    // one step earlier, so the flow does not change its mind at the last screen.
    draw()

    await waitFor(() => expect(screen.getAllByText(/Pay Cocoa Roasters/).length).toBeGreaterThan(0))
    expect(screen.queryByText(/Redeem at/)).toBeNull()
  })

  it('still routes through the merchant path, which is what the wording describes', async () => {
    // The wording changed; the operation did not. "From your vouchers with" is
    // the merchant-leg copy, and its presence proves this is still the
    // redemption flow underneath.
    await reachConfirm()

    expect(screen.getByText(/From your vouchers with/)).toBeTruthy()
  })
})
