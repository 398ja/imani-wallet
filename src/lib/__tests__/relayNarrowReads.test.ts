import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Event } from 'nostr-tools'

/**
 * #540 F6/F7 review: the two narrow reads `relay.ts` gained. `eventsSince` must say "there may be
 * more" (null) when the gateway's page came back full, or a spent-set top-up would silently miss
 * tombstones past the page. `eventsByD` must ask with a `#d` filter, never the whole kind.
 */
const gatewayQuery = vi.fn<(filter: Record<string, unknown>) => Promise<Event[]>>()
vi.mock('../gatewayNostr', async (orig) => ({
  ...(await orig<typeof import('../gatewayNostr')>()),
  gatewayQuery: (filter: Record<string, unknown>) => gatewayQuery(filter),
}))
vi.mock('nostr-tools', async (orig) => ({ ...(await orig<typeof import('nostr-tools')>()), verifyEvent: () => true }))

const { eventsSince, eventsByD } = await import('../relay')
const { GATEWAY_PAGE_LIMIT } = await import('../gatewayNostr')

const PK = 'a'.repeat(64)
const ev = (n: number): Event => ({ id: String(n).padStart(64, '0'), pubkey: PK, kind: 7375, created_at: n, tags: [], content: '', sig: '' })

beforeEach(() => gatewayQuery.mockReset())

describe('#540 relay narrow reads', () => {
  it('eventsSince answers the events of a short page', async () => {
    gatewayQuery.mockResolvedValue([ev(1), ev(2)])
    expect(await eventsSince(PK, 7375, 100)).toHaveLength(2)
    expect(gatewayQuery.mock.calls[0][0]).toMatchObject({ kinds: [7375], authors: [PK], since: 100 })
  })

  it('eventsSince answers null for a full page, so the caller reads everything', async () => {
    gatewayQuery.mockResolvedValue(Array.from({ length: GATEWAY_PAGE_LIMIT }, (_, n) => ev(n)))
    expect(await eventsSince(PK, 7375, 100)).toBeNull()
  })

  it('eventsByD asks by #d and never for the whole kind', async () => {
    gatewayQuery.mockResolvedValue([])
    await eventsByD(PK, 7375, ['t-state', 't-chunk-0'])
    expect(gatewayQuery.mock.calls[0][0]).toMatchObject({ tags: { '#d': ['t-state', 't-chunk-0'] } })
    expect(await eventsByD(PK, 7375, [])).toEqual([])
    expect(gatewayQuery).toHaveBeenCalledTimes(1)
  })
})
