/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { generateSecretKey } from 'nostr-tools'
import { bytesToHex } from '@noble/hashes/utils'

import { keyStore, loadUnprotectedKey, NO_PASSPHRASE } from '../nap'

/**
 * The invariant the login screen bets on.
 *
 * "This device has no passphrase" is answered by asking the stored ciphertext,
 * not by reading a flag. If that answer is ever wrong in either direction the
 * customer is locked out of their own wallet — offered a button that cannot
 * open a protected key, or a passphrase field for a key that needs none.
 *
 * Real WebCrypto, not a stub. PBKDF2 over an empty string is the whole
 * mechanism, so a test that mocked it would prove nothing.
 */
const privkeyHex = bytesToHex(generateSecretKey())

beforeEach(async () => {
  localStorage.clear()
})

describe('loadUnprotectedKey', () => {
  it('returns the key when the device was set up without a passphrase', async () => {
    await keyStore.save(privkeyHex, NO_PASSPHRASE)

    await expect(loadUnprotectedKey()).resolves.toBe(privkeyHex)
  })

  it('returns null when the key is behind a passphrase', async () => {
    await keyStore.save(privkeyHex, 'correct horse battery staple')

    await expect(loadUnprotectedKey()).resolves.toBeNull()
  })

  it('returns null when there is no key at all', async () => {
    await expect(loadUnprotectedKey()).resolves.toBeNull()
  })

  it('sees a passphrase removed, and put back', async () => {
    // The Security screen does exactly this pair of calls. A stored flag would
    // be the thing that fails to keep up here.
    await keyStore.save(privkeyHex, 'a passphrase')
    await keyStore.save(await keyStore.loadKey('a passphrase'), NO_PASSPHRASE)
    await expect(loadUnprotectedKey()).resolves.toBe(privkeyHex)

    await keyStore.save(privkeyHex, 'another passphrase')
    await expect(loadUnprotectedKey()).resolves.toBeNull()
  })
})
