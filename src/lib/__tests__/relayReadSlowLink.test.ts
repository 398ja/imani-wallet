/**
 * @vitest-environment node
 */
import { createConnection, createServer, type Server, type Socket } from 'node:net'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { finalizeEvent, type Event } from 'nostr-tools'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { getPublicKey } from 'nostr-tools/pure'
import WebSocket, { WebSocketServer } from 'ws'

import { allEvents } from '../relay'

// relay.ts imports SimplePool from 'nostr-tools'; a global WebSocket reaches it
// (see relayPublishCount.test.ts for why the pool setter does not).
;(globalThis as { WebSocket?: unknown }).WebSocket ??= WebSocket

/**
 * A relay READ must survive a slow link (imani-deploy#235).
 *
 * On staging a browser's reads to `wss://relay.staging.398ja.xyz` carried 0
 * bytes and closed 1006 about 60 s later, while its writes worked. The relay was
 * fine: the edge answers the upgrade in ~1 ms on the host and every client from
 * outside got EVENT + EOSE. The READ pool gave up first. It capped the socket
 * open at 1200 ms, and a `wss://` open costs DNS + TCP + TLS + the HTTP upgrade,
 * about four round trips. From a well-connected laptop that was already
 * 0.6-0.9 s; on a phone link it passes 1200 ms. nostr-tools then abandons the
 * socket without closing it (2.24.1), so it opens later, sends nothing, and dies
 * on the relay's ping as 1006. Writes use the uncapped 3000 ms pool, which is
 * why they still worked.
 *
 * Here: a local relay behind a proxy that delays every chunk, so the upgrade
 * takes ~1.6 s, like a slow phone link. A read must still return the event.
 */

const ONE_WAY_DELAY_MS = 800

const secret = secp256k1.utils.randomSecretKey()
const author = getPublicKey(secret)
const record: Event = finalizeEvent(
  { kind: 7375, created_at: Math.floor(Date.now() / 1000), tags: [['d', 'slow-link']], content: 'x' },
  secret,
)

let relay: WebSocketServer
let proxy: Server
let proxyPort = 0
const open: Socket[] = []

beforeAll(async () => {
  relay = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise<void>((resolve) => relay.once('listening', () => resolve()))
  relay.on('connection', (ws) =>
    ws.on('message', (raw) => {
      const [type, subId] = JSON.parse(String(raw)) as [string, string]
      if (type !== 'REQ') return
      ws.send(JSON.stringify(['EVENT', subId, record]))
      ws.send(JSON.stringify(['EOSE', subId]))
    }),
  )
  const relayPort = (relay.address() as { port: number }).port

  // Every chunk, in both directions, waits ONE_WAY_DELAY_MS: a round trip of 1.6 s.
  proxy = createServer((client) => {
    const upstream = createConnection(relayPort, '127.0.0.1')
    open.push(client, upstream)
    const pipe = (from: Socket, to: Socket) =>
      from.on('data', (chunk) => setTimeout(() => to.destroyed || to.write(chunk), ONE_WAY_DELAY_MS))
    pipe(client, upstream)
    pipe(upstream, client)
    for (const s of [client, upstream]) s.on('error', () => {})
    client.on('close', () => upstream.destroy())
    upstream.on('close', () => client.destroy())
  })
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  proxyPort = (proxy.address() as { port: number }).port
})

afterAll(async () => {
  for (const s of open) s.destroy()
  await new Promise<void>((resolve) => proxy.close(() => resolve()))
  await new Promise<void>((resolve) => relay.close(() => resolve()))
})

describe('relay reads over a slow link (#235)', () => {
  it('returns the record when the socket takes ~1.6 s to open', async () => {
    const started = Date.now()
    const events = await allEvents(author, 7375, [`ws://127.0.0.1:${proxyPort}`])

    // Red before the fix: [] after ~1.2 s, the connect cap firing first.
    expect(events.map((e) => e.id)).toEqual([record.id])
    expect(Date.now() - started).toBeGreaterThanOrEqual(2 * ONE_WAY_DELAY_MS)
  }, 15_000)
})
