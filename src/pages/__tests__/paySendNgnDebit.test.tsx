/**
 * @vitest-environment jsdom
 *
 * The NGN overcharge, on the screens. A sat of a 10 000.00 NGN coupon on 7429 sats is worth about
 * 134.6 kobo, so 1500.00 cannot be sent exactly: the fewest sats worth it are worth 1500.87, and
 * that is what leaves the balance. Pay and Send now say so before the tap. A EUR coupon, where a
 * sat is worth less than a cent, still shows no such line.
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
vi.mock('../../lib/giftLinks', async (orig) => ({
  ...(await orig<typeof import('../../lib/giftLinks')>()),
  settleAndCountLinks: () => Promise.resolve({ waiting: 0, expiredUnreturned: 0 }),
}))

import { PayPage } from '../PayPage'
import { SendPage } from '../SendPage'

beforeEach(() => {
  localStorage.clear()
  held = [ngnCoupon()]
})
afterEach(cleanup)

const taken = () => screen.getByText('Taken from your balance').nextElementSibling?.textContent ?? ''

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
    await waitFor(() => expect(screen.getByText('Taken from your balance')).toBeTruthy())
    expect(taken()).toMatch(/1,?500\.87/)
    expect(screen.getByText(/cannot make exactly/).textContent).toMatch(/0\.87 more/)
  })

  it('says nothing more on a EUR request, which goes exactly', async () => {
    // Arrange
    held = [eurCoupon()]

    // Act
    drawPay(250, 'EUR')

    // Assert
    await waitFor(() => expect(screen.getByText('Your balance')).toBeTruthy())
    expect(screen.queryByText('Taken from your balance')).toBeNull()
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
    await waitFor(() => expect(screen.getByText('Taken from your balance')).toBeTruthy())
    expect(taken()).toMatch(/1,?500\.87/)
    expect(screen.getByText(/cannot make exactly/)).toBeTruthy()
  })
})
