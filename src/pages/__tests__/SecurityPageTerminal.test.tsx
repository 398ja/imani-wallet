/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../../lib/nap', () => ({ keyStore: { has: async () => true } }))
vi.mock('../../lib/legacyBridge', () => ({ legacyApi: async () => ({}) }))

const { SecurityPage } = await import('../SecurityPage')
const { DECOMMISSION_COPY } = await import('../../lib/terminalDecommission')

/**
 * The danger zone says the right thing to whoever is holding the device.
 *
 * Ticket 08's fourth and fifth criteria. The existing logout copy promises an
 * account, a business and past sales all come back with a backup key — none of
 * which a terminal's holder has. And a person logging out of their OWN wallet
 * must see that copy completely unchanged.
 */

const show = (props: Record<string, unknown> = {}) =>
  render(
    <MemoryRouter>
      <SecurityPage onLogout={() => {}} pubkey={'a'.repeat(64)} {...props} />
    </MemoryRouter>,
  )

afterEach(cleanup)

describe('a person logging out of their own wallet', () => {
  it('sees the existing wording, unchanged', () => {
    // The fifth criterion, and the one a regression here would hurt most:
    // every non-terminal device in the world takes this path.
    show()

    expect(screen.getByText(/Make sure you have your backup key first/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Log out' })).toBeTruthy()
  })

  it('keeps the passphrase and backup-key panels', () => {
    show()
    expect(screen.queryByText(DECOMMISSION_COPY.title)).toBeNull()
  })
})

describe('a terminal', () => {
  it('is offered decommissioning, not logout', () => {
    show({ terminal: true })

    expect(screen.getByRole('button', { name: DECOMMISSION_COPY.title })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Log out' })).toBeNull()
  })

  it('is never told about a backup key', () => {
    /**
     * The fourth criterion. A terminal holds no coupons and has no key its
     * holder should write down, so this wording would send someone hunting for
     * a backup key that was never theirs.
     */
    const { container } = show({ terminal: true })

    expect(container.textContent).not.toMatch(/backup key/i)
    expect(container.textContent).not.toMatch(/nsec/i)
  })

  it('is not offered a passphrase change or a key reveal', () => {
    // Both are about a personal key. A terminal's is a disposable the owner
    // issued authority against, so neither panel means anything on one.
    const { container } = show({ terminal: true })

    expect(container.textContent).not.toMatch(/Change passphrase/i)
    expect(container.textContent).not.toMatch(/Show my backup key/i)
  })

  it('says what does come back, and who does it', () => {
    show({ terminal: true })
    expect(screen.getByText(/the stall owner adds it as a terminal/)).toBeTruthy()
  })
})
