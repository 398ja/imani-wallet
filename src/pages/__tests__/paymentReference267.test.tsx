/**
 * @vitest-environment jsdom
 *
 * #267 item 4: the Stripe reference on a card sale is usable for reconciliation.
 *
 * - On the voucher record it has a copy button, beside the amount and the date.
 * - On the sales list row it appears compactly, with its own copy button.
 * - No Stripe dashboard link: accounts are Express (no id search there) and no
 *   login-link endpoint exists, so a link would lead nowhere useful.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

const DAY = 86_400_000
const STALL = 'd'.repeat(64)
const REF = 'pi_3PqRsTuVwXyZ0123456789'

function cardSale({ id, ref }: { id: string; ref?: string }) {
  return {
    id: `issued:${id}`,
    type: 'issued',
    direction: 'out',
    amount: 2500,
    unit: 'XAF',
    decimals: 0,
    timestamp: Date.now() - DAY,
    memo: `Voucher ${id}`,
    voucherId: id,
    expiresAt: Date.now() + 30 * DAY,
    issuanceWarrant: JSON.stringify({
      form: 'processor',
      sale_total: 2500,
      face_decimals: 0,
      unit: 'XAF',
      nonce: 'n-1',
      ...(ref ? { ref } : {}),
    }),
  }
}

const rows: Record<string, unknown>[] = []

vi.mock('../../lib/wallet', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/wallet')>()),
  listTransactions: () => Promise.resolve(rows),
  onWalletChanged: () => () => {},
}))
vi.mock('../../lib/identity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/identity')>()),
  useIdentity: () => undefined,
}))

import { IssuedCouponPage, IssuedCouponsPage } from '../MerchantRecordPages'

const writeText = vi.fn().mockResolvedValue(undefined)
Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })

afterEach(() => {
  cleanup()
  writeText.mockClear()
})

describe('card reference on the voucher record', () => {
  function show(transactions: Record<string, unknown>[]) {
    rows.length = 0
    rows.push(...transactions)
    return render(
      <MemoryRouter initialEntries={['/merchant/coupon/v1']}>
        <Routes>
          <Route path="/merchant/coupon/:voucherId" element={<IssuedCouponPage pubkey={STALL} />} />
        </Routes>
      </MemoryRouter>,
    )
  }

  it('shows the pi_ ref with amount and date, and copies it', async () => {
    show([cardSale({ id: 'v1', ref: REF })])
    const block = await screen.findByTestId('payment-reference')
    expect(block.textContent).toContain(REF)
    expect(block.textContent).toMatch(/2[\s,.\u202f]?500/)
    expect(block.textContent).toMatch(/Paid /)
    fireEvent.click(screen.getByRole('button', { name: 'Copy payment reference' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(REF))
    expect(screen.queryByRole('link', { name: /stripe/i })).toBeNull()
  })

  it('shows no reference block for a card sale without one', async () => {
    show([cardSale({ id: 'v1' })])
    await screen.findByText('Voucher v1')
    expect(screen.queryByTestId('payment-reference')).toBeNull()
  })
})

describe('card reference on the sales list', () => {
  it('shows a compact copyable ref on the row', async () => {
    rows.length = 0
    rows.push(cardSale({ id: 'v1', ref: REF }))
    render(
      <MemoryRouter>
        <IssuedCouponsPage />
      </MemoryRouter>,
    )
    const button = await screen.findByRole('button', { name: 'Copy payment reference' })
    expect(button.textContent).toContain('pi_3PqR')
    fireEvent.click(button)
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(REF))
  })
})
