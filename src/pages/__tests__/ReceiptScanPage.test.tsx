/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'

/**
 * The receipt scanner (spec 049): the owner's, from Transactions, and a till's (receipt:read).
 * Receipts only: a voucher or anything else is refused in place, and a receipt goes to the check
 * with its payload in router state, never the URL, because the payload carries the key to the
 * evidence.
 */

vi.mock('../../lib/scannerSupport', () => ({ scannerBlocked: async () => 'no camera in tests' }))
let clipboard: string | null = null
vi.mock('../../lib/native', () => ({ readClipboard: async () => clipboard }))
const resolved: string[] = []
vi.mock('../../lib/issue', () => ({
  toRecipientPubkey: async (t: string) => (resolved.push(t), null),
}))

const { ReceiptScanPage } = await import('../ReceiptScanPage')

function Where() {
  const l = useLocation()
  return (
    <p data-testid="where">
      {l.pathname + l.search}|{(l.state as { qr?: string } | null)?.qr ?? ''}|{(l.state as { via?: string } | null)?.via ?? ''}
    </p>
  )
}

async function scan(text: string) {
  render(
    <MemoryRouter initialEntries={['/receipts/scan']}>
      <Routes>
        <Route path="/receipts/scan" element={<ReceiptScanPage />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  )
  fireEvent.change(await screen.findByLabelText('Or paste the receipt they sent you'), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
}

afterEach(() => {
  cleanup()
  resolved.length = 0
  clipboard = null
})

function mount() {
  render(
    <MemoryRouter initialEntries={['/receipts/scan']}>
      <Routes>
        <Route path="/receipts/scan" element={<ReceiptScanPage />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('a receipt the customer sent as text', () => {
  const CODE = 'imrc1:AAECAwQFBgcICQ#a2V5'

  it('Paste checks the code inside the message straight away, marked as sent as text', async () => {
    // Arrange
    clipboard = `My Imani payment receipt. To check it, open Check a receipt and paste this code:\n\n${CODE}`
    mount()

    // Act
    fireEvent.click(await screen.findByRole('button', { name: /Paste/ }))

    // Assert
    expect((await screen.findByTestId('where')).textContent).toBe(`/receipt/check|${CODE}|text`)
    expect(resolved).toEqual([])
  })

  it('typing the whole message into the field works too', async () => {
    // Arrange
    mount()

    // Act
    fireEvent.change(await screen.findByLabelText('Or paste the receipt they sent you'), {
      target: { value: `here: ${CODE} thanks` },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    // Assert
    expect((await screen.findByTestId('where')).textContent).toBe(`/receipt/check|${CODE}|text`)
  })

  it('a bare code followed by a remark is checked without the remark', async () => {
    // Arrange
    mount()

    // Act
    fireEvent.change(await screen.findByLabelText('Or paste the receipt they sent you'), {
      target: { value: `${CODE} thanks!` },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    // Assert
    expect((await screen.findByTestId('where')).textContent).toBe(`/receipt/check|${CODE}|text`)
  })

  it('a pasted message with no receipt in it is refused in place', async () => {
    // Arrange
    clipboard = 'see you tomorrow'
    mount()

    // Act
    fireEvent.click(await screen.findByRole('button', { name: /Paste/ }))

    // Assert
    expect(await screen.findByText(/That is not a receipt/)).toBeTruthy()
    expect(screen.queryByTestId('where')).toBeNull()
    expect(resolved).toEqual([])
  })
})

describe('the till receipt scanner', () => {
  it('opens the check with the payload in router state, not the URL', async () => {
    const qr = 'imrc1:AAECAwQFBgcICQ'
    await scan(`  ${qr} `)
    expect((await screen.findByTestId('where')).textContent).toBe(`/receipt/check|${qr}|text`)
  })

  it('refuses anything that is not a receipt, in place, and resolves nothing', async () => {
    await scan('cashuBo2FteBVodHRwczovL21pbnQ')
    expect(await screen.findByText(/That is not a receipt/)).toBeTruthy()
    expect(screen.queryByTestId('where')).toBeNull()
    expect(resolved).toEqual([])
  })

  it('tells the check where to come back to: this scanner', async () => {
    render(
      <MemoryRouter initialEntries={['/receipts/scan']}>
        <Routes>
          <Route path="/receipts/scan" element={<ReceiptScanPage />} />
          <Route path="*" element={<From />} />
        </Routes>
      </MemoryRouter>,
    )
    fireEvent.change(await screen.findByLabelText('Or paste the receipt they sent you'), { target: { value: 'imrc1:x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect((await screen.findByTestId('from')).textContent).toBe('/receipts/scan')
  })
})

function From() {
  return <p data-testid="from">{(useLocation().state as { from?: string } | null)?.from}</p>
}

describe('the owner’s receipt scanner, from Transactions', () => {
  it('goes back to Transactions', async () => {
    render(
      <MemoryRouter initialEntries={['/receipts/scan']}>
        <Routes>
          <Route path="/receipts/scan" element={<ReceiptScanPage back={{ to: '/merchant/transactions', label: 'Transactions' }} />} />
        </Routes>
      </MemoryRouter>,
    )
    const back = await screen.findByRole('link', { name: /Transactions/ })
    expect(back.getAttribute('href')).toBe('/merchant/transactions')
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Check a receipt')
  })
})
