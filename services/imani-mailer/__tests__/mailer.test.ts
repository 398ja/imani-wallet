import { describe, expect, it, vi } from 'vitest'

import { clean, createMailer, recipientTag, render, safeUrl, TemplateError, type Provider } from '../mailer'

const HOSTS = ['imani.casa']
const claimFields = {
  stall: 'Alice Bakery',
  amount: '€20.00',
  claimBy: '27 Nov 2026',
  claimUrl: `https://imani.casa/claim#${'ab'.repeat(32)}`,
  message: 'Happy birthday',
}

describe('templates', () => {
  it('the claim email: secret only in the body link, never the subject', () => {
    const r = render('gift-claim', claimFields, HOSTS)
    expect(r.subject).toBe('Someone sent you a voucher for Alice Bakery')
    expect(r.subject).not.toContain('ab'.repeat(32))
    expect(r.text).toContain(`https://imani.casa/claim#${'ab'.repeat(32)}`)
    expect(r.text).toMatch(/Don't forward it/)
    expect(r.text).toMatch(/never asks for card details or passwords/)
  })
  it('refuses a link to another host or not https', () => {
    expect(() => render('gift-claim', { ...claimFields, claimUrl: 'https://evil.example/claim#x' }, HOSTS)).toThrow(TemplateError)
    expect(() => render('gift-claim', { ...claimFields, claimUrl: 'http://imani.casa/claim#x' }, HOSTS)).toThrow(TemplateError)
  })
  it('fields are plain text', () => {
    expect(clean('<b>hi</b>\u0007')).toBe('bhi/b')
    expect(render('gift-claim', { ...claimFields, from: '<script>Eve' }, HOSTS).subject).toBe('scriptEve sent you a voucher for Alice Bakery')
  })
  it('every template renders with its fields, and refuses without them', () => {
    expect(render('gift-receipt', { stall: 'A', amount: '€1', recipient: 'bob@example.com' }, HOSTS).text).toMatch(/spam/)
    expect(render('gift-return-link', { stall: 'A', claimBy: 'x', returnUrl: 'https://imani.casa/gift-return#r=1' }, HOSTS).text).toMatch(/take it back/)
    expect(render('gift-bounced', { recipient: 'bob@exmaple.com' }, HOSTS).text).toMatch(/couldn't deliver/)
    expect(render('gift-reminder', { stall: 'A', when: 'expires in 7 days', returnUrl: 'https://imani.casa/gift-return#r=1' }, HOSTS).subject).toMatch(/7 days/)
    expect(() => render('gift-receipt', {}, HOSTS)).toThrow(TemplateError)
  })
  it('safeUrl', () => {
    expect(safeUrl('https://imani.casa/x', HOSTS)).toBe('https://imani.casa/x')
    expect(safeUrl('javascript:alert(1)', HOSTS)).toBeNull()
  })
})

describe('sending', () => {
  const setup = (provider?: Provider) => {
    const lines: Array<Record<string, unknown>> = []
    const p: Provider = provider ?? { send: vi.fn(async () => ({ id: 'm1' })) }
    let t = 0
    const mailer = createMailer({ provider: p, from: 'gifts@imani.casa', allowedHosts: HOSTS, now: () => (t += 1000), log: (l) => lines.push(l), perRecipientPerHour: 3 })
    return { mailer, lines, p }
  }
  const req = (key = 'evt_1:claim') => ({ template: 'gift-claim' as const, to: 'Bob@Example.com', fields: claimFields, idempotencyKey: key })

  it('sends once per idempotency key (one email per gift)', async () => {
    const { mailer, p } = setup()
    expect(await mailer.send(req())).toMatchObject({ status: 202, duplicate: false })
    expect(await mailer.send(req())).toMatchObject({ status: 202, duplicate: true })
    expect(p.send).toHaveBeenCalledTimes(1)
  })
  it('never logs the address, the body or the link', async () => {
    const { mailer, lines } = setup()
    await mailer.send(req())
    const all = JSON.stringify(lines)
    expect(all).not.toMatch(/bob@example\.com/i)
    expect(all).not.toContain('ab'.repeat(32))
    expect(all).not.toContain('Happy birthday')
    expect(all).toContain(recipientTag('bob@example.com'))
  })
  it('rate limits per recipient', async () => {
    const { mailer } = setup()
    for (let i = 0; i < 3; i++) expect((await mailer.send(req(`evt_${i}:claim`))).status).toBe(202)
    expect((await mailer.send(req('evt_9:claim'))).status).toBe(429)
  })
  it('a hard bounce suppresses the address; nothing is re-sent there', async () => {
    const { mailer } = setup()
    mailer.bounce('bob@example.com', true)
    expect((await mailer.send(req())).status).toBe(409)
  })
  it('a provider failure is a 502 and is not remembered as sent', async () => {
    let fail = true
    const { mailer } = setup({ send: async () => { if (fail) throw new Error('down'); return { id: 'm2' } } })
    expect((await mailer.send(req())).status).toBe(502)
    fail = false
    expect(await mailer.send(req())).toMatchObject({ status: 202, id: 'm2' })
  })
  it('refuses bad input', async () => {
    const { mailer } = setup()
    expect((await mailer.send({ ...req(), to: 'nope' })).status).toBe(400)
    expect((await mailer.send({ ...req(), idempotencyKey: 'x' })).status).toBe(400)
    expect((await mailer.send({ ...req(), fields: { ...claimFields, claimUrl: 'https://evil.example/' } })).status).toBe(400)
  })
})
