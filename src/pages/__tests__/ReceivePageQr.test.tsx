/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

/**
 * #285 review: the QR effect now drops a render that settles after its run is over. These pin
 * the user-visible half of that: the QR still appears, still follows a changed address, and a
 * stale render for the old address never overwrites the new one.
 */

// Each call parks its resolver so the test decides the order renders settle in.
const pending = vi.hoisted(() => [] as { text: string; resolve: (url: string) => void }[])
vi.mock('qrcode', () => ({
  default: {
    toDataURL: (text: string) =>
      new Promise<string>((resolve) => pending.push({ text, resolve })),
  },
}))

const { ReceivePage } = await import('../ReceivePage')

afterEach(() => {
  cleanup()
  pending.length = 0
})

const page = (nip05: string) => (
  <MemoryRouter>
    <ReceivePage profile={{ pubkey: 'a'.repeat(64), nip05 } as never} />
  </MemoryRouter>
)

describe('Receive QR (#285)', () => {
  it('renders the QR for the handle', async () => {
    render(page('ama@imani.test'))
    expect(pending.map((p) => p.text)).toEqual(['ama@imani.test'])
    await act(async () => pending[0].resolve('data:image/png;base64,AMA'))
    expect(screen.getByAltText('QR code for ama@imani.test').getAttribute('src')).toBe('data:image/png;base64,AMA')
  })

  it('follows a changed handle, and a late render for the old one does not win', async () => {
    const { rerender } = render(page('ama@imani.test'))
    rerender(page('kofi@imani.test'))
    expect(pending.map((p) => p.text)).toEqual(['ama@imani.test', 'kofi@imani.test'])

    // The new address settles first, then the stale render for the old one arrives.
    await act(async () => pending[1].resolve('data:image/png;base64,KOFI'))
    await act(async () => pending[0].resolve('data:image/png;base64,AMA'))

    expect(screen.getByAltText('QR code for kofi@imani.test').getAttribute('src')).toBe('data:image/png;base64,KOFI')
  })
})
