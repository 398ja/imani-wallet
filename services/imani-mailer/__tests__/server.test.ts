import { afterEach, describe, expect, it } from 'vitest'

import { authenticate, createApp, type Running } from '../server'
import { claimFields, CLIENTS, devConfig, ISSUER_TOKEN, memoryTransport, OPS_TOKEN, RECEIPTS_TOKEN } from './fixtures'

let running: Running | null = null
afterEach(async () => {
  await running?.close()
  running = null
})

async function start(overrides: Record<string, string | undefined> = {}) {
  const transport = memoryTransport()
  const lines: Array<Record<string, unknown>> = []
  running = await createApp(devConfig(overrides), { transport, log: (l) => lines.push(l) }).listen(0, '127.0.0.1')
  return { url: running.url, transport, lines }
}
const post = (url: string, token: string | null, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
const claim = { template: 'gift-claim', to: 'bob@example.com', fields: claimFields, idempotencyKey: 'evt_1:claim' }

describe('authenticate', () => {
  const config = devConfig()
  it('maps a token to its client, and nothing else to anything', () => {
    expect(authenticate(`Bearer ${ISSUER_TOKEN}`, config.clients)?.id).toBe('purchase-issuer')
    expect(authenticate(`Bearer ${RECEIPTS_TOKEN}`, config.clients)?.id).toBe('receipts')
    expect(authenticate(`Bearer ${ISSUER_TOKEN}x`, config.clients)).toBeNull()
    expect(authenticate(`bearer ${ISSUER_TOKEN}`, config.clients)).toBeNull()
    expect(authenticate(ISSUER_TOKEN, config.clients)).toBeNull()
    expect(authenticate('Bearer short', config.clients)).toBeNull()
    expect(authenticate(undefined, config.clients)).toBeNull()
    expect(authenticate(`Bearer ${CLIENTS[0].tokenSha256}`, config.clients)).toBeNull()
  })
})

describe('HTTP', () => {
  it('sends with a valid token and answers 202 with security headers', async () => {
    const { url, transport } = await start()
    const res = await post(`${url}/v1/send`, ISSUER_TOKEN, claim)
    expect(res.status).toBe(202)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
    expect(await res.json()).toMatchObject({ ok: true })
    expect(transport.sent).toHaveLength(1)
  })

  it('401 without or with a wrong token, and the attempt is logged without the token', async () => {
    const { url, lines, transport } = await start()
    expect((await post(`${url}/v1/send`, null, claim)).status).toBe(401)
    const wrong = await post(`${url}/v1/send`, 'not-the-right-token-at-all-0000', claim)
    expect(wrong.status).toBe(401)
    expect(wrong.headers.get('www-authenticate')).toBe('Bearer')
    expect(transport.sent).toHaveLength(0)
    expect(JSON.stringify(lines)).not.toContain('not-the-right-token')
  })

  it('403 for a template outside the client scope', async () => {
    const { url } = await start()
    expect((await post(`${url}/v1/send`, RECEIPTS_TOKEN, claim)).status).toBe(403)
  })

  it('JSON only, capped size, objects only', async () => {
    const { url } = await start({ MAILER_MAX_BODY_BYTES: '2048' })
    expect((await post(`${url}/v1/send`, ISSUER_TOKEN, 'template=x', { 'Content-Type': 'application/x-www-form-urlencoded' })).status).toBe(415)
    expect((await post(`${url}/v1/send`, ISSUER_TOKEN, '{bad')).status).toBe(400)
    expect((await post(`${url}/v1/send`, ISSUER_TOKEN, '[]')).status).toBe(400)
    expect((await post(`${url}/v1/send`, ISSUER_TOKEN, { ...claim, fields: { ...claimFields, message: 'x'.repeat(5000) } })).status).toBe(413)
  })

  it('429 carries Retry-After', async () => {
    const { url } = await start({ MAILER_RATE_PER_RECIPIENT_HOUR: '1' })
    await post(`${url}/v1/send`, ISSUER_TOKEN, claim)
    const res = await post(`${url}/v1/send`, ISSUER_TOKEN, { ...claim, idempotencyKey: 'evt_2:claim' })
    expect(res.status).toBe(429)
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0)
  })

  it('wrong methods and unknown paths', async () => {
    const { url } = await start()
    const get = await fetch(`${url}/v1/send`, { headers: { Authorization: `Bearer ${ISSUER_TOKEN}` } })
    expect(get.status).toBe(405)
    expect(get.headers.get('allow')).toBe('POST')
    expect((await fetch(`${url}/admin`, { headers: { Authorization: `Bearer ${ISSUER_TOKEN}` } })).status).toBe(404)
  })

  it('suppressions only for a client with bounce rights', async () => {
    const { url } = await start()
    const body = { to: 'bob@example.com', reason: 'hard-bounce' }
    expect((await post(`${url}/v1/suppressions`, ISSUER_TOKEN, body)).status).toBe(403)
    expect((await post(`${url}/v1/suppressions`, OPS_TOKEN, body)).status).toBe(200)
    expect((await post(`${url}/v1/send`, ISSUER_TOKEN, claim)).status).toBe(409)
    expect((await post(`${url}/v1/suppressions`, OPS_TOKEN, { ...body, reason: 'whatever' })).status).toBe(400)
    const lift = await fetch(`${url}/v1/suppressions`, { method: 'DELETE', headers: { Authorization: `Bearer ${OPS_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ to: 'bob@example.com' }) })
    expect(await lift.json()).toEqual({ removed: true })
    expect((await post(`${url}/v1/send`, ISSUER_TOKEN, claim)).status).toBe(202)
  })

  it('#410: suppressions/check answers a bounce client, refuses one without check, logs only the tag', async () => {
    const { url, lines } = await start()
    const body = { to: 'bob@example.com' }
    expect((await post(`${url}/v1/suppressions/check`, ISSUER_TOKEN, body)).status).toBe(403)
    expect(await (await post(`${url}/v1/suppressions/check`, OPS_TOKEN, body)).json()).toEqual({ suppressed: false })
    await post(`${url}/v1/suppressions`, OPS_TOKEN, { to: 'bob@example.com', reason: 'hard-bounce' })
    expect(await (await post(`${url}/v1/suppressions/check`, OPS_TOKEN, body)).json()).toEqual({ suppressed: true, reason: 'hard-bounce' })
    expect((await post(`${url}/v1/suppressions/check`, OPS_TOKEN, { to: 'x', extra: 1 })).status).toBe(400)
    expect(JSON.stringify(lines)).not.toContain('bob@example.com')
  })

  it('#410: a check-only client may check but not suppress', async () => {
    const token = 'check-token-0123456789abcdefghijklmnopqrs'
    const { createHash } = await import('node:crypto')
    const clients = [...CLIENTS, { id: 'checker', tokenSha256: createHash('sha256').update(token).digest('hex'), templates: ['gift-claim'], check: true }]
    const { url } = await start({ MAILER_CLIENTS: JSON.stringify(clients) })
    expect((await post(`${url}/v1/suppressions/check`, token, { to: 'bob@example.com' })).status).toBe(200)
    expect((await post(`${url}/v1/suppressions`, token, { to: 'bob@example.com', reason: 'manual' })).status).toBe(403)
  })

  it('#410: unsubscribeUrl becomes RFC 8058 List-Unsubscribe headers, only to an allowed host', async () => {
    const { url, transport, lines } = await start()
    const u = 'https://imani.test/api/v1/gifts/unsubscribe/d1?t=tok'
    expect((await post(`${url}/v1/send`, ISSUER_TOKEN, { ...claim, idempotencyKey: 'evt_2:claim', unsubscribeUrl: u })).status).toBe(202)
    expect(transport.sent[0].headers['List-Unsubscribe']).toBe(`<${u}>`)
    expect(transport.sent[0].headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click')
    expect(JSON.stringify(lines)).not.toContain('tok')
    expect((await post(`${url}/v1/send`, ISSUER_TOKEN, { ...claim, idempotencyKey: 'evt_3:claim', unsubscribeUrl: 'https://evil.example/u' })).status).toBe(400)
    expect((await post(`${url}/v1/send`, ISSUER_TOKEN, { ...claim, idempotencyKey: 'evt_4:claim' })).status).toBe(202)
    expect(transport.sent[1].headers['List-Unsubscribe']).toBeUndefined()
  })

  it('templates lists only what the client may send', async () => {
    const { url } = await start()
    const res = await fetch(`${url}/v1/templates`, { headers: { Authorization: `Bearer ${RECEIPTS_TOKEN}` } })
    const body = (await res.json()) as { templates: Array<{ name: string }> }
    expect(body.templates.map((t) => t.name)).toEqual(['gift-receipt'])
  })

  it('health and ready need no token; metrics needs its own when configured', async () => {
    const { url } = await start({ MAILER_METRICS_TOKEN: 'metrics-token-0123456789abcdef' })
    expect((await fetch(`${url}/health`)).status).toBe(200)
    expect((await fetch(`${url}/ready`)).status).toBe(200)
    expect((await fetch(`${url}/metrics`)).status).toBe(401)
    expect((await fetch(`${url}/metrics`, { headers: { Authorization: `Bearer ${ISSUER_TOKEN}` } })).status).toBe(401)
    const m = await fetch(`${url}/metrics`, { headers: { Authorization: 'Bearer metrics-token-0123456789abcdef' } })
    expect(m.status).toBe(200)
    expect(await m.text()).toContain('imani_mailer_suppressed_recipients')
  })
})
