/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * #348: logout is refused, with no override, until a known backup holds THIS key. These pin the
 * device id, the merge, the fingerprint rule (a backup of an older envelope does not count), the
 * offline gate, the plain-words copy, and the file re-check.
 */

vi.mock('../nap', () => ({ getSigner: () => { throw new Error('locked') } }))
vi.mock('../relay', () => ({ allEvents: vi.fn(async () => { throw new Error('offline') }), publish: vi.fn() }))
vi.mock('../transferSignature', () => ({ mirrorToGateway: vi.fn(async () => false) }))

const kb = await import('../keyBackups')
const { isKeptAcrossLogout } = await import('../unsavedReceipt')

const PK = 'ab'.repeat(32)
const ENVELOPE = { ciphertext: 'c1', kdf: 'k', iv: 'i' }
const NEW_ENVELOPE = { ciphertext: 'c2', kdf: 'k', iv: 'i' }

function holdKey(envelope: object) {
  localStorage.setItem('imani-wallet-key', JSON.stringify(envelope))
}

function backupFile(pubkey: string, envelope: object) {
  return JSON.stringify({ format: 'imani-wallet-backup', version: 1, pubkey, key: envelope, profile: null })
}

beforeEach(() => {
  localStorage.clear()
  holdKey(ENVELOPE)
})

describe('device identity', () => {
  it('is a random id made once per install, with a friendly name', () => {
    const id = kb.deviceId()
    expect(id).toMatch(/^[0-9a-f]{32}$/)
    expect(kb.deviceId()).toBe(id)
    expect(kb.friendlyDeviceName('Mozilla/5.0 (Linux; Android 14) AppleWebKit Chrome/120 Mobile Safari/537')).toBe('Chrome on Android')
    expect(kb.friendlyDeviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit Version/17 Mobile Safari/604')).toBe('Safari on iPhone')
    expect(kb.friendlyDeviceName('Mozilla/5.0 (Windows NT 10.0; rv:120) Gecko Firefox/120')).toBe('Firefox on Windows')
  })

  it('the id and the list survive the logout sweep', () => {
    expect(kb.DEVICE_ID_KEY.startsWith('imani-wallet:')).toBe(false)
    expect(isKeptAcrossLogout(kb.KEY_BACKUPS_PREFIX + PK)).toBe(true)
  })
})

describe('the list', () => {
  it('records a backup with location, device, times and fingerprint', () => {
    const b = kb.recordKeyBackup(PK, 'drive', { verified: true, at: 1000 })
    expect(b).toMatchObject({ location: 'drive', deviceId: kb.deviceId(), createdAt: 1000, lastVerifiedAt: 1000 })
    expect(b?.keyFingerprint).toBe(kb.envelopeFingerprint(ENVELOPE))
    expect(kb.loadKeyBackups(PK)).toHaveLength(1)
  })

  it('merges as a union: never forgets a location, keeps the latest check', () => {
    const base = { location: 'file' as const, deviceId: 'd1', deviceName: 'Chrome on Android', keyFingerprint: 'a'.repeat(16) }
    const merged = kb.mergeKeyBackups(
      [{ ...base, createdAt: 5 }],
      [{ ...base, createdAt: 9, lastVerifiedAt: 20 }, { ...base, deviceId: 'd2', createdAt: 3 }],
    )
    expect(merged).toHaveLength(2)
    expect(merged.find((b) => b.deviceId === 'd1')).toMatchObject({ createdAt: 5, lastVerifiedAt: 20 })
    // Commutative.
    expect(kb.mergeKeyBackups([{ ...base, createdAt: 9, lastVerifiedAt: 20 }, { ...base, deviceId: 'd2', createdAt: 3 }], [{ ...base, createdAt: 5 }])).toEqual(merged)
  })

  it('drops malformed entries from a record', () => {
    expect(kb.mergeKeyBackups([{ location: 'usb' } as never, { location: 'drive', deviceId: 'x', keyFingerprint: 'zz', createdAt: 1 } as never])).toEqual([])
  })
})

describe('the logout gate', () => {
  const offline = async () => null

  it('refuses with no backup known', async () => {
    await expect(kb.checkKeyBackup(PK, offline)).resolves.toEqual({ ok: false, backups: [] })
  })

  it('one location is enough, and it works offline', async () => {
    kb.recordKeyBackup(PK, 'file', { fileName: 'imani-wallet-backup-ana.json' })
    const out = await kb.checkKeyBackup(PK, offline)
    expect(out.ok).toBe(true)
    expect(out.backups[0]).toMatchObject({ location: 'file', fileName: 'imani-wallet-backup-ana.json' })
  })

  it('a backup of an OLDER envelope (before a passphrase change) does not count', async () => {
    kb.recordKeyBackup(PK, 'drive', { verified: true })
    holdKey(NEW_ENVELOPE)
    await expect(kb.checkKeyBackup(PK, offline)).resolves.toMatchObject({ ok: false })
  })

  it('counts a backup another device made, read from the relay record', async () => {
    const elsewhere = { location: 'drive' as const, deviceId: 'other', deviceName: 'Safari on iPhone', createdAt: 1, lastVerifiedAt: 1, keyFingerprint: kb.envelopeFingerprint(ENVELOPE) }
    const out = await kb.checkKeyBackup(PK, async (pk) => kb.mergeLocalKeyBackups(pk, [elsewhere]))
    expect(out).toMatchObject({ ok: true })
  })

  it('a relay that hangs does not hold logout: it decides on what this device knows', async () => {
    kb.recordKeyBackup(PK, 'file')
    const out = await kb.checkKeyBackup(PK, () => new Promise(() => {}), 10)
    expect(out.ok).toBe(true)
  })
})

describe('plain words', () => {
  it('names Drive private storage and a file in Downloads, plus the reminder', () => {
    const drive = kb.recordKeyBackup(PK, 'drive', { verified: true })!
    const file = kb.recordKeyBackup(PK, 'file', { fileName: 'imani-wallet-backup-ana.json' })!
    expect(kb.describeKeyBackup(drive)).toMatch(/Google Drive \(in the app's private storage, so it doesn't appear in your file list\)/)
    expect(kb.describeKeyBackup(file)).toBe('The file imani-wallet-backup-ana.json, in your Downloads on this device')
    expect(kb.describeKeyBackup({ ...file, deviceId: 'other', deviceName: 'Safari on iPhone' })).toMatch(/saved on Safari on iPhone/)
    const lines = kb.logoutBackupLines([drive, file])
    expect(lines).toMatch(/Do not delete it/)
    expect(lines).toMatch(/get back into your wallet/)
  })

  it('the refusal offers no override and no jargon', () => {
    expect(kb.KEY_BACKUP_COPY.blocked).not.toMatch(/anyway|nsec|npub|relay|nostr/i)
    expect(kb.KEY_BACKUP_COPY.blocked).toMatch(/Nothing has been erased/)
  })
})

describe('re-checking a file', () => {
  it('a file of this key is recorded as checked', () => {
    expect(kb.verifyBackupFile(PK, backupFile(PK, ENVELOPE), 'b.json')).toBe('ok')
    expect(kb.loadKeyBackups(PK)[0]).toMatchObject({ location: 'file', fileName: 'b.json' })
    expect(kb.loadKeyBackups(PK)[0].lastVerifiedAt).toBeGreaterThan(0)
  })

  it('refuses another account, an old envelope, and a non-backup, recording nothing', () => {
    expect(kb.verifyBackupFile(PK, backupFile('cd'.repeat(32), ENVELOPE))).toBe('other-account')
    expect(kb.verifyBackupFile(PK, backupFile(PK, NEW_ENVELOPE))).toBe('stale')
    expect(kb.verifyBackupFile(PK, 'not json')).toBe('not-a-backup')
    expect(kb.verifyBackupFile(PK, '{"format":"x"}')).toBe('not-a-backup')
    expect(kb.loadKeyBackups(PK)).toEqual([])
  })
})
