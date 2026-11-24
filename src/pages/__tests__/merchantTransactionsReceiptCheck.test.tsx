/**
 * @vitest-environment jsdom
 *
 * Spec 049: the stall owner checks a customer's receipt from the Transactions list, where they
 * already go to answer "did this person pay me?", on a scanner of its own (receipts only). The
 * route is the owner's alone (App.tsx guards it on `actor === null`), so the button needs no
 * terminal permission check of its own. Home carries no button: it stays minimal.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

vi.mock('../../lib/wallet', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/wallet')>()),
  listTransactions: () => Promise.resolve([]),
  onWalletChanged: () => () => {},
}))

import { MerchantTransactionsPage } from '../MerchantRecordPages'

afterEach(cleanup)

function show() {
  return render(
    <MemoryRouter initialEntries={['/merchant/transactions']}>
      <Routes>
        <Route path="/merchant/transactions" element={<MerchantTransactionsPage />} />
        <Route path="/receipts/scan" element={<p>receipt-scan-screen</p>} />
        <Route path="/scan" element={<p>general-scan-screen</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('Check a receipt on Transactions (spec 049)', () => {
  it('is offered above the list and opens the receipt scanner, not the general Scan', async () => {
    show()
    const button = screen.getByRole('button', { name: /Check a receipt/ })
    // Above the list, so a long history does not push it out of reach.
    const list = (await screen.findByText(/Nothing yet/)).closest('div')!
    expect(button.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.click(button)
    expect(await screen.findByText('receipt-scan-screen')).toBeTruthy()
  })

  it('is enabled: checking a receipt moves nothing', () => {
    show()
    expect((screen.getByRole('button', { name: /Check a receipt/ }) as HTMLButtonElement).disabled).toBe(false)
  })
})
