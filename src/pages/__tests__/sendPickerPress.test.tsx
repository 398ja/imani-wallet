/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

/**
 * SendPage's voucher picker is the older twin of SendLinkPage's, which the
 * apple-design pass gave a press state. These rows and the "change" link are
 * tapped mid-send, so they must answer on pointer-down the same way.
 */

const COCOA = 'a'.repeat(64)
const BAKERY = 'c'.repeat(64)
const ME = 'e'.repeat(64)

vi.mock('../../lib/branding', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/branding')>()),
  merchantBranding: (pubkey: string) =>
    Promise.resolve({
      organizationName: pubkey.toLowerCase().includes(COCOA) ? 'Cocoa Roasters' : 'Corner Bakery',
      nip05: undefined,
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

const coupon = (tokenId: string, merchantId: string) => ({
  token_id: tokenId,
  merchant_id: merchantId,
  issuer_id: merchantId,
  token: 'cashuBfake',
  face_value: 1000,
  face_unit: 'EUR',
  face_decimals: 2,
  token_amount: 1000,
  status: 'active',
  created_at: new Date().toISOString(),
})

vi.mock('../../lib/wallet', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/wallet')>()),
  listVouchers: () => Promise.resolve([coupon('t1', COCOA), coupon('t2', BAKERY)]),
}))

import { SendPage } from '../SendPage'

afterEach(cleanup)

const drawPicker = () =>
  render(
    <MemoryRouter initialEntries={[`/send?to=${'b'.repeat(64)}`]}>
      <SendPage pubkey={ME} />
    </MemoryRouter>,
  )

const pickerRow = (name: string) => screen.getByText(name).closest('button') as HTMLButtonElement

describe('the send picker’s press feedback', () => {
  // Every voucher row on the "Which voucher?" screen uses the house press state.
  it('gives every voucher row a press state', async () => {
    drawPicker()

    await waitFor(() => expect(screen.getByText('Corner Bakery')).toBeTruthy())
    expect(pickerRow('Cocoa Roasters').className).toContain('pressable')
    expect(pickerRow('Corner Bakery').className).toContain('pressable')
  })

  // The "change" link back to the picker also presses, and keeps a usable tap height.
  it('gives the change link a press state and a taller tap target', async () => {
    drawPicker()

    await waitFor(() => expect(screen.getByText('Cocoa Roasters')).toBeTruthy())
    fireEvent.click(pickerRow('Cocoa Roasters'))

    const change = await screen.findByRole('button', { name: 'change' })
    expect(change.className).toContain('pressable')
    expect(change.className).toContain('py-2')
  })
})
