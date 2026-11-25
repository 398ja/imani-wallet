import { describe, expect, it } from 'vitest'

import { FILE_RECHECK_MAX_AGE_MS, deriveKeyBackupState } from '../keyBackupState'
import type { KeyBackup } from '../keyBackups'

const FP = 'a'.repeat(16)
const OLD = 'b'.repeat(16)
const NOW = 1_800_000_000_000

const b = (over: Partial<KeyBackup> = {}): KeyBackup => ({
  location: 'drive',
  deviceId: 'dev',
  deviceName: 'Laptop',
  createdAt: NOW - 1000,
  keyFingerprint: FP,
  ...over,
})

describe('deriveKeyBackupState', () => {
  it('is none with no recorded backup', () => {
    expect(deriveKeyBackupState([], { fingerprint: FP, now: NOW })).toBe('none')
  })

  it('is verified for a read-back Drive backup of the current key', () => {
    expect(deriveKeyBackupState([b({ lastVerifiedAt: NOW - 5 })], { fingerprint: FP, now: NOW })).toBe('verified')
  })

  it('is local (blinking green) for a recently re-checked file and no remote backup', () => {
    // Arrange
    const f = b({ location: 'file', lastVerifiedAt: NOW - 1000 })
    // Act
    const state = deriveKeyBackupState([f], { fingerprint: FP, now: NOW })
    // Assert
    expect(state).toBe('local')
  })

  it('is missing when the only backups hold an old key', () => {
    expect(deriveKeyBackupState([b({ keyFingerprint: OLD, lastVerifiedAt: NOW })], { fingerprint: FP, now: NOW })).toBe(
      'missing',
    )
  })

  it('is local for a file downloaded recently and never re-checked', () => {
    // Arrange
    const f = b({ location: 'file', createdAt: NOW - 1000 })
    // Act
    const state = deriveKeyBackupState([f], { fingerprint: FP, now: NOW })
    // Assert
    expect(state).toBe('local')
  })

  it('is missing for a file downloaded long ago and never re-checked', () => {
    // Arrange
    const f = b({ location: 'file', createdAt: NOW - FILE_RECHECK_MAX_AGE_MS - 1 })
    // Act
    const state = deriveKeyBackupState([f], { fingerprint: FP, now: NOW })
    // Assert
    expect(state).toBe('missing')
  })

  it('a re-download restarts the 90 days', () => {
    // Arrange
    const f = b({ location: 'file', createdAt: NOW - 2 * FILE_RECHECK_MAX_AGE_MS, lastSavedAt: NOW - 1000 })
    // Act
    const state = deriveKeyBackupState([f], { fingerprint: FP, now: NOW })
    // Assert
    expect(state).toBe('local')
  })

  it('is missing for a file not re-checked recently', () => {
    const f = b({ location: 'file', createdAt: NOW - FILE_RECHECK_MAX_AGE_MS - 5, lastVerifiedAt: NOW - FILE_RECHECK_MAX_AGE_MS - 1 })
    expect(deriveKeyBackupState([f], { fingerprint: FP, now: NOW })).toBe('missing')
  })

  it('a file re-check counts for 90 days, and not a day more', () => {
    const DAY = 24 * 60 * 60 * 1000
    expect(FILE_RECHECK_MAX_AGE_MS).toBe(90 * DAY)
    const at = (age: number) => deriveKeyBackupState([b({ location: 'file', createdAt: NOW - 100 * DAY, lastVerifiedAt: NOW - age })], { fingerprint: FP, now: NOW })
    expect(at(89 * DAY)).toBe('local')
    expect(at(90 * DAY)).toBe('local')
    expect(at(91 * DAY)).toBe('missing')
  })

  it('is missing when a live Drive listing no longer has the key', () => {
    const d = b({ lastVerifiedAt: NOW })
    expect(deriveKeyBackupState([d], { fingerprint: FP, now: NOW, driveFingerprints: new Set([OLD]) })).toBe('missing')
    expect(deriveKeyBackupState([d], { fingerprint: FP, now: NOW, driveFingerprints: new Set([FP]) })).toBe('verified')
  })

  it('is missing, never verified, when no key fingerprint can be read', () => {
    expect(deriveKeyBackupState([b({ lastVerifiedAt: NOW })], { fingerprint: null, now: NOW })).toBe('missing')
  })

  it('is missing, never verified, on an error', () => {
    const broken = [b({ lastVerifiedAt: NOW })]
    const evil = { get has() { throw new Error('boom') } } as unknown as Set<string>
    expect(deriveKeyBackupState(broken, { fingerprint: FP, now: NOW, driveFingerprints: evil })).toBe('missing')
  })

  describe('local and remote together', () => {
    const DAY = 24 * 60 * 60 * 1000
    const remote = b({ location: 'drive', lastVerifiedAt: NOW - DAY })
    const freshFile = b({ location: 'file', createdAt: NOW - DAY })
    const staleFile = b({ location: 'file', createdAt: NOW - 120 * DAY })
    const oldKeyFile = b({ location: 'file', createdAt: NOW - DAY, keyFingerprint: OLD })
    const unconfirmedRemote = b({ location: 'drive' })

    it.each([
      ['none', [], 'none'],
      ['local only', [freshFile], 'local'],
      ['remote only', [remote], 'verified'],
      ['both', [remote, freshFile], 'verified'],
      ['stale local and remote', [staleFile, remote], 'verified'],
      ['stale local only', [staleFile], 'missing'],
      ['old-key local only (passphrase changed)', [oldKeyFile], 'missing'],
      ['old-key local and remote', [oldKeyFile, remote], 'verified'],
      ['unconfirmed remote and local', [unconfirmedRemote, freshFile], 'local'],
      ['unconfirmed remote only', [unconfirmedRemote], 'missing'],
    ] as const)('%s', (_name, list, expected) => {
      // Arrange
      const options = { fingerprint: FP, now: NOW }
      // Act
      const state = deriveKeyBackupState(list, options)
      // Assert
      expect(state).toBe(expected)
    })

    it('a remote backup gone from a live Drive listing falls back to the local file', () => {
      // Arrange
      const options = { fingerprint: FP, now: NOW, driveFingerprints: new Set<string>() }
      // Act
      const state = deriveKeyBackupState([remote, freshFile], options)
      // Assert
      expect(state).toBe('local')
    })
  })
})
