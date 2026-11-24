/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'

/**
 * The main Scan screen, handed a terminal setup code (#160, owner report on wallet 0.19.0).
 *
 * The owner's operator scanned the setup QR with the logged-in wallet's own Scan screen, which
 * routes payment requests, passes and accounts only, and answered "That is not a payment request,
 * a voucher, or an account we can find." It now recognises the code and routes it to
 * `/terminal/setup`, where a device that already holds a personal wallet is told plainly why it
 * cannot become a terminal.
 */

vi.mock('../../lib/scannerSupport', () => ({ scannerBlocked: async () => 'no camera in tests' }))
// The barrel pulls in nut16, which needs browser APIs jsdom lacks; the real handlers, from
// source, as voucherRedeemScan.test.ts imports them.
vi.mock('imani-qr', async () => import('../../../packages/imani-qr/src/handlers'))
vi.mock('../../lib/native', () => ({ readClipboard: async () => null }))
const resolved: string[] = []
vi.mock('../../lib/issue', () => ({
  toRecipientPubkey: async (t: string) => (resolved.push(t), null),
}))

const { ScanPage } = await import('../ScanPage')

const STALL = 'ab'.repeat(32)
const CODE = `imani-terminal:1:${STALL}:5f8a487d-6cea-4a7d-b681-9d5d62cc9dd9`

function Where() {
  const l = useLocation()
  return <p data-testid="where">{l.pathname + l.search}</p>
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
  const field = await screen.findByLabelText('Code')
  fireEvent.change(field, { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
}

afterEach(() => {
  cleanup()
  resolved.length = 0
})

describe('a terminal setup code on the Scan screen', () => {
  it('goes to the terminal setup screen, not "not an account we can find"', async () => {
    await scan(CODE)
    const where = await screen.findByTestId('where')
    expect(where.textContent).toBe(`/terminal/setup?code=${encodeURIComponent(CODE)}`)
    expect(resolved).toEqual([])
  })

  it('is recognised in upper case too, as an alphanumeric QR may carry it', async () => {
    await scan(CODE.toUpperCase())
    expect((await screen.findByTestId('where')).textContent).toMatch(/^\/terminal\/setup\?code=/)
  })

  it('garbage still gets the ordinary refusal', async () => {
    await scan('imani-terminal:1:nothex:x')
    expect(await screen.findByText(/not a payment request, a receipt, a voucher, or an account/)).toBeTruthy()
  })
})
