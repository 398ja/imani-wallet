/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

import { OPEN_TIME_LIMIT_MS, OPENING_COPY, RestoringVouchers, WalletOpening } from '../WalletOpening'
import { JARGON } from '../../lib/userMessage'

/**
 * #352: the screen in front of a wallet that will not open.
 *
 * It was a bare "Opening wallet…": no sign of life, no reason, no way on, and
 * it sat there for as long as another tab held the store. This simulates the
 * hang (the open never resolves; the screen only ever gets status "opening")
 * and checks the user always has: an indicator, then after the time limit a
 * plain explanation and Try again, which really starts again.
 */
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('WalletOpening', () => {
  it('a hang shows the indicator, then the explanation and Try again, then a fresh attempt', () => {
    vi.useFakeTimers()
    const onRetry = vi.fn()
    render(<WalletOpening status="opening" onRetry={onRetry} />)

    // Immediately: a spinner and plain words, no button to mash.
    expect(screen.getByTestId('opening-spinner')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toContain(OPENING_COPY.opening)
    expect(screen.queryByRole('button')).toBeNull()

    // Just before the limit: still the calm version.
    act(() => vi.advanceTimersByTime(OPEN_TIME_LIMIT_MS - 1))
    expect(screen.queryByText(OPENING_COPY.slow)).toBeNull()

    // At the limit: an explanation, still alive, and a way on.
    act(() => vi.advanceTimersByTime(1))
    expect(screen.getByText(OPENING_COPY.slow)).toBeTruthy()
    expect(screen.getByText(OPENING_COPY.slowDetail)).toBeTruthy()
    expect(screen.getByTestId('opening-spinner')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: OPENING_COPY.tryAgain }))
    expect(onRetry).toHaveBeenCalledTimes(1)
    // The new attempt gets its own full time limit.
    expect(screen.getByText(OPENING_COPY.opening)).toBeTruthy()
    act(() => vi.advanceTimersByTime(OPEN_TIME_LIMIT_MS))
    expect(screen.getByText(OPENING_COPY.slow)).toBeTruthy()
  })

  it('another tab in the way: says to close it, keeps waiting, and offers Try again at once', () => {
    const onRetry = vi.fn()
    render(<WalletOpening status="blocked" onRetry={onRetry} />)
    expect(screen.getByRole('heading').textContent).toBe('Close your other wallet tabs to continue')
    expect(screen.getByTestId('opening-spinner')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: OPENING_COPY.tryAgain }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('the wallet changed in another tab: says so and offers Reload, never a dead screen', () => {
    const onReload = vi.fn()
    render(<WalletOpening status="released" onRetry={vi.fn()} onReload={onReload} />)
    expect(screen.getByRole('heading').textContent).toBe('This wallet changed in another tab')
    expect(screen.queryByTestId('opening-spinner')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: OPENING_COPY.reload }))
    expect(onReload).toHaveBeenCalledTimes(1)
  })

  it('offers no logout or wipe from any waiting state (owner rule)', () => {
    for (const status of ['opening', 'blocked', 'released'] as const) {
      vi.useFakeTimers()
      render(<WalletOpening status={status} onRetry={vi.fn()} />)
      act(() => vi.advanceTimersByTime(OPEN_TIME_LIMIT_MS))
      const labels = screen.queryAllByRole('button').map((b) => b.textContent ?? '')
      for (const label of labels) expect(label).not.toMatch(/log ?out|erase|wipe|delete|reset/i)
      cleanup()
      vi.useRealTimers()
    }
  })

  it('the restore line says what is happening, in plain words', () => {
    render(<RestoringVouchers />)
    expect(screen.getByRole('status').textContent).toBe('Bringing back your vouchers…')
  })

  it('every waiting-screen string is free of protocol jargon', () => {
    for (const text of Object.values(OPENING_COPY)) expect(text).not.toMatch(JARGON)
  })
})
