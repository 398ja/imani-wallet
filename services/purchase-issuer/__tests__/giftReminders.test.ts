/**
 * #410 §6c/§6d expiry reminders, RFC 8058 unsubscribe, hard bounce, and #570 scrub-all retention,
 * all on a fake clock against the real GiftTracker.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { request } from 'node:http'

import { GiftTracker, hashToCurveHex, KEEP_AFTER_CLAIM_BY_MS, SWEEP_EVERY_MS, type ProofState, type ReportResult, type TrackedGift, type TrackerStore, type TrackInput } from '../giftTracker'
import type { SendOutcome, SendRequest } from '../../imani-mailer/mailer.ts'
import { encodePlainTokenV4 } from '../../../src/lib/plainToken'
import { giftNoticeCount, resetMetricsForTest } from '../metrics'
import { claimSubject } from '../discharge'
import { httpIsBounced, httpScrubAll } from '../giftDelivery'
import { mountUnsubscribe, server, unsubscribeUrl, UNSUBSCRIBE_PREFIX } from '../server'
import { compile, render, resolveFields } from '../../imani-mailer/templates'
import { BUILTIN_TEMPLATES } from '../../imani-mailer/builtins'

const KEY = 'cd'.repeat(32)
const DAY = 86_400_000
const HOUR = 3_600_000
const T0 = Date.UTC(2026, 10, 1, 12)
const CLAIM_BY = T0 + 14 * DAY
const DRAFT = '11111111-2222-3333-4444-555555555555'
const BUYER = 'ann@example.com'
const RECIPIENT = 'bob@example.com'
const SECRETS = ['["P2PK_VOUCHER",{"nonce":"01","data":"02aa"}]']
const TOKEN = encodePlainTokenV4('https://mint.example', 'sat', SECRETS.map((secret) => ({ amount: 1000, id: '00ab', secret, C: `02${'c'.repeat(64)}` })))
const OK: SendOutcome = { ok: true, status: 202, messageId: 'm', duplicate: false, sandboxed: true }

function memStore(): TrackerStore & { rows: Record<string, TrackedGift> } {
  const s = {
    rows: {} as Record<string, TrackedGift>,
    async read() {
      return JSON.parse(JSON.stringify(s.rows)) as Record<string, TrackedGift>
    },
    async write(rows: Record<string, TrackedGift>) {
      s.rows = JSON.parse(JSON.stringify(rows))
    },
  }
  return s
}

interface Opts {
  state?: ProofState
  mail?: (req: SendRequest) => SendOutcome
  scrub?: () => ReportResult
  bounced?: () => boolean
  offsets?: number[]
  code?: () => { status: 'active' | 'in_use' | 'used' | 'expired'; remaining: number }
  noUnsubscribeUrl?: boolean
}

function harness(o: Opts = {}) {
  let now = T0
  let state: ProofState = o.state ?? 'UNSPENT'
  const store = memStore()
  const mails: SendRequest[] = []
  const scrubs: string[] = []
  const tracker = new GiftTracker(KEY, store, {
    now: () => now,
    sweepEveryMs: 1,
    checkStates: async (_m, ys) => new Map(ys.map((y) => [y, state])),
    sendMail: async (req) => {
      mails.push(req)
      return o.mail ? o.mail(req) : OK
    },
    scrubAll: async (eventId) => {
      scrubs.push(eventId)
      return o.scrub ? o.scrub() : 'ok'
    },
    isBounced: async () => (o.bounced ? o.bounced() : false),
    ...(o.offsets ? { reminderOffsetsMs: o.offsets } : {}),
    ...(o.noUnsubscribeUrl ? {} : { unsubscribeUrl: (d: string, t: string) => unsubscribeUrl('https://issuer.imani.test', d, t) }),
    ...(o.code ? { checkCode: async () => o.code!() } : {}),
  })
  return {
    tracker,
    store,
    mails,
    scrubs,
    at: (ms: number) => void (now = ms),
    setState: (s: ProofState) => void (state = s),
    reminders: () => mails.filter((m) => m.template.endsWith('expiring')),
  }
}

const input = (over: Partial<TrackInput> = {}): TrackInput => ({
  draftId: DRAFT,
  kind: 'email',
  token: TOKEN,
  claimBy: CLAIM_BY,
  buyerEmail: BUYER,
  recipientDisplay: RECIPIENT,
  stall: 'Alice Bakery',
  amount: '€20.00',
  guest: true,
  returnMailDate: '01 Nov 2026',
  eventId: 'evt_1',
  recipient: { email: RECIPIENT, from: 'Ann', claimSubject: claimSubject('email', 'Ann', 'Alice Bakery'), sender: 'gifts@imani.casa' },
  ...over,
})

beforeEach(() => resetMetricsForTest())

describe('expiry reminders (§6c, §6d)', () => {
  it('7 d and 1 d before claimBy, to the recipient, once per offset, with the fields the template needs', async () => {
    const h = harness()
    await h.tracker.track(input(), 'm')
    await h.tracker.sweep()
    expect(h.reminders()).toHaveLength(0)
    h.at(CLAIM_BY - 7 * DAY)
    await h.tracker.sweep()
    h.at(CLAIM_BY - 7 * DAY + HOUR)
    await h.tracker.sweep()
    h.at(CLAIM_BY - DAY)
    await h.tracker.sweep()
    h.at(CLAIM_BY - DAY + HOUR)
    await h.tracker.sweep()
    const r = h.reminders()
    expect(r.map((m) => m.idempotencyKey)).toEqual([`${DRAFT}:expiring:${7 * DAY}`, `${DRAFT}:expiring:${DAY}`])
    expect(r[0]).toMatchObject({
      template: 'gift-expiring',
      to: RECIPIENT,
      fields: { from: 'Ann', stall: 'Alice Bakery', amount: '€20.00', claimBy: '15 Nov 2026', sentOn: '01 Nov 2026', sender: 'gifts@imani.casa', claimSubject: 'Ann sent you a voucher for Alice Bakery' },
    })
    expect(r[0].unsubscribeUrl).toMatch(new RegExp(`^https://issuer\\.imani\\.test${UNSUBSCRIBE_PREFIX}${DRAFT}\\?t=[A-Za-z0-9_-]+$`))
    expect(giftNoticeCount('expiring')).toBe(2)
    // Every reminder renders with the built-in template: no field missing, and no link in it.
    const t = compile('gift-expiring', BUILTIN_TEMPLATES['gift-expiring'])
    const out = render(t, resolveFields(t, r[0].fields as Record<string, string>, { hosts: [], allowHttp: false }))
    expect(out.text).toContain('"Ann sent you a voucher for Alice Bakery"')
    expect(out.text).not.toMatch(/https?:/)
  })

  it('claimSubject matches what the mailer renders for the claim and code emails', () => {
    const fields = { from: 'Ann', stall: 'Alice Bakery', amount: '€1', claimBy: 'x', claimUrl: 'https://w.imani.test/c#x' }
    const claim = compile('gift-claim', BUILTIN_TEMPLATES['gift-claim'])
    expect(render(claim, resolveFields(claim, fields, { hosts: ['w.imani.test'], allowHttp: false })).subject).toBe(claimSubject('email', 'Ann', 'Alice Bakery'))
    const code = compile('gift-code', BUILTIN_TEMPLATES['gift-code'])
    const cf = { stall: 'Alice Bakery', shop: 's', amount: '€1', code: 'ABCD', shopUrl: 'https://w.imani.test/', expiresOn: 'x', balanceUrl: 'https://w.imani.test/b' }
    expect(render(code, resolveFields(code, cf, { hosts: ['w.imani.test'], allowHttp: false })).subject).toBe(claimSubject('code', null, 'Alice Bakery'))
  })

  it('overdue: only the latest applicable reminder, never two at once', async () => {
    const h = harness()
    await h.tracker.track(input(), 'm')
    h.at(CLAIM_BY - 12 * HOUR) // both offsets passed while the tracker was down
    await h.tracker.sweep()
    h.at(CLAIM_BY - 11 * HOUR)
    await h.tracker.sweep()
    expect(h.reminders().map((m) => m.idempotencyKey)).toEqual([`${DRAFT}:expiring:${DAY}`])
  })

  it('never within 1 h of claimBy, nor at or after it', async () => {
    const h = harness()
    await h.tracker.track(input(), 'm')
    h.at(CLAIM_BY - 30 * 60_000)
    await h.tracker.sweep()
    h.at(CLAIM_BY + 1)
    await h.tracker.sweep()
    expect(h.reminders()).toHaveLength(0)
  })

  it('an offset longer than the window is skipped (a 5-day window gets only the 1-day reminder)', async () => {
    const h = harness()
    await h.tracker.track(input({ claimBy: T0 + 5 * DAY }), 'm')
    h.at(T0 + 4 * DAY)
    await h.tracker.sweep()
    expect(h.reminders().map((m) => m.idempotencyKey)).toEqual([`${DRAFT}:expiring:${DAY}`])
  })

  it('configurable offsets; [] turns reminders off', async () => {
    const h = harness({ offsets: [3 * DAY] })
    await h.tracker.track(input(), 'm')
    h.at(CLAIM_BY - 3 * DAY)
    await h.tracker.sweep()
    expect(h.reminders().map((m) => m.idempotencyKey)).toEqual([`${DRAFT}:expiring:${3 * DAY}`])
    const off = harness({ offsets: [] })
    await off.tracker.track(input(), 'm')
    off.at(CLAIM_BY - DAY)
    await off.tracker.sweep()
    expect(off.reminders()).toHaveLength(0)
  })

  it('skipped once claimed (any SPENT), and for a handle gift (no recipient email)', async () => {
    const h = harness({ state: 'SPENT' })
    await h.tracker.track(input(), 'm')
    h.at(CLAIM_BY - DAY)
    await h.tracker.sweep()
    expect(h.reminders()).toHaveLength(0)
    const p = harness({ state: 'PENDING' })
    await p.tracker.track(input(), 'm')
    p.at(CLAIM_BY - DAY)
    await p.tracker.sweep()
    expect(p.reminders()).toHaveLength(0)
    const handle = harness()
    await handle.tracker.track(input({ kind: 'handle', recipient: undefined }), 'm')
    handle.at(CLAIM_BY - DAY)
    await handle.tracker.sweep()
    expect(handle.reminders()).toHaveLength(0)
  })

  it('no unsubscribe URL (no public origin): no reminder, because every one must carry it', async () => {
    const h = harness({ noUnsubscribeUrl: true })
    await h.tracker.track(input(), 'm')
    h.at(CLAIM_BY - DAY)
    await h.tracker.sweep()
    expect(h.reminders()).toHaveLength(0)
  })

  it('a retryable mailer failure is retried; a permanent one marks the offset done', async () => {
    let fail: SendOutcome | null = { ok: false, status: 503, error: 'transport_unavailable', message: 'x', retryable: true }
    const h = harness({ mail: () => fail ?? OK })
    await h.tracker.track(input(), 'm')
    h.at(CLAIM_BY - 7 * DAY)
    await h.tracker.sweep()
    fail = null
    h.at(CLAIM_BY - 7 * DAY + HOUR)
    await h.tracker.sweep()
    expect(h.reminders().map((m) => m.idempotencyKey)).toEqual([`${DRAFT}:expiring:${7 * DAY}`, `${DRAFT}:expiring:${7 * DAY}`])
    fail = { ok: false, status: 409, error: 'recipient_suppressed', message: 'x', retryable: false }
    h.at(CLAIM_BY - DAY)
    await h.tracker.sweep()
    h.at(CLAIM_BY - DAY + HOUR)
    await h.tracker.sweep()
    expect(h.reminders()).toHaveLength(3)
  })

  it('the recipient email is sealed at rest, bound to its draft and label (not openable as the buyer email)', async () => {
    const h = harness()
    await h.tracker.track(input(), 'm')
    const disk = JSON.stringify(h.store.rows)
    expect(disk).not.toContain(RECIPIENT)
    expect(disk).not.toContain(BUYER)
    // Swapping the sealed boxes: the buyer slot cannot open the recipient box (distinct AAD label).
    const row = h.store.rows[DRAFT]
    h.store.rows[DRAFT] = { ...row, buyerEmail: row.recipient!.email }
    h.setState('SPENT')
    await h.tracker.sweep()
    expect(h.mails.filter((m) => m.template === 'gift-claimed')).toHaveLength(0)
  })

  it('a re-drive keeps the reminders already sent, the unsubscribe and the tracked date', async () => {
    const h = harness()
    await h.tracker.track(input(), 'm')
    h.at(CLAIM_BY - 7 * DAY)
    await h.tracker.sweep()
    await h.tracker.track(input(), 'm')
    expect(h.store.rows[DRAFT].trackedAt).toBe(T0)
    h.at(CLAIM_BY - 7 * DAY + HOUR)
    await h.tracker.sweep()
    expect(h.reminders()).toHaveLength(1)
  })
})

describe('code gifts (flagged choice: remind while untouched)', () => {
  it('a code with nothing spent gets gift-code-expiring; a part-spent one does not', async () => {
    let check = { status: 'active' as const, remaining: 2000 }
    const h = harness({ code: () => check })
    await h.tracker.track(input({ kind: 'code', code: { code: 'ABCD1234', amountMinor: 2000, decimals: 2, unit: 'EUR' }, recipient: { email: RECIPIENT, from: null, claimSubject: claimSubject('code', null, 'Alice Bakery'), sender: 'gifts@imani.casa' } }), 'm')
    h.at(CLAIM_BY - 7 * DAY)
    await h.tracker.sweep()
    const r = h.reminders()
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ template: 'gift-code-expiring', to: RECIPIENT, fields: { remaining: '€20.00' } })
    expect(JSON.stringify(r[0])).not.toContain('ABCD1234')
    const t = compile('gift-code-expiring', BUILTIN_TEMPLATES['gift-code-expiring'])
    expect(() => resolveFields(t, r[0].fields as Record<string, string>, { hosts: [], allowHttp: false })).not.toThrow()
    check = { status: 'active', remaining: 500 }
    h.at(CLAIM_BY - DAY + HOUR)
    await h.tracker.sweep() // the partial spend (gift-code-used)
    h.at(CLAIM_BY - DAY + 2 * HOUR)
    await h.tracker.sweep()
    expect(h.reminders()).toHaveLength(1)
  })
})

describe('RFC 8058 unsubscribe', () => {
  it('the token is per gift and verified in constant time; unsubscribe stops reminders, not the gift', async () => {
    const h = harness()
    await h.tracker.track(input(), 'm')
    const token = h.tracker.unsubscribeToken(DRAFT)
    expect(h.tracker.verifyUnsubscribe(DRAFT, token)).toBe(true)
    expect(h.tracker.verifyUnsubscribe('other', token)).toBe(false)
    expect(h.tracker.verifyUnsubscribe(DRAFT, token.slice(1))).toBe(false)
    expect(new GiftTracker('ef'.repeat(32), memStore(), {} as never).verifyUnsubscribe(DRAFT, token)).toBe(false)
    expect(await h.tracker.unsubscribe(DRAFT, 'nope')).toBe('bad')
    expect(await h.tracker.unsubscribe(DRAFT, token)).toBe('ok')
    h.at(CLAIM_BY - DAY)
    await h.tracker.sweep()
    expect(h.reminders()).toHaveLength(0)
    // The gift is still tracked: the buyer still hears it was claimed.
    h.setState('SPENT')
    h.at(CLAIM_BY - DAY + HOUR)
    await h.tracker.sweep()
    expect(h.mails.map((m) => m.template)).toEqual(['gift-claimed'])
  })

  it('the endpoint: GET shows a button only, POST with a good token unsubscribes, a bad token is 404', async () => {
    const h = harness()
    await h.tracker.track(input(), 'm')
    mountUnsubscribe(h.tracker)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    try {
      const port = (server.address() as { port: number }).port
      const call = (method: string, path: string, body = '') =>
        new Promise<{ status: number; text: string }>((resolve, reject) => {
          const req = request({ host: '127.0.0.1', port, method, path, headers: { 'content-type': 'application/x-www-form-urlencoded' } }, (res) => {
            let text = ''
            res.on('data', (c) => (text += c))
            res.on('end', () => resolve({ status: res.statusCode ?? 0, text }))
          })
          req.on('error', reject)
          req.end(body)
        })
      const token = h.tracker.unsubscribeToken(DRAFT)
      const path = `${UNSUBSCRIBE_PREFIX}${DRAFT}?t=${token}`
      const get = await call('GET', path)
      expect(get.status).toBe(200)
      expect(get.text).toContain('<form method="post">')
      expect((await h.store.read())[DRAFT].unsubscribed).toBeUndefined()
      expect((await call('POST', `${UNSUBSCRIBE_PREFIX}${DRAFT}?t=bad`, 'List-Unsubscribe=One-Click')).status).toBe(404)
      expect((await call('POST', path, 'List-Unsubscribe=One-Click')).status).toBe(200)
      expect((await h.store.read())[DRAFT].unsubscribed).toBe(T0)
      expect((await call('POST', `${UNSUBSCRIBE_PREFIX}../etc?t=x`)).status).toBe(404)
    } finally {
      mountUnsubscribe(null)
      await new Promise((r) => server.close(r))
    }
  })
})

describe('hard bounce', () => {
  it('the buyer gets gift-bounced once, and no reminder follows', async () => {
    let bounced = false
    const h = harness({ bounced: () => bounced })
    await h.tracker.track(input(), 'm')
    await h.tracker.sweep()
    expect(h.mails).toHaveLength(0)
    bounced = true
    h.at(T0 + HOUR)
    await h.tracker.sweep()
    h.at(T0 + 2 * HOUR)
    await h.tracker.sweep()
    expect(h.mails).toEqual([{ template: 'gift-bounced', to: BUYER, idempotencyKey: `${DRAFT}:bounced`, fields: { recipient: RECIPIENT } }])
    expect(giftNoticeCount('bounced')).toBe(1)
    h.at(CLAIM_BY - DAY)
    await h.tracker.sweep()
    expect(h.reminders()).toHaveLength(0)
  })

  it('httpIsBounced: only a hard bounce counts, the address goes in the body, an error throws', async () => {
    const seen: Array<{ url: string; body: string }> = []
    const f = (answer: unknown, status = 200) =>
      (async (url: string, init: RequestInit) => {
        seen.push({ url, body: String(init.body) })
        return new Response(JSON.stringify(answer), { status })
      }) as unknown as typeof fetch
    expect(await httpIsBounced('http://mailer/', 't', f({ suppressed: true, reason: 'hard-bounce' }))(RECIPIENT)).toBe(true)
    expect(await httpIsBounced('http://mailer', 't', f({ suppressed: true, reason: 'complaint' }))(RECIPIENT)).toBe(false)
    expect(await httpIsBounced('http://mailer', 't', f({ suppressed: false }))(RECIPIENT)).toBe(false)
    await expect(httpIsBounced('http://mailer', 't', f({}, 403))(RECIPIENT)).rejects.toThrow()
    expect(seen[0].url).toBe('http://mailer/v1/suppressions/check')
    expect(seen.every((s) => !s.url.includes('@'))).toBe(true)
    expect(JSON.parse(seen[0].body)).toEqual({ to: RECIPIENT })
  })
})

describe('#570 retention: scrub all before a row goes', () => {
  it('claimed: scrub?all=true for the purchase, then the row is dropped', async () => {
    const h = harness({ state: 'SPENT' })
    await h.tracker.track(input(), 'm')
    await h.tracker.sweep()
    expect(h.scrubs).toEqual(['evt_1'])
    expect(h.store.rows).toEqual({})
  })

  it('a failing scrub keeps the row (finished, no more mail) and is retried every sweep until it lands', async () => {
    let result: ReportResult = 'retry'
    const h = harness({ state: 'SPENT', scrub: () => result })
    await h.tracker.track(input(), 'm')
    await h.tracker.sweep()
    expect(h.store.rows[DRAFT]).toMatchObject({ finished: true })
    // Well past the keep window: still kept, because the purchase still holds the addresses.
    h.at(CLAIM_BY + KEEP_AFTER_CLAIM_BY_MS + 30 * DAY)
    await h.tracker.sweep()
    expect(h.store.rows[DRAFT]).toBeDefined()
    expect(h.mails.map((m) => m.template)).toEqual(['gift-claimed'])
    result = 'ok'
    h.at(CLAIM_BY + KEEP_AFTER_CLAIM_BY_MS + 31 * DAY)
    await h.tracker.sweep()
    expect(h.scrubs).toEqual(['evt_1', 'evt_1', 'evt_1'])
    expect(h.store.rows).toEqual({})
  })

  it('expired and notified: kept until claimBy + 7 d, then scrubbed and dropped', async () => {
    const h = harness()
    await h.tracker.track(input(), 'm')
    h.at(CLAIM_BY)
    await h.tracker.sweep()
    expect(h.scrubs).toEqual([])
    h.at(CLAIM_BY + KEEP_AFTER_CLAIM_BY_MS)
    await h.tracker.sweep()
    expect(h.scrubs).toEqual(['evt_1'])
    expect(h.store.rows).toEqual({})
  })

  it('returned (SPENT after claimBy): scrubbed and dropped; a row from before #570 (no event id) just goes', async () => {
    const h = harness({ state: 'SPENT' })
    await h.tracker.track(input({ eventId: undefined }), 'm')
    h.at(CLAIM_BY + SWEEP_EVERY_MS)
    await h.tracker.sweep()
    expect(h.scrubs).toEqual([])
    expect(h.store.rows).toEqual({})
  })

  it('httpScrubAll: ?all=true with the bearer token; 404 gone, 5xx and network retry', async () => {
    let seen = ''
    const f = (status: number) =>
      (async (url: string) => {
        seen = url
        return new Response(null, { status })
      }) as unknown as typeof fetch
    expect(await httpScrubAll('http://pa/', 't', f(204))('evt 1')).toBe('ok')
    expect(seen).toBe('http://pa/api/v1/purchases/evt%201/scrub?all=true')
    expect(await httpScrubAll('http://pa', 't', f(404))('e')).toBe('gone')
    expect(await httpScrubAll('http://pa', 't', f(503))('e')).toBe('retry')
    expect(await httpScrubAll('http://pa', 't', (async () => { throw new Error('down') }) as never)('e')).toBe('retry')
  })
})

// Keeps the fixture honest: one proof, Y as the mint computes it.
it('fixture', () => expect(hashToCurveHex(SECRETS[0])).toMatch(/^0[23][0-9a-f]{64}$/))
