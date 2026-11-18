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

import { classifyRelayError, publish, refusedTooLarge, relayHasEvent } from '../relay'

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
      // #532: classified, so a caller can tell "permanent, re-split" from "transient, retry".
      expect(result.refusals).toEqual([{ kind: 'too_large', bytes: 66031, reason: 'invalid: event too large: 66031' }])
      expect(refusedTooLarge(result)).toBe(true)
    } finally {
      server.close()
    }
  })
})

/**
 * A relay slow to ACCEPT the connection, not one that refuses. Staging 2026-10-31: right after a
 * terminal enrolment the stall's profile publish hit "connection timed out" every time and nothing
 * reached strfry. The default 3 s window stays for every other publish; the Terminals page asks
 * for 8 s (`connectMs`), which a 4 s accept fits.
 */
describe('relay refusal classes (#532)', () => {
  it('tells a size refusal from an unreachable relay and any other refusal', () => {
    expect(classifyRelayError('invalid: event too large: 66045')).toMatchObject({ kind: 'too_large', bytes: 66045 })
    expect(classifyRelayError('connection failure: ECONNREFUSED')).toMatchObject({ kind: 'unreachable' })
    expect(classifyRelayError('blocked: pubkey not admitted')).toMatchObject({ kind: 'refused' })
  })
  it('an unreachable relay is not a size refusal', async () => {
    const result = await publish(event(), [`ws://127.0.0.1:${deadPort}`])
    expect(refusedTooLarge(result)).toBe(false)
    expect(result.refusals?.[0]?.kind).toBe('unreachable')
  })
})

/**
 * #532: the read-back that proves delivery asks the RELAY for one id. A fake relay that holds one
 * event answers it; one that holds nothing answers EOSE (false); a dead port is null (not asked).
 */
describe('relayHasEvent (#532)', () => {
  it('true when the relay returns the id, false on EOSE without it, null when unreachable', async () => {
    const held = event()
    const { WebSocketServer } = await import('ws')
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await new Promise<void>((resolve) => server.on('listening', () => resolve()))
    server.on('connection', (socket) =>
      socket.on('message', (raw) => {
        const [type, sub, filter] = JSON.parse(String(raw)) as [string, string, { ids?: string[] }]
        if (type !== 'REQ') return
        if (filter.ids?.includes(held.id)) socket.send(JSON.stringify(['EVENT', sub, held]))
        socket.send(JSON.stringify(['EOSE', sub]))
      }),
    )
    try {
      const { port } = server.address() as { port: number }
      expect(await relayHasEvent(held.id, [`ws://127.0.0.1:${port}`])).toBe(true)
      expect(await relayHasEvent('00'.repeat(32), [`ws://127.0.0.1:${port}`])).toBe(false)
      expect(await relayHasEvent(held.id, [`ws://127.0.0.1:${deadPort}`], 1_500)).toBe(null)
    } finally {
      server.close()
    }
  }, 15_000)
})

describe('publish against a relay slow to accept', () => {
  it('gives up at the default 3 s window', async () => {
    const { createServer: http } = await import('node:http')
    const server = http()
    let held: Promise<void> = Promise.resolve()
    server.on('upgrade', (_req, socket) => {
      socket.on('error', () => {})
      // Never upgraded: the client's 3 s connect window passes and it gives up (and closes it).
      held = new Promise<void>((done) => socket.on('close', () => done()))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    try {
      const result = await publish(event(), [`ws://127.0.0.1:${port}`])
      expect(result.ok).toBe(0)
      expect(result.errors[0]).toMatch(/connection failure/)
      await Promise.race([held, new Promise((r) => setTimeout(r, 2000))])
    } finally {
      server.closeAllConnections?.()
      server.close()
    }
  }, 10_000)

  it('a caller may give the connect a longer window, and is then accepted', async () => {
    const { WebSocketServer } = await import('ws')
    const wss = new WebSocketServer({ noServer: true })
    let upgrades = 0
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw)) as [string, { id: string }]
        if (msg[0] === 'EVENT') ws.send(JSON.stringify(['OK', msg[1].id, true, '']))
      })
    })
    const { createServer: http } = await import('node:http')
    const server = http()
    let closing = false
    server.on('upgrade', (req, socket, head) => {
      upgrades += 1
      socket.on('error', () => {})
      // The connection is upgraded only after 4 s: past the default 3 s window, inside 8 s.
      const upgrade = () => (closing ? socket.destroy() : wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req)))
      if (upgrades === 1) {
        setTimeout(upgrade, 4000)
        return
      }
      upgrade()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    try {
      const result = await publish(event(), [`ws://127.0.0.1:${port}`], { connectMs: 8000 })
      expect(result).toMatchObject({ ok: 1, total: 1 })
      expect(upgrades).toBe(1)
    } finally {
      closing = true
      for (const c of wss.clients) c.terminate()
      wss.close()
      server.closeAllConnections?.()
      server.close()
    }
  }, 20_000)

})
