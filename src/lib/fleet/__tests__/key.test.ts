/**
 * @vitest-environment node
 *
 * #591 contract C2: the per-install fleet key.
 */
import { describe, expect, it, vi } from 'vitest'
import { generateSecretKey, getPublicKey, nip44, verifyEvent } from 'nostr-tools'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'

import { canLendKey, deriveFleetKey, fleetSigner, FleetKeyError, FLEET_KEY_INFO } from '../key'
import { unwrapSealed } from '../../giftWrap'

const walletKey = generateSecretKey()
const WALLET = getPublicKey(walletKey)
const lender = { withPrivkey: <T,>(f: (k: Uint8Array) => T): T => f(walletKey.slice()) }
const nonceA = new Uint8Array(32).fill(1)
const nonceB = new Uint8Array(32).fill(2)

describe('fleet key derivation (C2)', () => {
  it('is HMAC-SHA256(wallet_sk, "imani-fleet-key-v1" || install_nonce)', () => {
    const msg = new Uint8Array([...new TextEncoder().encode(FLEET_KEY_INFO), ...nonceA])
    expect(bytesToHex(deriveFleetKey(walletKey, nonceA))).toBe(bytesToHex(hmac(sha256, walletKey, msg)))
  })

  it('the same wallet and nonce give the same key; a new nonce gives an unrelated one', () => {
    const a1 = fleetSigner(lender, nonceA).pubkey
    const a2 = fleetSigner(lender, nonceA).pubkey
    const b = fleetSigner(lender, nonceB).pubkey
    expect(a1).toBe(a2)
    expect(b).not.toBe(a1)
    expect(a1).not.toBe(WALLET)
    expect(b).not.toBe(WALLET)
  })

  it('aborts on an HMAC output that is not a valid secp256k1 scalar', () => {
    expect(() => deriveFleetKey(walletKey, nonceA, () => new Uint8Array(32))).toThrow(FleetKeyError)
    expect(() => deriveFleetKey(walletKey, nonceA, () => new Uint8Array(32).fill(0xff))).toThrow(FleetKeyError)
  })

  it('refuses a nonce that is not 32 bytes', () => {
    expect(() => deriveFleetKey(walletKey, new Uint8Array(16))).toThrow(FleetKeyError)
  })

  it('signs events with the fleet key, never the wallet key', async () => {
    const s = fleetSigner(lender, nonceA)
    const e = await s.signEvent({ kind: 27235, created_at: 1, tags: [], content: '' })
    expect(verifyEvent(e)).toBe(true)
    expect(e.pubkey).toBe(s.pubkey)
    expect(e.pubkey).not.toBe(WALLET)
  })

  it('NIP-17 wraps are sealed by the fleet key', () => {
    const support = generateSecretKey()
    const s = fleetSigner(lender, nonceA)
    const wrap = s.wrap(getPublicKey(support), 'hello')
    const opened = unwrapSealed(wrap, support)
    expect(opened?.sealer).toBe(s.pubkey)
    expect(opened?.rumor.pubkey).toBe(s.pubkey)
    expect(JSON.stringify(wrap)).not.toContain(WALLET)
    expect(typeof nip44.v2.encrypt).toBe('function')
  })

  it('wipes each borrowed and derived key after use, and keeps none', async () => {
    const lent: Uint8Array[] = []
    const l = { withPrivkey: <T,>(f: (k: Uint8Array) => T): T => {
      const k = walletKey.slice()
      lent.push(k)
      try {
        return f(k)
      } finally {
        k.fill(0)
      }
    } }
    const s = fleetSigner(l, nonceA)
    await s.signEvent({ kind: 1, created_at: 1, tags: [], content: '' })
    expect(lent.length).toBeGreaterThanOrEqual(2)
    for (const k of lent) expect(k.every((b) => b === 0)).toBe(true)
    // The signer object holds no 32-byte key material.
    for (const v of Object.values(s)) expect(v instanceof Uint8Array).toBe(false)
  })

  it('a signer that cannot lend its key is detected, so the feature is not offered', () => {
    const remote = { withPrivkey: vi.fn(() => { throw new Error('remote signer') }) }
    expect(canLendKey(remote)).toBe(false)
    expect(canLendKey(lender)).toBe(true)
    expect(() => fleetSigner(remote, nonceA)).toThrow()
  })
})
