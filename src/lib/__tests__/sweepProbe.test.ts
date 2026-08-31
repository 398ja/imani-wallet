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
//
// VITE_RELAY_URL IS REQUIRED, and the command here omitted it — so this probe
// failed for a reason that had nothing to do with the code under test. The
// module publishes to `RELAY_URL`, which defaults to `ws://localhost:27778`,
// while the assertions below query staging directly: the publish went to a dead
// local port and the read-back found nothing, which reads exactly like a relay
// rejecting the event. Verified 2026-08-30 by publishing kinds 1 / 7376 / 7377 /
// 30078 to staging by hand — all four accepted and read back — and by running
// this probe on 70aeb37, which fails the same way, so it was never my change.
//
//   VITE_RELAY_URL=wss://relay.staging.398ja.xyz PROBE_RELAY=1 \
//     npx vitest run src/lib/__tests__/sweepProbe.test.ts
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

  // DEV-246 acceptance. The unit tests assert the receipt's shape against a
  // stubbed `publish`; this asserts that the id and date it carries actually
  // ADDRESS the event on the relay. A receipt that names an event nobody can
  // fetch is worse than none, because the merchant's screen says "published".
  it('hands back a receipt that really addresses the published event', async () => {
    const pool = new SimplePool()
    const token = 'probe-receipt-' + MERCHANT.slice(0, 8)

    const receipt = await attestRedemption({
      token,
      faceValue: 2500,
      unit: 'XAF',
      signatureValid: true,
    })
    expect(receipt).not.toBeNull()
    expect(receipt!.nullifier).toBe(nullifierFor(token))
    await new Promise((r) => setTimeout(r, 2000))

    // Fetch BY THE RECEIPT'S OWN ID — the drawer's "Ledger record id" is for
    // exactly this, and it is the claim the mocks cannot check.
    const [event] = await pool.querySync([RELAY], { ids: [receipt!.eventId] })
    expect(event).toBeDefined()
    expect(event.kind).toBe(ATTESTATION_KIND)
    expect(event.tags.find((t) => t[0] === 'n')?.[1]).toBe(receipt!.nullifier)

    // The date on the receipt is the EVENT's, not "now". A sweep can publish
    // long after the sale, and the screen dates the publication.
    expect(receipt!.at).toBe(event.created_at * 1000)

    pool.close([RELAY])
  }, 60000)

  // The write-back the sweep performs, against a real relay: both the gap it
  // republishes and the row whose attestation was already there. The second is
  // the case every redemption predating DEV-246 is in, and the one a
  // gaps-only sweep would leave permanently unstamped.
  it('stamps a receipt for a republished gap AND for an already-published row', async () => {
    const already = 'probe-stamp-known-' + MERCHANT.slice(0, 8)
    const gap = 'probe-stamp-gap-' + MERCHANT.slice(0, 8)

    // One is on the relay already; the other has never been published.
    await attestRedemption({ token: already, faceValue: 700, unit: 'XAF', signatureValid: true })
    await new Promise((r) => setTimeout(r, 2000))

    const stamped: Record<string, { eventId: string; at: number }> = {}
    const out = await reconcileAttestations(
      [
        { id: 'row-known', attestationNullifier: nullifierFor(already), attestedValue: 700, attestedUnit: 'XAF' },
        { id: 'row-gap', attestationNullifier: nullifierFor(gap), attestedValue: 1300, attestedUnit: 'XAF' },
      ],
      async (id, receipt) => {
        stamped[id] = { eventId: receipt.eventId, at: receipt.at }
      },
    )

    expect(out.missing).toBe(1)
    expect(out.republished).toBe(1)

    // BOTH rows stamped: the gap because it was just published, and the known
    // row because its event was already on the relay and the row did not know.
    expect(Object.keys(stamped).sort()).toEqual(['row-gap', 'row-known'])

    // And each id addresses a real event carrying the right nullifier.
    const pool = new SimplePool()
    await new Promise((r) => setTimeout(r, 2000))
    for (const [rowId, expectedToken] of [
      ['row-known', already],
      ['row-gap', gap],
    ] as const) {
      const [event] = await pool.querySync([RELAY], { ids: [stamped[rowId].eventId] })
      expect(event, `${rowId} receipt should address a real event`).toBeDefined()
      expect(event.tags.find((t) => t[0] === 'n')?.[1]).toBe(nullifierFor(expectedToken))
      expect(stamped[rowId].at).toBe(event.created_at * 1000)
    }
    pool.close([RELAY])
  }, 60000)
})
