/**
 * @vitest-environment jsdom
 *
 * Tombstones, read before a send.
 *
 * The behaviours worth pinning here are the FAILURE ones. A module that drops
 * spent coupons when both stores answer is easy; one that keeps a customer's
 * holding intact when neither does is the reason this can sit on the payment
 * path at all. So most of this file is about silence.
 *
 * Both sources are substituted at the module boundary rather than mocked
 * deeper, because the union rule and the "empty is not the same as unknown"
 * rule are properties of how the two answers combine, and a test that stubbed
 * the combination would be asserting itself.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Event } from 'nostr-tools'

const relayEvents = vi.fn<(pubkey: string, kind: number) => Promise<Event[]>>()
const gatewayQuery = vi.fn<(pubkey: string, kind: number) => Promise<Event[]>>()

vi.mock('../relay', () => ({ allEvents: (p: string, k: number) => relayEvents(p, k) }))
vi.mock('../gatewayNostr', () => ({ gatewayEvents: (p: string, k: number) => gatewayQuery(p, k) }))

const { spentTokenIds, withoutSpent, forgetSpentIds } = await import('../spentCoupons')

const PK = 'a'.repeat(64)

/** A tombstone as `buildRecord` writes one: `d` is the token_id, `spent` is a tag. */
const tombstone = (tokenId: string): Event =>
  ({
    id: `evt-${tokenId}`,
    kind: 7375,
    created_at: 1_700_000_000,
    pubkey: PK,
    tags: [
      ['d', tokenId],
      ['spent', 'true'],
    ],
    content: 'nip44-sealed-payload',
    sig: 'x',
  }) as Event

/** A live coupon record: same kind, same shape, `spent` false. */
const record = (tokenId: string): Event =>
  ({ ...tombstone(tokenId), tags: [['d', tokenId], ['spent', 'false']] }) as Event

beforeEach(() => {
  forgetSpentIds()
  relayEvents.mockReset()
  gatewayQuery.mockReset()
})
afterEach(() => forgetSpentIds())

describe('reading tombstones', () => {
  it('names the ids carrying a tombstone', async () => {
    relayEvents.mockResolvedValue([tombstone('t1'), record('t2'), tombstone('t3')])
    gatewayQuery.mockResolvedValue([])

    const spent = await spentTokenIds(PK)

    expect([...spent.ids].sort()).toEqual(['t1', 't3'])
    expect(spent.known).toBe(true)
  })

  it('reads the tag rather than the sealed payload', async () => {
    // The whole point: `d` and `spent` are public, so this never needs the
    // customer's key and never opens a NIP-44 seal. A test that passed only
    // with a decryptor available would mean the opposite.
    relayEvents.mockResolvedValue([tombstone('t1')])
    gatewayQuery.mockResolvedValue([])

    expect((await spentTokenIds(PK)).ids.has('t1')).toBe(true)
  })

  it('unions both stores, so either one seeing a spend is enough', async () => {
    relayEvents.mockResolvedValue([tombstone('only-relay')])
    gatewayQuery.mockResolvedValue([tombstone('only-gateway')])

    const spent = await spentTokenIds(PK)

    // A tombstone is FINAL, so there is no newest-wins rule to get wrong: an id
    // spent according to one store is spent, and a stale store can only miss
    // one, never invent one.
    expect([...spent.ids].sort()).toEqual(['only-gateway', 'only-relay'])
  })

  it('still answers when one store fails', async () => {
    relayEvents.mockRejectedValue(new Error('relay unreachable from the browser'))
    gatewayQuery.mockResolvedValue([tombstone('t1')])

    const spent = await spentTokenIds(PK)

    // Settled, not raced: one source failing must not discard the other's
    // answer. A deployment that does not publish strfry's port is exactly this
    // case, permanently.
    expect(spent.ids.has('t1')).toBe(true)
    expect(spent.known).toBe(true)
  })
})

describe('when nothing can be read', () => {
  it('reports unknown rather than an empty answer', async () => {
    relayEvents.mockRejectedValue(new Error('down'))
    gatewayQuery.mockRejectedValue(new Error('down'))

    const spent = await spentTokenIds(PK)

    // THE distinction. An empty set from a failed read and an empty set from a
    // wallet that has spent nothing are the same value and mean opposite
    // things — #36 is the precedent, where a gateway returning zero gift wraps
    // looked exactly like a customer holding none.
    expect(spent.known).toBe(false)
    expect(spent.ids.size).toBe(0)
  })

  it('leaves the holding untouched', async () => {
    relayEvents.mockRejectedValue(new Error('down'))
    gatewayQuery.mockRejectedValue(new Error('down'))

    const rows = [{ token_id: 't1' }, { token_id: 't2' }]

    expect(withoutSpent(rows, await spentTokenIds(PK))).toEqual(rows)
  })

  it('ignores ids it holds when the read is not known', () => {
    // Constructed rather than read, because a FAILED read yields an empty set
    // and an empty set is filtered out by the size check alone — so a version
    // that dropped the `known` guard passed anyway. That is the mutation this
    // exists to catch: `known` must gate the filter on its own, not merely
    // co-occur with emptiness.
    //
    // The state is reachable. A source can answer with tombstones and the
    // OTHER can be the one that failed, and a future caller assembling a
    // partial result must not have those ids acted on.
    const rows = [{ token_id: 't1' }, { token_id: 't2' }]

    expect(withoutSpent(rows, { ids: new Set(['t1']), known: false })).toEqual(rows)
    expect(withoutSpent(rows, { ids: new Set(['t1']), known: true })).toEqual([{ token_id: 't2' }])
  })

  it('does not cache a failed read', async () => {
    relayEvents.mockRejectedValueOnce(new Error('down'))
    gatewayQuery.mockRejectedValueOnce(new Error('down'))
    expect((await spentTokenIds(PK)).known).toBe(false)

    // The next send gets a fresh chance. Caching the failure would turn one bad
    // moment into a TTL's worth of blindness on the money path.
    relayEvents.mockResolvedValue([tombstone('t1')])
    gatewayQuery.mockResolvedValue([])

    const second = await spentTokenIds(PK)
    expect(second.known).toBe(true)
    expect(second.ids.has('t1')).toBe(true)
  })

  it('never throws, whatever the sources do', async () => {
    relayEvents.mockImplementation(() => {
      throw new Error('synchronous explosion')
    })
    gatewayQuery.mockImplementation(() => {
      throw new Error('synchronous explosion')
    })

    // An exception escaping here reaches the send path, where it would look
    // like a failed payment rather than an unreachable relay.
    await expect(spentTokenIds(PK)).resolves.toMatchObject({ known: false })
  })
})

describe('a wallet that has spent nothing', () => {
  it('answers known, with an empty set', async () => {
    relayEvents.mockResolvedValue([record('t1'), record('t2')])
    gatewayQuery.mockResolvedValue([])

    const spent = await spentTokenIds(PK)

    // Events came back, so the read WORKED — there simply are no tombstones.
    // Distinct from the failure case above, which is the point.
    expect(spent.known).toBe(true)
    expect(spent.ids.size).toBe(0)
  })
})

describe('filtering a holding', () => {
  it('drops a tombstoned coupon and keeps the rest', async () => {
    relayEvents.mockResolvedValue([tombstone('spent-elsewhere')])
    gatewayQuery.mockResolvedValue([])

    const rows = [{ token_id: 'spent-elsewhere' }, { token_id: 'still-mine' }]

    expect(withoutSpent(rows, await spentTokenIds(PK))).toEqual([{ token_id: 'still-mine' }])
  })

  it('keeps a row with no token_id, rather than guessing', async () => {
    relayEvents.mockResolvedValue([tombstone('t1')])
    gatewayQuery.mockResolvedValue([])

    const rows = [{ token_id: undefined }, { token_id: 't1' }]

    // A row without the id this module keys on cannot be matched, and dropping
    // what cannot be matched would silently remove money.
    expect(withoutSpent(rows, await spentTokenIds(PK))).toEqual([{ token_id: undefined }])
  })
})

describe('caching', () => {
  it('reads once for a burst of sends', async () => {
    relayEvents.mockResolvedValue([tombstone('t1')])
    gatewayQuery.mockResolvedValue([])

    await spentTokenIds(PK)
    await spentTokenIds(PK)
    await spentTokenIds(PK)

    // The read sits in front of a payment. One per session, not one per send.
    expect(relayEvents).toHaveBeenCalledTimes(1)
  })

  it('does not serve one customer’s answer to another', async () => {
    relayEvents.mockResolvedValue([tombstone('t1')])
    gatewayQuery.mockResolvedValue([])
    await spentTokenIds(PK)

    relayEvents.mockResolvedValue([tombstone('other')])
    const other = await spentTokenIds('b'.repeat(64))

    expect(other.ids.has('t1')).toBe(false)
    expect(other.ids.has('other')).toBe(true)
  })
})
