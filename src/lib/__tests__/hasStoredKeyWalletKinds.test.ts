/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from 'vitest'

/**
 * Owner report 2026-10-14: a claim link on a device that already has a wallet must route to Login.
 * ClaimLandingPage routes on `hasStoredKey()`, so it must say yes for every kind of wallet the app
 * can leave on a device. All of them live in ONE encrypted localStorage slot, `imani-wallet-key`.
 */
import { hasStoredKey, keyStore } from '../nap'
import { applyBackup, parseBackup } from '../backup'
import { getPublicKey, nip19 } from 'nostr-tools'
import { hexToBytes } from '@noble/hashes/utils'

const HEX = '1'.repeat(64)
const SLOT = 'imani-wallet-key'

beforeEach(() => localStorage.clear())

describe('hasStoredKey detects every wallet a device can hold', () => {
  it('a fresh device has none', async () => {
    expect(await hasStoredKey()).toBe(false)
  })

  it('a registered customer or merchant (registration.ts and the nsec import both keyStore.save)', async () => {
    await keyStore.save(HEX, 'correct horse battery')
    expect(await hasStoredKey()).toBe(true)
  })

  it('an account restored from a backup file', async () => {
    await keyStore.save(HEX, 'pw-pw-pw-pw')
    const envelope = JSON.parse(localStorage.getItem(SLOT)!)
    localStorage.clear()
    const parsed = parseBackup(JSON.stringify({
      format: 'imani-wallet-backup', version: 1, createdAt: new Date().toISOString(),
      npub: nip19.npubEncode(getPublicKey(hexToBytes(HEX))), pubkey: getPublicKey(hexToBytes(HEX)), key: envelope, profile: null,
    }))
    await applyBackup(parsed, () => keyStore.loadKey('pw-pw-pw-pw'))
    expect(await hasStoredKey()).toBe(true)
  })

  it('a record written by an older or newer wallet version (migrated storage)', async () => {
    localStorage.setItem(SLOT, JSON.stringify({ version: 0, kdf: { iterations: 1 }, iv: 'x', ciphertext: 'y' }))
    expect(await hasStoredKey()).toBe(true)
    localStorage.setItem(SLOT, JSON.stringify({ version: 99 }))
    expect(await hasStoredKey()).toBe(true)
  })
})
