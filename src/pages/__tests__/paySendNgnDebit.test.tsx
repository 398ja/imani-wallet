/**
 * @vitest-environment jsdom
 *
 * The NGN overcharge, on the screens. A sat of a 10 000.00 NGN coupon on 7429 sats is worth about
 * 134.6 kobo, so 1500.00 cannot be sent exactly: the fewest sats worth it are worth 1500.87, and
 * that is what leaves the balance. Pay and Send now say so before the tap. A EUR coupon, where a
 * sat is worth less than a cent, still shows no such line.
 *
 * #635: the headline on the confirm screen is that real figure, the asked amount under it, and the
 * done screen headlines what the gateway confirmed left, never calling an overcharge "partial".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/hashes/utils'

import { buildVoucherToken } from '../../lib/__tests__/voucherFixtures'

const KEY = schnorr.utils.randomSecretKey()
const STALL = bytesToHex(schnorr.getPublicKey(KEY))
const ME = 'e'.repeat(64)
const LATER = Math.floor(Date.now() / 1000) + 90 * 86_400

/** One coupon row: `face` minor units of `unit` on `proofs` sats, at face / sats. */
function couponRow(unit: string, face: number, proofs: number[]) {
  const sats = proofs.reduce((s, p) => s + p, 0)
  const ratio = face / sats
  const token = buildVoucherToken({ voucherId: `v-${unit}`, faceValue: face, unit, faceDecimals: 2, issuanceRatio: ratio, expiresAt: LATER }, proofs, {}, KEY).token
  return {
    token_id: `t-${unit}`,
    voucher_id: `v-${unit}`,
    token,
    issuer_id: STALL,
    merchant_id: STALL,
    amount: sats,
    token_amount: sats,
    face_value: face,
    face_unit: unit,
    face_decimals: 2,
    issuance_ratio: ratio,
    backing_strategy: 'PROPORTIONAL',
    status: 'active',
    expires_at: LATER,
    created_at: '2026-11-02T00:00:00Z',
  }
}

const ngnCoupon = () => couponRow('NGN', 1_000_000, [4096, 2048, 1024, 256, 4, 1])
const eurCoupon = () => couponRow('EUR', 1000, [8192, 4096, 1016])

let held: ReturnType<typeof couponRow>[] = []

vi.mock('../../lib/wallet', async (orig) => ({
  ...(await orig<typeof import('../../lib/wallet')>()),
  listVouchers: () => Promise.resolve(held),
}))
vi.mock('../../lib/spentCoupons', async (orig) => ({
  ...(await orig<typeof import('../../lib/spentCoupons')>()),
  spentTokenIds: () => Promise.resolve({ ids: new Set<string>(), known: true }),
}))
vi.mock('../../lib/merchantStatus', async (orig) => ({
  ...(await orig<typeof import('../../lib/merchantStatus')>()),
  fetchStallStatus: async () => ({ status: 'open', sellsByCard: false }),
}))
vi.mock('../../lib/identity', async (orig) => ({
  ...(await orig<typeof import('../../lib/identity')>()),
  useIdentity: () => undefined,
}))
vi.mock('../../lib/branding', async (orig) => ({
  ...(await orig<typeof import('../../lib/branding')>()),
  merchantBranding: () =>
    Promise.resolve({ organizationName: 'Bart', nip05: undefined, logoUrl: undefined, bannerUrl: undefined, storeDescription: undefined }),
}))
vi.mock('../../lib/merchant', async (orig) => ({
  ...(await orig<typeof import('../../lib/merchant')>()),
  merchantStatus: () => Promise.resolve('customer'),
  isMerchantPubkey: () => Promise.resolve(false),
}))
/** When set, the send or payment resolves with it instead of reaching a gateway. */
let answer: Record<string, unknown> | null = null
vi.mock('../../lib/pay', async (orig) => {
  const real = await orig<typeof import('../../lib/pay')>()
  return {
    ...real,
    sendVouchers: (args: Parameters<typeof real.sendVouchers>[0]) => (answer ? Promise.resolve(answer) : real.sendVouchers(args)),
    payRequest: (args: Parameters<typeof real.payRequest>[0]) => (answer ? Promise.resolve(answer) : real.payRequest(args)),
  }
})
vi.mock('../../lib/giftLinks', async (orig) => ({
  ...(await orig<typeof import('../../lib/giftLinks')>()),
  settleAndCountLinks: () => Promise.resolve({ waiting: 0, expiredUnreturned: 0 }),
}))

import { PayPage } from '../PayPage'
import { SendPage } from '../SendPage'

beforeEach(() => {
  localStorage.clear()
  held = [ngnCoupon()]
  answer = null
})
afterEach(cleanup)

/** The confirm screen's big figure. */
const headline = () => document.querySelector('.text-amount')?.textContent ?? ''

function drawPay(amount: number, unit: string) {
  ;(window as unknown as { NUT18V: unknown }).NUT18V = {
    parse: () => ({ paymentId: 'p1', issuerId: STALL, amount, unit }),
  }
  render(
    <MemoryRouter initialEntries={['/pay?paymentRequest=req']}>
      <PayPage pubkey={ME} />
    </MemoryRouter>,
  )
}

describe('Pay', () => {
  it('says 1500.87 leaves for a 1500.00 NGN request, before the tap', async () => {
    // Act
    drawPay(150_000, 'NGN')

    // Assert
    await waitFor(() => expect(screen.getByText(/cannot make exactly/)).toBeTruthy())
    expect(headline()).toMatch(/1,?500\.87/)
    expect(screen.getByText(/^Asked:/).textContent).toMatch(/1,?500\.00/)
    expect(screen.getByText(/cannot make exactly/).textContent).toMatch(/0\.87 more/)
  })

  it('says nothing more on a EUR request, which goes exactly', async () => {
    // Arrange
    held = [eurCoupon()]

    // Act
    drawPay(250, 'EUR')

    // Assert
    await waitFor(() => expect(screen.getByText('Your balance')).toBeTruthy())
    expect(headline()).toMatch(/2\.50/)
    expect(screen.queryByText(/^Asked:/)).toBeNull()
    expect(screen.queryByText(/cannot make exactly/)).toBeNull()
  })
})

describe('Send', () => {
  it('the confirm screen says 1500.87 leaves for 1500.00 NGN', async () => {
    // Arrange
    render(
      <MemoryRouter initialEntries={[`/send?to=${'b'.repeat(64)}`]}>
        <SendPage pubkey={ME} />
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByText(/available from/)).toBeTruthy())

    // Act
    fireEvent.change(screen.getByLabelText(/Amount/), { target: { value: '1500' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    // Assert
    await waitFor(() => expect(screen.getByText(/cannot make exactly/)).toBeTruthy())
    expect(headline()).toMatch(/1,?500\.87/)
    expect(screen.getByText(/You asked to send/).textContent).toMatch(/1,?500\.00/)
  })

  it('the done screen says what the gateway confirmed was sent, not the request (#635)', async () => {
    // Arrange: the gateway confirmed 1500.87 left for 1500.00 asked.
    answer = { id: 's1', requested: 150_000, delivered: 150_000, sent: 150_087, parts: 1, vouchers: 1 }
    render(
      <MemoryRouter initialEntries={[`/send?to=${'b'.repeat(64)}`]}>
        <SendPage pubkey={ME} />
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByText(/available from/)).toBeTruthy())
    fireEvent.change(screen.getByLabelText(/Amount/), { target: { value: '1500' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy())

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    // Assert
    await waitFor(() => expect(screen.getByText(/You asked to send/)).toBeTruthy())
    expect(headline()).toMatch(/1,?500\.87/)
    expect(screen.getByText(/You asked to send/).textContent).toMatch(/1,?500\.00/)
    expect(screen.queryByText(/ reached /)).toBeNull()
  })

  it('a EUR send reads as before: the request, no second line', async () => {
    // Arrange
    held = [eurCoupon()]
    answer = { id: 's2', requested: 250, delivered: 250, sent: 250, parts: 1, vouchers: 1 }
    render(
      <MemoryRouter initialEntries={[`/send?to=${'b'.repeat(64)}`]}>
        <SendPage pubkey={ME} />
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByText(/available from/)).toBeTruthy())
    fireEvent.change(screen.getByLabelText(/Amount/), { target: { value: '2.50' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy())
    expect(headline()).toMatch(/2\.50/)

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    // Assert
    await waitFor(() => expect(screen.getByText(/Sent to/)).toBeTruthy())
    expect(headline()).toMatch(/2\.50/)
    expect(screen.queryByText(/You asked to send/)).toBeNull()
  })
})

describe('Pay done (#635)', () => {
  it('headlines what was paid, the asked amount beside it, and is not "Not all paid"', async () => {
    // Arrange: a two-part bundle, each part a sat over.
    answer = { id: 'b1', requested: 150_000, delivered: 150_000, sent: 150_087, parts: 2, vouchers: 2 }
    drawPay(150_000, 'NGN')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Pay' })).toBeTruthy())

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Pay' }))

    // Assert
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Paid' })).toBeTruthy())
    const line = screen.getByText(/asked /).textContent ?? ''
    expect(line).toMatch(/1,?500\.87 \(asked .*1,?500\.00\)/)
    expect(screen.queryByText('Not all paid')).toBeNull()
  })
})
