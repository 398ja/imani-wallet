/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { nip19 } from 'nostr-tools'

const loadKey = vi.fn(async () => 'ab'.repeat(32))
// Like nap: re-encrypting writes a new envelope, so the stored key's fingerprint changes.
const save = vi.fn(async () => {
  localStorage.setItem('imani-wallet-key', JSON.stringify({ ciphertext: 'new', iv: 'i', kdf: 'k' }))
})
vi.mock('../../lib/nap', () => ({ keyStore: { loadKey, save } }))
vi.mock('../../lib/legacyBridge', () => ({ legacyApi: async () => ({}) }))

const listBackups = vi.fn<() => Promise<unknown[]>>(async () => [])
const putBackup = vi.fn<(json: string) => Promise<void>>(async () => {})
const driveConfigured = vi.fn(() => true)
vi.mock('../../lib/drive', () => ({
  driveConfigured: () => driveConfigured(),
  putBackup,
  // #348: the hook writes through the read-back variant.
  putAndVerifyBackup: putBackup,
  listBackups,
}))

vi.mock('../../lib/backup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/backup')>()),
  createBackup: () => '{"format":"imani-wallet-backup"}',
}))

const downloadText = vi.fn<(name: string, text: string) => Promise<void>>(async () => {})
vi.mock('../../lib/download', () => ({ downloadText }))

// The real file store, except where it would reach the Android plugin.
const rewriteSavedFile = vi.fn<(...a: unknown[]) => Promise<'rewritten' | 'none' | 'failed'>>(async () => 'none')
vi.mock('../../lib/backupFileStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/backupFileStore')>()),
  rewriteSavedFile: (...a: unknown[]) => rewriteSavedFile(...a),
}))

const { SecurityPage } = await import('../SecurityPage')
const { recordBackup, loadBackupRecord } = await import('../../lib/backupRecord')
const PUBKEY = 'a'.repeat(64)
// = await import('../SecurityPage')

/**
 * Rotating the passphrase must rotate the copy in Drive with it.
 *
 * `keyStore.save` re-encrypts the record in THIS browser and nothing else. A
 * Drive backup taken before the change goes on opening with the old
 * passphrase, and the customer discovers that on a new phone — holding a
 * passphrase that does not work, unable to tell whether they misremembered it
 * or the wallet lied to them.
 */
const rotate = async () => {
  render(
    <MemoryRouter>
      <SecurityPage onLogout={() => {}} pubkey={'a'.repeat(64)} />
    </MemoryRouter>,
  )

  const type = (placeholder: string, value: string) =>
    fireEvent.change(screen.getByPlaceholderText(placeholder), { target: { value } })

  type('Current passphrase', 'old passphrase')
  type('New passphrase', 'a new passphrase')
  type('Confirm new passphrase', 'a new passphrase')
  fireEvent.click(screen.getByRole('button', { name: 'Change passphrase' }))
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
})
afterEach(cleanup)

describe('changing the passphrase', () => {
  beforeEach(() => recordBackup(PUBKEY, 'drive', 1))

  it('rewrites the Google Drive copy', async () => {
    await rotate()

    await waitFor(() => expect(putBackup).toHaveBeenCalledTimes(1))
    expect(await screen.findByText(/Google Drive backup was updated/)).toBeTruthy()
  })

  it('rewrites Drive only after the local record, never before', async () => {
    await rotate()

    await waitFor(() => expect(putBackup).toHaveBeenCalled())
    // A Drive write that landed against a rotation that then failed would leave
    // Drive holding a passphrase this device does not have.
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(putBackup.mock.invocationCallOrder[0])
  })

  it('still reports the passphrase changed when Drive refuses', async () => {
    putBackup.mockRejectedValueOnce(new Error('Google Drive refused the request (403).'))

    await rotate()

    // The rotation already succeeded locally. Reporting it as a failure would
    // send someone to re-type a passphrase that is no longer their current one.
    expect(await screen.findByText(/Passphrase changed/)).toBeTruthy()
    expect(await screen.findByText(/still opens with the old one/)).toBeTruthy()
  })


  it('says before the change that it rewrites Drive, and what that write replaces (#559)', () => {
    render(
      <MemoryRouter>
        <SecurityPage onLogout={() => {}} pubkey={'a'.repeat(64)} />
      </MemoryRouter>,
    )
    expect(screen.getByText(/also updates your Google Drive backup/)).toBeTruthy()
    expect(screen.getByText(/Saving to Google Drive replaces/).textContent).toMatch(/keep their own backups/)
  })
})

describe('changing the passphrase touches only the backups that exist', () => {
  it('with no Drive backup recorded, never writes Drive and says nothing about it', async () => {
    recordBackup(PUBKEY, 'file', 1)
    render(
      <MemoryRouter>
        <SecurityPage onLogout={() => {}} pubkey={PUBKEY} />
      </MemoryRouter>,
    )
    expect(screen.queryByText(/Google Drive/)).toBeNull()
    cleanup()

    await rotate()
    expect(await screen.findByText(/Passphrase changed/)).toBeTruthy()
    expect(putBackup).not.toHaveBeenCalled()
    expect(screen.queryByText(/Google Drive/)).toBeNull()
  })

  it('with a Drive backup recorded, rewrites it exactly once', async () => {
    recordBackup(PUBKEY, 'drive', 1)
    await rotate()
    expect(await screen.findByText(/Google Drive backup was updated/)).toBeTruthy()
    expect(putBackup).toHaveBeenCalledTimes(1)
  })

  it('with a file backup recorded, offers a new file and records it once saved', async () => {
    recordBackup(PUBKEY, 'file', 1)
    await rotate()
    expect(await screen.findByText(/Your backup file could not be updated: it still opens with your old passphrase\. Save a new one/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Save new backup file' }))
    await waitFor(() => expect(downloadText).toHaveBeenCalledTimes(1))
    expect(downloadText.mock.calls[0][1]).toContain('imani-wallet-backup')
    expect(await screen.findByText(/New backup file saved/)).toBeTruthy()
    expect(loadBackupRecord(PUBKEY).file).toBeGreaterThan(1)
    expect(putBackup).not.toHaveBeenCalled()
  })

  it('with no backup recorded, puts one neutral file line and nothing about Drive', async () => {
    await rotate()
    expect(await screen.findByText(/Passphrase changed/)).toBeTruthy()
    expect(
      await screen.findByText(/If you saved a backup file before, it still opens with your old passphrase\. Save a new one/),
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save new backup file' })).toBeTruthy()
    const panel = screen.getByRole('button', { name: 'Change passphrase' }).parentElement!
    expect(panel.textContent).not.toMatch(/Google Drive/i)
    expect(putBackup).not.toHaveBeenCalled()
  })
})

const NPUB = nip19.npubEncode(PUBKEY)
const found = (over: Record<string, unknown>) => ({
  id: 'f1', fileId: 'f1', legacy: false, pubkey: PUBKEY, npub: NPUB, nip05: null,
  modifiedTime: '2025-01-01T00:00:00Z', text: '{}', ...over,
})

describe('changing the passphrase with no Drive record asks Drive', () => {
  it('finds this account\'s file, records Drive and rewrites it once', async () => {
    listBackups.mockResolvedValueOnce([found({})])
    await rotate()
    expect(await screen.findByText(/Google Drive backup was updated/)).toBeTruthy()
    expect(listBackups).toHaveBeenCalledTimes(1)
    expect(putBackup).toHaveBeenCalledTimes(1)
    expect(loadBackupRecord(PUBKEY).drive).toBeGreaterThan(0)
  })

  it('counts the legacy file whose npub is this account', async () => {
    listBackups.mockResolvedValueOnce([found({ legacy: true, id: 'L', fileId: 'L' })])
    await rotate()
    await waitFor(() => expect(putBackup).toHaveBeenCalledTimes(1))
  })

  it('ignores another account\'s file', async () => {
    listBackups.mockResolvedValueOnce([found({ pubkey: 'b'.repeat(64), npub: nip19.npubEncode('b'.repeat(64)) })])
    await rotate()
    expect(await screen.findByText(/Passphrase changed/)).toBeTruthy()
    expect(putBackup).not.toHaveBeenCalled()
  })

  it('with no file in Drive, writes nothing and says nothing about Drive', async () => {
    await rotate()
    expect(await screen.findByText(/Passphrase changed/)).toBeTruthy()
    await waitFor(() => expect(listBackups).toHaveBeenCalledTimes(1))
    expect(putBackup).not.toHaveBeenCalled()
    expect(screen.queryByText(/Google Drive/)).toBeNull()
    expect(loadBackupRecord(PUBKEY).drive).toBeUndefined()
  })

  it('when the lookup fails, says it could not check and writes nothing', async () => {
    listBackups.mockRejectedValueOnce(new Error('cancelled'))
    await rotate()
    expect(
      await screen.findByText('We could not check Google Drive. If you backed up there, back up again under Settings > Backup.'),
    ).toBeTruthy()
    expect(putBackup).not.toHaveBeenCalled()
  })
})

const { recordKeyBackup, loadKeyBackups, currentKeyFingerprint } = await import('../../lib/keyBackups')
const { currentKeyBackupState } = await import('../../lib/keyBackupState')

describe('after a passphrase change, every backup is updated or flagged', () => {
  const OLD_ENVELOPE = { ciphertext: 'old', iv: 'i', kdf: 'k' }
  beforeEach(() => {
    driveConfigured.mockReturnValue(true)
    localStorage.setItem('imani-wallet-key', JSON.stringify(OLD_ENVELOPE))
  })

  it('with Drive and a file: Drive is rewritten (steady green), the file is stale and the user told to re-download', async () => {
    // Arrange
    recordBackup(PUBKEY, 'drive', 1)
    recordBackup(PUBKEY, 'file', 1)
    recordKeyBackup(PUBKEY, 'drive', { verified: true })
    recordKeyBackup(PUBKEY, 'file', { fileName: 'me.json' })
    const oldFp = currentKeyFingerprint()
    // Act
    await rotate()
    // Assert
    expect(await screen.findByText(/Google Drive backup was updated/)).toBeTruthy()
    expect(screen.getByText(/backup file could not be updated.*Save a new one/)).toBeTruthy()
    const newFp = currentKeyFingerprint()
    expect(newFp).not.toBe(oldFp)
    const list = loadKeyBackups(PUBKEY)
    expect(list.some((b) => b.location === 'drive' && b.keyFingerprint === newFp)).toBe(true)
    expect(list.some((b) => b.location === 'file' && b.keyFingerprint === newFp)).toBe(false)
    expect(currentKeyBackupState(PUBKEY)).toBe('verified')
  })

  it('with only a file: the key turns orange until a new file is downloaded, then blinking green', async () => {
    // Arrange
    recordBackup(PUBKEY, 'file', 1)
    recordKeyBackup(PUBKEY, 'file', { fileName: 'me.json' })
    expect(currentKeyBackupState(PUBKEY)).toBe('local')
    // Act
    await rotate()
    await screen.findByText(/Passphrase changed/)
    const afterChange = currentKeyBackupState(PUBKEY)
    fireEvent.click(screen.getByRole('button', { name: 'Save new backup file' }))
    await screen.findByText(/New backup file saved/)
    // Assert
    expect(afterChange).toBe('missing')
    expect(currentKeyBackupState(PUBKEY)).toBe('local')
    expect(putBackup).not.toHaveBeenCalled()
  })

  it('with a Drive record this deployment cannot reach: says Drive still has the old passphrase', async () => {
    // Arrange
    driveConfigured.mockReturnValue(false)
    recordBackup(PUBKEY, 'drive', 1)
    recordKeyBackup(PUBKEY, 'drive', { verified: true })
    // Act
    await rotate()
    // Assert
    expect(await screen.findByText(/Google Drive backup could not be updated from here/)).toBeTruthy()
    expect(putBackup).not.toHaveBeenCalled()
    expect(currentKeyBackupState(PUBKEY)).toBe('missing')
  })

  it('when the Drive rewrite fails, the key does not stay green', async () => {
    // Arrange
    recordBackup(PUBKEY, 'drive', 1)
    recordKeyBackup(PUBKEY, 'drive', { verified: true })
    putBackup.mockRejectedValueOnce(new Error('403'))
    // Act
    await rotate()
    // Assert
    expect(await screen.findByText(/still opens with the old one/)).toBeTruthy()
    expect(currentKeyBackupState(PUBKEY)).toBe('missing')
  })
})

describe('after a passphrase change, a file the app can reach is rewritten in place', () => {
  const OLD_ENVELOPE = { ciphertext: 'old', iv: 'i', kdf: 'k' }
  beforeEach(() => {
    driveConfigured.mockReturnValue(true)
    localStorage.setItem('imani-wallet-key', JSON.stringify(OLD_ENVELOPE))
    rewriteSavedFile.mockResolvedValue('none')
  })

  it('rewrites the saved file, says so, offers no new file, and keeps the key green', async () => {
    // Arrange
    recordBackup(PUBKEY, 'file', 1)
    recordKeyBackup(PUBKEY, 'file', { fileName: 'me.json' })
    const oldFp = currentKeyFingerprint()
    rewriteSavedFile.mockResolvedValue('rewritten')

    // Act
    await rotate()

    // Assert
    expect(await screen.findByText(/Your backup file was updated too/)).toBeTruthy()
    expect(rewriteSavedFile).toHaveBeenCalledTimes(1)
    expect(rewriteSavedFile.mock.calls[0][1]).toBe(oldFp)
    expect(screen.queryByRole('button', { name: 'Save new backup file' })).toBeNull()
    const newFp = currentKeyFingerprint()
    expect(loadKeyBackups(PUBKEY).some((b) => b.location === 'file' && b.keyFingerprint === newFp && b.fileName === 'me.json')).toBe(true)
    expect(currentKeyBackupState(PUBKEY)).toBe('local')
  })

  it('a saved file that could not be written: told to save a new one, key not green', async () => {
    // Arrange
    recordBackup(PUBKEY, 'file', 1)
    recordKeyBackup(PUBKEY, 'file', { fileName: 'me.json' })
    rewriteSavedFile.mockResolvedValue('failed')

    // Act
    await rotate()

    // Assert
    expect(await screen.findByText(/Your backup file could not be updated/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save new backup file' })).toBeTruthy()
    expect(screen.queryByText(/Your backup file was updated too/)).toBeNull()
    expect(currentKeyBackupState(PUBKEY)).toBe('missing')
  })
})
