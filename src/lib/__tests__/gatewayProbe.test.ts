import { describe, expect, it } from 'vitest'

/**
 * DEV-144 acceptance, against the REAL staging gateway. Nothing is mocked.
 *
 * `gatewayNostr.test.ts` proves the merge LOGIC with both stores stubbed. This
 * proves the thing that file cannot: that the gateway actually honours a `#d`
 * tag filter, and that a merchant read survives an unreachable relay end to
 * end. Those were read off Java source before this existed, which is inspection
 * and not evidence.
 *
 * Skipped by default and env-gated, matching sweepProbe.test.ts: it needs
 * staging reachable and real data present, so it must never fail a clean
 * checkout or CI.
 *
 *   PROBE_GATEWAY=1 npx vitest run src/lib/__tests__/gatewayProbe.test.ts
 *
 * Measured 2026-08-30 against wallet.staging.398ja.xyz:
 *  - unfiltered kind-30078: 104 events, 90 distinct `d`
 *  - the same query with tags {#d:[one]}: exactly 1. The filter is real.
 *  - events carry `createdAt` and NOT `created_at`, so the camelCase
 *    normalisation in gatewayNostr is load-bearing against the live service.
 *  - on HEAD~1 (the pre-fix relay.ts) the two availability cases below FAIL,
 *    which is the card's reported defect reproduced rather than assumed.
 */
// `GATEWAY = ''` is a same-origin relative URL: correct in a browser, but Node
// has no origin, so fetch throws "Failed to parse URL". Give the relative path
// the staging origin, which is what the browser would supply. The code under
// test is untouched.
const ORIGIN = 'https://wallet.staging.398ja.xyz'
const realFetch = globalThis.fetch
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  realFetch(typeof input === 'string' && input.startsWith('/') ? ORIGIN + input : input, init)) as typeof fetch

const live = process.env.PROBE_GATEWAY ? describe : describe.skip

const AUTHOR = '42c9ef0b223a8f4a631b73bc4aa021a52059c8f97a89726d85f374f823ffde9f'
const D = 'voucher:a5e17b7b-136b-41ec-8615-cdadea10d001'

live('with the relay unreachable, the gateway carries the read', () => {
  it('newestAddressable still finds the record', async () => {
    const { newestAddressable } = await import('../relay')
    const found = await newestAddressable(AUTHOR, 30078, D, ['ws://127.0.0.1:1'])
    expect(found).not.toBeNull()
    expect(found!.tags.some(([n, v]) => n === 'd' && v === D)).toBe(true)
    expect(found!.created_at).toBeGreaterThan(0)
    console.log('LIVE newestAddressable id=%s created_at=%d', found!.id, found!.created_at)
  }, 60000)

  it('refuses a d tag that does not exist, rather than any old kind-30078', async () => {
    const { newestAddressable } = await import('../relay')
    const found = await newestAddressable(AUTHOR, 30078, 'imani:no-such-record', ['ws://127.0.0.1:1'])
    expect(found).toBeNull()
  }, 60000)

  it('allAddressable returns the prefixed set', async () => {
    const { allAddressable } = await import('../relay')
    const events = await allAddressable(AUTHOR, 30078, 'voucher:', ['ws://127.0.0.1:1'])
    expect(events.length).toBeGreaterThan(0)
    expect(events.every((e) => e.tags.some(([n, v]) => n === 'd' && v.startsWith('voucher:')))).toBe(true)
    console.log('LIVE allAddressable count=%d', events.length)
  }, 60000)

  it('excludes records that do not match the prefix', async () => {
    const { allAddressable } = await import('../relay')
    const events = await allAddressable(AUTHOR, 30078, 'imani:issued:', ['ws://127.0.0.1:1'])
    console.log('LIVE allAddressable imani:issued: count=%d', events.length)
    expect(events.every((e) => e.tags.some(([n, v]) => n === 'd' && v.startsWith('imani:issued:')))).toBe(true)
  }, 60000)

  /**
   * The freshness property, and the one that decides whether this design is
   * sound at all.
   *
   * I described this module as reading "the gateway's nostrdb cache". That was
   * wrong, and the difference is not cosmetic: a cache lags, so a merchant
   * renaming their stall could read back the old name. What the endpoint
   * actually does for kind-30078 is answer from the gateway's own SERVER-SIDE
   * RELAY CONNECTION — `RelayIngestPump` subscribes to kind-1059 only, so this
   * kind never enters nostrdb by that route, yet the endpoint returns it.
   *
   * Publishing here and reading back through the gateway proves it, and proves
   * defect 4 (the cache short-circuit) is genuinely gone: a short-circuiting
   * cache could not return an event it has never held.
   */
  it('returns an event published seconds ago, so it is not a lagging cache', async () => {
    const WebSocket = (await import('ws')).default
    // Node 20 has no global WebSocket, and nostr-tools reports that as a silent
    // connection failure that looks like the relay rejecting the event.
    ;(globalThis as unknown as { WebSocket?: unknown }).WebSocket ??= WebSocket
    const { SimplePool, finalizeEvent, generateSecretKey, getPublicKey } = await import(
      'nostr-tools'
    )

    const sk = generateSecretKey()
    const pubkey = getPublicKey(sk)
    const d = `probe-freshness-${Date.now()}`
    const event = finalizeEvent(
      { kind: 30078, created_at: Math.floor(Date.now() / 1000), tags: [['d', d]], content: '{}' },
      sk,
    )

    const pool = new SimplePool()
    await Promise.allSettled(pool.publish(['wss://relay.staging.398ja.xyz'], event))
    pool.close(['wss://relay.staging.398ja.xyz'])
    // The gateway's own relay subscription needs a moment to see it.
    await new Promise((r) => setTimeout(r, 2500))

    // Read it back with the relay leg of OUR code disabled, so the only path
    // to this event is through the gateway.
    const { newestAddressable } = await import('../relay')
    const found = await newestAddressable(pubkey, 30078, d, ['ws://127.0.0.1:1'])

    expect(found, 'gateway did not return an event published 2.5s ago').not.toBeNull()
    expect(found!.id).toBe(event.id)
    console.log('LIVE freshness d=%s returned id=%s', d, found!.id)
  }, 60000)
})
