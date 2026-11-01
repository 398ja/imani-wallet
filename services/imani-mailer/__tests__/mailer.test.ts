import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { createMailer } from '../mailer'
import { createStore } from '../store'
import { TransportError } from '../transport'
import { CLAIM_SECRET, claimFields, client, devConfig, memoryTransport } from './fixtures'

function setup(overrides: Record<string, string | undefined> = {}, stateFile: string | null = null) {
  const config = devConfig(overrides)
  const transport = memoryTransport()
  const lines: Array<Record<string, unknown>> = []
  let t = 1_700_000_000_000
  const store = createStore({ file: stateFile, ttlMs: config.idempotencyTtlHours * 3_600_000 })
  const mailer = createMailer({ config, transport, store, log: (l) => lines.push(l), now: () => t })
  const issuer = client(config, 'purchase-issuer')
  return { config, transport, lines, mailer, issuer, store, advance: (ms: number) => (t += ms) }
}
const claim = (key = 'evt_123:claim', to = 'Bob@Example.com', fields: Record<string, unknown> = claimFields) => ({
  template: 'gift-claim',
  to,
  fields,
  idempotencyKey: key,
})

describe('sending', () => {
  it('renders, sends one message to one recipient from the service address', async () => {
    const { mailer, issuer, transport } = setup()
    const out = await mailer.send(issuer, claim())
    expect(out).toMatchObject({ ok: true, status: 202, duplicate: false, sandboxed: false })
    expect(transport.sent).toHaveLength(1)
    const m = transport.sent[0]
    expect(m.to).toBe('Bob@Example.com')
    expect(m.fromName).toBe('Imani gifts')
    expect(m.subject).toBe('Alice sent you a voucher for Card Test Bakery')
    expect(m.messageId).toMatch(/^<[0-9a-f-]{36}@imani\.test>$/)
    expect(m.headers).toMatchObject({ 'Auto-Submitted': 'auto-generated', 'X-Imani-Template': 'gift-claim' })
  })

  it('never logs the address, the link, the secret, the message or the subject', async () => {
    const { mailer, issuer, lines } = setup()
    await mailer.send(issuer, claim())
    await mailer.send(issuer, claim('evt_123:claim:other', 'nope'))
    await mailer.send(issuer, claim('evt_124:claim', 'bob@example.com', { ...claimFields, claimUrl: 'https://evil.test/#x' }))
    const all = JSON.stringify(lines)
    for (const s of ['bob@example.com', 'Bob@Example.com', CLAIM_SECRET, 'claim#', 'Happy birthday', 'Card Test Bakery', 'evil.test']) {
      expect(all.toLowerCase()).not.toContain(s.toLowerCase())
    }
    expect(lines.find((l) => l.event === 'mail_accepted')?.to).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('authorisation', () => {
  it('a client may only send its own templates', async () => {
    const { mailer, config, transport } = setup()
    const out = await mailer.send(client(config, 'receipts'), claim())
    expect(out).toMatchObject({ ok: false, status: 403, error: 'template_not_allowed' })
    expect(transport.sent).toHaveLength(0)
  })

  it('unknown templates and unknown request properties are refused', async () => {
    const { mailer, issuer } = setup()
    expect(await mailer.send(issuer, { ...claim(), template: 'nope' })).toMatchObject({ status: 400, error: 'unknown_template' })
    expect(await mailer.send(issuer, { ...claim(), cc: 'x@y.z' } as never)).toMatchObject({ status: 400, error: 'invalid_request' })
    expect(await mailer.send(issuer, { ...claim(), fields: [] as never })).toMatchObject({ status: 400 })
  })
})

describe('recipients', () => {
  it.each(['bob@example.com, eve@example.com', 'bob@example.com\r\nBcc: eve@example.com', '"Bob" <bob@example.com>', 'bob', ''])('refuses %j', async (to) => {
    const { mailer, issuer, transport } = setup()
    expect(await mailer.send(issuer, claim('evt_9:claim', to))).toMatchObject({ ok: false, status: 400 })
    expect(transport.sent).toHaveLength(0)
  })

  it('deny and allow domains, subdomains included', async () => {
    const deny = setup({ MAILER_RECIPIENT_DENY_DOMAINS: 'example.com' })
    expect(await deny.mailer.send(deny.issuer, claim('evt_1:claim', 'bob@mail.example.com'))).toMatchObject({ status: 403, error: 'recipient_refused' })
    const allow = setup({ MAILER_RECIPIENT_ALLOW_DOMAINS: 'imani.test' })
    expect(await allow.mailer.send(allow.issuer, claim('evt_1:claim', 'bob@example.com'))).toMatchObject({ status: 403 })
    expect(await allow.mailer.send(allow.issuer, claim('evt_2:claim', 'qa@team.imani.test'))).toMatchObject({ ok: true })
  })

  it('a suppressed recipient is refused until lifted', async () => {
    const { mailer, issuer, config } = setup()
    const ops = client(config, 'ops')
    mailer.suppress(ops, 'BOB@example.com', 'hard-bounce')
    expect(await mailer.send(issuer, claim())).toMatchObject({ status: 409, error: 'recipient_suppressed' })
    expect(mailer.unsuppress(ops, 'bob@example.com')).toBe(true)
    expect(await mailer.send(issuer, claim())).toMatchObject({ ok: true })
  })

  it('sandbox: everything goes to one address, the subject says so, and the original address is not in the message', async () => {
    const { mailer, issuer, transport } = setup({ MAILER_SANDBOX_REDIRECT: 'qa@imani.test' })
    expect(await mailer.send(issuer, claim())).toMatchObject({ ok: true, sandboxed: true })
    const m = transport.sent[0]
    expect(m.to).toBe('qa@imani.test')
    expect(m.subject).toMatch(/^\[sandbox\] /)
    expect(JSON.stringify(m).toLowerCase()).not.toContain('bob@example.com')
    expect(m.headers['X-Imani-Sandbox-Recipient']).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('idempotency', () => {
  it('the same key and request sends once, and answers the same message id', async () => {
    const { mailer, issuer, transport } = setup()
    const a = await mailer.send(issuer, claim())
    const b = await mailer.send(issuer, claim())
    expect(b).toMatchObject({ ok: true, duplicate: true })
    expect(a.ok && b.ok && a.messageId === b.messageId).toBe(true)
    expect(transport.sent).toHaveLength(1)
  })

  it('the same key with a different request is a conflict, never a silent no-op', async () => {
    const { mailer, issuer, transport } = setup()
    await mailer.send(issuer, claim())
    expect(await mailer.send(issuer, claim('evt_123:claim', 'eve@example.com'))).toMatchObject({ status: 409, error: 'idempotency_conflict' })
    expect(transport.sent).toHaveLength(1)
  })

  it('concurrent duplicates send once', async () => {
    const { mailer, issuer, transport } = setup()
    const outs = await Promise.all(Array.from({ length: 10 }, () => mailer.send(issuer, claim())))
    expect(transport.sent).toHaveLength(1)
    expect(outs.filter((o) => o.ok && !o.duplicate)).toHaveLength(1)
  })

  it('keys are per client: another client using the same key is a separate message', async () => {
    const { mailer, issuer, config, transport } = setup()
    const receipt = { template: 'gift-receipt', to: 'bob@example.com', fields: { stall: 'A', amount: '£1', recipient: 'Bob' }, idempotencyKey: 'shared-key-1' }
    await mailer.send(issuer, receipt)
    expect(await mailer.send(client(config, 'receipts'), receipt)).toMatchObject({ ok: true, duplicate: false })
    expect(transport.sent).toHaveLength(2)
  })

  it('a failed send is not remembered, so the caller can retry with the same key', async () => {
    const { mailer, issuer, transport } = setup()
    transport.failNext(new TransportError('ECONNECTION', true))
    expect(await mailer.send(issuer, claim())).toMatchObject({ status: 503, error: 'transport_unavailable', retryable: true })
    expect(await mailer.send(issuer, claim())).toMatchObject({ ok: true, duplicate: false })
  })

  it('a permanent rejection is a 502 and not retryable', async () => {
    const { mailer, issuer, transport } = setup()
    transport.failNext(new TransportError('550 no such user', false))
    expect(await mailer.send(issuer, claim())).toMatchObject({ status: 502, error: 'transport_rejected', retryable: false })
  })

  it('survives a restart through the state file, written 0600, holding no address', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'mailer-state-')), 'state.json')
    const first = setup({}, file)
    await first.mailer.send(first.issuer, claim())
    first.mailer.suppress(client(first.config, 'ops'), 'eve@example.com', 'complaint')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const raw = readFileSync(file, 'utf8')
    expect(raw).not.toContain('example.com')
    const second = setup({}, file)
    expect(await second.mailer.send(second.issuer, claim())).toMatchObject({ ok: true, duplicate: true })
    expect(await second.mailer.send(second.issuer, claim('evt_7:claim', 'eve@example.com'))).toMatchObject({ error: 'recipient_suppressed' })
    expect(second.transport.sent).toHaveLength(0)
  })

  it('a corrupt state file refuses to start rather than forgetting suppressions', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'mailer-state-')), 'state.json')
    writeFileSync(file, '{not json')
    expect(() => createStore({ file, ttlMs: 1000 })).toThrow(/cannot be used/)
  })

  it('idempotency entries expire after the TTL', async () => {
    const { mailer, issuer, transport, advance, config } = setup({ MAILER_IDEMPOTENCY_TTL_HOURS: '1' })
    await mailer.send(issuer, claim())
    advance(config.idempotencyTtlHours * 3_600_000 + 1)
    mailer.housekeeping()
    expect(await mailer.send(issuer, claim())).toMatchObject({ ok: true, duplicate: false })
    expect(transport.sent).toHaveLength(2)
  })
})

describe('rate limits', () => {
  it('per recipient per hour, with Retry-After, and it resets', async () => {
    const { mailer, issuer, advance } = setup({ MAILER_RATE_PER_RECIPIENT_HOUR: '2' })
    expect(await mailer.send(issuer, claim('k-000001'))).toMatchObject({ ok: true })
    expect(await mailer.send(issuer, claim('k-000002'))).toMatchObject({ ok: true })
    const limited = await mailer.send(issuer, claim('k-000003'))
    expect(limited).toMatchObject({ status: 429, error: 'rate_limited', retryable: true })
    expect(!limited.ok && limited.retryAfterSeconds! > 0).toBe(true)
    advance(3_600_001)
    expect(await mailer.send(issuer, claim('k-000003'))).toMatchObject({ ok: true })
  })

  it('global per minute', async () => {
    const { mailer, issuer } = setup({ MAILER_RATE_GLOBAL_MINUTE: '1' })
    await mailer.send(issuer, claim('k-000001', 'a@example.com'))
    expect(await mailer.send(issuer, claim('k-000002', 'b@example.com'))).toMatchObject({ status: 429 })
  })

  it('a refused or failed send does not use up the recipient allowance', async () => {
    const { mailer, issuer, transport } = setup({ MAILER_RATE_PER_RECIPIENT_HOUR: '1' })
    transport.failNext(new TransportError('down', true))
    await mailer.send(issuer, claim('k-000001'))
    expect(await mailer.send(issuer, claim('k-000002'))).toMatchObject({ ok: true })
  })
})

describe('metrics', () => {
  it('counts by template and outcome, with no recipient or key in any label', async () => {
    const { mailer, issuer } = setup()
    await mailer.send(issuer, claim())
    await mailer.send(issuer, claim())
    const m = mailer.metrics()
    expect(m).toContain('imani_mailer_messages_total{template="gift-claim",outcome="accepted"} 1')
    expect(m).toContain('imani_mailer_messages_total{template="gift-claim",outcome="duplicate"} 1')
    expect(m).not.toMatch(/example|evt_/)
  })
})
