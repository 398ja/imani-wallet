/**
 * @vitest-environment jsdom
 *
 * The full "Expiring soon" list, and paging on the merchant's record screens.
 *
 * The dashboard shows three; this is where the rest live. Two things are worth
 * asserting beyond "it renders": that this page and the dashboard count the
 * SAME set — a second definition of "expiring soon" that drifts would have the
 * link disagreeing with its destination — and that a long list is capped at a
 * page rather than poured onto the screen.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const DAY = 86_400_000

function issued({ id, inDays }: { id: string; inDays: number }) {
  return {
    id: `issued:${id}`,
    type: 'issued',
    direction: 'out',
    amount: 1000,
    unit: 'EUR',
    decimals: 2,
    at: Date.now() - DAY,
    memo: `Voucher ${id}`,
    voucher_id: id,
    // Camel case: the only spelling `toTransaction` reads for this field.
    expiresAt: Date.now() + inDays * DAY,
  }
}

const rows: ReturnType<typeof issued>[] = []

vi.mock('../../lib/wallet', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/wallet')>()),
  listTransactions: () => Promise.resolve(rows),
  onWalletChanged: () => () => {},
}))

import { ExpiringVouchersPage } from '../MerchantRecordPages'

afterEach(cleanup)

function show(transactions: ReturnType<typeof issued>[]) {
  rows.length = 0
  rows.push(...transactions)
  return render(
    <MemoryRouter>
      <ExpiringVouchersPage />
    </MemoryRouter>,
  )
}

const soon = (n: number, from = 1) =>
  Array.from({ length: n }, (_, i) => issued({ id: `v${from + i}`, inDays: 1 + ((from + i) % 6) }))

describe('the expiring vouchers page', () => {
  it('lists what is running out, and says how many', async () => {
    show([issued({ id: 'v1', inDays: 1 }), issued({ id: 'v2', inDays: 3 })])

    await waitFor(() => expect(screen.getByText('2 vouchers within 7 days')).toBeTruthy())
    expect(screen.getByText('Voucher v1')).toBeTruthy()
    expect(screen.getByText('Voucher v2')).toBeTruthy()
  })

  it('leaves out vouchers that are not near expiry, matching the dashboard', async () => {
    // Same rule, same function. A page that showed everything would make the
    // dashboard's "See all (2)" lead to a list of forty.
    show([issued({ id: 'soon', inDays: 2 }), issued({ id: 'far', inDays: 90 })])

    await waitFor(() => expect(screen.getByText('1 voucher within 7 days')).toBeTruthy())
    expect(screen.queryByText('Voucher far')).toBeNull()
  })

  it('leaves out vouchers that have already expired', async () => {
    // Nothing can be done about them, and mixing them in buries the ones a
    // merchant could still ring a customer about.
    show([issued({ id: 'gone', inDays: -3 }), issued({ id: 'soon', inDays: 2 })])

    await waitFor(() => expect(screen.getByText('1 voucher within 7 days')).toBeTruthy())
    expect(screen.queryByText('Voucher gone')).toBeNull()
  })

  it('answers plainly when there is nothing expiring', async () => {
    // Reachable by typing the URL, or by keeping the tab open until the last
    // one lapses.
    show([issued({ id: 'far', inDays: 90 })])

    await waitFor(() =>
      expect(screen.getByText('Nothing expiring in the next 7 days.')).toBeTruthy(),
    )
  })

  it('goes back to the dashboard, which is the only way in', async () => {
    // The back link names the screen you came FROM. This page exists only as
    // the dashboard's "See all", so sending it to the till (where the sibling
    // lists go) would strand a merchant mid-read.
    show([issued({ id: 'v1', inDays: 1 })])

    await waitFor(() => expect(screen.getByText('Voucher v1')).toBeTruthy())
    const back = screen.getByRole('link', { name: /Dashboard/ })
    expect(back.getAttribute('href')).toBe('/merchant/dashboard')
  })

  it('shows at most 21 at a time, and pages to the rest', async () => {
    show(soon(30))

    await waitFor(() => expect(screen.getByText('30 vouchers within 7 days')).toBeTruthy())

    // 21 rows on the page, not 30.
    expect(screen.getAllByText(/^Voucher v/)).toHaveLength(21)
    expect(screen.getByText('Page 1 of 2')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Next/ }))

    expect(screen.getAllByText(/^Voucher v/)).toHaveLength(9)
    expect(screen.getByText('Page 2 of 2')).toBeTruthy()
  })
})
