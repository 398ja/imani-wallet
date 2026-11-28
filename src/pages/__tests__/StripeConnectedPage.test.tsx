/**
 * @vitest-environment jsdom
 */
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

/**
 * The OAuth return: code and state leave the URL before any network call, the code is posted
 * exactly once (StrictMode included), and failure offers "Start again", never "Try again".
 */
const m = vi.hoisted(() => ({ complete: vi.fn(), start: vi.fn(), urlAtPost: '' as string }))
vi.mock('../../lib/stripeAccount', async (orig) => ({
  ...(await orig<typeof import('../../lib/stripeAccount')>()),
  completeStripeOAuth: (...args: unknown[]) => {
    m.urlAtPost = window.location.href
    return m.complete(...args)
  },
  startStripeOAuth: m.start,
}))

import { StripeConnectedPage, resetStripeConnectedGuard } from '../StripeConnectedPage'

function open(query: string, strict = false) {
  window.history.replaceState(null, '', `/settings/payments/stripe-connected${query}`)
  const tree = (
    <MemoryRouter initialEntries={['/settings/payments/stripe-connected']}>
      <Routes>
        <Route path="/settings/payments/stripe-connected" element={<StripeConnectedPage />} />
        <Route path="/settings/payments" element={<p>payments screen</p>} />
      </Routes>
    </MemoryRouter>
  )
  return render(strict ? <StrictMode>{tree}</StrictMode> : tree)
}

beforeEach(() => {
  resetStripeConnectedGuard()
  m.complete.mockReset()
  m.start.mockReset()
  m.urlAtPost = ''
})
afterEach(cleanup)

describe('StripeConnectedPage', () => {
  it('strips code and state before posting, posts once, then goes to Card payments', async () => {
    m.complete.mockResolvedValue({ kind: 'ok', status: {} })
    open('?code=ac_123&state=st_9')
    expect(window.location.search).toBe('')
    expect(await screen.findByText('payments screen')).toBeTruthy()
    expect(m.urlAtPost).not.toContain('ac_123')
    expect(m.urlAtPost).not.toContain('st_9')
    expect(m.complete).toHaveBeenCalledTimes(1)
    expect(m.complete).toHaveBeenCalledWith('ac_123', 'st_9')
  })

  it('posts exactly once under StrictMode double mount', async () => {
    m.complete.mockResolvedValue({ kind: 'ok', status: {} })
    open('?code=ac_dbl&state=st', true)
    expect(await screen.findByText('payments screen')).toBeTruthy()
    expect(m.complete).toHaveBeenCalledTimes(1)
  })

  // Review regression: coming back to the page after a finished attempt (Back button, a second tab)
  // has no query and nothing in flight, so it must say the code is spent, not hang on "Connecting…".
  it('a later visit with no query after a finished attempt says Start again, not Connecting', async () => {
    m.complete.mockResolvedValue({ kind: 'refused', reason: 'x', code: 'OAUTH_STATE_INVALID' })
    open('?code=ac_once&state=st')
    expect(await screen.findByRole('button', { name: 'Start again' })).toBeTruthy()
    cleanup()

    open('')
    expect(await screen.findByText(/That took too long, or was already used/)).toBeTruthy()
    expect(screen.queryByText(/Connecting your Stripe account/)).toBeNull()
    expect(m.complete).toHaveBeenCalledTimes(1)
  })

  it('access_denied: nothing was connected, Connect again, no post', async () => {
    open('?error=access_denied&error_description=no')
    expect(await screen.findByText('Nothing was connected.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Connect again' })).toBeTruthy()
    expect(m.complete).not.toHaveBeenCalled()
    expect(window.location.search).toBe('')
  })

  it('failure shows the mapped words and Start again, never Try again', async () => {
    m.complete.mockResolvedValue({ kind: 'refused', reason: 'x', code: 'OAUTH_STATE_INVALID' })
    open('?code=ac_bad&state=st')
    expect(await screen.findByText(/That took too long, or was already used/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Start again' })).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/try again/i)
    expect(m.complete).toHaveBeenCalledTimes(1)
  })

  it('a Stripe outage on complete still says Start again, not Try again', async () => {
    m.complete.mockResolvedValue({ kind: 'refused', reason: 'down', code: 'STRIPE_API_ERROR' })
    open('?code=ac_down&state=st')
    expect(await screen.findByRole('button', { name: 'Start again' })).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/try again/i)
  })
})
