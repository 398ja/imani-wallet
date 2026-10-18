/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { nip19 } from 'nostr-tools'

const PUBKEY = 'b'.repeat(64)
const NPUB = nip19.npubEncode(PUBKEY)

const backup = vi.hoisted(() => ({ text: null as string | null }))

vi.mock('../../lib/nap', () => ({ keyStore: { loadKey: async () => 'ff'.repeat(32) } }))
vi.mock('../../lib/drive', () => ({ getBackup: async () => backup.text }))
// Offline: the relay never answers, so only the backup's own profile can name the account.
vi.mock('../../lib/profile', async (orig) => ({
  ...(await orig<typeof import('../../lib/profile')>()),
  refreshProfile: () => new Promise(() => {}),
}))
vi.mock('../../lib/identity', async (orig) => ({
  ...(await orig<typeof import('../../lib/identity')>()),
  useIdentityState: () => ({ identity: undefined, loading: false }),
}))
vi.mock('../../hooks/useIsMerchant', () => ({ useIsMerchant: () => false }))

const { RestorePage } = await import('../BackupPages')

const file = (profile: unknown) =>
  JSON.stringify({
    format: 'imani-wallet-backup',
    version: 1,
    createdAt: '2026-10-18T00:00:00Z',
    npub: NPUB,
    pubkey: PUBKEY,
    key: { ciphertext: 'c', kdf: 'k', iv: 'i' },
    profile,
  })

async function openDriveBackup(profile: unknown) {
  backup.text = file(profile)
  const view = render(
    <MemoryRouter>
      <RestorePage onUnlock={async () => {}} />
    </MemoryRouter>,
  )
  fireEvent.click(screen.getByRole('button', { name: /Restore from Google Drive/i }))
  await screen.findByText('This backup holds the account')
  return view
}

afterEach(() => {
  cleanup()
  localStorage.clear()
})

describe('the Drive restore passphrase prompt', () => {
  // The account is named by the identity component, from the profile stored in
  // the backup: name and NIP-05, with no relay answer needed.
  it('shows the profile with the backup name and handle', async () => {
    await openDriveBackup({ pubkey: PUBKEY, npub: NPUB, displayName: 'Amina', nip05: 'amina@imani.africa', updatedAt: 1 })

    expect(screen.getByText('Amina')).toBeTruthy()
    expect(screen.getByText('@amina')).toBeTruthy()
  })

  // The raw npub is no longer led with: it is not on screen until asked for.
  it('does not show the full npub by default', async () => {
    const { container } = await openDriveBackup({ pubkey: PUBKEY, npub: NPUB, displayName: 'Amina', updatedAt: 1 })

    expect(container.textContent).not.toContain(NPUB)
  })

  // A backup with no profile at all still names the account, as a short key.
  it('falls back to a short key when the backup has no profile', async () => {
    const { container } = await openDriveBackup(null)

    expect(screen.getByText(`${PUBKEY.slice(0, 8)}…${PUBKEY.slice(-4)}`)).toBeTruthy()
    expect(container.textContent).not.toContain(NPUB)
  })

  // Two accounts stay tellable apart: the full npub is one tap away, and hides again.
  it('reveals the full npub behind "Show account key"', async () => {
    const { container } = await openDriveBackup({ pubkey: PUBKEY, npub: NPUB, displayName: 'Amina', updatedAt: 1 })

    fireEvent.click(screen.getByRole('button', { name: 'Show account key' }))
    expect(screen.getByText(NPUB)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Hide account key' }))
    expect(container.textContent).not.toContain(NPUB)
  })
})
