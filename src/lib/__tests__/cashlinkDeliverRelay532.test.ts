/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hexToBytes } from '@noble/hashes/utils'

/**
 * #532 point 1: a Cashlink wrap is delivered only when the RELAY holds it (publish OK and a
 * read-back by id from the relay). The gateway mirror keeps what strfry refused, so it never counts.
 */
const h = vi.hoisted(() => ({
  relay: { ok: 1, total: 1, errors: [] as string[] },
  held: true,
  mirrored: true,
  publishes: 0,
  readBacks: 0,
}))
vi.mock('../relay', async (orig) => ({
  ...(await orig<typeof import('../relay')>()),
  publish: async () => {
    h.publishes++
    return h.relay
  },
  relayHasEvent: async () => {
    h.readBacks++
    return h.held
  },
}))
vi.mock('../transferSignature', async (orig) => ({ ...(await orig<typeof import('../transferSignature')>()), mirrorToGateway: async () => h.mirrored }))
vi.mock('../nap', async (orig) => ({ ...(await orig<typeof import('../nap')>()), getSigner: () => ({ pubkey: 'ab'.repeat(32) }) }))

const { deliver } = await import('../cashlinkPorts')
const { deliverToRelay } = await import('../relayDelivery')
const L = hexToBytes('55'.repeat(32))

beforeEach(() => {
  h.relay = { ok: 1, total: 1, errors: [] }
  h.held = true
  h.mirrored = true
  h.publishes = 0
  h.readBacks = 0
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('cashlink deliver counts only the relay (#532)', () => {
  it('relay OK and found by id on the relay: delivered', async () => {
    expect(await deliver(L, 'cashuBexample')).toBe(true)
    expect(h.readBacks).toBe(1)
  })

  it('relay refuses too_large, the gateway mirror accepts: NOT delivered, and not retried', async () => {
    h.relay = { ok: 0, total: 1, errors: ['invalid: event too large: 66045'] }
    h.mirrored = true
    expect(await deliver(L, 'cashuBexample')).toBe(false)
    expect(h.publishes).toBe(1)
    expect(h.readBacks).toBe(0)
  })

  it('relay said OK but does not hold it by id: not delivered', async () => {
    h.held = false
    expect(await deliver(L, 'cashuBexample')).toBe(false)
  }, 10_000)

  it('mirror failing does not undo a relay delivery', async () => {
    h.mirrored = false
    expect(await deliver(L, 'cashuBexample')).toBe(true)
  })
})

describe('deliverToRelay outcomes', () => {
  const ev = { id: 'ee'.repeat(32), kind: 1059, pubkey: 'ab'.repeat(32), created_at: 1, tags: [], content: 'x', sig: '00'.repeat(64) }
  const ports = (publish: () => Promise<{ ok: number; total: number; errors: string[] }>, readBack: () => Promise<boolean | null> = async () => true) => ({
    publish,
    readBack,
    sleep: async () => {},
  })

  it('says too_large for a size refusal', async () => {
    expect(await deliverToRelay(ev, ports(async () => ({ ok: 0, total: 1, errors: ['invalid: event too large: 66045'] })))).toEqual({ delivered: false, why: 'too_large' })
  })
  it('retries an unreachable relay and then gives up', async () => {
    let n = 0
    const out = await deliverToRelay(ev, ports(async () => (n++, { ok: 0, total: 1, errors: ['connection failure: x'] })), { attempts: 3 })
    expect(out).toEqual({ delivered: false, why: 'unreachable' })
    expect(n).toBe(3)
  })
  it('refuses to publish an event over the budget at all', async () => {
    let n = 0
    const big = { ...ev, content: 'a'.repeat(60_000) }
    expect(await deliverToRelay(big, ports(async () => (n++, { ok: 1, total: 1, errors: [] })))).toEqual({ delivered: false, why: 'oversize' })
    expect(n).toBe(0)
  })
  it('a relay that cannot be read back is unreachable, not delivered', async () => {
    expect(await deliverToRelay(ev, ports(async () => ({ ok: 1, total: 1, errors: [] }), async () => null))).toEqual({ delivered: false, why: 'unreachable' })
  })
})
