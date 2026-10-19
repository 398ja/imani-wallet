/**
 * @vitest-environment jsdom
 */
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { getPublicKey } from 'nostr-tools'
import { hexToBytes } from '@noble/hashes/utils'

/**
 * #330: importing a key, opening a backup or registering while ANOTHER wallet's
 * data is on the device must not replace its key (that orphaned its vouchers).
 * Same-account re-import stays allowed. Driven through the real key store and
 * the real `applyBackup`.
 */

const { keyStore } = await import('../nap')
const { applyBackup, parseBackup } = await import('../backup')
const { refuseIfAnotherWallet, accountsOnDevice, OTHER_WALLET_COPY, OtherWalletOnDeviceError } = await import(
  '../keySlotGuard'
)
const { JARGON } = await import('../userMessage')

const A = '1'.repeat(64)
const B = '2'.repeat(64)
const pk = (hex: string) => getPublicKey(hexToBytes(hex))
const SLOT = 'imani-wallet-key'

async function holdWallet(hex: string, passphrase = 'pass-a-pass-a') {
  await keyStore.save(hex, passphrase)
  localStorage.setItem(`imani-wallet:profile:${pk(hex)}`, JSON.stringify({ pubkey: pk(hex) }))
}

beforeEach(async () => {
  localStorage.clear()
  for (const db of (await indexedDB.databases()) ?? []) if (db.name) indexedDB.deleteDatabase(db.name)
})

describe('the guard', () => {
  it('an empty slot is never refused', async () => {
    await expect(refuseIfAnotherWallet(B)).resolves.toBeUndefined()
  })

  it('another account in the slot is refused, in plain words', async () => {
    await holdWallet(A)
    await expect(refuseIfAnotherWallet(B)).rejects.toThrow(OTHER_WALLET_COPY)
    expect(JARGON.test(OTHER_WALLET_COPY)).toBe(false)
  })

  it('the same account is allowed back in', async () => {
    await holdWallet(A)
    await expect(refuseIfAnotherWallet(A)).resolves.toBeUndefined()
  })

  it('a taken slot whose account cannot be told is refused (the safe direction)', async () => {
    await keyStore.save(A, 'pass-a-pass-a')
    await expect(refuseIfAnotherWallet(A)).rejects.toBeInstanceOf(OtherWalletOnDeviceError)
  })

  it("another account's wallet store counts, even with no records beside it", async () => {
    await keyStore.save(A, 'pass-a-pass-a')
    await new Promise<void>((resolve) => {
      const req = indexedDB.open(`imani-wallet-${pk(A)}`)
      req.onsuccess = () => (req.result.close(), resolve())
    })
    expect(await accountsOnDevice()).toEqual(new Set([pk(A)]))
    await expect(refuseIfAnotherWallet(A)).resolves.toBeUndefined()
    await expect(refuseIfAnotherWallet(B)).rejects.toThrow(OTHER_WALLET_COPY)
  })

  it("the merchant branding cache (other people's keys) does not count as an account", async () => {
    await holdWallet(A)
    localStorage.setItem(`imani-wallet:identity:${pk(B)}`, '{}')
    await expect(refuseIfAnotherWallet(A)).resolves.toBeUndefined()
  })
})

describe('opening a backup (BackupLogin, applyBackup)', () => {
  async function backupOf(hex: string, passphrase: string) {
    const previous = localStorage.getItem(SLOT)
    await keyStore.save(hex, passphrase)
    const key = JSON.parse(localStorage.getItem(SLOT)!)
    if (previous === null) localStorage.removeItem(SLOT)
    else localStorage.setItem(SLOT, previous)
    return parseBackup(JSON.stringify({ format: 'imani-wallet-backup', version: 1, key, profile: null }))
  }

  it("another account's backup is refused and the device's key is left exactly as it was", async () => {
    await holdWallet(A)
    const before = localStorage.getItem(SLOT)
    const backup = await backupOf(B, 'pass-b-pass-b')
    await expect(applyBackup(backup, () => keyStore.loadKey('pass-b-pass-b'))).rejects.toThrow(OTHER_WALLET_COPY)
    expect(localStorage.getItem(SLOT)).toBe(before)
    await expect(keyStore.loadKey('pass-a-pass-a')).resolves.toBe(A)
  })

  it("the same account's backup is allowed", async () => {
    await holdWallet(A)
    const backup = await backupOf(A, 'other-passphrase')
    await expect(applyBackup(backup, () => keyStore.loadKey('other-passphrase'))).resolves.toMatchObject({
      privkeyHex: A,
    })
  })

  it('on an empty device it is allowed', async () => {
    const backup = await backupOf(B, 'pass-b-pass-b')
    await expect(applyBackup(backup, () => keyStore.loadKey('pass-b-pass-b'))).resolves.toMatchObject({
      privkeyHex: B,
    })
  })
})
