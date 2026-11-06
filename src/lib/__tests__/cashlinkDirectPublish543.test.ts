/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hexToBytes } from '@noble/hashes/utils'

/**
 * #543 review: a direct Cashlink's wrap is "on the link" only when the relay said OK AND the gateway
 * mirror took it. The claimer reads the gateway, so a relay-only copy is not delivered; and a
 * gateway-only copy is the #532 trap (the gateway keeps what strfry refused).
 */
const h = vi.hoisted(() => ({ relayOk: 1, mirrored: true, errors: [] as string[], calls: 0, script: [] as Array<{ ok: number; errors: string[] }> }))
vi.mock('../relay', async (orig) => ({
  ...(await orig<typeof import('../relay')>()),
  publish: async () => {
    h.calls++
    const next = h.script.shift()
    if (next) return { ...next, total: 1 }
    return { ok: h.relayOk, total: 1, errors: h.relayOk ? [] : h.errors }
  },
}))
vi.mock('../transferSignature', async (orig) => ({ ...(await orig<typeof import('../transferSignature')>()), mirrorToGateway: async () => h.mirrored }))
vi.mock('../nap', async (orig) => ({ ...(await orig<typeof import('../nap')>()), getSigner: () => ({ pubkey: 'ab'.repeat(32) }) }))

const { appDirectPorts, publishWrap, WRAP_RELAY_ATTEMPTS } = await import('../cashlinkDirectPorts')
const noSleep = async () => {}
const L = hexToBytes('44'.repeat(32))
const TOKEN = 'cashuBexample'

beforeEach(() => {
  h.relayOk = 1
  h.mirrored = true
  h.errors = ['invalid: event too large: 66045']
  h.calls = 0
  h.script = []
})

describe('#543 review: a direct wrap is delivered only on relay OK and gateway 2xx', () => {
  it('both: delivered', async () => {
    expect(await appDirectPorts().publish(L, TOKEN)).toBe(true)
  })
  it('relay refused (too large, #532), gateway kept it: not delivered', async () => {
    h.relayOk = 0
    expect(await appDirectPorts().publish(L, TOKEN)).toBe(false)
  })
  it('relay OK, gateway refused: not delivered (the claimer reads the gateway)', async () => {
    h.mirrored = false
    expect(await appDirectPorts().publish(L, TOKEN)).toBe(false)
  })
  it('a relay that could not be reached is tried again, and the wrap lands', async () => {
    h.script = [{ ok: 0, errors: ['connection failure: connection timed out'] }, { ok: 0, errors: ['connection failure: connection timed out'] }]
    expect(await publishWrap(L, TOKEN, noSleep)).toBe(true)
    expect(h.calls).toBe(3)
  })
  it('an unreachable relay is tried at most WRAP_RELAY_ATTEMPTS times', async () => {
    h.relayOk = 0
    h.errors = ['connection failure: connection timed out']
    expect(await publishWrap(L, TOKEN, noSleep)).toBe(false)
    expect(h.calls).toBe(WRAP_RELAY_ATTEMPTS)
  })
  it('a relay that REFUSED the wrap (too large) is never tried again', async () => {
    h.relayOk = 0
    expect(await publishWrap(L, TOKEN, noSleep)).toBe(false)
    expect(h.calls).toBe(1)
  })
})
