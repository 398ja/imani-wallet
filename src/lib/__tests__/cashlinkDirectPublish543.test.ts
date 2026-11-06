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
const h = vi.hoisted(() => ({ relayOk: 1, mirrored: true }))
vi.mock('../relay', async (orig) => ({ ...(await orig<typeof import('../relay')>()), publish: async () => ({ ok: h.relayOk, failed: h.relayOk ? 0 : 1 }) }))
vi.mock('../transferSignature', async (orig) => ({ ...(await orig<typeof import('../transferSignature')>()), mirrorToGateway: async () => h.mirrored }))
vi.mock('../nap', async (orig) => ({ ...(await orig<typeof import('../nap')>()), getSigner: () => ({ pubkey: 'ab'.repeat(32) }) }))

const { appDirectPorts } = await import('../cashlinkDirectPorts')
const L = hexToBytes('44'.repeat(32))
const TOKEN = 'cashuBexample'

beforeEach(() => {
  h.relayOk = 1
  h.mirrored = true
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
})
