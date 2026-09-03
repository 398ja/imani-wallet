/**
 * The one lookup on this service that needs a network.
 *
 * The query is injected so an outage is a test rather than an argument. Every
 * failure mode here resolves to `unknown`, and `unknown` refuses the send.
 */
import { readFile } from 'node:fs/promises'

import { describe, expect, it, vi } from 'vitest'
import type { Event } from 'nostr-tools'

import { createStallLookup, STALL_KIND, STALL_D_TAG } from '../stallLookup.js'

const KEY = 'a'.repeat(64)

const event = (over: Partial<Event> & { content?: string } = {}): Event =>
  ({
    id: 'e'.repeat(64),
    pubkey: KEY,
    kind: STALL_KIND,
    created_at: 1_700_000_000,
    tags: [['d', STALL_D_TAG]],
    content: JSON.stringify({ active: true, categories: ['retail'] }),
    sig: 'f'.repeat(128),
    ...over,
  }) as Event

describe('reading a stall record', () => {
  it('reports a live record as a stall', async () => {
    const lookup = createStallLookup(async () => [event()])
    expect(await lookup.role(KEY)).toBe('stall')
  })

  it('reports no record as a customer', async () => {
    const lookup = createStallLookup(async () => [])
    expect(await lookup.role(KEY)).toBe('customer')
  })

  it('reports a retired stall as a customer', async () => {
    const lookup = createStallLookup(async () => [
      event({ content: JSON.stringify({ active: false }) }),
    ])
    expect(await lookup.role(KEY)).toBe('customer')
  })

  /**
   * Publishing the record is the act that makes someone a stall, so an
   * unparseable one still counts — the app's `mergeMerchantEvent` takes the
   * same position. Erring towards "is a stall" can only cause a refusal, never
   * an allowance, which is the safe direction here.
   */
  it('treats an unparseable record as a stall, erring towards refusal', async () => {
    const lookup = createStallLookup(async () => [event({ content: 'not json' })])
    expect(await lookup.role(KEY)).toBe('stall')
  })

  it('treats a record missing `active` as live, not as a retirement', async () => {
    const lookup = createStallLookup(async () => [
      event({ content: JSON.stringify({ categories: ['retail'] }) }),
    ])
    expect(await lookup.role(KEY)).toBe('stall')
  })

  /**
   * A store that ignored the `#d` filter would otherwise satisfy
   * `imani:merchant` with any other kind-30078 this key has published, and
   * possa-merchant writes several.
   */
  it('ignores a kind-30078 that is not a stall record', async () => {
    const lookup = createStallLookup(async () => [
      event({ tags: [['d', 'imani:settings']] }),
    ])
    expect(await lookup.role(KEY)).toBe('customer')
  })

  it('takes the newest record when a relay returns an old copy too', async () => {
    const lookup = createStallLookup(async () => [
      event({ created_at: 1_700_000_000, content: JSON.stringify({ active: true }) }),
      event({ created_at: 1_800_000_000, content: JSON.stringify({ active: false }) }),
    ])
    // The newer one retires the stall.
    expect(await lookup.role(KEY)).toBe('customer')
  })
})

describe('when the network cannot be reached', () => {
  /**
   * The branch the whole module exists for. `unknown` is not `customer`: one
   * means "asked, and they are not a stall", the other "could not ask".
   * Collapsing them is what lets a foreign coupon through during an outage.
   */
  it('reports unknown rather than customer', async () => {
    const lookup = createStallLookup(async () => {
      throw new Error('relay unreachable')
    })
    expect(await lookup.role(KEY)).toBe('unknown')
  })

  it('reports unknown when the query times out', async () => {
    const lookup = createStallLookup(async () => {
      throw new Error('relay lookup timed out after 5000ms')
    })
    expect(await lookup.role(KEY)).toBe('unknown')
  })

  it('never throws, so the guard always gets an answer to act on', async () => {
    const lookup = createStallLookup(async () => {
      throw new Error('boom')
    })
    await expect(lookup.role(KEY)).resolves.toBe('unknown')
  })
})

describe('caching', () => {
  it('caches a positive answer rather than asking twice', async () => {
    const query = vi.fn(async () => [event()])
    const lookup = createStallLookup(query)

    expect(await lookup.role(KEY)).toBe('stall')
    expect(await lookup.role(KEY)).toBe('stall')
    expect(query).toHaveBeenCalledTimes(1)
  })

  /**
   * Only positives are cached, exactly as the app caches only positives. A
   * cached NEGATIVE is the dangerous one: a lookup that lost a race, or a relay
   * briefly unreachable, would pin "not a stall" on a real stall for the life
   * of the process — and that is the answer that ALLOWS a foreign coupon
   * through.
   */
  it('does not cache a negative, so a stall is never pinned as a customer', async () => {
    let answer: Event[] = []
    const query = vi.fn(async () => answer)
    const lookup = createStallLookup(query)

    expect(await lookup.role(KEY)).toBe('customer')

    // The relay now holds the record — a race the first call lost.
    answer = [event()]
    expect(await lookup.role(KEY)).toBe('stall')
    expect(query).toHaveBeenCalledTimes(2)
  })

  it('does not cache an outage as an answer', async () => {
    let fail = true
    const query = vi.fn(async () => {
      if (fail) throw new Error('down')
      return [event()]
    })
    const lookup = createStallLookup(query)

    expect(await lookup.role(KEY)).toBe('unknown')
    fail = false
    expect(await lookup.role(KEY)).toBe('stall')
  })

  it('is case-insensitive, so one key is not looked up twice', async () => {
    const query = vi.fn(async () => [event()])
    const lookup = createStallLookup(query)

    await lookup.role(KEY.toUpperCase())
    await lookup.role(KEY)
    expect(query).toHaveBeenCalledTimes(1)
  })
})

/**
 * The failure the unit tests could not see.
 *
 * Every outage test above injects a query that THROWS. `querySync` does not
 * throw when a relay is unreachable — measured against a dead host, it RESOLVES
 * `[]` after 19ms. An unreachable relay is byte-identical to a relay holding no
 * record, which reads as `customer` and ALLOWS a cross-stall send.
 *
 * So the whole fail-closed guarantee was absent while every test passed. The
 * container proved it on the first real request: a coupon issued by stall A,
 * addressed to stall B, with no relay anywhere, was planned without complaint.
 *
 * The fix is to open the connection explicitly first, because `ensureRelay`
 * DOES reject when the socket cannot open. These tests pin the distinction that
 * fix rests on.
 */
describe('an unreachable relay is not an empty relay', () => {
  it('refuses when the connection fails, even though a query would resolve empty', async () => {
    // Exactly what nostr-tools does: the connection is what fails, and a query
    // against it would have quietly returned nothing.
    const lookup = createStallLookup(async () => {
      throw new Error('connection failed')
    })

    expect(await lookup.role(KEY)).toBe('unknown')
  })

  /**
   * The inverse, and the reason this cannot simply be "treat empty as unknown":
   * a genuinely empty answer from a live relay MUST read as `customer`, or
   * every send to a customer would be refused and the feature would be useless.
   */
  it('still reports a customer when a live relay genuinely holds nothing', async () => {
    const lookup = createStallLookup(async () => [])
    expect(await lookup.role(KEY)).toBe('customer')
  })

  /**
   * Pins the real seam rather than the injected one.
   *
   * The injected `query` is where tests substitute an outage, but production
   * uses `queryRelay`, and the bug lived there — in code no injected query
   * could reach. This asserts the source establishes the connection before
   * querying, which is the property that makes an empty result trustworthy.
   */
  it('opens the connection explicitly before querying', async () => {
    const source = await readFile(new URL('../stallLookup.ts', import.meta.url), 'utf8')

    // Comment lines stripped: both names appear in the prose above the code,
    // which made a naive index comparison compare documentation rather than
    // behaviour — it failed on a correct implementation.
    const code = source
      .split('\n')
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join('\n')

    const ensureAt = code.indexOf('ensureRelay')
    const queryAt = code.indexOf('querySync')

    expect(ensureAt).toBeGreaterThan(-1)
    expect(queryAt).toBeGreaterThan(ensureAt)
    // And the connection state is checked, not assumed.
    expect(code).toContain('relay.connected')
  })
})
