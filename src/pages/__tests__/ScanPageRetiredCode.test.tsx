/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'

/**
 * Typed cashback codes are retired (wallet#268). A `CB-` code scanned or pasted on the Scan screen
 * is not looked up anywhere: the screen says codes are no longer used and asks for the Cashlink QR.
 */

vi.mock('../../lib/scannerSupport', () => ({ scannerBlocked: async () => 'no camera in tests' }))
vi.mock('imani-qr', async () => import('../../../packages/imani-qr/src/handlers'))
vi.mock('../../lib/native', () => ({ readClipboard: async () => null }))
const resolved: string[] = []
vi.mock('../../lib/issue', () => ({
  toRecipientPubkey: async (t: string) => (resolved.push(t), null),
}))
const fetched: string[] = []
vi.stubGlobal('fetch', async (u: string) => {
  fetched.push(String(u))
  return new Response('{}', { status: 500 })
})

const { ScanPage } = await import('../ScanPage')

function Where() {
  const l = useLocation()
  return <p data-testid="where">{l.pathname}</p>
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
  fetched.length = 0
})

describe('a typed cashback code on the Scan screen', () => {
  it('says codes are no longer used, and looks nothing up', async () => {
    await scan('CB-ABCDE-FGHJK')
    expect(await screen.findByText('Codes are no longer used. Ask the shop to show you the Cashlink QR again.')).toBeTruthy()
    expect(resolved).toEqual([])
    expect(fetched.filter((u) => u.includes('by-code'))).toEqual([])
    expect(screen.queryByTestId('where')).toBeNull()
  })

  it('a legacy six-character code gets the same answer', async () => {
    await scan('cb-a1b2-c3')
    expect(await screen.findByText(/Codes are no longer used/)).toBeTruthy()
  })
})
