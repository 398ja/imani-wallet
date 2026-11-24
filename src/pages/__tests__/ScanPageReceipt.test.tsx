/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'

/**
 * A payment receipt (spec 049, `imrc1:`) scanned on the main Scan screen goes to the receipt
 * check, carried in router state and never in the URL: the payload holds the payer's signature
 * and the key to the evidence, and URLs end up in history and logs.
 */

vi.mock('../../lib/scannerSupport', () => ({ scannerBlocked: async () => 'no camera in tests' }))
vi.mock('imani-qr', async () => import('../../../packages/imani-qr/src/handlers'))
vi.mock('../../lib/native', () => ({ readClipboard: async () => null }))
const resolved: string[] = []
vi.mock('../../lib/issue', () => ({
  toRecipientPubkey: async (t: string) => (resolved.push(t), null),
}))
// Only the cheap prefix check is needed; the real one, so a change of prefix is caught here.
vi.mock('../../lib/receipts', async () => {
  const { isReceiptQr } = await import('../../lib/receipts/verify')
  return { isReceiptQr }
})

const { ScanPage } = await import('../ScanPage')

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
    <MemoryRouter initialEntries={['/scan']}>
      <Routes>
        <Route path="/scan" element={<ScanPage />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  )
  fireEvent.change(await screen.findByLabelText('Code'), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
}

afterEach(() => {
  cleanup()
  resolved.length = 0
})

describe('a receipt on the Scan screen', () => {
  it('opens the receipt check with the payload in router state, not the URL', async () => {
    const qr = 'imrc1:AAECAwQFBgcICQ'
    await scan(`  ${qr} `)
    expect((await screen.findByTestId('where')).textContent).toBe(`/receipt/check|${qr}`)
    expect(resolved).toEqual([])
  })

  it('anything else is not mistaken for a receipt', async () => {
    await scan('imrc2:whatever')
    expect(await screen.findByText(/not a payment request, a receipt, a voucher, or an account/)).toBeTruthy()
  })
})
