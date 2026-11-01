/**
 * @vitest-environment jsdom
 *
 * #460: coupons from the same stall bought at two sales with different issuance ratios are two
 * VoucherGrouper groups. The Pay screen read only the first, so 5 + 7 EUR showed as 7 EUR and
 * the shortfall was computed from that. The balance is every group in the request's unit.
 *
 * (Harness copied from PayPageClosedStall434.)
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const STALL = 'a'.repeat(64)
const ME = 'e'.repeat(64)
const LATER = Math.floor(Date.now() / 1000) + 30 * 86_400

// Face 500 backed by 500 sats (ratio 1) and face 700 backed by 350 sats (ratio 2): two groups.
const row = (token_id: string, face_value: number, token_amount: number) => ({
  token_id,
  token: `cashuB${token_id}`,
  voucher_id: token_id,
  issuer_id: STALL,
  merchant_id: STALL,
  face_value,
  face_unit: 'EUR',
  face_decimals: 2,
  token_amount,
  amount: token_amount,
  backing_strategy: 'PROPORTIONAL',
  status: 'active',
  expires_at: LATER,
  created_at: new Date().toISOString(),
})

vi.mock('../../lib/merchantStatus', async (orig) => ({
  ...(await orig<typeof import('../../lib/merchantStatus')>()),
  fetchStallStatus: async () => ({ status: 'open', sellsByCard: false }),
}))
vi.mock('../../lib/wallet', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/wallet')>()),
  listVouchers: () => Promise.resolve([row('five', 500, 500), row('seven', 700, 350)]),
}))
vi.mock('../../lib/spentCoupons', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/spentCoupons')>()),
  spentTokenIds: () => Promise.resolve({ ids: new Set<string>(), known: true }),
}))
vi.mock('../../lib/identity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/identity')>()),
  useIdentity: () => undefined,
}))

import { PayPage } from '../PayPage'

afterEach(cleanup)

function draw(amount: number) {
  ;(window as unknown as { NUT18V: unknown }).NUT18V = {
    parse: () => ({ paymentId: 'p1', issuerId: STALL, amount, unit: 'EUR' }),
  }
  render(
    <MemoryRouter initialEntries={['/pay?paymentRequest=req']}>
      <PayPage pubkey={ME} />
    </MemoryRouter>,
  )
}

function balance(): string {
  const label = screen.getByText('Your balance')
  return label.nextElementSibling?.textContent ?? ''
}

describe('Pay balance across issuance ratios (#460)', () => {
  it('sums both groups: 5 + 7 EUR shows 12 and a 1.25 EUR request is not short', async () => {
    draw(125)
    await waitFor(() => expect(screen.getByText('Your balance')).toBeTruthy())
    expect(balance()).toMatch(/12\.00/)
    expect(screen.getByText('Vouchers held').nextElementSibling?.textContent).toBe('2')
    expect(screen.queryByText(/Short by/)).toBeNull()
  })

  it('still reports a shortfall when the sum is below the request', async () => {
    draw(1500)
    await waitFor(() => expect(screen.getByText('Your balance')).toBeTruthy())
    expect(balance()).toMatch(/12\.00/)
    expect(screen.getByText(/Short by/).textContent).toMatch(/3\.00/)
  })
})
