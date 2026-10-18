import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Event } from 'nostr-tools'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools'

/**
 * Review of #326: the gateway is the restore's second source for coupon
 * records, and a big wallet must not lose the records beyond one page.
 *
 * The fake honours `limit` and an INCLUSIVE `until`, newest first, the way the
 * gateway's `/nostr/query` (NostrQueryAdapter.buildFilter) and strfry do.
 */

const sk = generateSecretKey()
const pk = getPublicKey(sk)

const { gatewayAllEvents, unionWithGateway } = await import('../gatewayNostr')

let store: Event[] = []
let calls = 0
const realFetch = globalThis.fetch

beforeEach(() => {
  calls = 0
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    calls++
    const body = JSON.parse(String(init?.body ?? '{}')) as { limit?: number; until?: number; kinds: number[] }
    const cap = Math.min(body.limit ?? 100, 500)
    const page = store
      .filter((e) => body.kinds.includes(e.kind))
      .filter((e) => body.until === undefined || e.created_at <= body.until)
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, cap)
      .map((e) => ({ ...e, createdAt: e.created_at }))
    return new Response(JSON.stringify({ events: page }), { status: 200 })
  }) as typeof fetch
})
afterEach(() => {
  globalThis.fetch = realFetch
})

function events(n: number, sameSecondEvery = 1): Event[] {
  return Array.from({ length: n }, (_, i) =>
    finalizeEvent(
      { kind: 7375, created_at: 1_700_000_000 + Math.floor(i / sameSecondEvery), tags: [['d', `t${i}`]], content: `c${i}` },
      sk,
    ),
  )
}

describe('the gateway coupon read pages past one response', () => {
  it('returns all 1,234 records, not the newest 500', async () => {
    store = events(1234)
    const got = await gatewayAllEvents(pk, 7375)
    expect(got).not.toBeNull()
    expect(new Set(got!.map((e) => e.id)).size).toBe(1234)
    expect(calls).toBeGreaterThan(2)
  })

  it('does not lose events that share a second across a page boundary', async () => {
    // 10 events per second: every page boundary falls inside a second.
    store = events(1234, 10)
    const got = await gatewayAllEvents(pk, 7375)
    expect(new Set(got!.map((e) => e.id)).size).toBe(1234)
  })

  it('terminates on a full page that is all one second', async () => {
    store = events(700, 700)
    const got = await gatewayAllEvents(pk, 7375)
    // The gateway cannot serve past 500 in ONE second with `until` alone; the
    // walk must still end rather than loop.
    expect(got!.length).toBeGreaterThanOrEqual(500)
    expect(calls).toBeLessThan(10)
  })

  it('answers null (not []) when the gateway cannot be reached, so callers can tell', async () => {
    globalThis.fetch = (async () => new Response('', { status: 502 })) as typeof fetch
    expect(await gatewayAllEvents(pk, 7375)).toBeNull()
  })

  it('the union keeps every verified paged event', async () => {
    store = events(800)
    const got = await gatewayAllEvents(pk, 7375)
    expect(unionWithGateway([], got ?? [], pk, 7375)).toHaveLength(800)
  })
})
