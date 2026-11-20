/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { hexToBytes } from '@noble/hashes/utils'
import * as nip44 from 'nostr-tools/nip44'
import { getPublicKey } from 'nostr-tools/pure'

import { forwardAllReceipts, forwardReceipts, forwardTarget, forwardedReceiptId } from '../receiptForward'
import { delegatedCredential, delegationJson, LOCK, LOCK_PUB, STALL, STALL_SK } from './stallFixture'

const CUSTOMER_SK = '22'.repeat(32)
const CUSTOMER = getPublicKey(hexToBytes(CUSTOMER_SK))
const GW = 'https://gw.test'

/** What an old customer wallet posts: encrypted customer -> delegate. */
function oldWalletReceipt(id: string, payload: object) {
  return {
    receiptId: id,
    ciphertextBase64: nip44.encrypt(JSON.stringify(payload), nip44.getConversationKey(hexToBytes(CUSTOMER_SK), LOCK_PUB)),
    recipientPubkeyHex: CUSTOMER,
    consumeToken: 'tok-' + id,
  }
}

function authPubkey(init: RequestInit): string {
  const header = String((init.headers as Record<string, string>).Authorization)
  return JSON.parse(atob(header.replace(/^Nostr /, ''))).pubkey
}

function fakeGateway(queue: ReturnType<typeof oldWalletReceipt>[], postStatus = 201) {
  const posted: any[] = []
  const acked: string[][] = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    const who = authPubkey(init)
    if (url.endsWith('/drain')) {
      expect(who).toBe(LOCK_PUB)
      return new Response(JSON.stringify({ receipts: queue, nonce: 'n1', moreAvailable: false }), { status: 200 })
    }
    if (url.endsWith('/ack')) {
      acked.push(body.consumeTokens)
      return new Response(JSON.stringify({ acknowledged: body.consumeTokens.length, ignored: 0 }), { status: 200 })
    }
    // The gateway's own rule: authenticated key must be the recipient.
    expect(who).toBe(body.recipientPubkeyHex)
    posted.push(body)
    return new Response('{}', { status: postStatus })
  }) as unknown as typeof fetch
  return { fetchImpl, posted, acked }
}

describe('receipt forwarding (follow-up to #655)', () => {
  it('forwards an old wallet receipt to the stall, readable by the stall drain, attestation intact', async () => {
    const payload = { v: 1, voucherId: 'v1', faceValue: 500, faceUnit: 'GBP', redeemedAt: 1, cashAttestation: 'ATT' }
    const gw = fakeGateway([oldWalletReceipt('a'.repeat(64), payload)])
    const r = await forwardReceipts(GW, delegatedCredential(), gw.fetchImpl)
    expect(r).toEqual({ forwarded: 1, dropped: 0, failed: 0 })
    const fwd = gw.posted[0]
    expect(fwd.senderPubkeyHex).toBe(STALL)
    expect(fwd.recipientPubkeyHex).toBe(LOCK_PUB)
    expect(fwd.receiptId).toBe(forwardedReceiptId('a'.repeat(64)))
    // Exactly what paymentReceiptDrain.fileReceipt does: decrypt with recipientPubkeyHex as counterparty.
    const opened = JSON.parse(nip44.decrypt(fwd.ciphertextBase64, nip44.getConversationKey(hexToBytes(STALL_SK), fwd.recipientPubkeyHex)))
    expect(opened).toEqual(payload)
    expect(gw.acked).toEqual([['tok-' + 'a'.repeat(64)]])
  })

  it('does not ack when the forward is refused, so it is retried', async () => {
    const gw = fakeGateway([oldWalletReceipt('b'.repeat(64), { v: 1, redeemedAt: 1 })], 503)
    const r = await forwardReceipts(GW, delegatedCredential(), gw.fetchImpl)
    expect(r.failed).toBe(1)
    expect(gw.acked).toEqual([])
  })

  it('treats a 409 (already forwarded) as done', async () => {
    const gw = fakeGateway([oldWalletReceipt('c'.repeat(64), { v: 1, redeemedAt: 1 })], 409)
    expect((await forwardReceipts(GW, delegatedCredential(), gw.fetchImpl)).forwarded).toBe(1)
    expect(gw.acked).toHaveLength(1)
  })

  it('acks and drops an undecryptable receipt without forwarding it', async () => {
    const bad = { ...oldWalletReceipt('d'.repeat(64), {}), ciphertextBase64: 'garbage' }
    const gw = fakeGateway([bad])
    expect(await forwardReceipts(GW, delegatedCredential(), gw.fetchImpl)).toEqual({ forwarded: 0, dropped: 1, failed: 0 })
    expect(gw.posted).toEqual([])
  })

  it('forwards nothing without a delegation that verifies (no spoofing)', async () => {
    const otherSk = '33'.repeat(32)
    const cases = [
      delegatedCredential({ delegation: '' }),
      delegatedCredential({ delegation: delegationJson({ stallSk: otherSk }) }),
      delegatedCredential({ delegation: delegationJson({ delegate: getPublicKey(hexToBytes(otherSk)) }) }),
      delegatedCredential({ delegation: delegationJson({ scope: 'coupon:redeem' }) }),
      delegatedCredential({ delegation: delegationJson({ d: 'something-else' }) }),
      { ...delegatedCredential(), stallPubkey: getPublicKey(hexToBytes(otherSk)) },
      delegatedCredential({ delegation: tamperSig(delegationJson()) }),
    ]
    for (const c of cases) {
      expect(forwardTarget(c)).toBeNull()
      const gw = fakeGateway([oldWalletReceipt('e'.repeat(64), { v: 1, redeemedAt: 1 })])
      await forwardReceipts(GW, c, gw.fetchImpl)
      expect(gw.posted).toEqual([])
    }
  })

  it('still forwards after the delegation expires: the receipt is for a coupon already sold', () => {
    expect(forwardTarget(delegatedCredential({ delegation: delegationJson({ expiresAt: 1 }) }))).toBe(STALL)
  })

  it('never throws when the gateway is down', async () => {
    const down = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    await expect(forwardAllReceipts(GW, [delegatedCredential()], down)).resolves.toEqual({ forwarded: 0, dropped: 0, failed: 0 })
  })

  it('uses the lock key fixture the vault holds', () => {
    expect(getPublicKey(hexToBytes(LOCK))).toBe(LOCK_PUB)
  })
})

function tamperSig(json: string): string {
  const e = JSON.parse(json)
  e.tags = e.tags.map((t: string[]) => (t[0] === 'p' ? ['p', getPublicKey(hexToBytes('44'.repeat(32)))] : t))
  return JSON.stringify(e)
}
