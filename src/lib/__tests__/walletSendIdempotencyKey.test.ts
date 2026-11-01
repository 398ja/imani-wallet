/**
 * #179: the REAL shared/api.js `send()` puts the caller's Idempotency-Key on the wire.
 *
 * Driven through the classic script itself (as atomicSendWitnesses.test.ts does), because the
 * question is what that file sends. Before #179 `send()` took no key and sent no header, so a
 * retry after a lost answer could not be recognised by the gateway.
 */
import { readFileSync } from 'node:fs'

import { beforeEach, describe, expect, it } from 'vitest'

function loadApi(seen: Array<Record<string, string>>) {
  const scope = globalThis as unknown as Record<string, unknown>
  scope.window = scope
  scope.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
  scope.GatewayConfig = { relayUrl: 'wss://r', apiUrl: 'http://gw', gatewayUrl: 'http://gw' }
  scope.NostrUtils = { createNip98AuthHeader: async () => 'Nostr stub' }
  scope.fetch = async (_url: string, opts: { headers?: Record<string, string> }) => {
    seen.push(opts?.headers ?? {})
    return {
      ok: true, status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ status: 'SUCCESS' }),
      text: async () => '{"status":"SUCCESS"}',
    }
  }
  new Function(readFileSync(new URL('../../../shared/api.js', import.meta.url), 'utf8'))()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const api = scope.api as any
  api.setNostrCredentials('a'.repeat(64), '1'.repeat(64))
  return api
}

describe('shared/api.js send() Idempotency-Key (#179)', () => {
  let seen: Array<Record<string, string>>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let api: any

  beforeEach(() => {
    seen = []
    api = loadApi(seen)
  })

  it('a retry of one send carries the same key; a new send carries its own', async () => {
    await api.send(100, 'v-1', 'k-intent-1')
    await api.send(100, 'v-1', 'k-intent-1') // the retry after a lost answer
    await api.send(100, 'v-1', 'k-intent-2') // a new send

    expect(seen.map((h) => h['Idempotency-Key'])).toEqual(['k-intent-1', 'k-intent-1', 'k-intent-2'])
  })

  it('sends no header when the caller has no key, exactly as before', async () => {
    await api.send(100, 'v-1')
    expect(seen[0]).not.toHaveProperty('Idempotency-Key')
  })
})
