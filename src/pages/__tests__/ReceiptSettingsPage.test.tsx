/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

/** Spec 049 FR-017: the owner's answer, changeable at any time, with the merchant default shown. */

vi.mock('../../lib/receipts', () => ({
  onReceiptsChanged: () => () => undefined,
  receiptAcknowledgementState: () => ({ on: false, answered: false }),
  setReceiptAcknowledgement: async () => undefined,
}))

const { ReceiptSettingsPage } = await import('../ReceiptSettingsPage')

afterEach(() => cleanup())

function show(initial: { on: boolean; answered: boolean }) {
  let current = initial
  const answer = vi.fn(async (allow: boolean) => {
    current = { on: allow, answered: true }
  })
  render(
    <MemoryRouter>
      <ReceiptSettingsPage state={() => current} answer={answer} />
    </MemoryRouter>,
  )
  return answer
}

describe('Settings, Receipts', () => {
  it('shows a merchant default as on, before any answer', () => {
    show({ on: true, answered: false })
    expect((screen.getByRole('switch', { name: /Confirm payments you receive/ }) as HTMLInputElement).checked).toBe(true)
  })

  it('turning it on records yes; turning it off records no', async () => {
    const answer = show({ on: false, answered: false })
    const sw = screen.getByRole('switch', { name: /Confirm payments you receive/ }) as HTMLInputElement
    expect(sw.checked).toBe(false)
    await act(async () => void fireEvent.click(sw))
    expect(answer).toHaveBeenLastCalledWith(true)
    expect(sw.checked).toBe(true)
    await act(async () => void fireEvent.click(sw))
    expect(answer).toHaveBeenLastCalledWith(false)
    expect(sw.checked).toBe(false)
  })
})
