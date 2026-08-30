import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Event } from 'nostr-tools'

/**
 * DEV-144 — the merchant reads that used to bypass the gateway's cache.
 *
 * The property under test is availability without loss of correctness: a
 * merchant must keep their stall record and their issuance ledger when strfry
 * is unreachable from the browser (which is the normal case in a deployment
 * that does not publish its port), and must never be shown a stale record when
 * a newer one exists.
 */

let relayEvents: Event[] = []
let relayThrows = false

vi.mock('nostr-tools', async (importOriginal) => {
  const actual = await importOriginal<typeof import('nostr-tools')>()
  return {
    ...actual,
    SimplePool: class {
      async querySync() {
        if (relayThrows) throw new Error('relay unreachable')
        return relayEvents
      }
      close() {}
    },
  }
})

let gatewayResponse: { ok: boolean; events: unknown[] } = { ok: true, events: [] }
let lastRequestBody: Record<string, unknown> | undefined
let gatewayThrows = false

vi.stubGlobal('fetch', async (_url: string, init?: { body?: string }) => {
  if (gatewayThrows) throw new Error('gateway unreachable')
  lastRequestBody = init?.body ? JSON.parse(init.body) : undefined
  return {
    ok: gatewayResponse.ok,
    json: async () => ({ events: gatewayResponse.events }),
  }
})

const { allAddressable, newestAddressable } = await import('../relay')

const MERCHANT = 'a'.repeat(64)

/** A relay event: the standard `created_at`. */
const relayEvent = (id: string, d: string, created_at: number): Event =>
  ({ id, kind: 30078, pubkey: MERCHANT, content: `relay-${id}`, tags: [['d', d]], created_at, sig: '' }) as Event

/** A gateway event: `createdAt`, the camelCase the gateway actually serialises. */
const gatewayEvent = (id: string, d: string, createdAt: number) => ({
  id,
  kind: 30078,
  pubkey: MERCHANT,
  content: `gateway-${id}`,
  tags: [['d', d]],
  createdAt,
  sig: '',
})

beforeEach(() => {
  relayEvents = []
  relayThrows = false
  gatewayThrows = false
  gatewayResponse = { ok: true, events: [] }
  lastRequestBody = undefined
})

describe('the merchant record survives an unreachable relay', () => {
  it('is found in the gateway cache when the relay cannot be reached', async () => {
    // THE case this card exists for. imani-deploy publishes no strfry port —
    // "services reach via docker DNS only" — so in a real deployment this read
    // returned null, and null means the merchant role disappears: the home
    // screen reverts to a customer's and Stats resets to zero. Logout wipes the
    // device, so there is no other way back to a merchant's own books.
    relayThrows = true
    gatewayResponse = { ok: true, events: [gatewayEvent('e1', 'imani:merchant', 100)] }

    const found = await newestAddressable(MERCHANT, 30078, 'imani:merchant')
    expect(found?.content).toBe('gateway-e1')
  })

  it('still works when the gateway is the one that is down', async () => {
    // The converse. Adding a second store must not make the wallet depend on
    // both being up.
    gatewayThrows = true
    relayEvents = [relayEvent('e1', 'imani:merchant', 100)]

    expect((await newestAddressable(MERCHANT, 30078, 'imani:merchant'))?.content).toBe('relay-e1')
  })

  it('returns null when neither store has it, rather than throwing', async () => {
    relayThrows = true
    gatewayThrows = true
    expect(await newestAddressable(MERCHANT, 30078, 'imani:merchant')).toBeNull()
  })
})

describe('a stale cache can never win', () => {
  it('prefers the relay copy when it is newer', async () => {
    // The reason the bypass existed: the gateway's ingest pump subscribes to
    // kind-1059 only, so a kind-30078 this wallet published may never enter its
    // nostrdb. A merchant renaming their stall must not read back the old name.
    relayEvents = [relayEvent('new', 'imani:merchant', 200)]
    gatewayResponse = { ok: true, events: [gatewayEvent('old', 'imani:merchant', 100)] }

    expect((await newestAddressable(MERCHANT, 30078, 'imani:merchant'))?.content).toBe('relay-new')
  })

  it('prefers the gateway copy when THAT is newer', async () => {
    // Symmetric, and not hypothetical: another device can publish through the
    // gateway while this browser's relay read is answered by a lagging replica.
    relayEvents = [relayEvent('old', 'imani:merchant', 100)]
    gatewayResponse = { ok: true, events: [gatewayEvent('new', 'imani:merchant', 300)] }

    expect((await newestAddressable(MERCHANT, 30078, 'imani:merchant'))?.content).toBe(
      'gateway-new',
    )
  })

  it('reads the gateway\'s camelCase timestamp, not just created_at', async () => {
    // The gateway serialises `createdAt`. Reading only `created_at` would make
    // every cached event look like epoch 0 — it would never win a comparison,
    // and the merge would silently degrade to relay-only.
    relayThrows = true
    gatewayResponse = { ok: true, events: [gatewayEvent('e1', 'imani:merchant', 500)] }

    expect((await newestAddressable(MERCHANT, 30078, 'imani:merchant'))?.created_at).toBe(500)
  })
})

describe('the d tag is still checked locally, on both stores', () => {
  it('refuses another kind-30078 record from the same key', async () => {
    // possa-merchant writes `imani:settings` and others under this kind. A
    // store that ignored the filter would otherwise satisfy `imani:merchant`
    // with any of them — which is what makes the local re-check load-bearing
    // rather than defensive.
    relayThrows = true
    gatewayResponse = { ok: true, events: [gatewayEvent('e1', 'imani:settings', 100)] }

    expect(await newestAddressable(MERCHANT, 30078, 'imani:merchant')).toBeNull()
  })

  it('sends #d as a standard tag filter the gateway now honours', async () => {
    // Not `pTags`. The DTO carries a general `tags` map and merges pTags into
    // it as `#p`; sending the filter under any other name makes it a
    // suggestion, which is exactly the defect the card recorded.
    await newestAddressable(MERCHANT, 30078, 'imani:merchant')
    expect(lastRequestBody).toMatchObject({
      kinds: [30078],
      authors: [MERCHANT],
      tags: { '#d': ['imani:merchant'] },
    })
  })
})

describe('the issuance ledger', () => {
  it('merges both stores, deduping by d rather than by event id', async () => {
    // Two stores holding different revisions of one record hold two different
    // ids. Deduping by id would restore the merchant's coupon twice, once
    // stale, and the ledger would double-count.
    relayEvents = [
      relayEvent('r1', 'imani:issued:v1', 100),
      relayEvent('r2', 'imani:issued:v2', 100),
    ]
    gatewayResponse = {
      ok: true,
      events: [gatewayEvent('g1', 'imani:issued:v1', 900), gatewayEvent('g3', 'imani:issued:v3', 50)],
    }

    const events = await allAddressable(MERCHANT, 30078, 'imani:issued:')
    expect(events).toHaveLength(3)
    // v1 exists in both; the newer gateway copy wins.
    expect(events.find((e) => e.tags[0][1] === 'imani:issued:v1')?.content).toBe('gateway-g1')
  })

  it('keeps the whole ledger when the relay is unreachable', async () => {
    relayThrows = true
    gatewayResponse = {
      ok: true,
      events: [gatewayEvent('g1', 'imani:issued:v1', 100), gatewayEvent('g2', 'imani:issued:v2', 100)],
    }

    expect(await allAddressable(MERCHANT, 30078, 'imani:issued:')).toHaveLength(2)
  })

  it('applies the prefix to both sources', async () => {
    // The prefix is filtered client-side because no relay can match a prefix —
    // so the gateway cannot either, and its extra events must be dropped here
    // rather than trusted.
    relayEvents = [relayEvent('r1', 'imani:issued:v1', 100)]
    gatewayResponse = { ok: true, events: [gatewayEvent('g9', 'imani:merchant', 900)] }

    const events = await allAddressable(MERCHANT, 30078, 'imani:issued:')
    expect(events.map((e) => e.id)).toEqual(['r1'])
  })

  it('sends NO #d filter for a prefix query', async () => {
    // A `#d` filter names one exact value. Sending the prefix as one would
    // match nothing and empty the ledger.
    await allAddressable(MERCHANT, 30078, 'imani:issued:')
    expect(lastRequestBody).not.toHaveProperty('tags')
  })

  it('drops an event with no d tag instead of keying it by id', async () => {
    // `newestByD` falls back to the id so nothing vanishes silently, but the
    // prefix filter must exclude these first — an event with no `d` cannot be
    // an issuance record.
    relayThrows = true
    gatewayResponse = {
      ok: true,
      events: [{ id: 'x', kind: 30078, pubkey: MERCHANT, content: '{}', tags: [], createdAt: 100 }],
    }

    expect(await allAddressable(MERCHANT, 30078, 'imani:issued:')).toEqual([])
  })
})

describe('a malformed gateway reply cannot corrupt the merge', () => {
  it('ignores an event with no id or no timestamp', async () => {
    // Every caller dedupes and compares. An event that can do neither is worse
    // than absent, because it would occupy a slot in the merge.
    relayThrows = true
    gatewayResponse = {
      ok: true,
      events: [
        { kind: 30078, tags: [['d', 'imani:merchant']], createdAt: 100 },
        { id: 'no-time', kind: 30078, tags: [['d', 'imani:merchant']] },
      ],
    }

    expect(await newestAddressable(MERCHANT, 30078, 'imani:merchant')).toBeNull()
  })

  it('treats a non-200 as an empty answer, not an error', async () => {
    // A 401 from an unauthenticated read must degrade to relay-only, not throw
    // at a merchant opening their own home screen.
    gatewayResponse = { ok: false, events: [] }
    relayEvents = [relayEvent('r1', 'imani:merchant', 100)]

    expect((await newestAddressable(MERCHANT, 30078, 'imani:merchant'))?.content).toBe('relay-r1')
  })
})
