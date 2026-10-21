/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from 'vitest'

import { applyBackup, parseBackup } from '../backup'
import { loadProfile, saveProfile, type Profile } from '../profile'

/**
 * Second review of #358: a restore never erases, or replaces, the acceptance this device holds.
 *
 * Reachable on a device that keeps an account's record: a legacy account finishes its profile on
 * its own card (acceptance recorded locally), then logs in again on the same device from a backup
 * file written before that (no acceptance). `applyBackup` used to write the file's profile over
 * the record wholesale, so the acceptance was gone, and the next Drive backup would upload the
 * record without it. The earliest acceptance is the one that counts, wherever it came from.
 */
const PUBKEY = '4728fd8ad6a2f5c8930f4065347907e22186fba6c73bd04e145dfd780b98e451'
const URL_ = 'https://www.imani.casa/terms.html'
const envelope = { version: 1, kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: 310000, salt: 'c2FsdA==' }, iv: 'aXY=', ciphertext: 'x' }

const backupWith = (profile: Partial<Profile>) =>
  parseBackup(
    JSON.stringify({
      format: 'imani-wallet-backup',
      version: 1,
      createdAt: '2026-10-01T00:00:00.000Z',
      key: envelope,
      profile: { pubkey: PUBKEY, npub: 'npub1x', updatedAt: 1, ...profile },
    }),
  )

const local = (termsAccepted?: Profile['termsAccepted']) =>
  saveProfile({ pubkey: PUBKEY, npub: 'npub1x', nip05: 'alice@imani.local', updatedAt: 2, termsAccepted })

beforeEach(() => localStorage.clear())

describe('a restore keeps the earliest Terms and Conditions acceptance (second review of #358)', () => {
  it('a backup without an acceptance does not erase the one this device holds', async () => {
    local({ url: URL_, acceptedAt: 100 })
    const { profile } = await applyBackup(backupWith({ displayName: 'Alice' }), async () => 'k')
    expect(loadProfile(PUBKEY)?.termsAccepted).toEqual({ url: URL_, acceptedAt: 100 })
    expect(loadProfile(PUBKEY)?.displayName).toBe('Alice')
    expect(profile?.termsAccepted).toEqual({ url: URL_, acceptedAt: 100 })
  })

  it('a backup with a later acceptance does not replace the earlier one held here', async () => {
    local({ url: URL_, acceptedAt: 100 })
    await applyBackup(backupWith({ termsAccepted: { url: URL_, acceptedAt: 500 } }), async () => 'k')
    expect(loadProfile(PUBKEY)?.termsAccepted).toEqual({ url: URL_, acceptedAt: 100 })
  })

  it('a backup with an earlier acceptance wins over a later one held here', async () => {
    local({ url: URL_, acceptedAt: 500 })
    await applyBackup(backupWith({ termsAccepted: { url: URL_, acceptedAt: 100 } }), async () => 'k')
    expect(loadProfile(PUBKEY)?.termsAccepted).toEqual({ url: URL_, acceptedAt: 100 })
  })

  it("a fresh device takes the backup's acceptance, and none stays none", async () => {
    await applyBackup(backupWith({ termsAccepted: { url: URL_, acceptedAt: 7 } }), async () => 'k')
    expect(loadProfile(PUBKEY)?.termsAccepted).toEqual({ url: URL_, acceptedAt: 7 })
    localStorage.clear()
    await applyBackup(backupWith({}), async () => 'k')
    expect(loadProfile(PUBKEY)).not.toBeNull()
    expect(loadProfile(PUBKEY)?.termsAccepted).toBeUndefined()
  })

  it('a malformed acceptance held here is not carried over', async () => {
    local({ url: 'javascript:alert(1)', acceptedAt: 1 } as never)
    await applyBackup(backupWith({}), async () => 'k')
    expect(loadProfile(PUBKEY)?.termsAccepted).toBeUndefined()
  })

  it('a refused restore (wrong passphrase) leaves the record as it was', async () => {
    local({ url: URL_, acceptedAt: 100 })
    await expect(applyBackup(backupWith({}), () => Promise.reject(new Error('Invalid passphrase')))).rejects.toThrow()
    expect(loadProfile(PUBKEY)?.termsAccepted).toEqual({ url: URL_, acceptedAt: 100 })
  })
})
