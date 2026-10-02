/**
 * @vitest-environment jsdom
 */
/**
 * #155: a cashback voucher's detail must not ask Sell questions of it.
 *
 * "Paid: At the counter" and "Customer receipt: Not collected" are about a
 * sale. A cashback was given away, so those lines read as a wrong rail and a
 * missing receipt. The claim state comes from the stored portal status instead.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'

import { VoucherRecordDetail } from '../MerchantRecordPages'
import { issuedVoucher } from '../../lib/issuedVoucher'
import { warrantSaleDigest } from '../../lib/issuanceWarrant'
import { formatDate } from '../../lib/format'
import type { WalletTransaction } from '../../lib/transactions'

const STALL_SK = '9'.repeat(63) + '1'
const STALL = bytesToHex(schnorr.getPublicKey(hexToBytes(STALL_SK)))
const NOW = 1_800_000_000_000
const DAY = 86_400_000

function warrantFor(total: number): string {
  return JSON.stringify({
    form: 'merchant',
    sale_total: total,
    face_decimals: 0,
    unit: 'XAF',
    nonce: 'n1',
    sig: bytesToHex(schnorr.sign(warrantSaleDigest(STALL, total, 0, 'XAF', 'n1'), hexToBytes(STALL_SK))),
  })
}

function row(over: Partial<WalletTransaction>): WalletTransaction {
  return {
    id: 'issued:v1',
    type: 'issued',
    direction: 'out',
    at: NOW - DAY,
    amount: 500,
    unit: 'XAF',
    decimals: 0,
    voucherId: 'v1',
    memo: 'Voucher v1',
    issuanceWarrant: warrantFor(500),
    ...over,
  }
}

function renderDetail(tx: WalletTransaction) {
  const voucher = issuedVoucher([tx], 'v1', { now: NOW, stallPubkey: STALL })
  if (!voucher) throw new Error('no voucher')
  render(
    <MemoryRouter>
      <VoucherRecordDetail voucher={voucher} />
    </MemoryRouter>,
  )
}

const cashback = (over: Partial<WalletTransaction> = {}) =>
  row({ type: 'cashback', id: 'cashback:c1', cashbackId: 'c1', claimCode: 'CB-AAAAA-BBBBB', ...over })

afterEach(cleanup)

describe('cashback voucher detail (#155)', () => {
  it('shows a claimed cashback as claimed, with its date, and no Sell lines', () => {
    const claimedAt = NOW - DAY / 2
    renderDetail(cashback({ cashbackStatus: 'Claimed', claimedAt }))

    expect(screen.queryByText('Not collected')).toBeNull()
    expect(screen.queryByText('At the counter')).toBeNull()
    expect(screen.getByText(`Claimed on ${formatDate(claimedAt)}`)).toBeTruthy()
    expect(screen.getByText('Cashback from this stall')).toBeTruthy()
    expect(screen.getByText('Signed by this stall')).toBeTruthy()
    expect(screen.queryByText('Paid')).toBeNull()
    expect(screen.queryByText('Customer receipt')).toBeNull()
    expect(screen.getByText('The cashback this came from')).toBeTruthy()
    expect(screen.queryByText('The sale this came from')).toBeNull()
  })

  it('shows an unclaimed cashback as not claimed yet, never as claimed', () => {
    renderDetail(cashback())

    expect(screen.queryByText('Not collected')).toBeNull()
    expect(screen.queryByText('At the counter')).toBeNull()
    expect(screen.queryByText(/^Claimed on/)).toBeNull()
    expect(screen.getAllByText('Not claimed yet').length).toBeGreaterThan(0)
    expect(screen.getByText('Signed by this stall')).toBeTruthy()
  })

  it('does not call an expired cashback unclaimed when the portal never said so', () => {
    // The list stops asking once a code is past expiry, so a claim made just
    // before then may never have been stored here.
    renderDetail(cashback({ expiresAt: NOW - 1 }))

    expect(screen.getByText('No claim on record')).toBeTruthy()
    expect(screen.queryByText('Expired unclaimed')).toBeNull()
    expect(screen.queryByText(/^Claimed on/)).toBeNull()
  })

  it('still shows all three evidence lines on a Sell voucher', () => {
    renderDetail(row({}))

    expect(screen.getByText('Paid')).toBeTruthy()
    expect(screen.getByText('Authorised')).toBeTruthy()
    expect(screen.getByText('Customer receipt')).toBeTruthy()
    expect(screen.getByText('Not collected')).toBeTruthy()
    expect(screen.getByText('Signed by this stall')).toBeTruthy()
    expect(screen.queryByText('Cashback from this stall')).toBeNull()
    expect(screen.getByText('The sale this came from')).toBeTruthy()
  })
})
