import { beforeEach, describe, expect, it, vi } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools'

/**
 * Reads go through the gateway's cache only (owner rule, #428). The properties under test:
 * - every read is ONE gateway query, and never a relay socket;
 * - "the gateway did not answer" throws, so it can never read as "no record" (which takes away
 *   the merchant role, or restores a zero balance);
 * - a cached event is trusted only if it is by the author, of the kind, and its signature verifies;
 * - the `d` tag is still checked locally, and newest wins per `d`.
 */

const SimplePoolUsed = vi.fn()
vi.mock('nostr-tools', async (importOriginal) => {
  const actual = await importOriginal<typeof import('nostr-tools')>()
  return {
    ...actual,
    SimplePool: class {
      constructor() {
        SimplePoolUsed()
      }
      async querySync() {
        throw new Error('a read opened a relay socket')
      }
      close() {}
    },
  }
})

let gatewayResponse: { ok: boolean; events: unknown[] } = { ok: true, events: [] }
let lastRequestBody: Record<string, unknown> | undefined
let gatewayThrows = false
let calls = 0

vi.stubGlobal('fetch', async (_url: string, init?: { body?: string }) => {
  calls += 1
  if (gatewayThrows) throw new Error('gateway unreachable')
  lastRequestBody = init?.body ? JSON.parse(init.body) : undefined
  return { ok: gatewayResponse.ok, status: gatewayResponse.ok ? 200 : 503, json: async () => ({ events: gatewayResponse.events }) }
})

const { allAddressable, allEvents, newestAddressable, GatewayUnreachableError } = await import('../relay')

const SK = generateSecretKey()
const MERCHANT = getPublicKey(SK)

/** A signed event as the gateway serialises it: `createdAt`, camelCase. */
function cached(d: string | null, created_at: number, content = `c-${d}-${created_at}`, kind = 30078) {
  const e = finalizeEvent({ kind, created_at, tags: d === null ? [] : [['d', d]], content }, SK)
  const { created_at: at, ...rest } = e
  return { ...rest, createdAt: at }
}

beforeEach(() => {
  gatewayThrows = false
  gatewayResponse = { ok: true, events: [] }
  lastRequestBody = undefined
  calls = 0
  SimplePoolUsed.mockClear()
})

describe('every read is the gateway, never the relay', () => {
  it('newestAddressable: one gateway query, no socket', async () => {
    gatewayResponse = { ok: true, events: [cached('imani:merchant', 100)] }
    expect((await newestAddressable(MERCHANT, 30078, 'imani:merchant'))?.created_at).toBe(100)
    expect(calls).toBe(1)
    expect(SimplePoolUsed).not.toHaveBeenCalled()
  })

  it('allAddressable and allEvents: gateway only, no socket', async () => {
    gatewayResponse = { ok: true, events: [cached('imani:issued:v1', 100)] }
    expect(await allAddressable(MERCHANT, 30078, 'imani:issued:')).toHaveLength(1)
    expect(await allEvents(MERCHANT, 30078)).toHaveLength(1)
    expect(SimplePoolUsed).not.toHaveBeenCalled()
  })
})

describe('unreachable is never "none"', () => {
  it('throws when the gateway cannot be reached', async () => {
    gatewayThrows = true
    await expect(newestAddressable(MERCHANT, 30078, 'imani:merchant')).rejects.toBeInstanceOf(GatewayUnreachableError)
    await expect(allEvents(MERCHANT, 30078)).rejects.toBeInstanceOf(GatewayUnreachableError)
  })

  it('throws on a non-2xx', async () => {
    gatewayResponse = { ok: false, events: [] }
    await expect(newestAddressable(MERCHANT, 30078, 'imani:merchant')).rejects.toBeInstanceOf(GatewayUnreachableError)
    await expect(allAddressable(MERCHANT, 30078, 'imani:issued:')).rejects.toBeInstanceOf(GatewayUnreachableError)
  })

  it('returns null when the gateway answered and holds none', async () => {
    expect(await newestAddressable(MERCHANT, 30078, 'imani:merchant')).toBeNull()
  })
})

describe('a cached event is trusted only when it is authentic', () => {
  it('drops a forged signature', async () => {
    const forged = { ...cached('imani:merchant', 100), content: 'swapped' }
    gatewayResponse = { ok: true, events: [forged] }
    expect(await newestAddressable(MERCHANT, 30078, 'imani:merchant')).toBeNull()
  })

  it('drops another author or another kind', async () => {
    const other = finalizeEvent({ kind: 30078, created_at: 100, tags: [['d', 'imani:merchant']], content: '' }, generateSecretKey())
    gatewayResponse = { ok: true, events: [{ ...other, createdAt: other.created_at }, cached('imani:merchant', 100, 'x', 30079)] }
    expect(await newestAddressable(MERCHANT, 30078, 'imani:merchant')).toBeNull()
  })

  it('reads the camelCase timestamp', async () => {
    gatewayResponse = { ok: true, events: [cached('imani:merchant', 500)] }
    expect((await newestAddressable(MERCHANT, 30078, 'imani:merchant'))?.created_at).toBe(500)
  })
})

describe('the d tag and newest-wins', () => {
  it('sends #d as a standard tag filter, and re-checks it locally', async () => {
    gatewayResponse = { ok: true, events: [cached('imani:settings', 100)] }
    expect(await newestAddressable(MERCHANT, 30078, 'imani:merchant')).toBeNull()
    expect(lastRequestBody).toMatchObject({ kinds: [30078], authors: [MERCHANT], tags: { '#d': ['imani:merchant'] } })
  })

  it('newest copy wins for one d', async () => {
    gatewayResponse = { ok: true, events: [cached('imani:merchant', 100, 'old'), cached('imani:merchant', 300, 'new')] }
    expect((await newestAddressable(MERCHANT, 30078, 'imani:merchant'))?.content).toBe('new')
  })

  it('the ledger dedupes by d (newest), applies the prefix, and drops events with no d', async () => {
    gatewayResponse = {
      ok: true,
      events: [
        cached('imani:issued:v1', 100, 'v1-old'),
        cached('imani:issued:v1', 900, 'v1-new'),
        cached('imani:issued:v2', 100),
        cached('imani:merchant', 900),
        cached(null, 100),
      ],
    }
    const events = await allAddressable(MERCHANT, 30078, 'imani:issued:')
    expect(events).toHaveLength(2)
    expect(events.find((e) => e.tags[0][1] === 'imani:issued:v1')?.content).toBe('v1-new')
  })

  it('sends NO #d filter for a prefix query', async () => {
    await allAddressable(MERCHANT, 30078, 'imani:issued:')
    expect(lastRequestBody).not.toHaveProperty('tags')
  })

  it('ignores a gateway event with no id or no timestamp', async () => {
    gatewayResponse = {
      ok: true,
      events: [
        { kind: 30078, tags: [['d', 'imani:merchant']], createdAt: 100 },
        { id: 'no-time', kind: 30078, tags: [['d', 'imani:merchant']] },
      ],
    }
    expect(await newestAddressable(MERCHANT, 30078, 'imani:merchant')).toBeNull()
  })
})
