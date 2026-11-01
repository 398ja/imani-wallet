/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

/**
 * #402: every checkout code is one row in history, carrying its status, opening the code screen,
 * and never counted twice against the coupons it was made of.
 */

const rows = new Map<string, Record<string, unknown>>()
const published: string[] = []
vi.mock('../wallet', async (orig) => ({
  ...(await orig<object>()),
  getWallet: () => ({
    getTransaction: async (id: string) => rows.get(id) ?? null,
    getAllTransactions: async () => [...rows.values()],
    addTransaction: async (row: Record<string, unknown>) => {
      rows.set(String(row.id), row)
      published.push(String(row.id))
      return row
    },
  }),
  notifyWalletChanged: () => {},
}))
vi.mock('../identity', async (orig) => ({
  ...(await orig<object>()),
  useMerchantLabel: ({ pubkey }: { pubkey: string }) => (pubkey === STALL ? 'Mama Ngozi' : 'Someone'),
}))

const STALL = 'ab'.repeat(32)
const { saveCheckoutCode } = await import('../checkoutCodeRecords')
const { appCheckoutPorts, writeCodeRow } = await import('../checkoutCodePorts')
const { toTransaction } = await import('../transactions')
const { toContent, toRow } = await import('../txRecords')
const { groupHistory } = await import('../historyGroups')
const { HistoryListItem } = await import('../../components/ui/records')
type Rec = import('../checkoutCodeRecords').CheckoutCodeRecord

const ME = 'cd'.repeat(32)
const record = (over: Partial<Rec> = {}): Rec => ({
  id: 'code1',
  stall: STALL,
  shopKey: 'ee'.repeat(32),
  shopUrl: 'https://shop.example.com/cart',
  platform: 'woocommerce',
  unit: 'EUR',
  decimals: 2,
  amount: 1500,
  x: 2_000_000_000,
  createdAt: Date.UTC(2026, 9, 31, 12),
  status: 'locking',
  parts: [{ i: 0, amount: 1500, sourceTokenId: 't1', state: 'new' }],
  ...over,
})

const settle = async () => {
  for (let n = 0; n < 5; n++) await new Promise((r) => setTimeout(r, 0))
}
const history = () => [...rows.values()].map((r) => toTransaction(r as never))
function draw() {
  const [entry] = groupHistory(history())
  return render(
    <MemoryRouter>
      <HistoryListItem entry={entry!} />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  rows.clear()
  published.length = 0
  localStorage.clear()
})
afterEach(cleanup)

describe('checkout codes in history', () => {
  it('a code appears in history as soon as it is started', async () => {
    saveCheckoutCode(ME, record())
    await settle()
    const [tx] = history()
    expect(tx).toMatchObject({ id: 'checkout:code1', type: 'checkout_code', direction: 'out', amount: 1500, merchantId: STALL })
    draw()
    expect(screen.getByText('Mama Ngozi')).toBeTruthy()
    expect(screen.getByTestId('checkout-status').textContent).toBe('Being made')
    expect(screen.getByText(/shop\.example\.com/)).toBeTruthy()
    expect(document.body.textContent).not.toContain(STALL)
  })

  it('status changes flow to the same row', async () => {
    for (const [status, words] of [
      ['reserved', 'Ready to use'],
      ['held', 'In a checkout'],
      ['cancelling', 'Cancelling'],
      ['cancelled', 'Cancelled'],
      ['expired', 'Expired'],
      ['abandoned', 'Not made'],
      ['redeemed', 'Used'],
    ] as const) {
      saveCheckoutCode(ME, record({ status }))
      await settle()
      expect(rows.size).toBe(1)
      draw()
      expect(screen.getByTestId('checkout-status').textContent).toBe(words)
      cleanup()
    }
  })

  it('opens the code screen', async () => {
    saveCheckoutCode(ME, record({ status: 'reserved' }))
    await settle()
    draw()
    expect(screen.getByRole('link').getAttribute('href')).toBe('/online/code/code1')
  })

  it('the outcome activity is the memo of the one row, never a second row', async () => {
    saveCheckoutCode(ME, record({ status: 'redeemed', spent: 1200, done: true }))
    await settle()
    await appCheckoutPorts().activity({ id: 'checkout:code1:redeemed', at: 1, stall: STALL, unit: 'EUR', decimals: 2, amount: 1200, memo: 'used' })
    expect([...rows.keys()]).toEqual(['checkout:code1'])
    expect(history()[0]).toMatchObject({ amount: 1200, memo: 'used' })
    // A later save keeps the memo.
    await writeCodeRow(ME, record({ status: 'redeemed', spent: 1200, done: true }))
    expect(history()[0]?.memo).toBe('used')
  })

  it('returned value is shown without a minus: the coupons it came back as carry it', async () => {
    saveCheckoutCode(ME, record({ status: 'cancelled', done: true }))
    await settle()
    draw()
    expect(screen.getByText('€15.00').textContent).not.toContain('−')
    cleanup()
    saveCheckoutCode(ME, record({ status: 'reserved' }))
    await settle()
    draw()
    expect(screen.getByText(/15\.00/).textContent).toContain('−')
  })

  it('survives the relay round trip with its status', async () => {
    saveCheckoutCode(ME, record({ status: 'held' }))
    await settle()
    const tx = history()[0]!
    const back = toTransaction(toRow(tx.id, JSON.parse(JSON.stringify(toContent(tx)))))
    expect(back.checkoutCode).toEqual({ id: 'code1', status: 'held', shopHost: 'shop.example.com' })
    expect(back).toMatchObject({ type: 'checkout_code', direction: 'out', amount: 1500 })
  })
})

describe('the change a shop gives back (2026-11-01: it was missing from history)', () => {
  it('is its own incoming row, labelled Change, keyed on the code so a second notice overwrites it', async () => {
    const row = { id: 'checkout:code1:change', at: Date.UTC(2026, 10, 1, 21), stall: STALL, unit: 'EUR', decimals: 2, amount: 90, memo: 'Change from shop.example.com: €0.90 back in your wallet' }
    await appCheckoutPorts().changeActivity!(row)
    await appCheckoutPorts().changeActivity!(row)
    expect([...rows.keys()]).toEqual(['checkout:code1:change'])
    const tx = history()[0]!
    expect(tx).toMatchObject({ type: 'checkout_change', direction: 'in', amount: 90, merchantId: STALL })
    const { transactionLabel } = await import('../transactions')
    expect(transactionLabel(tx)).toBe('Change')
    // Survives the relay round trip.
    const back = toTransaction(toRow(tx.id, JSON.parse(JSON.stringify(toContent(tx)))))
    expect(back).toMatchObject({ type: 'checkout_change', direction: 'in', amount: 90 })
  })
})
