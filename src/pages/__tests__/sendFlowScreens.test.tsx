/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

/**
 * The REAL SendPage, rendered, on the screens the report named.
 *
 * `sendFlowNames` covers the hook's decision; this covers the wiring, which is
 * where the bug actually lived — `merchantLabel` was a plain function call that
 * never asked the network, and only rendering the page proves the call sites
 * now go through the hook. A regression that reverted one of the three would
 * pass the hook tests and fail here.
 */

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

// Not a merchant, so the picker offers the coupon without narrowing it away.
vi.mock('../../lib/merchant', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/merchant')>()),
  merchantStatus: () => Promise.resolve('customer'),
  isMerchantPubkey: () => Promise.resolve(false),
}))

/*
  One spendable coupon whose stored merchant name IS the issuer's hex key —
  exactly what `VoucherGrouper` produces for a coupon issued without the
  optional `merchant_metadata.merchant_name`, and precisely the case that
  printed a key on every screen of this flow.
*/
vi.mock('../../lib/wallet', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/wallet')>()),
  listVouchers: () =>
    Promise.resolve([
      {
        token_id: 't1',
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

const draw = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <SendPage pubkey={ME} />
    </MemoryRouter>,
  )

describe('the send flow’s screens', () => {
  /**
   * Step 2, the voucher picker. The row named the merchant by hex key.
   */
  it('names the merchant on the voucher picker', async () => {
    draw(`/send?to=${'b'.repeat(64)}`)

    await waitFor(() => expect(screen.getByText('Cocoa Roasters')).toBeTruthy())
    // The handle, and NOT the key that used to stand in for it.
    expect(screen.getByText('@cocoa')).toBeTruthy()
    expect(screen.queryByText(/aaaaaaaa…aaaa/)).toBeNull()
  })

  /**
   * Step 3, the amount screen: "… available from X". Reached by picking the
   * only coupon, which the page skips to automatically.
   */
  it('names the merchant on the amount screen', async () => {
    draw(`/send?to=${'b'.repeat(64)}`)

    // Waiting for the NAME, not for the static words around it: "available
    // from" renders immediately while the profile is still in flight, so
    // asserting the name right after it is a race that passes only when the
    // mock happens to resolve first.
    await waitFor(() => expect(screen.getAllByText('Cocoa Roasters').length).toBeGreaterThan(0))
    expect(screen.queryByText(/aaaaaaaa…aaaa/)).toBeNull()
  })

  /**
   * Step 4, the confirm screen: "From your vouchers with X". The last place a
   * key was printed, and the one place it is read just before money moves.
   */
  it('names the merchant on the confirm screen', async () => {
    draw(`/send?to=${'b'.repeat(64)}`)

    await waitFor(() => expect(screen.getAllByText('Cocoa Roasters').length).toBeGreaterThan(0))
    fireEvent.change(screen.getByLabelText(/Amount/), { target: { value: '1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    await waitFor(() => expect(screen.getByText(/From your vouchers with/)).toBeTruthy())
    // Twice over: the recipient's row at the top, and the merchant whose
    // coupon is being spent. Both were keys before.
    expect(screen.getAllByText('Cocoa Roasters').length).toBeGreaterThanOrEqual(1)
    expect(screen.queryByText(/aaaaaaaa…aaaa/)).toBeNull()
  })
})
