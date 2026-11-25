/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * "Check my backups": every known backup of the current key is checked where it is, with no
 * location asked for. Two things make a good backup: it is still there, and the key in it is this
 * npub's. The key icon follows from what the check records.
 */

vi.mock('../nap', () => ({ getSigner: () => { throw new Error('locked') } }))
vi.mock('../relay', () => ({ allEvents: vi.fn(async () => { throw new Error('offline') }) }))
vi.mock('../relayDelivery', () => ({ deliverToRelay: vi.fn(async () => ({ delivered: false, why: 'unreachable' })) }))
vi.mock('../transferSignature', () => ({ mirrorToGateway: vi.fn(async () => false) }))

const { nip19 } = await import('nostr-tools')
const kb = await import('../keyBackups')
const { checkKeyBackups } = await import('../keyBackupCheck')
const { currentKeyBackupState } = await import('../keyBackupState')
const { DriveError, CANCELLED } = await import('../googleToken')
type ReadSaved = import('../backupFileStore').ReadSaved

const PK = 'ab'.repeat(32)
const OTHER = 'cd'.repeat(32)
const ENVELOPE = { ciphertext: 'c1', kdf: 'k', iv: 'i' }
const OLD_ENVELOPE = { ciphertext: 'c0', kdf: 'k', iv: 'i' }
const NOW = 1_800_000_000_000
const DAY = 24 * 60 * 60 * 1000

function backup(envelope: object, pubkey = PK, npub = nip19.npubEncode(pubkey)) {
  return JSON.stringify({ format: 'imani-wallet-backup', version: 1, npub, pubkey, key: envelope, profile: null })
}

function ports(over: { drive?: string | null | Error; file?: ReadSaved; configured?: boolean } = {}) {
  const calls = { drive: 0, file: 0 }
  return {
    calls,
    ports: {
      readDrive: async () => {
        calls.drive++
        if (over.drive instanceof Error) throw over.drive
        return over.drive === undefined ? backup(ENVELOPE) : over.drive
      },
      driveConfigured: () => over.configured ?? true,
      readFile: async () => {
        calls.file++
        return over.file ?? { kind: 'text' as const, text: backup(ENVELOPE) }
      },
      now: () => NOW,
    },
  }
}

const fp = () => kb.envelopeFingerprint(ENVELOPE)

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('imani-wallet-key', JSON.stringify(ENVELOPE))
})

describe('validateBackupText: present and holding this npub’s key', () => {
  it('accepts a backup whose npub, pubkey and key are this account’s current ones', () => {
    // Arrange
    const text = backup(ENVELOPE)

    // Act
    const result = kb.validateBackupText(PK, text)

    // Assert
    expect(result).toBe('ok')
  })

  it('refuses a backup whose npub names another account, even with the right pubkey field', () => {
    // Arrange
    const text = backup(ENVELOPE, PK, nip19.npubEncode(OTHER))

    // Act
    const result = kb.validateBackupText(PK, text)

    // Assert
    expect(result).toBe('other-account')
  })

  it('refuses a backup of another account, an older key, and anything that is not a backup', () => {
    // Arrange
    const inputs = [backup(ENVELOPE, OTHER), backup(OLD_ENVELOPE), 'not json', '{"format":"x"}', backup(ENVELOPE, PK, 'npub1garbage')]

    // Act
    const results = inputs.map((t) => kb.validateBackupText(PK, t))

    // Assert
    expect(results).toEqual(['other-account', 'stale', 'not-a-backup', 'not-a-backup', 'other-account'])
  })
})

describe('checking a file this device saved', () => {
  it('opens it where it was saved, finds this npub’s key, and records it as checked', async () => {
    // Arrange
    kb.recordKeyBackup(PK, 'file', { fileName: 'b.json', at: NOW - 200 * DAY })
    const { ports: p, calls } = ports()

    // Act
    const result = await checkKeyBackups(PK, p)

    // Assert
    expect(calls.file).toBe(1)
    expect(result.files[0].result).toEqual({ kind: 'ok' })
    expect(kb.loadKeyBackups(PK)[0].lastVerifiedAt).toBe(NOW)
    expect(currentKeyBackupState(PK, NOW)).toBe('local')
  })

  it('a file that is gone stops counting: orange, and logout no longer relies on it', async () => {
    // Arrange
    kb.recordKeyBackup(PK, 'file', { fileName: 'b.json', at: NOW - DAY })
    const { ports: p } = ports({ file: { kind: 'gone' } })

    // Act
    const result = await checkKeyBackups(PK, p)

    // Assert
    expect(result.files[0].result).toEqual({ kind: 'gone' })
    expect(currentKeyBackupState(PK, NOW)).toBe('missing')
    expect((await kb.checkKeyBackup(PK, async () => null, 0)).ok).toBe(false)
  })

  it('a file holding another npub or an older key stops counting', async () => {
    // Arrange
    kb.recordKeyBackup(PK, 'file', { fileName: 'b.json', at: NOW - DAY })
    const { ports: p } = ports({ file: { kind: 'text', text: backup(ENVELOPE, PK, nip19.npubEncode(OTHER)) } })

    // Act
    const result = await checkKeyBackups(PK, p)

    // Assert
    expect(result.files[0].result).toEqual({ kind: 'mismatch', why: 'other-account' })
    expect(currentKeyBackupState(PK, NOW)).toBe('missing')
  })

  it('a file that could not be opened just now changes nothing', async () => {
    // Arrange
    kb.recordKeyBackup(PK, 'file', { fileName: 'b.json', at: NOW - DAY })
    const { ports: p } = ports({ file: { kind: 'unreadable' } })

    // Act
    const result = await checkKeyBackups(PK, p)

    // Assert
    expect(result.files[0].result).toEqual({ kind: 'unreadable' })
    expect(currentKeyBackupState(PK, NOW)).toBe('local')
  })

  it('a file whose location this device never learnt (a browser download) is judged from its record', async () => {
    // Arrange
    kb.recordKeyBackup(PK, 'file', { fileName: 'b.json', at: NOW - DAY })
    const { ports: p } = ports({ file: { kind: 'unknown' } })

    // Act
    const result = await checkKeyBackups(PK, p)

    // Assert
    expect(result.files[0].result).toEqual({ kind: 'unlocated', current: true, countsUntil: NOW - DAY + 90 * DAY })
    expect(currentKeyBackupState(PK, NOW)).toBe('local')
  })

  it('a file saved on another device is not opened here', async () => {
    // Arrange
    kb.mergeLocalKeyBackups(PK, [
      { location: 'file', deviceId: 'other-device', deviceName: 'Phone', createdAt: NOW - DAY, keyFingerprint: fp(), fileName: 'p.json' },
    ])
    const { ports: p, calls } = ports()

    // Act
    const result = await checkKeyBackups(PK, p)

    // Assert
    expect(calls.file).toBe(0)
    expect(result.files[0].result.kind).toBe('unlocated')
  })

  it('a later save of the file counts again after it was found gone', async () => {
    // Arrange
    kb.recordKeyBackup(PK, 'file', { fileName: 'b.json', at: NOW - DAY })
    await checkKeyBackups(PK, ports({ file: { kind: 'gone' } }).ports)

    // Act
    kb.recordKeyBackup(PK, 'file', { fileName: 'b.json', at: NOW + 1000 })

    // Assert
    expect(currentKeyBackupState(PK, NOW + 1000)).toBe('local')
  })
})

describe('checking Google Drive', () => {
  it('reads the account’s file back with no listing to choose from: steady green', async () => {
    // Arrange
    kb.recordKeyBackup(PK, 'drive', { verified: true, at: NOW - DAY })
    const { ports: p, calls } = ports()

    // Act
    const result = await checkKeyBackups(PK, p)

    // Assert
    expect(calls.drive).toBe(1)
    expect(result.drive).toBe('ok')
    expect(currentKeyBackupState(PK, NOW)).toBe('verified')
  })

  it('Drive gone, or holding an older key: the record stops vouching for it', async () => {
    // Arrange
    kb.recordKeyBackup(PK, 'drive', { verified: true, at: NOW - DAY })

    // Act
    const gone = await checkKeyBackups(PK, ports({ drive: null }).ports)

    // Assert
    expect(gone.drive).toBe('gone')
    expect(currentKeyBackupState(PK, NOW)).toBe('missing')
    expect((await kb.checkKeyBackup(PK, async () => null, 0)).ok).toBe(false)
    const old = await checkKeyBackups(PK, ports({ drive: backup(OLD_ENVELOPE) }).ports)
    expect(old.drive).toBe('old-key')
  })

  it('Drive unreachable or sign-in closed: nothing changes', async () => {
    // Arrange
    kb.recordKeyBackup(PK, 'drive', { verified: true, at: NOW - DAY })

    // Act
    const offline = await checkKeyBackups(PK, ports({ drive: new Error('network') }).ports)
    const cancelled = await checkKeyBackups(PK, ports({ drive: new DriveError(CANCELLED) }).ports)

    // Assert
    expect([offline.drive, cancelled.drive]).toEqual(['unreachable', 'cancelled'])
    expect(currentKeyBackupState(PK, NOW)).toBe('verified')
  })

  it('a missing mark syncs: another device merging it sees the Drive backup as unconfirmed', () => {
    // Arrange
    const entry = kb.recordKeyBackup(PK, 'drive', { verified: true, at: NOW - DAY })!

    // Act
    const merged = kb.mergeKeyBackups([entry], [{ ...entry, lastMissingAt: NOW }])

    // Assert
    expect(kb.driveConfirmed(merged[0])).toBe(false)
  })
})

describe('checking both', () => {
  it('checks the local and the remote backup in one go, without asking where either is', async () => {
    // Arrange
    kb.recordKeyBackup(PK, 'drive', { verified: true, at: NOW - DAY })
    kb.recordKeyBackup(PK, 'file', { fileName: 'b.json', at: NOW - DAY })
    const { ports: p, calls } = ports()

    // Act
    const result = await checkKeyBackups(PK, p)

    // Assert
    expect(calls).toEqual({ drive: 1, file: 1 })
    expect(result.drive).toBe('ok')
    expect(result.files.map((f) => f.result.kind)).toEqual(['ok'])
  })

  it('Drive gone but the file fine: blinking green, not orange', async () => {
    // Arrange
    kb.recordKeyBackup(PK, 'drive', { verified: true, at: NOW - DAY })
    kb.recordKeyBackup(PK, 'file', { fileName: 'b.json', at: NOW - DAY })

    // Act
    await checkKeyBackups(PK, ports({ drive: null }).ports)

    // Assert
    expect(currentKeyBackupState(PK, NOW)).toBe('local')
  })

  it('with no known backup, asks nothing and says so', async () => {
    // Arrange
    const { ports: p, calls } = ports()

    // Act
    const result = await checkKeyBackups(PK, p)

    // Assert
    expect(result).toEqual({ drive: null, files: [], none: true })
    expect(calls).toEqual({ drive: 0, file: 0 })
  })
})
