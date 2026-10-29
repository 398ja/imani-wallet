/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

/**
 * #410 G14 /gift-return: R is read from the fragment and the URL scrubbed in the first render; the
 * state is shown; nothing is taken back on load, only on the button, and only after the date.
 */
const m = vi.hoisted(() => ({ read: vi.fn(), take: vi.fn() }))
vi.mock('../../lib/lockedGiftsApp', () => ({ readGiftReturn: m.read, takeBackGuestGift: m.take }))
vi.mock('../../lib/trustedMint', () => ({ loadTrustedMints: async () => {} }))

import { GiftReturnPage } from '../GiftReturnPage'

const R = '44'.repeat(32)
const view = (state: string) => ({ kind: 'ok', view: { token: 'cashuBx', stall: 'Mama Put', faceMinor: 1000, unit: 'GBP', decimals: 2, x: 1_800_000_000, state } })

function open(authed = true) {
  window.history.replaceState(null, '', `/gift-return#r=${R}`)
  return render(
    <MemoryRouter initialEntries={['/gift-return']}>
      <Routes>
        <Route path="/gift-return" element={<GiftReturnPage authed={authed} />} />
        <Route path="/" element={<p>home</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  m.read.mockReset()
  m.take.mockReset()
})
afterEach(cleanup)

describe('GiftReturnPage', () => {
  it('scrubs the fragment at once and never shows the key', async () => {
    m.read.mockResolvedValue(view('waiting'))
    open()
    expect(window.location.hash).toBe('')
    expect(await screen.findByText(/take it back after/i)).toBeTruthy()
    expect(document.body.textContent).not.toContain(R)
    expect(m.take).not.toHaveBeenCalled()
  })

  it('ready: no take-back on load; the button takes it back into the open wallet', async () => {
    m.read.mockResolvedValue(view('ready'))
    m.take.mockResolvedValue({ kind: 'returned' })
    open()
    const button = await screen.findByRole('button', { name: /take it back into my wallet/i })
    expect(m.take).not.toHaveBeenCalled()
    fireEvent.click(button)
    expect(await screen.findByText('Gift taken back')).toBeTruthy()
    expect(m.take).toHaveBeenCalledTimes(1)
  })

  it('ready but signed out: asks to open or create a wallet, no button', async () => {
    m.read.mockResolvedValue(view('ready'))
    open(false)
    expect(await screen.findByText(/open or create your imani wallet/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /take it back/i })).toBeNull()
  })

  it('claimed', async () => {
    m.read.mockResolvedValue(view('claimed'))
    open()
    expect(await screen.findByText('Gift claimed')).toBeTruthy()
  })

  it('a refused gift is not offered', async () => {
    m.read.mockResolvedValue({ kind: 'refused', why: 'wrong_key' })
    open()
    expect(await screen.findByText('Gift unavailable')).toBeTruthy()
  })

  it('left open past the date: checks again then and offers the take-back (found on the local stack)', async () => {
    const x = Math.floor(Date.now() / 1000) + 2
    m.read.mockResolvedValueOnce({ ...view('waiting'), view: { ...view('waiting').view, x } }).mockResolvedValue({ ...view('ready'), view: { ...view('ready').view, x } })
    open()
    expect(await screen.findByText(/take it back after/i)).toBeTruthy()
    expect(await screen.findByRole('button', { name: /take it back into my wallet/i }, { timeout: 6_000 })).toBeTruthy()
    expect(m.read).toHaveBeenCalledTimes(2)
    expect(m.take).not.toHaveBeenCalled()
  }, 10_000)
})
