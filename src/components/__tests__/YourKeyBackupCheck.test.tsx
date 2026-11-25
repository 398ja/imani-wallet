/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

/**
 * Settings, "Your key backup": one button, "Check my backups", checks every known backup where it
 * is. No file picker opens and no location is asked for.
 */

vi.mock('../../lib/nap', () => ({ getSigner: () => { throw new Error('locked') } }))
vi.mock('../../lib/relay', () => ({ allEvents: vi.fn(async () => { throw new Error('offline') }) }))
vi.mock('../../lib/relayDelivery', () => ({ deliverToRelay: vi.fn(async () => ({ delivered: false, why: 'unreachable' })) }))
vi.mock('../../lib/transferSignature', () => ({ mirrorToGateway: vi.fn(async () => false) }))

const io = { drive: 0, file: 0, fileResult: 'gone' as 'gone' | 'ok' }
vi.mock('../../lib/drive', () => ({
  driveConfigured: () => true,
  readAccountBackup: async () => (io.drive++, null),
}))
vi.mock('../../lib/backupFileStore', () => ({
  readSavedFile: async () => (io.file++, { kind: io.fileResult === 'gone' ? 'gone' : 'unknown' }),
}))

const kb = await import('../../lib/keyBackups')
const { YourKeyBackup } = await import('../KeyBackup')

const PK = 'ab'.repeat(32)

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('imani-wallet-key', JSON.stringify({ ciphertext: 'c1', kdf: 'k', iv: 'i' }))
  Object.assign(io, { drive: 0, file: 0, fileResult: 'gone' })
})

afterEach(cleanup)

describe('Check my backups', () => {
  it('is the button, and the old "Check a backup file" is gone', () => {
    // Arrange
    kb.recordKeyBackup(PK, 'file', { fileName: 'b.json' })

    // Act
    render(<YourKeyBackup pubkey={PK} />)

    // Assert
    expect(screen.getByRole('button', { name: 'Check my backups' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Check a backup file' })).toBeNull()
  })

  it('checks Drive and the file where they are, without opening a picker, and reports each', async () => {
    // Arrange
    kb.recordKeyBackup(PK, 'drive', { verified: true })
    kb.recordKeyBackup(PK, 'file', { fileName: 'b.json' })
    render(<YourKeyBackup pubkey={PK} />)
    const picker = screen.getByTestId('key-backup-check-input') as HTMLInputElement
    const opened = vi.spyOn(picker, 'click')

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Check my backups' }))

    // Assert
    const lines = await screen.findByTestId('key-backup-check-result')
    expect(io).toMatchObject({ drive: 1, file: 1 })
    expect(opened).not.toHaveBeenCalled()
    expect(lines.textContent).toContain('Google Drive: missing. Back up again.')
    expect(lines.textContent).toContain('b.json: missing. Back up again.')
    expect(lines.textContent).toMatch(/Last checked/)
  })

  it('shows only the last check, and keeps it after leaving and coming back', async () => {
    // Arrange
    kb.recordKeyBackup(PK, 'drive', { verified: true })
    kb.recordKeyBackup(PK, 'file', { fileName: 'b.json' })
    const first = render(<YourKeyBackup pubkey={PK} />)
    expect(screen.getByText('Not checked yet')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Check my backups' }))
    await screen.findByText(/Last checked/)
    first.unmount()

    // Act
    render(<YourKeyBackup pubkey={PK} />)

    // Assert
    const lines = screen.getByTestId('key-backup-check-result')
    expect(lines.querySelectorAll('li')).toHaveLength(2)
    expect(lines.textContent).toMatch(/Last checked/)
    expect(screen.queryByText(/Your Google Drive \(in the app/)).toBeNull()
  })

  it('is off when there is no backup to check', () => {
    // Arrange / Act
    render(<YourKeyBackup pubkey={PK} />)

    // Assert
    expect((screen.getByRole('button', { name: 'Check my backups' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
