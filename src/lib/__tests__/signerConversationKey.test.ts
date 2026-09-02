/**
 * The signer's conversation-key cache.
 *
 * `nip44.getConversationKey` is an ECDH — a full elliptic-curve scalar
 * multiplication — and it depends only on the two keys involved, so for a
 * given peer it produces the same 32 bytes every time. Restoring a wallet
 * decrypts one relay record per coupon, all addressed to the customer's own
 * pubkey, so that derivation was being repeated once per coupon: ~450ms of the
 * ~1000ms a 120-coupon wallet spent settling after unlock (#42).
 *
 * The speed is the easy part. What these tests are really for is the cache's
 * LIFETIME: it holds key material derived from the secret, so it must not
 * outlive the lock. A cache that survives `clearKey()` leaves the wallet
 * decryptable while it reports being locked, which is a worse bug than the one
 * the cache fixes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { generateSecretKey, getPublicKey, nip44 } from 'nostr-tools'
import { bytesToHex } from '@noble/hashes/utils'

import { createWalletSigner, SessionLockedError } from '../signer'

/**
 * `nostr-tools` exports `nip44` as a frozen module namespace, so the
 * derivation cannot be spied on directly. Counting the ECDH by its COST is the
 * honest alternative anyway: it is the expense that motivated the cache, and a
 * measurement of it cannot be satisfied by a mock that merely looks right.
 */
function derivationsIn(fn: () => void, oneDerivationMs: number): number {
  const started = performance.now()
  fn()
  return Math.round((performance.now() - started) / oneDerivationMs)
}

/** What a single uncached derivation costs on this machine, right now. */
function costOfOneDerivation(): number {
  const sk = generateSecretKey()
  const pk = getPublicKey(generateSecretKey())
  const started = performance.now()
  for (let i = 0; i < 5; i++) nip44.getConversationKey(sk, pk)
  return (performance.now() - started) / 5
}

const privkey = bytesToHex(generateSecretKey())
const pubkey = getPublicKey(Uint8Array.from(Buffer.from(privkey, 'hex')))

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('nip44 round trip', () => {
  it('still decrypts what it encrypted', () => {
    // The cache must not change the answer, only how often it is computed.
    const signer = createWalletSigner(privkey)

    const sealed = signer.nip44Encrypt(signer.pubkey, 'a coupon record')

    expect(signer.nip44Decrypt(signer.pubkey, sealed)).toBe('a coupon record')
  })

  it('produces ciphertext a fresh signer can read', () => {
    // Proves the cached key is the real conversation key and not something
    // that only round-trips against itself.
    const a = createWalletSigner(privkey)
    const b = createWalletSigner(privkey)

    expect(b.nip44Decrypt(b.pubkey, a.nip44Encrypt(a.pubkey, 'shared'))).toBe('shared')
  })

  it('reads a record encrypted outside the signer entirely', () => {
    const signer = createWalletSigner(privkey)
    const key = nip44.getConversationKey(
      Uint8Array.from(Buffer.from(privkey, 'hex')),
      pubkey,
    )

    expect(signer.nip44Decrypt(pubkey, nip44.encrypt('from elsewhere', key))).toBe(
      'from elsewhere',
    )
  })
})

describe('the cache', () => {
  it('derives the conversation key once per peer', () => {
    const one = costOfOneDerivation()
    const signer = createWalletSigner(privkey)
    // Warm the cache, so the loop below measures only the encryption.
    signer.nip44Encrypt(signer.pubkey, 'warm')

    const derivations = derivationsIn(() => {
      for (let i = 0; i < 40; i++) signer.nip44Encrypt(signer.pubkey, `record ${i}`)
    }, one)

    // The bug: 40 encryptions cost 40 derivations, because restoring a wallet
    // decrypts one record per coupon and all of them address the same peer.
    // Uncached this would be ≥40; cached it is a small fraction of one.
    expect(derivations).toBeLessThan(10)
  })

  it('keeps a separate key per peer', () => {
    // Two peers must not share one key, which would seal a record into the
    // wrong conversation. Checked by the answer, not by counting: a shared
    // key still round-trips against itself and would pass a call count.
    const signer = createWalletSigner(privkey)
    const otherSk = generateSecretKey()
    const other = getPublicKey(otherSk)

    const mine = signer.nip44Encrypt(signer.pubkey, 'mine')
    const theirs = signer.nip44Encrypt(other, 'theirs')

    expect(signer.nip44Decrypt(signer.pubkey, mine)).toBe('mine')
    expect(signer.nip44Decrypt(other, theirs)).toBe('theirs')
    // And the peer really can read what was addressed to them.
    const peerKey = nip44.getConversationKey(otherSk, signer.pubkey)
    expect(nip44.decrypt(theirs, peerKey)).toBe('theirs')
  })
})

describe('locking', () => {
  it('cannot decrypt once locked', () => {
    // The property that matters. A cached conversation key surviving the lock
    // would leave the wallet readable while it claims to be locked.
    const signer = createWalletSigner(privkey)
    const sealed = signer.nip44Encrypt(signer.pubkey, 'secret')

    signer.clearKey()

    expect(() => signer.nip44Decrypt(signer.pubkey, sealed)).toThrow(SessionLockedError)
  })

  it('works again after an unlock, and still round trips', () => {
    const signer = createWalletSigner(privkey)
    const before = signer.nip44Encrypt(signer.pubkey, 'before')

    signer.clearKey()
    signer.setKey(privkey)

    // Re-derived rather than served from a cache that outlived the lock — and
    // still the right key, since it reads what the pre-lock signer wrote.
    expect(signer.nip44Decrypt(signer.pubkey, before)).toBe('before')
    expect(signer.nip44Decrypt(signer.pubkey, signer.nip44Encrypt(signer.pubkey, 'after'))).toBe(
      'after',
    )
  })

  it('refuses a restored key for a different identity, cache or not', () => {
    const signer = createWalletSigner(privkey)
    signer.nip44Encrypt(signer.pubkey, 'mine')
    signer.clearKey()

    expect(() => signer.setKey(bytesToHex(generateSecretKey()))).toThrow(/different identity/i)
  })
})
