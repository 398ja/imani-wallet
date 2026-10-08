/**
 * @vitest-environment node
 */
import { createServer, type Server } from 'node:net'

import { beforeAll, describe, expect, it } from 'vitest'
import { finalizeEvent } from 'nostr-tools'
// Aliased: not a React hook, it only starts with `use`.
import { useWebSocketImplementation as setWebSocketImplementation } from 'nostr-tools/pool'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import WebSocket from 'ws'

import { publish } from '../relay'

setWebSocketImplementation(WebSocket)
// relay.ts imports SimplePool from 'nostr-tools', a different module instance
// from 'nostr-tools/pool' under vitest, so the setter above does not reach it
// (the two tests above passed regardless, since a refused port fails either
// way). A global WebSocket does.
;(globalThis as { WebSocket?: unknown }).WebSocket ??= WebSocket

/**
 * `publish` must not count a relay it never reached as one that accepted the
 * event (#98 review).
 *
 * nostr-tools resolves a failed connection with the string
 * "connection failure: ..." instead of rejecting, so the old count treated
 * every unreachable relay as a success. Found by the live receipt probe, which
 * reported a signature "sent" with the wallet's relay pointed at a dead port.
 * Callers act on `ok`: an attestation receipt is written, and a queued 7378 is
 * dropped as published, only when `ok > 0`.
 *
 * Over real sockets rather than a mocked pool, because the defect is exactly a
 * disagreement between what the pool's API looks like and what it does.
 */

const event = () =>
  finalizeEvent(
    { kind: 1, created_at: Math.floor(Date.now() / 1000), tags: [], content: 'publish-count test' },
    secp256k1.utils.randomSecretKey(),
  )

/** A TCP port that refuses every connection: bound, then closed. */
let deadPort = 0
beforeAll(async () => {
  const s: Server = createServer()
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve))
  deadPort = (s.address() as { port: number }).port
  await new Promise<void>((resolve) => s.close(() => resolve()))
})

describe('publish', () => {
  it('reports an unreachable relay as a failure, not an acceptance', async () => {
    const result = await publish(event(), [`ws://127.0.0.1:${deadPort}`])

    expect(result.total).toBe(1)
    expect(result.ok).toBe(0)
    expect(result.errors[0]).toMatch(/connection failure/)
  })

  it('counts each relay on its own merits', async () => {
    const result = await publish(event(), [`ws://127.0.0.1:${deadPort}`, 'ws://127.0.0.1:1'])

    expect(result).toMatchObject({ ok: 0, total: 2 })
    expect(result.errors).toHaveLength(2)
  })
})

/**
 * A relay that answers `OK false` has refused the event, and its reason must
 * reach the caller (#203). strfry says `invalid: event too large: 66031` for a
 * coupon backup over `maxEventSize`, and that refusal went unseen because the
 * caller ignored the result. Over a real socket, against a relay that refuses
 * everything, so a nostr-tools change that resolved `OK false` as a string
 * would fail here rather than in production.
 */
describe('publish against a relay that refuses', () => {
  it('counts an OK false as a failure and carries the relay reason', async () => {
    const { WebSocketServer } = await import('ws')
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await new Promise<void>((resolve) => server.on('listening', () => resolve()))
    server.on('connection', (socket) =>
      socket.on('message', (raw) => {
        const [type, ev] = JSON.parse(String(raw)) as [string, { id: string }]
        if (type === 'EVENT') socket.send(JSON.stringify(['OK', ev.id, false, 'invalid: event too large: 66031']))
      }),
    )
    try {
      const { port } = server.address() as { port: number }
      const result = await publish(event(), [`ws://127.0.0.1:${port}`])
      expect(result).toMatchObject({ ok: 0, total: 1 })
      expect(result.errors).toEqual(['invalid: event too large: 66031'])
    } finally {
      server.close()
    }
  })
})
