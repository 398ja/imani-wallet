/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'

/**
 * A till's receipt scanner (spec 049, receipt:read). Receipts only: a voucher or anything else is
 * refused in place, and a receipt goes to the check with its payload in router state, never the
 * URL, because the payload carries the key to the evidence.
 */

vi.mock('../../lib/scannerSupport', () => ({ scannerBlocked: async () => 'no camera in tests' }))
vi.mock('../../lib/native', () => ({ readClipboard: async () => null }))
const resolved: string[] = []
vi.mock('../../lib/issue', () => ({
  toRecipientPubkey: async (t: string) => (resolved.push(t), null),
}))

const { TerminalReceiptScanPage } = await import('../TerminalReceiptScanPage')

function Where() {
  const l = useLocation()
  return (
    <p data-testid="where">
      {l.pathname + l.search}|{(l.state as { qr?: string } | null)?.qr ?? ''}
    </p>
  )
}

async function scan(text: string) {
  render(
    <MemoryRouter initialEntries={['/receipts/scan']}>
      <Routes>
        <Route path="/receipts/scan" element={<TerminalReceiptScanPage />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  )
  fireEvent.change(await screen.findByLabelText('Or paste the receipt code'), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
}

afterEach(() => {
  cleanup()
  resolved.length = 0
})

describe('the till receipt scanner', () => {
  it('opens the check with the payload in router state, not the URL', async () => {
    const qr = 'imrc1:AAECAwQFBgcICQ'
    await scan(`  ${qr} `)
    expect((await screen.findByTestId('where')).textContent).toBe(`/receipt/check|${qr}`)
  })

  it('refuses anything that is not a receipt, in place, and resolves nothing', async () => {
    await scan('cashuBo2FteBVodHRwczovL21pbnQ')
    expect(await screen.findByText(/That is not a receipt/)).toBeTruthy()
    expect(screen.queryByTestId('where')).toBeNull()
    expect(resolved).toEqual([])
  })
})
