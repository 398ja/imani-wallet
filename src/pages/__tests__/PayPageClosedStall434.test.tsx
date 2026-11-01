/**
 * @vitest-environment jsdom
 *
 * #434: a customer cannot pay a stall that is closed for business, or one nobody could confirm is
 * open. Pay is disabled with the reason, and a stall that closes after the screen loaded is
 * caught by the re-check at the tap, before anything leaves the wallet.
 *
 * (Harness copied from PayPagePassedOverTombstone.)
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
const stall = vi.hoisted(() => ({ status: 'open' as string, calls: 0 }))
const paid = vi.hoisted(() => ({ n: 0 }))

// #434: the stall's open-for-business status is asked of the portal. Open here: these tests
// are about something else, and an unmocked fetch would (correctly) fail closed.
vi.mock('../../lib/merchantStatus', async (orig) => ({
  ...(await orig<typeof import('../../lib/merchantStatus')>()),
  fetchStallStatus: async () => {
    stall.calls += 1
    return { status: stall.status, sellsByCard: false }
  },
}))
vi.mock('../../lib/pay', async (orig) => ({
  ...(await orig<typeof import('../../lib/pay')>()),
  payRequest: async () => {
    paid.n += 1
    return { id: 's', requested: 400, delivered: 400, parts: 1 }
  },
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
  stall.status = 'open'
  stall.calls = 0
  paid.n = 0
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

describe('paying a stall that is closed for business (#434)', () => {
  it.each([
    ['closed', /is closed right now/],
    ['unknown', /can't check whether/i],
  ])('%s: Pay is disabled and says why', async (s, why) => {
    stall.status = s
    draw()
    await waitFor(() => expect(screen.getByText(why)).toBeTruthy())
    expect((screen.getByRole('button', { name: /^Pay$/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('open: Pay is enabled', async () => {
    draw()
    await waitFor(() => expect((screen.getByRole('button', { name: /^Pay$/ }) as HTMLButtonElement).disabled).toBe(false))
  })

  it('a stall that closes after load is refused at the tap, and nothing is sent', async () => {
    draw()
    const pay = await waitFor(() => {
      const b = screen.getByRole('button', { name: /^Pay$/ }) as HTMLButtonElement
      expect(b.disabled).toBe(false)
      return b
    })
    stall.status = 'closed'
    pay.click()
    await waitFor(() => expect(screen.getByText(/is closed right now/)).toBeTruthy())
    expect(paid.n).toBe(0)
  })
})
