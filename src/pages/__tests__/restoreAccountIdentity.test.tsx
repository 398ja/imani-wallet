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
  // The account is named by the full profile component, from the profile stored
  // in the backup: avatar, display name and handle, with no relay answer needed,
  // and no npub anywhere on screen until asked for.
  it('shows the avatar, display name and handle, and no npub', async () => {
    const { container } = await openDriveBackup({
      pubkey: PUBKEY,
      npub: NPUB,
      displayName: 'Amina',
      nip05: 'amina@imani.africa',
      picture: 'https://example.com/amina.png',
      updatedAt: 1,
    })

    const avatar = screen.getByRole('img', { name: 'Amina' })
    expect(avatar.getAttribute('src')).toBe('https://example.com/amina.png')
    expect(screen.getByText('Amina')).toBeTruthy()
    expect(screen.getByText('@amina')).toBeTruthy()
    expect(container.textContent).not.toContain(NPUB)
    expect(container.textContent).not.toContain('npub1')
  })

  // The raw npub is no longer led with: it is not on screen until asked for.
  it('does not show the full npub by default', async () => {
    const { container } = await openDriveBackup({ pubkey: PUBKEY, npub: NPUB, displayName: 'Amina', updatedAt: 1 })

    expect(container.textContent).not.toContain(NPUB)
    expect(container.textContent).not.toContain('npub1')
  })

  // A backup with no profile at all: a neutral word, never a key fragment (#324).
  // Every account has a profile, so this is an old or damaged file.
  it('falls back to a neutral word, not a short key, when the backup has no profile', async () => {
    const { container } = await openDriveBackup(null)

    expect(screen.getByText('Someone')).toBeTruthy()
    expect(container.textContent).not.toContain(`${PUBKEY.slice(0, 8)}…`)
    expect(container.textContent).not.toContain(NPUB)
  })

  // No way to reveal a raw key here: customers never meet protocol terms or keys.
  it('offers no key disclosure and no protocol wording', async () => {
    const { container } = await openDriveBackup({ pubkey: PUBKEY, npub: NPUB, displayName: 'Amina', updatedAt: 1 })

    expect(screen.queryByRole('button', { name: /account key/i })).toBeNull()
    expect(container.textContent).not.toMatch(/npub|nsec|nostr|relay|nip-?05/i)
  })
})

describe('the file restore passphrase prompt', () => {
  it('shows the profile from the file, and no npub', async () => {
    const { container } = render(
      <MemoryRouter>
        <RestorePage onUnlock={async () => {}} />
      </MemoryRouter>,
    )
    const text = file({ pubkey: PUBKEY, npub: NPUB, displayName: 'Amina', nip05: 'amina@imani.africa', picture: 'https://example.com/amina.png', updatedAt: 1 })
    const picked = new File([text], 'backup.json', { type: 'application/json' })
    Object.defineProperty(picked, 'text', { value: async () => text })
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [picked] } })
    await screen.findByText('This backup holds the account')

    expect(screen.getByRole('img', { name: 'Amina' }).getAttribute('src')).toBe('https://example.com/amina.png')
    expect(container.textContent).not.toMatch(/npub|nsec|nostr|relay|nip-?05/i)
  })

  it('drops a javascript: picture from the backup', async () => {
    await openDriveBackup({ pubkey: PUBKEY, npub: NPUB, displayName: 'Amina', picture: 'javascript:alert(1)', updatedAt: 1 })
    expect(screen.queryByRole('img', { name: 'Amina' })).toBeNull()
  })
})
