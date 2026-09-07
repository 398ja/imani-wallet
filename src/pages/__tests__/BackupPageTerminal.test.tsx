/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../../lib/nap', () => ({ keyStore: { loadKey: async () => 'ff'.repeat(32) } }))

const { BackupPage } = await import('../BackupPages')

/**
 * The backup key must never be offered to a terminal.
 *
 * This rule used to be enforced on Settings → Security, which took a `terminal`
 * prop and hid the reveal. Moving the reveal to Settings → Backup moved the
 * risk with it: that route renders for whoever is holding the device, and a
 * terminal holds a disposable credential the stall owner issued authority
 * against — not an account key its holder should ever write down. Offering one
 * the reveal would send someone hunting for a backup key that was never theirs,
 * and put a credential on a clipboard.
 *
 * The file and the Drive copy are a different matter and stay: both are
 * encrypted before they go anywhere.
 */
const profile = {
  pubkey: 'a'.repeat(64),
  npub: 'npub1test',
  displayName: 'Stall',
  nip05: 'stall@imani.local',
  updatedAt: 1,
} as never

const show = (props: Record<string, unknown> = {}) =>
  render(
    <MemoryRouter>
      <BackupPage profile={profile} {...props} />
    </MemoryRouter>,
  )

afterEach(cleanup)

describe('a terminal on the backup screen', () => {
  it('is never offered the backup key', () => {
    const { container } = show({ terminal: true })

    expect(screen.queryByRole('button', { name: /Show my backup key/i })).toBeNull()
    expect(container.textContent).not.toMatch(/backup key/i)
    expect(container.textContent).not.toMatch(/nsec/i)
  })

  it('has no passphrase field to type into', () => {
    // The gate and the thing it guards go together. A passphrase box with
    // nothing behind it is an invitation to try the owner's passphrase on a
    // device the owner does not control.
    const { container } = show({ terminal: true })

    expect(container.querySelector('input[type="password"]')).toBeNull()
  })

  it('can still save the account file, which is encrypted either way', () => {
    show({ terminal: true })
    expect(screen.getByRole('button', { name: /Download file/i })).toBeTruthy()
  })
})

describe('a person on the backup screen', () => {
  it('is offered the backup key, behind the passphrase', () => {
    show()

    expect(screen.getByRole('button', { name: /Show my backup key/i })).toBeTruthy()
    expect(screen.getByPlaceholderText('Passphrase')).toBeTruthy()
  })

  it('does not show the key before the passphrase is given', () => {
    const { container } = show()
    expect(container.textContent).not.toMatch(/nsec1/i)
  })
})
