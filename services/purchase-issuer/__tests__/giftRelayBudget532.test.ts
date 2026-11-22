import { describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey, nip17 } from 'nostr-tools'
import { bytesToHex } from '@noble/hashes/utils'

import { handBuyerTheGift, publishLinkWrap, type GiftPorts, type WrapEvent } from '../giftDelivery'
import type { RelayPort, RelayPublishOutcome } from '../relayPort'
import { encodePlainTokenV4 } from '../../../src/lib/plainToken'
import { tokenProofs } from '../../../src/lib/voucherToken'
import { eventBytes, WRAP_BUDGET_BYTES } from '../../../src/lib/wrapSize'
import { STALL } from './stallFixture'

/**
 * #532: purchase-issuer gift wraps fit the relay budget (a large token is cut into self-contained
 * parts of the same voucher) and are delivered only once the RELAY holds them (publish OK, read back
 * by id). The gateway's cache keeps what strfry refuses, so it never counts on its own.
 */
const ISSUER_SK = generateSecretKey()
const BUYER_SK = generateSecretKey()
const BUYER = getPublicKey(BUYER_SK)
const ELL = generateSecretKey()
const L = getPublicKey(ELL)
const X = 1_900_000_000

/** A minted-locked secret with a heavy warrant-like tag, about 1.8 KB per proof in the token. */
function lockedSecret(n: number): string {
  return JSON.stringify([
    'P2PK_VOUCHER',
    {
      nonce: bytesToHex(generateSecretKey()),
      data: `02${L}`,
      tags: [['issuer', STALL], ['locktime', String(X)], ['refund', `02${BUYER}`], ['sigflag', 'SIG_ALL'], ['n_sigs', '1'], ['max_sats', '1000'], ['warrant', 'w'.repeat(1_400) + n]],
    },
  ])
}
const bigToken = (proofs: number) =>
  encodePlainTokenV4('https://mint.example', 'sat', Array.from({ length: proofs }, (_, n) => ({ amount: 2 ** (n % 8), id: '00ab', secret: lockedSecret(n), C: `02${'c'.repeat(64)}` })))

function fakeRelay(answer: (e: WrapEvent) => RelayPublishOutcome = () => 'ok') {
  const held = new Map<string, WrapEvent>()
  const seen: WrapEvent[] = []
  const port: RelayPort = {
    publish: async (e) => {
      seen.push(e as never)
      const out = answer(e as never)
      if (out === 'ok') held.set(e.id, e as never)
      return out
    },
    has: async (id) => held.has(id),
  }
  return { port, held, seen }
}

function ports(relay: RelayPort | undefined) {
  const gateway: WrapEvent[] = []
  const p: GiftPorts = {
    sealSecretHex: bytesToHex(ISSUER_SK),
    walletOrigin: 'https://imani.casa',
    publishEvent: async (_s, e) => (gateway.push(e), true),
    queryWraps: async (reader) => gateway.filter((e) => e.tags.some((t) => t[0] === 'p' && t[1] === getPublicKey(reader))),
    sendMail: async () => ({ ok: true, status: 202, messageId: 'm', duplicate: false, sandboxed: true }),
    scrubSeal: async () => true,
    anchor: async (_i, n) => n,
    stallName: async () => 'Alice',
    ...(relay ? { relay } : {}),
  }
  return { p, gateway }
}

const tokensIn = (wraps: WrapEvent[], sk: Uint8Array) => wraps.map((w) => String((JSON.parse(nip17.unwrapEvent(w as never, sk).content) as { token: string }).token))

describe('email gift link wrap (#532)', () => {
  it('a small gift is one wrap, on the relay and in the gateway', async () => {
    const relay = fakeRelay()
    const { p, gateway } = ports(relay.port)
    const token = bigToken(2)
    expect(await publishLinkWrap(p, ELL, token)).toEqual({ ok: true })
    expect(gateway).toHaveLength(1)
    expect(relay.held.size).toBe(1)
    expect(tokensIn(gateway, ELL)).toEqual([token])
  })

  it('a large gift (30 heavy proofs) is cut into wraps of at most 55,121 bytes holding every proof', async () => {
    const relay = fakeRelay()
    const { p, gateway } = ports(relay.port)
    const token = bigToken(30)
    expect(await publishLinkWrap(p, ELL, token)).toEqual({ ok: true })
    expect(gateway.length).toBeGreaterThan(1)
    for (const w of gateway) expect(eventBytes(w)).toBeLessThanOrEqual(WRAP_BUDGET_BYTES)
    expect([...relay.held.keys()].sort()).toEqual(gateway.map((w) => w.id).sort())
    const secrets = tokensIn(gateway, ELL).flatMap((t) => tokenProofs(t).map((x) => x.secret))
    expect(secrets).toEqual(tokenProofs(token).map((x) => x.secret))
  }, 30_000)

  it('the relay refuses too_large while the gateway would accept: NOT delivered, permanent', async () => {
    const relay = fakeRelay(() => 'too_large')
    const { p, gateway } = ports(relay.port)
    expect(await publishLinkWrap(p, ELL, bigToken(2))).toMatchObject({ ok: false, permanent: true })
    expect(gateway).toHaveLength(0)
  })

  it('the relay unreachable: not delivered, retried later', async () => {
    const { p } = ports(fakeRelay(() => 'unreachable').port)
    expect(await publishLinkWrap(p, ELL, bigToken(2))).toMatchObject({ ok: false, permanent: false })
  })

  it('the relay says OK but does not hold it by id: not delivered', async () => {
    const relay = fakeRelay()
    relay.port.has = async () => false
    const { p } = ports(relay.port)
    expect(await publishLinkWrap(p, ELL, bigToken(2))).toMatchObject({ ok: false, permanent: false })
  })

  it('a retry after the gateway took it but the relay did not re-sends the SAME wrap to the relay', async () => {
    let down = true
    const relay = fakeRelay(() => (down ? 'unreachable' : 'ok'))
    const { p, gateway } = ports(relay.port)
    const token = bigToken(2)
    // First pass: the gateway is written only after the relay holds it, so nothing is cached yet.
    expect((await publishLinkWrap(p, ELL, token)).ok).toBe(false)
    expect(gateway).toHaveLength(0)
    // A gateway-only copy from an older build: the retry puts that very event on the relay.
    const { wrapForLink } = await import('../giftLock')
    const old = wrapForLink(ELL, token) as unknown as WrapEvent
    gateway.push(old)
    down = false
    expect(await publishLinkWrap(p, ELL, token)).toEqual({ ok: true })
    expect(relay.held.has(old.id)).toBe(true)
    expect(gateway).toHaveLength(1)
  })
})

describe("the buyer's copy (#532)", () => {
  const input = (token: string) => ({ refundPubkey: BUYER, token, stall: 'Alice', to: 'bob@example.com', claimBy: X })

  it('is on the relay, read back by id, and in the gateway', async () => {
    const relay = fakeRelay()
    const { p, gateway } = ports(relay.port)
    expect(await handBuyerTheGift(p, input(bigToken(2)))).toEqual({ ok: true })
    expect(gateway).toHaveLength(1)
    expect(relay.held.has(gateway[0].id)).toBe(true)
  })

  it('a large copy is several imani_gift_sent wraps, each within the budget', async () => {
    const relay = fakeRelay()
    const { p, gateway } = ports(relay.port)
    const token = bigToken(30)
    expect(await handBuyerTheGift(p, input(token))).toEqual({ ok: true })
    expect(gateway.length).toBeGreaterThan(1)
    for (const w of gateway) expect(eventBytes(w)).toBeLessThanOrEqual(WRAP_BUDGET_BYTES)
    const rumors = gateway.map((w) => JSON.parse(nip17.unwrapEvent(w as never, BUYER_SK).content) as { type: string; token: string })
    expect(rumors.every((r) => r.type === 'imani_gift_sent')).toBe(true)
    expect(rumors.flatMap((r) => tokenProofs(r.token).map((x) => x.secret))).toEqual(tokenProofs(token).map((x) => x.secret))
  }, 30_000)

  it('a relay size refusal is not delivered and is permanent, even with the gateway up', async () => {
    const { p } = ports(fakeRelay(() => 'too_large').port)
    expect(await handBuyerTheGift(p, input(bigToken(2)))).toMatchObject({ ok: false, permanent: true })
  })

  it('a relay that never answers is not delivered (retryable)', async () => {
    const { p } = ports(fakeRelay(() => 'unreachable').port)
    expect(await handBuyerTheGift(p, input(bigToken(2)))).toMatchObject({ ok: false, permanent: false })
  })
})



