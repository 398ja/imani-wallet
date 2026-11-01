/**
 * @vitest-environment jsdom
 *
 * #402 traceability: an online shop says which of its orders spent a voucher, and the stall's books
 * keep it on the incoming payment, across a relay round trip, and link the payment to the sale.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { TransactionRow } from '@imani/wallet-storage'

import { parseSpendSource, spendSourceLabel } from '../spendSource'
import { toTransaction } from '../transactions'
import { toContent, toRow } from '../txRecords'
import { TransactionListItem } from '../../components/ui/records'

afterEach(cleanup)

const WIRE = {
  kind: 'online_shop',
  shop_url: 'https://shop.example',
  platform: 'woocommerce',
  order_ref: 'wc-order-55',
  order_number: '55',
  code_ref: 'd322d4d32d3a',
  amount_applied: 1000,
}

const received = {
  id: 'received:9a79fa249ca599ced49ee39957503fd5',
  txId: 'received:9a79fa249ca599ced49ee39957503fd5',
  type: 'received',
  direction: 'in',
  timestamp: 1786891362412,
  amount: 1000,
  unit: 'EUR',
  decimals: 2,
  merchantId: 'bb'.repeat(32),
  voucherId: '78a2f286-eb13-4750-81b4-c8053cc10118',
  tokenId: '9a79fa249ca599ced49ee39957503fd5',
  memo: 'Received via DM',
  spendSource: WIRE,
} as unknown as TransactionRow

describe('spend source', () => {
  it('reads the envelope and labels the order', () => {
    const s = parseSpendSource(WIRE)!
    expect(s).toMatchObject({ shopHost: 'shop.example', orderNumber: '55', codeRef: 'd322d4d32d3a', amountApplied: 1000 })
    expect(spendSourceLabel(s)).toBe('Order 55 at shop.example')
    expect(spendSourceLabel({ ...s, orderNumber: undefined })).toBe('Online at shop.example')
  })

  it('drops anything malformed rather than half-keeping it', () => {
    expect(parseSpendSource({ ...WIRE, kind: 'till' })).toBeUndefined()
    expect(parseSpendSource({ ...WIRE, shop_url: 'javascript:alert(1)' })).toBeUndefined()
    expect(parseSpendSource({ ...WIRE, shop_url: undefined })).toBeUndefined()
    expect(parseSpendSource({ ...WIRE, amount_applied: -1 })?.amountApplied).toBeUndefined()
    expect(parseSpendSource('nope')).toBeUndefined()
  })

  it('rides the incoming row and survives the relay round trip', () => {
    const tx = toTransaction(received)
    expect(tx.spendSource?.orderNumber).toBe('55')
    const back = toTransaction(toRow(tx.id, toContent(tx)))
    expect(back.spendSource).toEqual(tx.spendSource)
  })

  it('shows the order on the history row, with an Online badge', () => {
    render(
      <MemoryRouter>
        <TransactionListItem tx={toTransaction(received)} />
      </MemoryRouter>,
    )
    expect(screen.getByText(/Order 55 at shop\.example/)).toBeTruthy()
    expect(screen.getByText('Online')).toBeTruthy()
    expect(screen.queryByText(/Received via DM/)).toBeNull()
  })
})
