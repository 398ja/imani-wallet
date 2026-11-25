/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/hashes/utils'

import { buildVoucherToken } from '../../lib/__tests__/voucherFixtures'

/**
 * #635 on the Cashlink confirm screen (owner report 2026-11-25): a NGN 1.00 Cashlink took NGN 1.70,
 * and the screen said NGN 1.00. Like Send and Pay, it now leads with what really leaves the balance,
 * with the amount asked and the reason beneath it. EUR, sent exactly, reads as before.
 */

const KEY = schnorr.utils.randomSecretKey()
const STALL = bytesToHex(schnorr.getPublicKey(KEY))
const ME = 'e'.repeat(64)
const LATER = Math.floor(Date.now() / 1000) + 90 * 86_400

const h = vi.hoisted(() => ({ rows: [] as unknown[], direct: false }))

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

vi.mock('../../lib/branding', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/branding')>()),
  merchantBranding: () =>
    Promise.resolve({ organizationName: 'Shop', nip05: undefined, logoUrl: undefined, bannerUrl: undefined, storeDescription: undefined }),
}))
vi.mock('../../lib/merchant', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/merchant')>()),
  merchantStatus: () => Promise.resolve('customer'),
  isMerchantPubkey: () => Promise.resolve(false),
}))
vi.mock('../../lib/giftLink', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/giftLink')>()),
  // The fixture tokens carry no gift terms; what may go in a link is not under test here.
  giftExclusion: () => null,
}))
vi.mock('../../lib/giftLinks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/giftLinks')>()),
  settleAndCountLinks: () => Promise.resolve({ waiting: 0, expiredUnreturned: 0 }),
  warmCashlinkPath: () => undefined,
  cashlinkDirectOpen: () => h.direct,
}))
vi.mock('../../lib/wallet', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/wallet')>()),
  listVouchers: () => Promise.resolve(h.rows),
}))

import { SendLinkPage } from '../SendLinkPage'

afterEach(() => {
  cleanup()
  h.rows = []
  h.direct = false
})

async function confirmFor(amount: string) {
  render(
    <MemoryRouter initialEntries={[`/send/link?from=${STALL}`]}>
      <Routes>
        <Route path="/send/link" element={<SendLinkPage pubkey={ME} />} />
      </Routes>
    </MemoryRouter>,
  )
  await waitFor(() => expect(screen.getByText('How much?')).toBeTruthy())
  fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: amount } })
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  await waitFor(() => expect(screen.getByText('Confirm send')).toBeTruthy())
}

describe('Cashlink confirm: what really leaves', () => {
  it('NGN 1.00 at 85 kobo a sat: leads with NGN 1.70 and says what was asked, and why', async () => {
    // Arrange: 850.00 NGN on 1000 sats.
    h.rows = [couponRow('NGN', 85_000, [512, 256, 128, 64, 32, 8])]

    // Act
    await confirmFor('1.00')

    // Assert
    expect(screen.getAllByText(/1\.70/).length).toBeGreaterThan(0)
    expect(screen.getByText(/You asked to send .*1\.00/)).toBeTruthy()
    expect(screen.getByText(/cannot make exactly .*1\.00.*nearest they can send is .*1\.70.*0\.70 more leaves your balance/)).toBeTruthy()
    expect(screen.getByText(/Anyone with the link can claim .*1\.70/)).toBeTruthy()
  })

  it('takes the same figure when the locked path is open', async () => {
    // Arrange
    h.rows = [couponRow('NGN', 85_000, [512, 256, 128, 64, 32, 8])]
    h.direct = true

    // Act
    await confirmFor('1.00')

    // Assert
    expect(screen.getByText(/You asked to send .*1\.00/)).toBeTruthy()
    expect(screen.getByText(/Anyone with the link can claim .*1\.70/)).toBeTruthy()
  })

  it('EUR, sent exactly: the request alone, no note', async () => {
    // Arrange
    h.rows = [couponRow('EUR', 1000, [8192, 4096, 1016])]

    // Act
    await confirmFor('3.37')

    // Assert
    expect(screen.getByText(/Anyone with the link can claim .*3\.37/)).toBeTruthy()
    expect(screen.queryByText(/You asked to send/)).toBeNull()
    expect(screen.queryByText(/cannot make exactly/)).toBeNull()
  })
})
