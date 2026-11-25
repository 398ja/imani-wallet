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

  it('is verified for a recently re-checked file', () => {
    const f = b({ location: 'file', lastVerifiedAt: NOW - 1000 })
    expect(deriveKeyBackupState([f], { fingerprint: FP, now: NOW })).toBe('verified')
  })

  it('is missing when the only backups hold an old key', () => {
    expect(deriveKeyBackupState([b({ keyFingerprint: OLD, lastVerifiedAt: NOW })], { fingerprint: FP, now: NOW })).toBe(
      'missing',
    )
  })

  it('is missing for a file never re-checked', () => {
    expect(deriveKeyBackupState([b({ location: 'file' })], { fingerprint: FP, now: NOW })).toBe('missing')
  })

  it('is missing for a file not re-checked recently', () => {
    const f = b({ location: 'file', lastVerifiedAt: NOW - FILE_RECHECK_MAX_AGE_MS - 1 })
    expect(deriveKeyBackupState([f], { fingerprint: FP, now: NOW })).toBe('missing')
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
})
