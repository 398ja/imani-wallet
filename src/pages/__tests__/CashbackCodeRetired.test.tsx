/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

/**
 * wallet#268 phase 1: the customer's "enter a code" page is gone. A bookmark or an old link to
 * `/receive/cashback` lands on a page that says codes are no longer used, offers no code field,
 * and still banks any Cashlink claimed earlier but not yet added (the replay the old page ran).
 * Receive no longer links to it.
 */

const h = vi.hoisted(() => ({ replays: 0, recovered: false }))
vi.mock('../../lib/cashback', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/cashback')>()),
  replayPendingCashback: async () => {
    h.replays += 1
    return h.recovered
  },
  useCashbackAvailable: () => true,
}))

const { CashbackCodeRetiredPage } = await import('../CashbackCodeRetiredPage')
const { ReceivePage } = await import('../ReceivePage')

afterEach(() => {
  cleanup()
  h.replays = 0
  h.recovered = false
})

describe('/receive/cashback after codes are retired', () => {
  it('says codes are no longer used and has no field to type one', async () => {
    render(
      <MemoryRouter>
        <CashbackCodeRetiredPage />
      </MemoryRouter>,
    )
    expect(screen.getByText('Codes are no longer used. Ask the shop to show you the Cashlink QR again.')).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
    await waitFor(() => expect(h.replays).toBe(1))
  })

  it('says so when an earlier Cashlink finished arriving', async () => {
    h.recovered = true
    render(
      <MemoryRouter>
        <CashbackCodeRetiredPage />
      </MemoryRouter>,
    )
    expect(await screen.findByText(/An earlier Cashlink finished arriving/)).toBeTruthy()
  })
})

describe('Receive', () => {
  it('no longer offers "Enter a cashback code"', () => {
    render(
      <MemoryRouter>
        <ReceivePage profile={{ pubkey: 'a'.repeat(64) } as never} />
      </MemoryRouter>,
    )
    expect(screen.queryByText(/Enter a cashback code/)).toBeNull()
    expect(screen.queryByText(/code/i)).toBeNull()
  })
})
