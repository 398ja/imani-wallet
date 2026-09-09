/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const loadKey = vi.fn(async () => 'ab'.repeat(32))
const save = vi.fn(async () => {})
vi.mock('../../lib/nap', () => ({ keyStore: { loadKey, save } }))
vi.mock('../../lib/legacyBridge', () => ({ legacyApi: async () => ({}) }))

const putBackup = vi.fn<(json: string) => Promise<void>>(async () => {})
vi.mock('../../lib/drive', () => ({
  driveConfigured: () => true,
  putBackup,
  getBackup: async () => null,
}))

vi.mock('../../lib/backup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/backup')>()),
  createBackup: () => '{"format":"imani-wallet-backup"}',
}))

const { SecurityPage } = await import('../SecurityPage')

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

beforeEach(() => vi.clearAllMocks())
afterEach(cleanup)

describe('changing the passphrase', () => {
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

  it('warns that an already-downloaded file is now stale', async () => {
    await rotate()
    expect(await screen.findByText(/still needs your old passphrase/)).toBeTruthy()
  })
})
