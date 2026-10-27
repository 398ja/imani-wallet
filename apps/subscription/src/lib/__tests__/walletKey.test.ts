/**
 * @vitest-environment jsdom
 *
 * The subscription site opens the stall's key from exactly what the WALLET writes: the envelope
 * its keystore puts in localStorage, and the backup file `createBackup` produces (the same file it
 * uploads to Drive). Both are produced here with the wallet's own code, then opened with the
 * site's, so a format change on either side fails this test.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools'
import { bytesToHex } from '@noble/hashes/utils'

import { keyStore } from '../../../../../src/lib/nap'
import { createBackup } from '../../../../../src/lib/backup'
import { saveProfile } from '../../../../../src/lib/profile'
import { KeyError, keyFromBackup, keyInThisBrowser, openKey } from '../walletKey'

const PASS = 'correct horse battery'

async function walletWithKey() {
  const sk = generateSecretKey()
  const pubkey = getPublicKey(sk)
  await keyStore.save(bytesToHex(sk), PASS)
  return { sk, pubkey }
}

afterEach(() => localStorage.clear())

describe('the wallet key in this browser', () => {
  it('is found, named from the wallet profile, and opens with the wallet passphrase', async () => {
    const { pubkey } = await walletWithKey()
    saveProfile({ pubkey, name: 'Mama Ngozi', display_name: 'Mama Ngozi' } as never)
    const found = keyInThisBrowser()!
    expect(found).toMatchObject({ source: 'browser', npub: nip19.npubEncode(pubkey), name: 'Mama Ngozi' })
    const opened = await openKey(found, PASS)
    expect(opened.pubkey).toBe(pubkey)
  })

  it('refuses a wrong passphrase and writes nothing', async () => {
    await walletWithKey()
    const before = JSON.stringify(localStorage)
    await expect(openKey(keyInThisBrowser()!, 'wrong')).rejects.toBeInstanceOf(KeyError)
    expect(JSON.stringify(localStorage)).toBe(before)
  })

  it('is absent when the wallet has never been used here', () => {
    expect(keyInThisBrowser()).toBeNull()
  })
})

describe('a wallet backup (file or Google Drive)', () => {
  it('opens the file the wallet downloads / uploads, and checks it names the same account', async () => {
    const { pubkey } = await walletWithKey()
    const file = createBackup(pubkey)
    localStorage.clear()
    const found = keyFromBackup(file, 'file')
    expect(found.npub).toBe(nip19.npubEncode(pubkey))
    expect((await openKey(found, PASS)).pubkey).toBe(pubkey)
    expect(localStorage.length).toBe(0)
  })

  it('refuses a file that is not a wallet backup, or a damaged one', async () => {
    expect(() => keyFromBackup('{"hello":1}', 'file')).toThrow(KeyError)
    expect(() => keyFromBackup('not json', 'drive')).toThrow(KeyError)
    const { pubkey } = await walletWithKey()
    const file = JSON.parse(createBackup(pubkey)) as Record<string, unknown>
    expect(() => keyFromBackup(JSON.stringify({ ...file, key: {} }), 'file')).toThrow(/damaged/)
    // A backup that names one account but carries another's key.
    const other = nip19.npubEncode(getPublicKey(generateSecretKey()))
    await expect(openKey(keyFromBackup(JSON.stringify({ ...file, npub: other }), 'file'), PASS)).rejects.toThrow(/does not match/)
  })
})
