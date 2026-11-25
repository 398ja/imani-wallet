/**
 * @vitest-environment jsdom
 *
 * `onText` is documented as "return true to consume it, so it is not resolved as an account". Sell
 * relies on the other half (spec 049): a receipt is consumed, anything else is still a customer.
 * The typed path is exercised here; the camera calls the same `accept`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const resolved = vi.hoisted(() => ({ asked: [] as string[] }))
vi.mock('../../lib/issue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/issue')>()),
  resolveRecipient: async (text: string) => {
    resolved.asked.push(text)
    return { pubkey: 'e'.repeat(64), handle: text }
  },
}))
// No camera in jsdom: say the decoder is blocked so the effect stops before qr-scanner.
vi.mock('../../lib/scannerSupport', () => ({ scannerBlocked: async () => 'no camera here' }))

import { ScanRecipient } from '../ScanRecipient'

afterEach(() => {
  cleanup()
  resolved.asked = []
})

function typeAndContinue(text: string) {
  fireEvent.change(screen.getByLabelText(/Or enter their handle/), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
}

describe('ScanRecipient onText', () => {
  it('true consumes the text: nothing is resolved', async () => {
    const onFound = vi.fn()
    render(<ScanRecipient onFound={onFound} onText={() => true} />)
    typeAndContinue('imrc1:abc')
    await new Promise((r) => setTimeout(r, 0))
    expect(resolved.asked).toEqual([])
    expect(onFound).not.toHaveBeenCalled()
  })

  it('false lets it through to the account lookup', async () => {
    const onFound = vi.fn()
    render(<ScanRecipient onFound={onFound} onText={() => false} />)
    typeAndContinue('cocoa')
    await waitFor(() => expect(onFound).toHaveBeenCalledWith('e'.repeat(64), 'cocoa'))
    expect(resolved.asked).toEqual(['cocoa'])
  })
})
