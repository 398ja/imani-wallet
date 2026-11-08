/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from 'vitest'

import { applyBackup, createBackup, parseBackup } from '../backup'
import { loadBackupRecord, recordBackup } from '../backupRecord'
import { sweepAppStorage } from '../appStorage'
import { isKeptAcrossLogout } from '../unsavedReceipt'
import { loadProfile, saveProfile } from '../profile'
const KEYSTORE_STORAGE_KEY = 'imani-wallet-key'

const ALICE = 'a'.repeat(64)
const BOB = 'b'.repeat(64)

beforeEach(() => localStorage.clear())

describe('the backup record', () => {
  it('records each kind per account, with timestamps', () => {
    recordBackup(ALICE, 'drive', 10)
    recordBackup(ALICE, 'file', 20)
    expect(loadBackupRecord(ALICE)).toEqual({ drive: 10, file: 20 })
    expect(loadBackupRecord(BOB)).toEqual({})
  })

  it('survives logout while the rest of the app storage is swept', () => {
    recordBackup(ALICE, 'drive', 10)
    localStorage.setItem(`imani-wallet:profile:${ALICE}`, '{}')
    sweepAppStorage(isKeptAcrossLogout)
    expect(loadBackupRecord(ALICE)).toEqual({ drive: 10 })
    expect(localStorage.getItem(`imani-wallet:profile:${ALICE}`)).toBeNull()
  })

  it('travels in the backup file profile and is restored on a new device', async () => {
    localStorage.setItem(KEYSTORE_STORAGE_KEY, JSON.stringify({ ciphertext: 'c', kdf: 'k', iv: 'i' }))
    saveProfile({ pubkey: ALICE, npub: 'npub1x', updatedAt: 1 })
    recordBackup(ALICE, 'drive', 10)
    const text = createBackup(ALICE)
    expect(JSON.parse(text).profile.backups).toEqual({ drive: 10 })

    localStorage.clear()
    await applyBackup(parseBackup(text), async () => 'ab'.repeat(32))
    expect(loadBackupRecord(ALICE)).toEqual({ drive: 10 })
    expect(loadProfile(ALICE)).not.toHaveProperty('backups')
  })

  it('drops a malformed record from a file', () => {
    const parsed = parseBackup(
      JSON.stringify({
        format: 'imani-wallet-backup',
        version: 1,
        key: { ciphertext: 'c', kdf: 'k', iv: 'i' },
        profile: { pubkey: ALICE, npub: 'n', updatedAt: 1, backups: { drive: 'yes', file: 5 } },
      }),
    )
    expect(parsed.profile?.backups).toEqual({ file: 5 })
  })
})
