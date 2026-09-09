/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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

afterEach(() => {
  cleanup()
  localStorage.clear()
})

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

/**
 * The Drive button is offered on every deployment, configured or not.
 *
 * import.meta.env carries no client id in tests, so this file renders the
 * unconfigured case by default — which is the one that used to render nothing
 * at all. Hiding it meant "you can back this up to Drive" was a fact about the
 * deployment rather than about the product, and nobody learns a feature that is
 * invisible until an operator sets a variable.
 *
 * What an unconfigured build cannot do is complete the backup: Google runs no
 * OAuth for an unregistered app, so the click has to explain itself rather than
 * fail silently. lib/drive.ts owns that sentence.
 */
describe('the Google Drive button without a client id', () => {
  it('is still offered', () => {
    show()
    expect(screen.getByRole('button', { name: /Google Drive/i })).toBeTruthy()
  })

  it('is offered to a terminal too — the file is encrypted either way', () => {
    show({ terminal: true })
    expect(screen.getByRole('button', { name: /Google Drive/i })).toBeTruthy()
  })

  it('says why it cannot finish, rather than failing silently', async () => {
    // A real envelope in storage, so the click reaches lib/drive.ts. Without
    // it `createBackup` throws first and the test passes on the wrong error.
    localStorage.setItem(
      'imani-wallet-key',
      JSON.stringify({
        version: 1,
        kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: 310000, salt: 'c2FsdA==' },
        iv: 'aXY=',
        ciphertext: 'Y2lwaGVy',
      }),
    )

    // The first cut of this rendered the button and swallowed the failure —
    // a click that did nothing at all, which is worse than the hidden button
    // it replaced. `drive.save` reports through its own state, so the page has
    // to read that state or the message goes nowhere.
    show()
    fireEvent.click(screen.getByRole('button', { name: /Google Drive/i }))

    expect(await screen.findByText(/not set up for Google Drive yet/i)).toBeTruthy()
  })
})
