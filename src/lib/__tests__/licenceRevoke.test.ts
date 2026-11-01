/**
 * imani-wallet#226: the licence seller revokes a subscription (a refund).
 *
 * A licence is P2PK-locked to its buyer, so the seller holds nothing it could spend to end it.
 * The seller revokes it at gateway-customer instead: `sell-subscription.mjs --revoke sub_…`
 * signs `POST /api/v1/wallet/licences/revoke` with NIP-98, and the server stops counting every
 * licence of that subscription at once. These tests pin the request the script sends and what it
 * records locally, without a network.
 */
import { describe, expect, it } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { verifyEvent } from 'nostr-tools'

const SK = 'cd'.repeat(32)
const PK = bytesToHex(schnorr.getPublicKey(hexToBytes(SK)))
const URL_ = 'https://api.wallet.example/api/v1/wallet/licences/revoke'

function decodeAuth(header: string) {
  expect(header.startsWith('Nostr ')).toBe(true)
  return JSON.parse(Buffer.from(header.slice(6), 'base64').toString('utf8'))
}

describe('sell-subscription.mjs --revoke (imani-wallet#226)', () => {
  it('builds a NIP-98 signed revocation over the exact URL, method and body', async () => {
    const { revokeRequest } = await import('../../../scripts/sell-subscription.mjs')
    const req = revokeRequest({ pk: PK, sk: hexToBytes(SK) }, 'https://api.wallet.example', 'sub_9f2c11aabbccddee', 'refund 2026-10-10')

    expect(req.url).toBe(URL_)
    expect(req.method).toBe('POST')
    expect(JSON.parse(req.body)).toEqual({ subscription_id: 'sub_9f2c11aabbccddee', reason: 'refund 2026-10-10' })
    const event = decodeAuth(req.headers.Authorization)
    expect(verifyEvent(event)).toBe(true)
    expect(event.kind).toBe(27235)
    expect(event.pubkey).toBe(PK)
    const tag = (name: string) => event.tags.find((t: string[]) => t[0] === name)?.[1]
    expect(tag('u')).toBe(URL_)
    expect(tag('method')).toBe('POST')
    expect(tag('payload')).toBe(bytesToHex(sha256(new TextEncoder().encode(req.body))))
  })

  it('never sends an edge session header: the server requires NIP-98 for a revocation', async () => {
    const { revokeRequest } = await import('../../../scripts/sell-subscription.mjs')
    const req = revokeRequest({ pk: PK, sk: hexToBytes(SK) }, 'https://api.wallet.example', 'sub_1', '')

    expect(Object.keys(req.headers)).not.toContain('X-Auth-Pubkey')
    expect(Object.keys(req.headers)).not.toContain('X-Edge-Auth')
    expect(JSON.parse(req.body)).toEqual({ subscription_id: 'sub_1' })
  })

  it('refuses a malformed subscription id before signing anything', async () => {
    const { revokeRequest } = await import('../../../scripts/sell-subscription.mjs')
    for (const bad of ['', 'sub 1', 'sub_1\n', 'x'.repeat(129)]) {
      expect(() => revokeRequest({ pk: PK, sk: hexToBytes(SK) }, 'https://x', bad, '')).toThrow(/subscription/)
    }
  })

  it('marks the sale revoked in the ledger, so the expiry reminders stop', async () => {
    const { markRevoked } = await import('../../../scripts/sell-subscription.mjs')
    const rows = [
      { subscription_id: 'sub_a', customer_pubkey: 'aa', expires_at: 1, notices: [] },
      { subscription_id: 'sub_b', customer_pubkey: 'bb', expires_at: 2, notices: [] },
    ]

    const out = markRevoked(rows, 'sub_a', '2026-10-10T12:00:00Z', 'refund')

    expect(out.find((r) => r.subscription_id === 'sub_a')).toMatchObject({
      revoked_at: '2026-10-10T12:00:00Z', revoked_reason: 'refund',
    })
    expect(out.find((r) => r.subscription_id === 'sub_b')).not.toHaveProperty('revoked_at')
    // A revocation of a sale this ledger never recorded is still written down.
    expect(markRevoked([], 'sub_z', '2026-10-10T12:00:00Z', '')).toEqual([
      { subscription_id: 'sub_z', notices: [], revoked_at: '2026-10-10T12:00:00Z' },
    ])
  })

  it('refuses to sell a renewal under a subscription id the ledger records as revoked (review of #226)', async () => {
    const { assertNotRevoked } = await import('../../../scripts/sell-subscription.mjs')
    const rows = [
      { subscription_id: 'sub_a', revoked_at: '2026-10-10T12:00:00Z' },
      { subscription_id: 'sub_b' },
    ]

    expect(() => assertNotRevoked(rows, 'sub_a')).toThrow(/revoked.*NEW subscription id/s)
    expect(() => assertNotRevoked(rows, 'sub_b')).not.toThrow()
    expect(() => assertNotRevoked(rows, 'sub_never_sold')).not.toThrow()
    expect(() => assertNotRevoked(null as unknown as [], 'sub_a')).not.toThrow()
  })

  it('notify-expiring sends no reminder for a revoked subscription', async () => {
    const { remindable } = await import('../../../scripts/notify-expiring.mjs')
    expect(remindable({ subscription_id: 'sub_a', expires_at: 10 })).toBe(true)
    expect(remindable({ subscription_id: 'sub_a', expires_at: 10, revoked_at: '2026-10-10T12:00:00Z' })).toBe(false)
  })
})
