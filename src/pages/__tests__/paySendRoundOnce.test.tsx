/**
 * @vitest-environment jsdom
 *
 * Pay, Send and Send by link showed a merchant's balance as the sum of each coupon's own rounding,
 * so they read a cent below Home (staging 2026-11-02, "georges 8.98 vs 8.99"): the change of a
 * checkout code comes back as six coupon rows of one voucher, 8192 + 4096 + 512 + 128 + 64 + 16 sats
 * at 0.0691443 c/sat. Each row rounds to 566 + 283 + 35 + 9 + 4 + 1 = 898 c, the voucher is worth
 * 899.43 c. Home shows 8.99 (#494); these three screens now show it too.
 *
 * A send still draws coupon by coupon, so only 8.98 can actually go. Asking for 8.99 is refused
 * BEFORE the tap, in words, instead of being offered and failing at the gateway.
 *
 * Real tokens (`buildVoucherToken`), so `roundedOnceTotal` reads them exactly as it does in the app.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/hashes/utils'

import { buildVoucherToken } from '../../lib/__tests__/voucherFixtures'
import { creditableFaceValue, parseVoucherToken } from '../../lib/voucherToken'
import { roundingShortfallNote, roundedOnceTotal, spendableTotal } from '../../lib/couponTotals'
import { holdingForUnit, toMerchants, unitHoldings } from '../../lib/merchants'

const KEY = schnorr.utils.randomSecretKey()
const STALL = bytesToHex(schnorr.getPublicKey(KEY))
const ME = 'e'.repeat(64)
const LATER = Math.floor(Date.now() / 1000) + 90 * 86_400
const GEORGES_RATE = 0.0691443
const GEORGES_CHANGE = [8192, 4096, 512, 128, 64, 16]

/** One coupon row per proof, all of ONE voucher: the rows a checkout code's change came back as. */
function rowsOf(sats: number[], ratio = GEORGES_RATE, face = 1200) {
  const fields = { voucherId: 'bart-12eur', faceValue: face, unit: 'EUR', faceDecimals: 2, issuanceRatio: ratio, expiresAt: LATER }
  return sats.map((s, i) => {
    const token = buildVoucherToken(fields, [s], {}, KEY).token
    return {
      token_id: `t-${i}`,
      voucher_id: 'bart-12eur',
      token,
      issuer_id: STALL,
      merchant_id: STALL,
      amount: s,
      token_amount: s,
      face_value: creditableFaceValue(parseVoucherToken(token)).faceValue,
      face_unit: 'EUR',
      face_decimals: 2,
      issuance_ratio: ratio,
      backing_strategy: 'PROPORTIONAL',
      status: 'active',
      expires_at: LATER,
      created_at: `2026-11-02T00:00:0${i}Z`,
    }
  })
}

let held: ReturnType<typeof rowsOf> = []

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
import { SendLinkPage } from '../SendLinkPage'

beforeEach(() => {
  localStorage.clear()
  held = rowsOf(GEORGES_CHANGE)
})
afterEach(cleanup)

const eur = (minor: number) => `€${(minor / 100).toFixed(2)}`

describe('the holding Pay and Send read (georges 8.98 vs 8.99)', () => {
  it('the six change rows: balance 8.99 (as Home), 8.98 can be drawn', () => {
    expect(held.map((r) => r.face_value)).toEqual([566, 283, 35, 9, 4, 1])
    const [merchant] = toMerchants(held as never)
    const h = holdingForUnit(merchant, 'EUR')!
    expect(h.totalFaceValue).toBe(899)
    expect(h.spendable).toBe(898)
    expect(unitHoldings([merchant])[0].totalFaceValue).toBe(899)
  })

  it('a voucher held as one coupon is unchanged: balance and spendable are its face', () => {
    held = rowsOf([13008])
    const h = holdingForUnit(toMerchants(held as never)[0], 'EUR')!
    expect(h.totalFaceValue).toBe(899)
    expect(h.spendable).toBe(899)
  })

  it('never shows more than the coupons cover when each coupon rounds UP', () => {
    // 3 x 1 sat at 0.6 c/sat: each coupon credits 1 c (3 c), the voucher is worth 1.8 c.
    held = rowsOf([1, 1, 1], 0.6, 100)
    const h = holdingForUnit(toMerchants(held as never)[0], 'EUR')!
    expect(h.totalFaceValue).toBe(1)
    expect(h.spendable).toBe(1)
  })

  it('the note: only when the amount is within the balance but over what can go', () => {
    expect(roundingShortfallNote(898, 898, 899, eur)).toBeNull()
    expect(roundingShortfallNote(900, 898, 899, eur)).toBeNull() // "Short by" says this one
    expect(roundingShortfallNote(899, 898, 899, eur)).toBe(
      'You can use up to €8.98 of your €8.99. It is held as several vouchers, and each one rounds down.',
    )
    expect(spendableTotal(held)).toBe(898)
    expect(roundedOnceTotal(held)).toBe(899)
  })
})

function drawPay(amount: number) {
  ;(window as unknown as { NUT18V: unknown }).NUT18V = {
    parse: () => ({ paymentId: 'p1', issuerId: STALL, amount, unit: 'EUR' }),
  }
  render(
    <MemoryRouter initialEntries={['/pay?paymentRequest=req']}>
      <PayPage pubkey={ME} />
    </MemoryRouter>,
  )
}

const balance = () => screen.getByText('Your balance').nextElementSibling?.textContent ?? ''
const payButton = () => screen.getByRole('button', { name: 'Pay' }) as HTMLButtonElement

describe('Pay', () => {
  it('shows the balance as Home does: 8.99, not 8.98', async () => {
    drawPay(100)
    await waitFor(() => expect(screen.getByText('Your balance')).toBeTruthy())
    expect(balance()).toMatch(/8\.99/)
  })

  it('pays 8.98', async () => {
    drawPay(898)
    await waitFor(() => expect(screen.getByText('Your balance')).toBeTruthy())
    await waitFor(() => expect(payButton().disabled).toBe(false))
    expect(screen.queryByText(/You can use up to/)).toBeNull()
    expect(screen.queryByText(/Short by/)).toBeNull()
  })

  it('refuses 8.99 before the tap, and says why, rather than "Short by"', async () => {
    drawPay(899)
    await waitFor(() => expect(screen.getByText(/You can use up to/)).toBeTruthy())
    expect(screen.getByText(/You can use up to/).textContent).toMatch(/up to .*8\.98 of your .*8\.99/)
    expect(screen.queryByText(/Short by/)).toBeNull()
    expect(payButton().disabled).toBe(true)
  })

  it('9.00 is short by 0.01 of the balance shown', async () => {
    drawPay(900)
    await waitFor(() => expect(screen.getByText(/Short by/)).toBeTruthy())
    expect(screen.getByText(/Short by/).textContent).toMatch(/0\.01/)
    expect(screen.queryByText(/You can use up to/)).toBeNull()
  })
})

function drawSend() {
  render(
    <MemoryRouter initialEntries={[`/send?to=${'b'.repeat(64)}`]}>
      <SendPage pubkey={ME} />
    </MemoryRouter>,
  )
}

describe('Send', () => {
  it('shows 8.99 available and refuses 8.99 in words, takes 8.98', async () => {
    drawSend()
    await waitFor(() => expect(screen.getByText(/available from/)).toBeTruthy())
    expect(screen.getByText(/available from/).textContent).toMatch(/8\.99/)

    fireEvent.change(screen.getByLabelText(/Amount/), { target: { value: '8.99' } })
    expect(screen.getByText(/You can use up to/)).toBeTruthy()
    expect(screen.queryByText(/Short by/)).toBeNull()
    expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(screen.getByLabelText(/Amount/), { target: { value: '8.98' } })
    expect(screen.queryByText(/You can use up to/)).toBeNull()
    expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(false)

    fireEvent.change(screen.getByLabelText(/Amount/), { target: { value: '9.00' } })
    expect(screen.getByText(/Short by/).textContent).toMatch(/0\.01/)
  })

  it('the confirm screen says the balance is 8.99', async () => {
    drawSend()
    await waitFor(() => expect(screen.getByText(/available from/)).toBeTruthy())
    fireEvent.change(screen.getByLabelText(/Amount/), { target: { value: '1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(screen.getByText('Your balance')).toBeTruthy())
    expect(balance()).toMatch(/8\.99/)
  })
})

describe('Send by link', () => {
  it('shows 8.99 available and refuses 8.99 in words, takes 8.98', async () => {
    render(
      <MemoryRouter initialEntries={[`/send/link?from=${STALL}`]}>
        <Routes>
          <Route path="/send/link" element={<SendLinkPage pubkey={ME} />} />
        </Routes>
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByText(/available from/)).toBeTruthy())
    expect(screen.getByText(/available from/).textContent).toMatch(/8\.99/)

    fireEvent.change(screen.getByLabelText(/Amount/), { target: { value: '8.99' } })
    expect(screen.getByText(/You can use up to/)).toBeTruthy()
    expect(screen.queryByText(/Short by/)).toBeNull()

    fireEvent.change(screen.getByLabelText(/Amount/), { target: { value: '8.98' } })
    expect(screen.queryByText(/You can use up to/)).toBeNull()
  })
})
