/**
 * imani-mailer against a real SMTP server: Mailpit, in disposable containers (see mailpit.ts).
 *
 *   npm run test:mailer-it
 *
 * The whole path is real: an HTTP request with a client token to the mailer's own server, the
 * nodemailer SMTP transport, and Mailpit receiving the message. Assertions read what Mailpit
 * STORED (its API), so they check the message as a recipient's server would see it: envelope,
 * headers, MIME parts, DKIM signature, TLS and authentication, not what the mailer meant to send.
 *
 * Opt-in (MAILER_IT=1, which the npm script sets) because it needs Docker; `npm test` stays fast
 * and hermetic. Skipped with the reason when Docker or openssl is missing.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { dkimVerify } from 'mailauth'

import { mailerClient } from '../client'
import { loadConfig } from '../config'
import { createApp, type Running } from '../server'
import { claimFields, CLAIM_SECRET, CLIENTS, devEnv, ISSUER_TOKEN, OPS_TOKEN, RECEIPTS_TOKEN, sha } from './fixtures'
import { dockerAvailable, makeDkimKey, makePki, SMTP_PASSWORD, SMTP_USER, startMailpit, type Mailpit, type Pki } from './mailpit'

const enabled = process.env.MAILER_IT === '1'
const missing = enabled ? dockerAvailable() : 'set MAILER_IT=1 (npm run test:mailer-it)'
const suite = missing ? describe.skip : describe

if (missing && enabled) console.warn(`[imani-mailer IT] skipped: ${missing}`)

let running: Running | null = null
afterEach(async () => {
  await running?.close()
  running = null
})

/** The mailer, configured from environment variables exactly as in a deployment. */
async function mailerFor(env: Record<string, string | undefined>, files: Record<string, string> = {}) {
  const config = loadConfig(devEnv({ MAILER_TRANSPORT: 'smtp', MAILER_SMTP_HOST: '127.0.0.1', MAILER_SMTP_POOL: 'false', ...env }), (p) => {
    if (p in files) return files[p]
    throw new Error(`no file ${p}`)
  })
  const logs: Array<Record<string, unknown>> = []
  running = await createApp(config, { log: (l) => logs.push(l) }).listen(0, '127.0.0.1')
  const issuer = mailerClient({ baseUrl: running.url, token: ISSUER_TOKEN })
  return { url: running.url, issuer, logs, config }
}

const claimReq = (key: string, to = 'bob@example.com', fields: Record<string, unknown> = claimFields) => ({
  template: 'gift-claim',
  to,
  fields,
  idempotencyKey: key,
})

suite('imani-mailer + Mailpit (plain SMTP)', () => {
  let mp: Mailpit
  beforeAll(async () => {
    mp = await startMailpit('plain')
  }, 180_000)
  afterAll(() => mp?.stop())
  afterEach(async () => {
    await mp.clear()
  })
  const plain = () => ({ MAILER_SMTP_PORT: String(mp.smtpPort), MAILER_SMTP_SECURITY: 'none' })

  it('delivers the claim email: one recipient, the service sender, text and HTML, the link intact', async () => {
    const { issuer } = await mailerFor(plain())
    const out = await issuer.send(claimReq('evt_it_1:claim'))
    expect(out).toMatchObject({ ok: true, duplicate: false })

    const [summary] = await mp.waitFor(1)
    expect(summary.To.map((t) => t.Address)).toEqual(['bob@example.com'])
    expect(summary.Cc ?? []).toEqual([])
    expect(summary.Bcc ?? []).toEqual([])
    expect(summary.From).toEqual({ Name: 'Imani gifts', Address: 'gifts@imani.test' })
    expect(summary.Subject).toBe('Alice sent you a voucher for Card Test Bakery')
    expect(out.ok && `<${summary.MessageID}>`).toBe(out.ok && out.messageId)

    const m = await mp.message(summary.ID)
    expect(m.ReturnPath).toBe('gifts@imani.test')
    expect(m.Text).toContain(`https://wallet.imani.test/claim#${CLAIM_SECRET}`)
    expect(m.Text).toContain('Happy birthday!')
    expect(m.HTML).toContain(`href="https://wallet.imani.test/claim#${CLAIM_SECRET}"`)
    // No tracking: the only link is the claim link, exactly as sent.
    expect([...m.HTML.matchAll(/href="([^"]+)"/g)].map((x) => x[1])).toEqual([`https://wallet.imani.test/claim#${CLAIM_SECRET}`])
    expect(m.HTML).not.toMatch(/<img/i)

    const h = await mp.headers(summary.ID)
    expect(h['Auto-Submitted']).toEqual(['auto-generated'])
    expect(h['X-Imani-Template']).toEqual(['gift-claim'])
    expect(h['Content-Type'][0]).toMatch(/^multipart\/alternative/)
  })

  it('a hostile field cannot add a header or a recipient, and HTML is escaped in the delivered message', async () => {
    const { issuer } = await mailerFor(plain())
    const out = await issuer.send(
      claimReq('evt_it_2:claim', 'bob@example.com', {
        ...claimFields,
        from: 'Eve\r\nBcc: victim@evil.test\r\nX-Injected: yes',
        stall: 'Shop\nTo: second@evil.test',
        message: '<script>alert(1)</script><a href="https://evil.test">click</a>',
      }),
    )
    expect(out.ok).toBe(true)
    const [summary] = await mp.waitFor(1)
    expect(summary.To.map((t) => t.Address)).toEqual(['bob@example.com'])
    expect(summary.Bcc ?? []).toEqual([])
    const h = await mp.headers(summary.ID)
    expect(h['X-Injected']).toBeUndefined()
    expect(h.Bcc).toBeUndefined()
    expect(h.To).toHaveLength(1)
    const m = await mp.message(summary.ID)
    expect(m.HTML).not.toContain('<script>')
    expect(m.HTML).not.toContain('href="https://evil.test"')
    expect(m.HTML).toContain('&lt;script&gt;')
    expect(await mp.messages()).toHaveLength(1)
  })

  it('a link to a host outside MAILER_LINK_HOSTS is refused and nothing reaches the server', async () => {
    const { issuer } = await mailerFor(plain())
    const out = await issuer.send(claimReq('evt_it_3:claim', 'bob@example.com', { ...claimFields, claimUrl: 'https://phish.test/claim#x' }))
    expect(out).toMatchObject({ ok: false, status: 400, error: 'invalid_fields', retryable: false })
    await new Promise((r) => setTimeout(r, 300))
    expect(await mp.messages()).toHaveLength(0)
  })

  it('idempotent across concurrent retries and a restart: exactly one email arrives', async () => {
    const dir = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'mailer-it-'))
    const state = `${dir}/state.json`
    const first = await mailerFor({ ...plain(), MAILER_STATE_FILE: state })
    const outs = await Promise.all(Array.from({ length: 8 }, () => first.issuer.send(claimReq('evt_it_4:claim'))))
    expect(outs.filter((o) => o.ok && !o.duplicate)).toHaveLength(1)
    await running?.close()
    running = null
    const second = await mailerFor({ ...plain(), MAILER_STATE_FILE: state })
    expect(await second.issuer.send(claimReq('evt_it_4:claim'))).toMatchObject({ ok: true, duplicate: true })
    expect(await second.issuer.send(claimReq('evt_it_4:claim', 'eve@example.com'))).toMatchObject({ ok: false, status: 409, error: 'idempotency_conflict' })
    await new Promise((r) => setTimeout(r, 300))
    expect(await mp.messages()).toHaveLength(1)
  })

  it('sandbox mode: the message goes to the sandbox inbox only, marked, without the real address', async () => {
    const { issuer } = await mailerFor({ ...plain(), MAILER_SANDBOX_REDIRECT: 'qa@imani.test' })
    expect(await issuer.send(claimReq('evt_it_5:claim', 'real.customer@example.com'))).toMatchObject({ ok: true, sandboxed: true })
    const [summary] = await mp.waitFor(1)
    expect(summary.To.map((t) => t.Address)).toEqual(['qa@imani.test'])
    expect(summary.Subject).toMatch(/^\[sandbox\] /)
    expect((await mp.raw(summary.ID)).toLowerCase()).not.toContain('real.customer@example.com')
  })

  it('scopes, suppressions and the per-recipient limit hold end to end', async () => {
    const { url, issuer } = await mailerFor({ ...plain(), MAILER_RATE_PER_RECIPIENT_HOUR: '2' })
    const receipts = mailerClient({ baseUrl: url, token: RECEIPTS_TOKEN })
    expect(await receipts.send(claimReq('evt_it_6:claim'))).toMatchObject({ ok: false, status: 403, error: 'template_not_allowed' })
    const unknown = mailerClient({ baseUrl: url, token: 'x'.repeat(40) })
    expect(await unknown.send(claimReq('evt_it_6:claim'))).toMatchObject({ ok: false, status: 401 })

    const bounce = await fetch(`${url}/v1/suppressions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'bounced@example.com', reason: 'hard-bounce' }),
    })
    expect(bounce.status).toBe(200)
    expect(await issuer.send(claimReq('evt_it_7:claim', 'bounced@example.com'))).toMatchObject({ ok: false, error: 'recipient_suppressed' })

    expect(await issuer.send(claimReq('evt_it_8:claim', 'busy@example.com'))).toMatchObject({ ok: true })
    expect(await issuer.send(claimReq('evt_it_9:claim', 'busy@example.com'))).toMatchObject({ ok: true })
    const limited = await issuer.send(claimReq('evt_it_10:claim', 'busy@example.com'))
    expect(limited).toMatchObject({ ok: false, status: 429, retryable: true })

    await new Promise((r) => setTimeout(r, 300))
    const delivered = await mp.messages()
    expect(delivered.map((d) => d.To[0].Address).sort()).toEqual(['busy@example.com', 'busy@example.com'])
  })

  it('a deployment template from MAILER_TEMPLATES_FILE is delivered, and its fields are typed', async () => {
    const files = {
      '/templates.json': JSON.stringify({
        'licence-renewed': {
          fromName: 'Imani subscriptions',
          subject: 'Your {{plan}} plan is renewed',
          text: 'Hello {{name}},\n\nYour {{plan}} plan now runs until {{until}}.\n\nManage it: {{manageUrl}}',
          fields: {
            name: { type: 'line', default: 'there' },
            plan: { type: 'line', required: true },
            until: { type: 'line', required: true },
            manageUrl: { type: 'url', required: true },
          },
        },
      }),
    }
    const SUBS_TOKEN = 'subscriptions-token-0123456789abcdefghij'
    const clients = JSON.stringify([...CLIENTS, { id: 'subscriptions', tokenSha256: sha(SUBS_TOKEN), templates: ['licence-renewed'] }])
    const { url } = await mailerFor({ ...plain(), MAILER_TEMPLATES_FILE: '/templates.json', MAILER_CLIENTS: clients }, files)
    // The issuer may not send another service's template…
    const issuer = mailerClient({ baseUrl: url, token: ISSUER_TOKEN })
    expect(await issuer.send({ template: 'licence-renewed', to: 'm@example.com', fields: {}, idempotencyKey: 'lic-0000001' })).toMatchObject({ status: 403 })
    // …the subscriptions client may, with its fields checked and the default applied.
    const subs = mailerClient({ baseUrl: url, token: SUBS_TOKEN })
    expect(await subs.send({ template: 'licence-renewed', to: 'm@example.com', fields: { plan: 'Basic', until: '1 Dec 2026', manageUrl: 'ftp://imani.test/x' }, idempotencyKey: 'lic-0000002' })).toMatchObject({ status: 400, error: 'invalid_fields' })
    expect(await subs.send({ template: 'licence-renewed', to: 'm@example.com', fields: { plan: 'Basic', until: '1 Dec 2026', manageUrl: 'https://imani.test/subscription' }, idempotencyKey: 'lic-0000003' })).toMatchObject({ ok: true })
    const [summary] = await mp.waitFor(1)
    expect(summary.From.Name).toBe('Imani subscriptions')
    expect(summary.Subject).toBe('Your Basic plan is renewed')
    expect((await mp.message(summary.ID)).Text).toContain('Hello there,')
  })
})

suite('imani-mailer + Mailpit (STARTTLS required, AUTH required, private CA)', () => {
  let mp: Mailpit
  let pki: Pki
  beforeAll(async () => {
    pki = makePki()
    mp = await startMailpit('secure', pki)
  }, 180_000)
  afterAll(() => mp?.stop())
  afterEach(async () => {
    await mp.clear()
  })
  const secure = (extra: Record<string, string | undefined> = {}) => ({
    MAILER_SMTP_PORT: String(mp.smtpPort),
    MAILER_SMTP_SECURITY: 'starttls',
    MAILER_SMTP_USER: SMTP_USER,
    MAILER_SMTP_PASSWORD: SMTP_PASSWORD,
    MAILER_SMTP_CA_FILE: '/ca.pem',
    ...extra,
  })

  it('upgrades with STARTTLS, verifies the certificate against the configured CA, authenticates, delivers', async () => {
    const { issuer, url } = await mailerFor(secure(), { '/ca.pem': pki.caPem })
    expect((await fetch(`${url}/ready`)).status).toBe(200)
    expect(await issuer.send(claimReq('evt_tls_1:claim'))).toMatchObject({ ok: true })
    const [summary] = await mp.waitFor(1)
    expect(summary.Subject).toBe('Alice sent you a voucher for Card Test Bakery')
    // This Mailpit refuses MAIL FROM before STARTTLS and before AUTH (MP_SMTP_REQUIRE_STARTTLS, an
    // auth file), so a stored message is proof the mailer did both. The refusals are the tests below.
    expect(summary.To.map((t) => t.Address)).toEqual(['bob@example.com'])
  })

  it('refuses a certificate it cannot verify, and nothing is sent', async () => {
    const { issuer, url, logs } = await mailerFor(secure({ MAILER_SMTP_CA_FILE: undefined }))
    expect((await fetch(`${url}/ready`)).status).toBe(503)
    const out = await issuer.send(claimReq('evt_tls_2:claim'))
    expect(out).toMatchObject({ ok: false, status: 503, error: 'transport_unavailable', retryable: true })
    expect(JSON.stringify(logs)).toMatch(/certificate|self.signed|CERT/i)
    await new Promise((r) => setTimeout(r, 300))
    expect(await mp.messages()).toHaveLength(0)
  })

  it('wrong credentials are refused by the server; the message is kept for retry, not dropped', async () => {
    const { issuer, logs } = await mailerFor(secure({ MAILER_SMTP_PASSWORD: 'wrong-password-123' }), { '/ca.pem': pki.caPem })
    const out = await issuer.send(claimReq('evt_tls_3:claim'))
    expect(out).toMatchObject({ ok: false, error: 'transport_unavailable', retryable: true })
    expect(JSON.stringify(logs)).toMatch(/EAUTH|535/)
    expect(JSON.stringify(logs)).not.toContain('wrong-password-123')
    expect(JSON.stringify(logs)).not.toContain(SMTP_PASSWORD)
    await new Promise((r) => setTimeout(r, 300))
    expect(await mp.messages()).toHaveLength(0)
  })

  it('without credentials the server refuses the message (so a delivery above proves AUTH happened)', async () => {
    const { issuer } = await mailerFor(secure({ MAILER_SMTP_USER: undefined, MAILER_SMTP_PASSWORD: undefined }), { '/ca.pem': pki.caPem })
    expect(await issuer.send(claimReq('evt_tls_5:claim'))).toMatchObject({ ok: false })
    await new Promise((r) => setTimeout(r, 300))
    expect(await mp.messages()).toHaveLength(0)
  })

  it('a server that requires STARTTLS refuses a mailer configured for clear text', async () => {
    const { issuer } = await mailerFor({
      ...secure({ MAILER_SMTP_SECURITY: 'none', MAILER_SMTP_CA_FILE: undefined }),
      MAILER_SMTP_ALLOW_PLAINTEXT_AUTH: 'true',
    })
    expect(await issuer.send(claimReq('evt_tls_4:claim'))).toMatchObject({ ok: false })
    await new Promise((r) => setTimeout(r, 300))
    expect(await mp.messages()).toHaveLength(0)
  })
})

suite('imani-mailer + Mailpit (DKIM)', () => {
  let mp: Mailpit
  beforeAll(async () => {
    mp = await startMailpit('plain')
  }, 180_000)
  afterAll(() => mp?.stop())

  it('signs with the configured key, and the delivered message verifies against the published record', async () => {
    const key = makeDkimKey()
    const { issuer } = await mailerFor(
      { MAILER_SMTP_PORT: String(mp.smtpPort), MAILER_SMTP_SECURITY: 'none', MAILER_DKIM_DOMAIN: 'imani.test', MAILER_DKIM_SELECTOR: 'it2026', MAILER_DKIM_PRIVATE_KEY: key.privateKey },
    )
    expect(await issuer.send(claimReq('evt_dkim_1:claim'))).toMatchObject({ ok: true })
    const [summary] = await mp.waitFor(1)
    const raw = await mp.raw(summary.ID)
    expect(raw).toMatch(/^DKIM-Signature: .*d=imani\.test/m)

    const resolver = async (name: string, type: string) => {
      if (type === 'TXT' && name === 'it2026._domainkey.imani.test') return [[key.dnsTxt]]
      throw Object.assign(new Error('NXDOMAIN'), { code: 'ENOTFOUND' })
    }
    const verified = await dkimVerify(Buffer.from(raw), { resolver })
    const result = verified.results[0]
    expect(result.status.result).toBe('pass')
    expect(result.signingDomain).toBe('imani.test')
    expect(result.status.aligned).toBe('imani.test')

    // And a tampered body fails, so the pass above means something.
    const tampered = raw.replace('Card Test Bakery', 'Card Test Bakerz')
    expect(tampered).not.toBe(raw)
    expect((await dkimVerify(Buffer.from(tampered), { resolver })).results[0].status.result).not.toBe('pass')
  })
})

suite('imani-mailer + Mailpit (server refusals, Chaos)', () => {
  let mp: Mailpit
  beforeAll(async () => {
    mp = await startMailpit('chaos')
  }, 180_000)
  afterAll(() => mp?.stop())
  afterEach(async () => {
    await mp.chaos({})
    await mp.clear()
  })
  const plain = () => ({ MAILER_SMTP_PORT: String(mp.smtpPort), MAILER_SMTP_SECURITY: 'none' })

  it('a 4xx from the server is retryable, and a retry with the same key delivers once', async () => {
    const { issuer } = await mailerFor(plain())
    await mp.chaos({ Recipient: { ErrorCode: 451, Probability: 100 } })
    expect(await issuer.send(claimReq('evt_chaos_1:claim'))).toMatchObject({ ok: false, status: 503, error: 'transport_unavailable', retryable: true })
    await mp.chaos({})
    expect(await issuer.send(claimReq('evt_chaos_1:claim'))).toMatchObject({ ok: true, duplicate: false })
    expect(await mp.waitFor(1)).toHaveLength(1)
  })

  it('a 5xx to the recipient is a permanent rejection the caller must not retry', async () => {
    const { issuer } = await mailerFor(plain())
    await mp.chaos({ Recipient: { ErrorCode: 550, Probability: 100 } })
    expect(await issuer.send(claimReq('evt_chaos_2:claim'))).toMatchObject({ ok: false, status: 502, error: 'transport_rejected', retryable: false })
  })

  it('a 5xx to the sender is permanent too', async () => {
    const { issuer } = await mailerFor(plain())
    await mp.chaos({ Sender: { ErrorCode: 554, Probability: 100 } })
    expect(await issuer.send(claimReq('evt_chaos_3:claim'))).toMatchObject({ ok: false, status: 502, retryable: false })
  })

  it('the SMTP server being down is retryable and /ready says so', async () => {
    const { issuer, url } = await mailerFor({ MAILER_SMTP_PORT: '1', MAILER_SMTP_SECURITY: 'none', MAILER_SMTP_CONNECT_TIMEOUT_MS: '1000' })
    expect((await fetch(`${url}/ready`)).status).toBe(503)
    expect(await issuer.send(claimReq('evt_chaos_4:claim'))).toMatchObject({ ok: false, status: 503, retryable: true })
  })
})
