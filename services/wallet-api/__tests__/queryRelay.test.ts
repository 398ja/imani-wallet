/**
 * `queryRelay` against a real socket (#359 review).
 *
 * It used `querySync`, which RESOLVES with whatever it holds when the relay answers CLOSED, or when
 * its own 4.4s EOSE timer fires. A rate-limited or erroring relay then read as "asked, holds
 * nothing": a stall's validity as never-expires, and a stall as a customer. Only a real EOSE may
 * resolve; anything else must throw, which both callers read as unknown/unreadable.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer } from 'ws'
import { finalizeEvent } from 'nostr-tools/pure'
import { hexToBytes } from '@noble/hashes/utils'

const SK = '7'.repeat(63) + '1'

type Mode = 'eose' | 'closed' | 'silent'

async function relay(mode: Mode, events: unknown[] = []) {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise((r) => wss.on('listening', r))
  wss.on('connection', (ws) =>
    ws.on('message', (raw) => {
      const [type, id] = JSON.parse(String(raw)) as [string, string]
      if (type !== 'REQ') return
      if (mode === 'closed') ws.send(JSON.stringify(['CLOSED', id, 'error: rate-limited']))
      if (mode === 'eose') {
        for (const e of events) ws.send(JSON.stringify(['EVENT', id, e]))
        ws.send(JSON.stringify(['EOSE', id]))
      }
    }),
  )
  const port = (wss.address() as { port: number }).port
  vi.resetModules()
  vi.stubEnv('WALLET_API_RELAY_URL', `ws://127.0.0.1:${port}`)
  const lookup = await import('../stallLookup.js')
  const validity = await import('../stallValidity.js')
  return { wss, ...lookup, ...validity }
}

let open: WebSocketServer | undefined
afterEach(() => {
  open?.close()
  open = undefined
  vi.unstubAllEnvs()
})

describe('asking the relay for a stall record', () => {
  it('reads a record the relay holds, after a real EOSE', async () => {
    const record = finalizeEvent(
      { kind: 30078, created_at: 1_700_000_000, tags: [['d', 'imani:merchant']], content: '{"voucherValidityDays":90}' },
      hexToBytes(SK),
    )
    const r = await relay('eose', [record])
    open = r.wss
    expect(await r.createValidityReader(r.queryRelay)(record.pubkey)).toEqual({ kind: 'days', days: 90, source: 'record' })
    expect(await r.createStallLookup(r.queryRelay).role(record.pubkey)).toBe('stall')
  })

  it('reads a relay that genuinely holds nothing as the stall default', async () => {
    const r = await relay('eose')
    open = r.wss
    expect(await r.createValidityReader(r.queryRelay)('ab'.repeat(32))).toMatchObject({ kind: 'days', source: 'default' })
  })

  it('reads a relay that REFUSES the query (CLOSED) as unreadable, never as never-expires', async () => {
    const r = await relay('closed')
    open = r.wss
    expect(await r.createValidityReader(r.queryRelay)('ab'.repeat(32))).toMatchObject({ kind: 'unreadable' })
    expect(await r.createStallLookup(r.queryRelay).role('ab'.repeat(32))).toBe('unknown')
  })

  it('reads a relay that never answers as unreadable, not as an empty answer', async () => {
    const r = await relay('silent')
    open = r.wss
    expect(await r.createValidityReader(r.queryRelay)('ab'.repeat(32))).toMatchObject({ kind: 'unreadable' })
  }, 15_000)
})
