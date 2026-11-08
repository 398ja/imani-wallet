/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../../lib/nap', () => ({ keyStore: { loadKey: async () => 'ff'.repeat(32), save: async () => {} } }))

const { BackupPage } = await import('../BackupPages')
const { DriveOverwriteWarning } = await import('../../components/DriveOverwriteWarning')
const { handleOf } = await import('../../lib/format')

/**
 * #559: a Drive backup replaces only its own account's earlier Drive copy. Before each account had its
 * own file, a backup replaced whatever the Google account held, and a user lost account duran's key
 * that way. The backup screen says what a Drive backup replaces, beside the button.
 */
const profile = {
  pubkey: 'b'.repeat(64),
  npub: 'npub1test',
  displayName: 'Duran',
  nip05: 'duran@staging.398ja.xyz',
  updatedAt: 1,
} as never

afterEach(() => {
  cleanup()
  localStorage.clear()
})

describe('the Drive overwrite warning (#559)', () => {
  it('is on Settings > Backup, naming whose backup replaces the one in Drive', () => {
    render(
      <MemoryRouter>
        <BackupPage profile={profile} />
      </MemoryRouter>,
    )
    const note = screen.getByText(/Saving to Google Drive replaces/i)
    expect(note.textContent).toMatch(/replaces duran's earlier Drive backup/)
    expect(note.textContent).toMatch(/Other Imani accounts in the same Google account keep their own backups/)
    expect(note.textContent).not.toMatch(/older|update every device/)
  })

  it('stays on a terminal, which still backs up to Drive', () => {
    render(
      <MemoryRouter>
        <BackupPage profile={profile} terminal />
      </MemoryRouter>,
    )
    expect(screen.getByText(/Saving to Google Drive replaces/i)).toBeTruthy()
  })

  it('says "this account" when there is no handle', () => {
    render(<DriveOverwriteWarning who={null} />)
    expect(screen.getByRole('status').textContent).toMatch(/replaces this account's earlier/)
  })

  it('reads the handle out of a nip05', () => {
    expect(handleOf('duran@staging.398ja.xyz')).toBe('duran')
    expect(handleOf('')).toBeNull()
    expect(handleOf(undefined)).toBeNull()
  })
})
