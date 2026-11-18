/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { nip19 } from 'nostr-tools'

const loadKey = vi.fn(async () => 'ab'.repeat(32))
const save = vi.fn(async () => {})
vi.mock('../../lib/nap', () => ({ keyStore: { loadKey, save } }))
vi.mock('../../lib/legacyBridge', () => ({ legacyApi: async () => ({}) }))

const listBackups = vi.fn<() => Promise<unknown[]>>(async () => [])
const putBackup = vi.fn<(json: string) => Promise<void>>(async () => {})
vi.mock('../../lib/drive', () => ({
  driveConfigured: () => true,
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
    expect(await screen.findByText('Your backup file still opens with your old passphrase.')).toBeTruthy()

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
      await screen.findByText('If you saved a backup file before, it still opens with your old passphrase.'),
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
