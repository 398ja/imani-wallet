import { describe, expect, it, vi } from 'vitest'
import { finalizeEvent } from 'nostr-tools'

/** imani-wallet#582: the ledger v2 relay read pages to exhaustion and fails closed, never truncates. */

let store: ReturnType<typeof finalizeEvent>[] = []
let fail = false
/** When set, the gateway ignores the filter and answers this per call (a misbehaving gateway). */
let rogue: (() => ReturnType<typeof finalizeEvent>[]) | null = null
vi.mock('../gatewayNostr', async (orig) => {
  const real = await orig<typeof import('../gatewayNostr')>()
  return {
    ...real,
    gatewayQuery: async (f: { limit: number; until?: number }) => {
      if (fail) throw new real.GatewayUnreachableError('timed out')
      if (rogue) return rogue()
      // Newest first, capped at the page limit, inclusive `until`: like the gateway.
      return store
        .filter((e) => f.until === undefined || e.created_at <= f.until)
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, f.limit)
    },
  }
})
const { eventsByDTag, MAX_LEDGER_EVENTS } = await import('../relay')

const sk = new Uint8Array(32).fill(7)
const ev = (t: number) => finalizeEvent({ kind: 30078, tags: [['d', 'x']], content: String(t), created_at: t }, sk)

describe('eventsByDTag', () => {
  it('reads every event across pages, oldest included', { timeout: 60_000 }, async () => {
    fail = false
    store = Array.from({ length: 1100 }, (_, i) => ev(i + 1))
    const got = await eventsByDTag(30078, 'x')
    expect(got).toHaveLength(1100)
    expect(got.some((e) => e.created_at === 1)).toBe(true)
  })
  it('throws above the cap', async () => {
    fail = false
    // The cap is checked before signatures, so unsigned stand-ins with distinct ids suffice.
    const base = ev(1)
    store = Array.from({ length: MAX_LEDGER_EVENTS + 1 }, (_, i) => ({ ...base, id: `e${i}`, created_at: i + 1 }))
    await expect(eventsByDTag(30078, 'x')).rejects.toThrow(String(MAX_LEDGER_EVENTS))
  })
  it('throws when the gateway cannot answer', async () => {
    fail = true
    await expect(eventsByDTag(30078, 'x')).rejects.toThrow('timed out')
  })
})

describe('eventsByDTag page bound (N5)', () => {
  it('throws past MAX_LEDGER_PAGES when every page brings only one new event', async () => {
    fail = false
    const { MAX_LEDGER_PAGES } = await import('../relay')
    const base = ev(1)
    // Each call: one full page, 499 repeats plus one new id, a second earlier each time, so the walk never ends.
    let call = 0
    rogue = () => {
      call++
      return [
        ...Array.from({ length: 499 }, (_, i) => ({ ...base, id: `old${i}`, created_at: 10_000 - call })),
        { ...base, id: `n${call}`, created_at: 10_000 - call },
      ]
    }
    await expect(eventsByDTag(30078, 'x')).rejects.toThrow(`${MAX_LEDGER_PAGES} pages`)
    expect(call).toBe(MAX_LEDGER_PAGES)
    rogue = null
  })
})
