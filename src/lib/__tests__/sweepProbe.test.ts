// Live-relay probe: drives the REAL attestation module (no re-implemented
// crypto — an earlier hand-rolled probe derived H wrongly and proved nothing)
// against staging, to check the wire behaviour the mocks cannot: that a
// published attestation is found by an authors-query, that the sweep closes a
// real gap, and that a customer's #n lookup works without the merchant's key.
import { describe, expect, it, vi } from 'vitest'
import { SimplePool } from 'nostr-tools'
// Node 20 has no global WebSocket, and nostr-tools reports that as a silent
// "connection failure" that looks exactly like a relay rejecting the event.
// Cost 20 minutes; supplying it is the whole fix.
import WebSocket from 'ws'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).WebSocket ??= WebSocket

const RELAY = 'wss://relay.staging.398ja.xyz'
const MERCHANT = bytesToHex(sha256(utf8ToBytes('probe-' + Date.now())))

vi.mock('../nap', () => ({
  getSigner: () => ({ privkeyHex: () => MERCHANT }),
}))

const { attestRedemption, reconcileAttestations, ledgerPubkey, nullifierFor, ATTESTATION_KIND } =
  await import('../attestation')

// Opt-in: this talks to a real relay over the network, so it must not run in
// the default suite, where it would be a flake that fails on a plane.
//   PROBE_RELAY=1 npx vitest run src/lib/__tests__/sweepProbe.test.ts
const live = process.env.PROBE_RELAY ? describe : describe.skip

live('against the live staging relay', () => {
  it('publishes, finds the gap, and closes it', async () => {
    const pool = new SimplePool()
    const tokLanded = 'probe-landed-' + MERCHANT.slice(0, 8)
    const tokLost = 'probe-lost-' + MERCHANT.slice(0, 8)

    await attestRedemption({ token: tokLanded, faceValue: 2500, unit: 'XAF', signatureValid: true })
    await new Promise((r) => setTimeout(r, 2000))

    const found = await pool.querySync([RELAY], {
      kinds: [ATTESTATION_KIND],
      authors: [ledgerPubkey()],
    })
    expect(found.length).toBeGreaterThan(0)

    // The sweep sees one local row with no published attestation.
    const out = await reconcileAttestations([
      { attestationNullifier: nullifierFor(tokLanded), attestedValue: 2500, attestedUnit: 'XAF' },
      { attestationNullifier: nullifierFor(tokLost), attestedValue: 1800, attestedUnit: 'XAF' },
    ])
    expect(out).toEqual({ checked: 2, missing: 1, republished: 1 })

    await new Promise((r) => setTimeout(r, 2000))
    const after = await pool.querySync([RELAY], {
      kinds: [ATTESTATION_KIND],
      authors: [ledgerPubkey()],
    })
    const ns = new Set(after.map((e) => e.tags.find((t) => t[0] === 'n')?.[1]))
    expect(ns.has(nullifierFor(tokLanded))).toBe(true)
    expect(ns.has(nullifierFor(tokLost))).toBe(true)

    // A second sweep now finds nothing missing.
    const again = await reconcileAttestations([
      { attestationNullifier: nullifierFor(tokLost), attestedValue: 1800, attestedUnit: 'XAF' },
    ])
    expect(again.missing).toBe(0)

    // The customer's check: by tag, with no author, so it never reveals which
    // stall redeemed the coupon.
    const byTag = await pool.querySync([RELAY], {
      kinds: [ATTESTATION_KIND],
      '#n': [nullifierFor(tokLost)],
    })
    expect(byTag.length).toBeGreaterThan(0)
    pool.close([RELAY])
  }, 60000)
})
