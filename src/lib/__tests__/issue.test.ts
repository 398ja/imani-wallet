import { describe, it, expect } from 'vitest'
import { nip19 } from 'nostr-tools'

import { toEpochSeconds, toPubkeyHex } from '../issue'

const PUBKEY = '4728fd8ad6a2f5c8930f4065347907e22186fba6c73bd04e145dfd780b98e451'

describe('toEpochSeconds', () => {
  it('passes seconds through', () => {
    expect(toEpochSeconds(1_760_000_000)).toBe(1_760_000_000)
  })

  it('scales milliseconds down', () => {
    // The failure this prevents is not subtle: sending ms where seconds are
    // expected dates the coupon to roughly the year 58000.
    expect(toEpochSeconds(1_760_000_000_000)).toBe(1_760_000_000)
  })

  it('parses an ISO string, which the gateway also returns', () => {
    expect(toEpochSeconds('2026-08-13T00:00:00Z')).toBe(Math.floor(Date.parse('2026-08-13T00:00:00Z') / 1000))
  })

  it('returns undefined for nothing, so the field is omitted rather than sent as 0', () => {
    expect(toEpochSeconds(null)).toBeUndefined()
    expect(toEpochSeconds(undefined)).toBeUndefined()
    expect(toEpochSeconds('')).toBeUndefined()
    expect(toEpochSeconds(0)).toBeUndefined()
    expect(toEpochSeconds('whenever')).toBeUndefined()
  })
})

describe('toPubkeyHex', () => {
  it('accepts the npub a customer receive screen shows', () => {
    expect(toPubkeyHex(nip19.npubEncode(PUBKEY))).toBe(PUBKEY)
  })

  it('accepts raw hex, and normalises case', () => {
    expect(toPubkeyHex(PUBKEY.toUpperCase())).toBe(PUBKEY)
  })

  it('tolerates a nostr: URI prefix, which some QR encoders add', () => {
    expect(toPubkeyHex(`nostr:${nip19.npubEncode(PUBKEY)}`)).toBe(PUBKEY)
  })

  it('accepts an nprofile', () => {
    expect(toPubkeyHex(nip19.nprofileEncode({ pubkey: PUBKEY, relays: [] }))).toBe(PUBKEY)
  })

  it('rejects anything else rather than throwing at a camera loop', () => {
    expect(toPubkeyHex('')).toBeNull()
    expect(toPubkeyHex('hello')).toBeNull()
    expect(toPubkeyHex('deadbeef')).toBeNull()
    // An nsec is a valid bech32 entity and decodes fine — it must still be
    // refused, or a merchant scanning the wrong QR issues to a secret key.
    expect(toPubkeyHex(nip19.nsecEncode(new Uint8Array(32).fill(7)))).toBeNull()
  })
})
