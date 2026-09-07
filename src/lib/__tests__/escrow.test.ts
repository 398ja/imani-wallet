/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools'
import { bytesToHex } from '@noble/hashes/utils'

import { createEscrow, parseEscrow, nsecProtected, EscrowError, type EscrowFile } from '../escrow'

const KEYSTORE_STORAGE_KEY = 'imani-wallet-key'

const sk = generateSecretKey()
const privkeyHex = bytesToHex(sk)
const pubkey = getPublicKey(sk)
const npub = nip19.npubEncode(pubkey)

/** Shaped like nap's envelope. Opaque to escrow.ts, so the values do not matter. */
const envelope = {
  version: 1,
  kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: 310000, salt: 'c2FsdA==' },
  iv: 'aXY=',
  ciphertext: 'Y2lwaGVy',
}

beforeEach(() => {
  localStorage.clear()
})

describe('createEscrow', () => {
  it('copies the stored envelope when no key is passed', () => {
    localStorage.setItem(KEYSTORE_STORAGE_KEY, JSON.stringify(envelope))

    const file = JSON.parse(createEscrow(pubkey)) as EscrowFile

    expect(file.npub).toBe(npub)
    expect(file.pubkey).toBe(pubkey)
    expect(file.nsec).toEqual(envelope)
  })

  it('writes the key as hex when one is passed', () => {
    const file = JSON.parse(createEscrow(pubkey, privkeyHex)) as EscrowFile

    expect(file.nsec).toBe(privkeyHex)
    // The whole reason the npub is stored in the clear: restore has to name the
    // account before it asks for anything.
    expect(file.npub).toBe(npub)
  })

  it('refuses to escrow when the browser holds no key', () => {
    expect(() => createEscrow(pubkey)).toThrow(EscrowError)
  })
})

describe('parseEscrow', () => {
  const write = (overrides: Partial<EscrowFile>): string =>
    JSON.stringify({
      format: 'imani-wallet-escrow',
      version: 1,
      createdAt: '2026-09-07T00:00:00.000Z',
      npub,
      pubkey,
      nsec: privkeyHex,
      profile: null,
      ...overrides,
    })

  it('round-trips a protected escrow', () => {
    localStorage.setItem(KEYSTORE_STORAGE_KEY, JSON.stringify(envelope))

    const parsed = parseEscrow(createEscrow(pubkey))

    expect(parsed.npub).toBe(npub)
    expect(nsecProtected(parsed.nsec)).toBe(true)
  })

  it('round-trips an unprotected escrow', () => {
    const parsed = parseEscrow(createEscrow(pubkey, privkeyHex))

    expect(parsed.pubkey).toBe(pubkey)
    expect(nsecProtected(parsed.nsec)).toBe(false)
    expect(parsed.nsec).toBe(privkeyHex)
  })

  it('rejects a file that is not an escrow', () => {
    expect(() => parseEscrow('not json')).toThrow(EscrowError)
    expect(() => parseEscrow(JSON.stringify({ format: 'something-else' }))).toThrow(EscrowError)
  })

  it('rejects an escrow from a newer version', () => {
    expect(() => parseEscrow(write({ version: 2 }))).toThrow(EscrowError)
  })

  it('rejects an escrow whose npub and pubkey disagree', () => {
    // The confirmation screen shows the npub. A file where the two fields
    // disagree could restore a different account than the one on screen.
    expect(() => parseEscrow(write({ pubkey: 'f'.repeat(64) }))).toThrow(EscrowError)
  })

  it('rejects an unprotected escrow whose key does not derive its npub', () => {
    const other = bytesToHex(generateSecretKey())

    expect(() => parseEscrow(write({ nsec: other }))).toThrow(EscrowError)
  })

  it('rejects a truncated envelope rather than failing later as a wrong passphrase', () => {
    expect(() => parseEscrow(write({ nsec: { ...envelope, ciphertext: '' } }))).toThrow(EscrowError)
  })

  it('drops a profile belonging to another account', () => {
    const profile = { pubkey: 'f'.repeat(64), npub: 'npub1other', displayName: 'Not me' }

    expect(parseEscrow(write({ profile: profile as never })).profile).toBeNull()
  })
})
