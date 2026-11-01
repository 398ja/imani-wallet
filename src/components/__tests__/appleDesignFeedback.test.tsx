/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

/**
 * Feedback on the small Cashlink and card-sale controls (apple-design pass).
 *
 * - A copy is announced from a live region that is mounted BEFORE the copy, because one inserted
 *   already holding its text is not read by most screen readers.
 * - A failed cancel is an `alert`: it answers the tap the user just made.
 */

vi.mock('../../lib/cashback', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/cashback')>()),
  revokeCashback: async () => ({ kind: 'failed' as const }),
}))

import { CopyReferenceButton } from '../PaymentReference'
import { CancelCashback } from '../CashbackClaimLink'

afterEach(cleanup)

describe('CopyReferenceButton', () => {
  it('has its live region in place before the copy, and fills it after', async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => {}) } })
    render(<CopyReferenceButton reference="pi_123" />)
    const button = screen.getByRole('button', { name: 'Copy payment reference' })
    const live = button.querySelector('[aria-live="polite"]')
    expect(live).not.toBeNull()
    expect(live!.textContent).toBe('')
    await act(async () => {
      fireEvent.click(button)
    })
    expect(live!.textContent).toBe('Copied')
  })
})

describe('CancelCashback', () => {
  it('reports a failed cancel as an alert', async () => {
    render(<CancelCashback cashbackId="cb1" onCancelled={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel Cashlink' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Yes, cancel it' }))
    })
    expect((await screen.findByRole('alert')).textContent).toMatch(/Could not cancel just now/)
  })
})
