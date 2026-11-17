/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

/**
 * A Cashlink take-back and the send that made it, one tap from each other on the record page: the
 * return links to the send, and the send lists what came back from it.
 */

const K = 'k'.repeat(43)
const h = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }))

vi.mock('../../lib/wallet', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/wallet')>()),
  getTransactionRow: async (id: string) => h.rows.find((r) => r.id === id) ?? null,
  listTransactions: async () => h.rows,
  onWalletChanged: () => () => {},
  recheckCashbackRowOnOpen: async () => {},
}))

const { TransactionPage } = await import('../RecordDetailPages')

const SENT = { id: 'sent:t0', txId: 'sent:t0', type: 'sent', timestamp: 1_000, amount: 300, unit: 'EUR', decimals: 2, memo: 'Cashlink', link: { k: K, x: 2_000_000_000, status: 'reclaimed', closedAt: 3_000 } }
const BACK = { id: 'returned:t1', txId: 'returned:t1', type: 'received', timestamp: 3_000, amount: 300, unit: 'EUR', decimals: 2, memo: 'Taken back from Cashlink', returnOf: 'sent:t0' }

const open = (id: string) =>
  render(
    <MemoryRouter initialEntries={[`/transaction/${encodeURIComponent(id)}`]}>
      <Routes>
        <Route path="/transaction/:id" element={<TransactionPage />} />
      </Routes>
    </MemoryRouter>,
  )

afterEach(() => cleanup())

describe('a Cashlink take-back and its send', () => {
  it('the take-back links to the send that made the Cashlink', async () => {
    // Arrange
    h.rows = [SENT, BACK]

    // Act
    open(BACK.id)

    // Assert
    const link = await screen.findByRole('link', { name: /See the Cashlink you sent/ })
    expect(link.getAttribute('href')).toBe('/transaction/sent%3At0')
  })

  it('the send lists what came back from it', async () => {
    // Arrange
    h.rows = [SENT, BACK]

    // Act
    open(SENT.id)

    // Assert
    await screen.findByText('Came back')
    const back = screen.getAllByRole('link').find((a) => a.getAttribute('href') === '/transaction/returned%3At1')
    expect(back).toBeDefined()
  })

  it('a send with nothing back, and an ordinary receive, show neither', async () => {
    // Arrange
    h.rows = [SENT, { ...BACK, id: 'received:x', returnOf: undefined }]

    // Act
    open(SENT.id)
    await screen.findAllByText('Transaction')

    // Assert
    expect(screen.queryByText('Came back')).toBeNull()
    expect(screen.queryByText(/See the Cashlink you sent/)).toBeNull()
  })
})
