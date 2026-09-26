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
