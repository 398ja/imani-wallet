/**
 * @vitest-environment jsdom
 *
 * The Pay screen's "a voucher that expires sooner is not used" note (#157) must
 * describe the same holding payRequest spends from (#169 review, LOW-4). A
 * coupon already spent on another device carries a tombstone on the relay;
 * payRequest leaves it out, so the note must not name it either.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const STALL = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)
const ME = 'e'.repeat(64)

const row = (token_id: string, issuer: string, expires_at: number) => ({
  token_id,
  token: `cashuB${token_id}`,
  voucher_id: token_id,
  issuer_id: issuer,
  merchant_id: issuer,
  face_value: 1000,
  face_unit: 'EUR',
  face_decimals: 2,
  token_amount: 1000,
  status: 'active',
  expires_at,
  created_at: new Date().toISOString(),
})

const SOON = Math.floor(Date.now() / 1000) + 86_400
const LATER = SOON + 30 * 86_400

let tombstoned = new Set<string>()

// #434: the stall's open-for-business status is asked of the portal. Open here: these tests
// are about something else, and an unmocked fetch would (correctly) fail closed.
vi.mock('../../lib/merchantStatus', async (orig) => ({
  ...(await orig<typeof import('../../lib/merchantStatus')>()),
  fetchStallStatus: async () => ({ status: 'open', sellsByCard: true, eventId: 'e' }),
}))
vi.mock('../../lib/wallet', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/wallet')>()),
  listVouchers: () =>
    Promise.resolve([row('stall-later', STALL, LATER), row('other-sooner', OTHER, SOON)]),
}))

vi.mock('../../lib/spentCoupons', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/spentCoupons')>()),
  spentTokenIds: () => Promise.resolve({ ids: tombstoned, known: true }),
}))

vi.mock('../../lib/identity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/identity')>()),
  useIdentity: () => undefined,
}))

import { PayPage } from '../PayPage'

afterEach(() => {
  cleanup()
  tombstoned = new Set()
})

function draw() {
  ;(window as unknown as { NUT18V: unknown }).NUT18V = {
    parse: () => ({ paymentId: 'p1', issuerId: STALL, amount: 400, unit: 'EUR' }),
  }
  render(
    <MemoryRouter initialEntries={['/pay?paymentRequest=req']}>
      <PayPage pubkey={ME} />
    </MemoryRouter>,
  )
}

describe('the Pay screen passed-over note and tombstones', () => {
  // Control: a live sooner coupon from another stall IS named, so the note works.
  it('names a sooner coupon from another stall that is still live', async () => {
    draw()
    await waitFor(() => expect(screen.getByText(/expires sooner is not used/)).toBeTruthy())
  })

  // The case under review: the same coupon, but tombstoned. payRequest would
  // never consider it, so the screen must not talk about it.
  it('does not name a sooner coupon this wallet has already spent elsewhere', async () => {
    tombstoned = new Set(['other-sooner'])
    draw()
    await waitFor(() => expect(screen.getByRole('button', { name: /Pay/ })).toBeTruthy())
    expect(screen.queryByText(/expires sooner is not used/)).toBeNull()
  })
})
