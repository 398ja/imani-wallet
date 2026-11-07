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
 * #559: a Drive backup replaces whatever wallet backup the Google account already holds, another
 * Imani account's included. A user lost account duran's key that way (restore brought back
 * cruchot). Until each account has its own Drive file, the backup screen says so beside the button.
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
    const note = screen.getByText(/one wallet backup per Google account/i)
    expect(note.textContent).toMatch(/replaces any backup already there/i)
    expect(note.textContent).toMatch(/another Imani account/i)
    expect(note.textContent).toMatch(/with duran's/)
    expect(note.textContent).toMatch(/Download file/)
  })

  it('stays on a terminal, which still backs up to Drive', () => {
    render(
      <MemoryRouter>
        <BackupPage profile={profile} terminal />
      </MemoryRouter>,
    )
    expect(screen.getByText(/one wallet backup per Google account/i)).toBeTruthy()
  })

  it('says "this account" when there is no handle', () => {
    render(<DriveOverwriteWarning who={null} />)
    expect(screen.getByRole('status').textContent).toMatch(/with this account's/)
  })

  it('reads the handle out of a nip05', () => {
    expect(handleOf('duran@staging.398ja.xyz')).toBe('duran')
    expect(handleOf('')).toBeNull()
    expect(handleOf(undefined)).toBeNull()
  })
})
