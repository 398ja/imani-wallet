/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

/**
 * Spec 049 FR-017: a personal wallet asks once, at the first payment it could confirm, and either
 * answer is kept. The prompt appears only when something waits on it, and only on Home.
 */

const listeners = new Set<() => void>()
vi.mock('../../lib/receipts', () => ({
  onReceiptsChanged: (l: () => void) => (listeners.add(l), () => listeners.delete(l)),
  receiptsAwaitingAnswer: async () => 0,
  setReceiptAcknowledgement: async () => undefined,
}))

const { ReceiptAckPrompt } = await import('../ReceiptAckPrompt')

function show(awaiting: () => Promise<number>, answer = vi.fn(async () => undefined), path = '/') {
  render(
    <MemoryRouter initialEntries={[path]}>
      <ReceiptAckPrompt awaiting={awaiting} answer={answer} />
    </MemoryRouter>,
  )
  return answer
}

afterEach(() => {
  cleanup()
  listeners.clear()
})

describe('the acknowledge-payments prompt', () => {
  it('is absent until a received payment waits on the answer, then appears when one does', async () => {
    let n = 0
    show(async () => n)
    await act(async () => undefined)
    expect(screen.queryByRole('heading', { name: 'Confirm payments you receive?' })).toBeNull()
    n = 1
    await act(async () => listeners.forEach((l) => l()))
    expect(await screen.findByRole('heading', { name: 'Confirm payments you receive?' })).toBeTruthy()
    expect(screen.getByText(/Someone paid you and is waiting/)).toBeTruthy()
  })

  it('Confirm answers yes and goes away', async () => {
    const answer = show(async () => 2)
    expect(await screen.findByText(/2 payments are waiting/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await act(async () => undefined)
    expect(answer).toHaveBeenCalledWith(true)
    expect(screen.queryByRole('heading', { name: 'Confirm payments you receive?' })).toBeNull()
  })

  it('Not now answers no, so it is not asked again', async () => {
    const answer = show(async () => 1)
    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }))
    await act(async () => undefined)
    expect(answer).toHaveBeenCalledWith(false)
    expect(screen.queryByRole('heading', { name: 'Confirm payments you receive?' })).toBeNull()
  })

  it('stays off the other screens', async () => {
    show(async () => 1, undefined, '/send')
    await act(async () => undefined)
    expect(screen.queryByRole('heading', { name: 'Confirm payments you receive?' })).toBeNull()
  })
})
