/**
 * @vitest-environment jsdom
 *
 * The "Public ledger" row on the merchant's voucher record (imani-gateway-customer#310 step 4).
 * The one thing that must never happen: a gateway that did not answer reading as "no record".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

const STALL = 'a'.repeat(64)
const rows: Record<string, unknown>[] = []
const read = vi.fn()
let enabled = true

vi.mock('../../lib/wallet', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/wallet')>()),
  listTransactions: () => Promise.resolve(rows),
  onWalletChanged: () => () => {},
}))
vi.mock('../../lib/identity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/identity')>()),
  useIdentity: () => undefined,
}))
vi.mock('../../lib/voucherLedgerV2Status', () => ({
  readVoucherLedgerStatus: (...args: unknown[]) => read(...args),
}))
vi.mock('../../lib/attestation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/attestation')>()),
  voucherLedgerV2Enabled: () => enabled,
}))

import { GatewayUnreachableError } from '../../lib/relay'
import { IssuedCouponPage } from '../MerchantRecordPages'

beforeEach(() => {
  enabled = true
  read.mockReset()
  rows.length = 0
  rows.push({
    id: 'issued:v1',
    type: 'issued',
    direction: 'out',
    amount: 1000,
    unit: 'XAF',
    decimals: 0,
    timestamp: Date.now() - 86_400_000,
    memo: 'Voucher v1',
    voucherId: 'v1',
    expiresAt: Date.now() + 30 * 86_400_000,
  })
})
afterEach(cleanup)

function show() {
  return render(
    <MemoryRouter initialEntries={['/merchant/coupon/v1']}>
      <Routes>
        <Route path="/merchant/coupon/:voucherId" element={<IssuedCouponPage pubkey={STALL} />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('the Public ledger row', () => {
  it('asks the ledger at the stall key and this voucher id, and shows issued', async () => {
    read.mockResolvedValue({ status: 'ISSUED' })
    show()
    await waitFor(() => expect(screen.getByText('Recorded as issued')).toBeTruthy())
    expect(screen.getByText('Public ledger')).toBeTruthy()
    expect(read).toHaveBeenCalledWith(STALL, 'v1')
  })

  it('shows redeemed', async () => {
    read.mockResolvedValue({ status: 'REDEEMED' })
    show()
    await waitFor(() => expect(screen.getByText('Recorded as redeemed')).toBeTruthy())
  })

  it('reads null as no public record yet', async () => {
    read.mockResolvedValue(null)
    show()
    await waitFor(() => expect(screen.getByText('No public record yet')).toBeTruthy())
  })

  it('reads an unreachable gateway as could not check, never as no record', async () => {
    read.mockRejectedValue(new GatewayUnreachableError('down'))
    show()
    await waitFor(() => expect(screen.getByText('Could not check right now')).toBeTruthy())
    expect(screen.queryByText(/No public record/)).toBeNull()
  })

  it('says checking while the answer is on its way', async () => {
    read.mockReturnValue(new Promise(() => {}))
    show()
    await waitFor(() => expect(screen.getByText('Checking…')).toBeTruthy())
  })

  it('renders nothing and asks nothing when the ledger is off', async () => {
    enabled = false
    show()
    await waitFor(() => expect(screen.getByText('Voucher v1')).toBeTruthy())
    expect(screen.queryByText('Public ledger')).toBeNull()
    expect(read).not.toHaveBeenCalled()
  })
})
