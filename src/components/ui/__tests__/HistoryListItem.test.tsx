/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import { HistoryListItem } from '../records'
import { groupHistory } from '../../../lib/historyGroups'
import type { WalletTransaction } from '../../../lib/transactions'

/**
 * One payment of several vouchers is one line in history (#106), opening to the
 * rows it was made of, each still linking to its own detail screen.
 */

afterEach(cleanup)

const tx = (id: string, amount: number, over: Partial<WalletTransaction> = {}): WalletTransaction => ({
  id,
  type: 'received',
  direction: 'in',
  at: Date.UTC(2026, 8, 20, 12),
  amount,
  unit: 'EUR',
  decimals: 2,
  bundleId: 'b1',
  ...over,
})

function draw(rows: WalletTransaction[]) {
  const [entry] = groupHistory(rows)
  return render(
    <MemoryRouter>
      <HistoryListItem entry={entry!} />
    </MemoryRouter>,
  )
}

describe('HistoryListItem', () => {
  it('shows one line with the summed total and the voucher count', () => {
    const { container } = draw([tx('a', 300), tx('b', 300)])
    const summary = container.querySelector('summary')!
    expect(summary.textContent).toMatch(/6\.00/)
    expect(summary.textContent).toMatch(/2 vouchers/)
    // A screen reader hears the whole line as one statement.
    expect(summary.getAttribute('aria-label')).toMatch(/Received, plus .*6\.00, 2 vouchers/)
  })

  it('opens to the rows it was made of, each linking to its own record', () => {
    const { container } = draw([tx('a', 400), tx('b', 200)])
    const details = container.querySelector('details')!
    expect(details.open).toBe(false)

    fireEvent.click(container.querySelector('summary')!)
    expect(details.open).toBe(true)

    const links = screen.getAllByRole('link')
    expect(links.map((l) => l.getAttribute('href'))).toEqual(['/transaction/a', '/transaction/b'])
  })

  it('is a native disclosure, so it is reachable and operable from the keyboard', () => {
    const { container } = draw([tx('a', 300), tx('b', 300)])
    // <summary> is focusable and toggled by Enter/Space by the platform; no
    // tabindex or key handler is needed, and none should be added.
    expect(container.querySelector('details > summary')).not.toBeNull()
  })

  it('renders a single transaction exactly as before', () => {
    render(
      <MemoryRouter>
        <HistoryListItem entry={{ kind: 'single', tx: tx('solo', 600, { bundleId: undefined }) }} />
      </MemoryRouter>,
    )
    expect(screen.getByRole('link').getAttribute('href')).toBe('/transaction/solo')
    expect(document.querySelector('details')).toBeNull()
  })
})
