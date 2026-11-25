/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../../lib/nap', () => ({ keyStore: { loadKey: async () => 'ff'.repeat(32) } }))

const { BackupPage } = await import('../BackupPages')

const profile = { pubkey: 'a'.repeat(64), npub: 'npub1test', displayName: 'Me', updatedAt: 1 } as never

const show = (url: string) =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <BackupPage profile={profile} />
    </MemoryRouter>,
  )

afterEach(() => {
  cleanup()
  localStorage.clear()
})

describe('the backup page opened from the key icon', () => {
  it('recommends a first backup for red', () => {
    show('/settings/backup?recommend=none')
    expect(screen.getByTestId('backup-recommendation').textContent).toMatch(/Back up your key\. There is no backup/)
  })

  it('recommends backing up again for orange, saying why', () => {
    show('/settings/backup?recommend=missing')
    expect(screen.getByTestId('backup-recommendation').textContent).toMatch(/could not be confirmed.*passphrase change/)
  })

  it('says nothing extra when opened normally, or with an unknown flag', () => {
    show('/settings/backup')
    expect(screen.queryByTestId('backup-recommendation')).toBeNull()
    cleanup()
    show('/settings/backup?recommend=verified')
    expect(screen.queryByTestId('backup-recommendation')).toBeNull()
  })
})

describe('the backup page opened from the blinking green key', () => {
  it('offers a remote backup when only a local file exists', () => {
    // Arrange
    const url = '/settings/backup?recommend=local'
    // Act
    show(url)
    // Assert
    expect(screen.getByTestId('backup-recommendation').textContent).toMatch(/backed up to a file.*Add a Google Drive backup/)
  })
})
