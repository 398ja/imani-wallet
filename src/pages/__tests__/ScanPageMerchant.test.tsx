/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'

/** #280: scanning a stall opens its profile; anyone else keeps the send flow. */

const STALL = 'ab'.repeat(32)
const FRIEND = 'cd'.repeat(32)

vi.mock('../../lib/scannerSupport', () => ({ scannerBlocked: async () => 'no camera in tests' }))
vi.mock('imani-qr', async () => import('../../../packages/imani-qr/src/handlers'))
vi.mock('../../lib/native', () => ({ readClipboard: async () => null }))
vi.mock('../../lib/issue', () => ({
  toRecipientPubkey: async (t: string) => (t === 'rosa' ? STALL : t === 'sam' ? FRIEND : null),
}))
vi.mock('../../lib/merchant', () => ({
  merchantStatus: async (p: string) => (p === STALL ? 'merchant' : 'customer'),
}))

const { ScanPage } = await import('../ScanPage')

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
  fireEvent.change(await screen.findByLabelText('Code'), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  return (await screen.findByTestId('where')).textContent
}

afterEach(cleanup)

describe('an address on the Scan screen', () => {
  it('a merchant lands on its profile', async () => {
    expect(await scan('rosa')).toBe(`/merchants/${STALL}`)
  })

  it('a non-merchant goes to send, as before', async () => {
    expect(await scan('sam')).toBe(`/send?to=${FRIEND}`)
  })
})
