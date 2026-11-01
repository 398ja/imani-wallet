/**
 * Where the REAL shared/api.js puts receive witnesses, and what it says when a proxy refuses.
 *
 * Staging 2026-10-31: a 7-proof locked voucher made a 12 KB X-Cashu-Witnesses header, nginx
 * answered an HTML 400 "Request Header Or Cookie Too Large", and the wallet showed only
 * "API request failed". Small witness sets keep the header (works against any gateway); large
 * ones go in the body `witnesses` field, and that body is the one NIP-98 signs.
 */
import { readFileSync } from 'node:fs'

import { beforeEach, describe, expect, it } from 'vitest'

interface Captured {
  headers: Record<string, string>
  body: string | null
  signedBody: string | null | undefined
}

interface Reply {
  status: number
  statusText?: string
  contentType: string
  text: string
}

function loadApi(captured: Captured, reply: () => Reply) {
  const scope = globalThis as unknown as Record<string, unknown>
  scope.window = scope
  scope.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
  scope.GatewayConfig = { relayUrl: 'wss://r', apiUrl: 'http://gw', gatewayUrl: 'http://gw' }
  scope.NostrUtils = {
    createNip98AuthHeader: async (_u: string, _m: string, _pk: string, _sk: string, body: string | null) => {
      captured.signedBody = body
      return 'Nostr stub'
    },
  }
  scope.fetch = async (_url: string, opts: { headers: Record<string, string>; body?: string }) => {
    captured.headers = opts.headers
    captured.body = opts.body ?? null
    const r = reply()
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      statusText: r.statusText ?? '',
      headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? r.contentType : null) },
      json: async () => JSON.parse(r.text),
      text: async () => r.text,
    }
  }
  new Function(readFileSync(new URL('../../../shared/api.js', import.meta.url), 'utf8'))()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const api = scope.api as any
  api.setNostrCredentials('a'.repeat(64), '1'.repeat(64))
  return api
}

/** A witness map shaped like the real one: ~1.6 KB secret+sig per proof. */
function witnesses(proofs: number): string {
  const map: Record<string, string[]> = {}
  for (let i = 0; i < proofs; i++) {
    map[`["P2PK",{"nonce":"${i}","data":"02${'a'.repeat(64)}","tags":[["x","${'b'.repeat(1300)}"]]}]`] = ['c'.repeat(128)]
  }
  return JSON.stringify(map)
}

const OK: Reply = { status: 200, contentType: 'application/json', text: '{"amount":1}' }

describe('receive witnesses placement', () => {
  let captured: Captured
  let reply: Reply
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let api: any

  beforeEach(() => {
    captured = { headers: {}, body: null, signedBody: undefined }
    reply = OK
    api = loadApi(captured, () => reply)
  })

  const hook = (value: string | null) => {
    ;(globalThis as Record<string, unknown>).__imaniWitnessHeaderForToken = () => value
  }

  it('keeps a small witness set in the header, body unchanged', async () => {
    const w = witnesses(1)
    hook(w)
    await api.receive('cashuBxyz')
    expect(captured.headers['X-Cashu-Witnesses']).toBe(w)
    expect(JSON.parse(captured.body!)).toEqual({ token: 'cashuBxyz' })
  })

  it('moves a 7-proof witness set (the staging failure) to the body', async () => {
    const w = witnesses(7)
    expect(w.length).toBeGreaterThan(6 * 1024)
    hook(w)
    await api.receive('cashuBxyz')
    expect(captured.headers['X-Cashu-Witnesses']).toBeUndefined()
    const sent = JSON.parse(captured.body!)
    expect(sent.token).toBe('cashuBxyz')
    expect(sent.witnesses).toEqual(JSON.parse(w))
    // The gateway hashes the compact form; the body field must round-trip to the header string.
    expect(JSON.stringify(sent.witnesses)).toBe(w)
  })

  it('signs (NIP-98) exactly the body it sends', async () => {
    hook(witnesses(7))
    await api.receive('cashuBxyz')
    expect(captured.signedBody).toBe(captured.body)
  })

  it('sends no witnesses at all for a bearer token', async () => {
    hook(null)
    await api.receive('cashuBxyz')
    expect(captured.headers['X-Cashu-Witnesses']).toBeUndefined()
    expect(JSON.parse(captured.body!)).toEqual({ token: 'cashuBxyz' })
  })
})

describe('non-JSON error responses', () => {
  let captured: Captured
  let reply: Reply
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let api: any

  beforeEach(() => {
    captured = { headers: {}, body: null, signedBody: undefined }
    api = loadApi(captured, () => reply)
    ;(globalThis as Record<string, unknown>).__imaniWitnessHeaderForToken = () => null
  })

  it('names nginx\'s 400 header-too-large page instead of "API request failed"', async () => {
    reply = {
      status: 400, statusText: 'Bad Request', contentType: 'text/html',
      text: '<html><head><title>400 Request Header Or Cookie Too Large</title></head><body></body></html>',
    }
    await expect(api.receive('cashuBxyz')).rejects.toMatchObject({
      status: 400,
      message: 'HTTP 400: 400 Request Header Or Cookie Too Large',
    })
  })

  it.each([
    [413, 'Request too large'],
    [431, 'Request headers too large'],
  ])('describes an empty-bodied %i', async (status, text) => {
    reply = { status, contentType: 'text/html', text: '' }
    await expect(api.receive('cashuBxyz')).rejects.toMatchObject({ status, message: `HTTP ${status}: ${text}` })
  })

  it('still uses the gateway\'s JSON error message', async () => {
    reply = {
      status: 400, contentType: 'application/json',
      text: '{"error":{"code":"WITNESSES_CONFLICT","message":"header and body witnesses differ"}}',
    }
    await expect(api.receive('cashuBxyz')).rejects.toMatchObject({
      code: 'WITNESSES_CONFLICT', message: 'header and body witnesses differ',
    })
  })
})
