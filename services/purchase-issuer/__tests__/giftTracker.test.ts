import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hashToCurve } from '@cashu/crypto/modules/common'

import {
  fileTrackerStore,
  GiftTracker,
  hashToCurveHex,
  howBack,
  httpCheckStates,
  KEEP_AFTER_CLAIM_BY_MS,
  SWEEP_EVERY_MS,
  type ProofState,
  type GiftOutcome,
  type ReportResult,
  type TrackedGift,
  type TrackerStore,
  type TrackInput,
} from '../giftTracker'
import type { SendOutcome, SendRequest } from '../../imani-mailer/mailer.ts'
import { encodePlainTokenV4 } from '../../../src/lib/plainToken'
import { giftNoticeCount, resetMetricsForTest, renderMetrics } from '../metrics'
import { httpReportOutcome } from '../giftDelivery'
import { runPass } from '../worker'
import { compile, render, resolveFields } from '../../imani-mailer/templates'
import { BUILTIN_TEMPLATES } from '../../imani-mailer/builtins'

const KEY = 'ab'.repeat(32)
const DAY = 86_400_000
const T0 = Date.UTC(2026, 9, 29, 12)
const CLAIM_BY = T0 + 30 * DAY
const DRAFT = 'd-11111111-2222'
const BUYER_EMAIL = 'ann@example.com'
const SECRETS = ['["P2PK_VOUCHER",{"nonce":"01","data":"02aa"}]', '["P2PK_VOUCHER",{"nonce":"02","data":"02aa"}]']
const TOKEN = encodePlainTokenV4('https://mint.example', 'sat', SECRETS.map((secret) => ({ amount: 1000, id: '00ab', secret, C: `02${'c'.repeat(64)}` })))
const YS = SECRETS.map(hashToCurveHex)

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

function harness(opts: { states?: () => ProofState[]; mail?: (req: SendRequest) => SendOutcome; mintThrows?: boolean } = {}) {
  let now = T0
  const store = memStore()
  const mails: SendRequest[] = []
  const asked: Array<{ mintUrl: string; ys: string[] }> = []
  let states = opts.states ?? (() => ['UNSPENT', 'UNSPENT'])
  const tracker = new GiftTracker(KEY, store, {
    now: () => now,
    checkStates: async (mintUrl, ys) => {
      asked.push({ mintUrl, ys })
      if (opts.mintThrows) throw new Error('down')
      const st = states()
      return new Map(ys.map((y, i) => [y, st[i] ?? 'UNKNOWN']))
    },
    sendMail: async (req) => {
      mails.push(req)
      return opts.mail ? opts.mail(req) : { ok: true, status: 202, messageId: 'm', duplicate: false, sandboxed: true }
    },
  })
  return {
    tracker,
    store,
    mails,
    asked,
    at: (ms: number) => void (now = ms),
    setStates: (f: () => ProofState[]) => void (states = f),
  }
}

const input = (over: Partial<TrackInput> = {}): TrackInput => ({
  draftId: DRAFT,
  kind: 'email',
  token: TOKEN,
  claimBy: CLAIM_BY,
  buyerEmail: BUYER_EMAIL,
  recipientDisplay: 'bob@example.com',
  stall: 'Alice Bakery',
  amount: '€20.00',
  guest: false,
  returnMailDate: null,
  ...over,
})

beforeEach(() => resetMetricsForTest())
afterEach(() => vi.restoreAllMocks())

describe('tracking a delivered gift', () => {
  it('Ys are hash_to_curve of every proof secret (the @cashu/crypto construction)', async () => {
    const h = harness()
    await h.tracker.track(input(), 'https://mint.example')
    const row = h.store.rows[DRAFT]
    expect(row.ys).toEqual(SECRETS.map((s) => hashToCurve(new TextEncoder().encode(s)).toHex(true)))
    expect(row).toMatchObject({ mintUrl: 'https://mint.example', claimBy: CLAIM_BY, stall: 'Alice Bakery', amount: '€20.00', recipientDisplay: 'bob@example.com', guest: false, notified: {} })
  })

  it('at rest: no token, no secret, no plaintext buyer email; the sealed email is bound to its draft', async () => {
    const h = harness()
    await h.tracker.track(input(), 'https://mint.example')
    const disk = JSON.stringify(h.store.rows)
    expect(disk).not.toContain(BUYER_EMAIL)
    expect(disk).not.toContain(TOKEN)
    expect(disk).not.toContain('P2PK_VOUCHER')
    // Moving the sealed email onto another draft's row fails the GCM tag: no mail is sent.
    const row = h.store.rows[DRAFT]
    h.store.rows = { other: { ...row, draftId: 'other' } }
    h.setStates(() => ['SPENT', 'SPENT'])
    await h.tracker.sweep()
    expect(h.mails).toHaveLength(0)
  })

  it('the file store is 0600, atomic, and survives a new tracker (durable)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gift-tracker-'))
    const path = join(dir, 'nested', 'tracker.json')
    const ports = { now: () => T0, checkStates: async () => new Map(), sendMail: async () => ({ ok: true }) as SendOutcome }
    await new GiftTracker(KEY, fileTrackerStore(path), ports).track(input(), 'https://mint.example')
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await readFile(path, 'utf8')).not.toContain(BUYER_EMAIL)
    expect(Object.keys(await fileTrackerStore(path).read())).toEqual([DRAFT])
  })

  it('a corrupt store throws rather than being overwritten', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gift-tracker-'))
    const path = join(dir, 't.json')
    await (await import('node:fs/promises')).writeFile(path, '{nope')
    await expect(fileTrackerStore(path).read()).rejects.toThrow()
  })

  it('a re-drive keeps what was already notified', async () => {
    const h = harness()
    await h.tracker.track(input(), 'm')
    h.store.rows[DRAFT].notified = { expired: 1 }
    await h.tracker.track(input(), 'm')
    expect(h.store.rows[DRAFT].notified).toEqual({ expired: 1 })
  })

  it('refuses a key that is not 32 bytes', () => {
    expect(() => new GiftTracker('ab', memStore(), {} as never)).toThrow(/32 bytes/)
  })
})

describe('the sweep (contract §4.3 rules)', () => {
  it('all SPENT before claimBy: gift-claimed with <draftId>:claimed, row dropped', async () => {
    const h = harness({ states: () => ['SPENT', 'SPENT'] })
    await h.tracker.track(input(), 'https://mint.example')
    await h.tracker.sweep()
    expect(h.mails).toEqual([
      { template: 'gift-claimed', to: BUYER_EMAIL, idempotencyKey: `${DRAFT}:claimed`, fields: { stall: 'Alice Bakery', amount: '€20.00', recipient: 'bob@example.com' } },
    ])
    expect(h.store.rows).toEqual({})
    expect(h.asked[0]).toEqual({ mintUrl: 'https://mint.example', ys: YS })
    expect(giftNoticeCount('claimed')).toBe(1)
  })

  it('partly SPENT before claimBy: nothing yet', async () => {
    const h = harness({ states: () => ['SPENT', 'UNSPENT'] })
    await h.tracker.track(input(), 'm')
    await h.tracker.sweep()
    expect(h.mails).toHaveLength(0)
    expect(h.store.rows[DRAFT]).toBeDefined()
  })

  it('a retryable mailer refusal keeps the row; the next allowed sweep sends it', async () => {
    let fail = true
    const h = harness({
      states: () => ['SPENT', 'SPENT'],
      mail: (): SendOutcome => (fail ? { ok: false, status: 503, error: 'transport_unavailable', message: 'x', retryable: true } : { ok: true, status: 202, messageId: 'm', duplicate: false, sandboxed: true }),
    })
    await h.tracker.track(input(), 'm')
    await h.tracker.sweep()
    expect(h.store.rows[DRAFT]).toBeDefined()
    fail = false
    h.at(T0 + SWEEP_EVERY_MS)
    await h.tracker.sweep()
    expect(h.mails.map((m) => m.idempotencyKey)).toEqual([`${DRAFT}:claimed`, `${DRAFT}:claimed`])
    expect(h.store.rows).toEqual({})
  })

  it('at or after claimBy, all UNSPENT: gift-expired once (<draftId>:expired), kept; then a later SPENT drops it with no email', async () => {
    const h = harness()
    await h.tracker.track(input(), 'm')
    h.at(CLAIM_BY)
    await h.tracker.sweep()
    expect(h.mails).toHaveLength(1)
    expect(h.mails[0]).toMatchObject({
      template: 'gift-expired',
      idempotencyKey: `${DRAFT}:expired`,
      fields: { stall: 'Alice Bakery', amount: '€20.00', recipient: 'bob@example.com', claimBy: '28 Nov 2026', howBack: 'Open your Imani wallet: it takes it back for you.' },
    })
    expect(h.store.rows[DRAFT].notified.expired).toBe(CLAIM_BY)
    h.at(CLAIM_BY + SWEEP_EVERY_MS)
    await h.tracker.sweep()
    expect(h.mails).toHaveLength(1)
    h.setStates(() => ['SPENT', 'SPENT'])
    h.at(CLAIM_BY + 2 * SWEEP_EVERY_MS)
    await h.tracker.sweep()
    expect(h.mails).toHaveLength(1)
    expect(h.store.rows).toEqual({})
  })

  it('G17 (C): the expired notice says the expiry a taken-back voucher keeps, and nothing for an old row', async () => {
    const spendBy = Date.UTC(2027, 0, 27)
    const h = harness()
    await h.tracker.track(input({ spendBy }), 'm')
    h.at(CLAIM_BY)
    await h.tracker.sweep()
    expect(h.mails[0].fields!.spendBy).toBe("Once it's back, it keeps its original expiry: spend it by 27 Jan 2027.")

    const never = harness()
    await never.tracker.track(input({ spendBy: null }), 'm')
    never.at(CLAIM_BY)
    await never.tracker.sweep()
    expect(never.mails[0].fields!.spendBy).toBe("Once it's back, the voucher doesn't expire.")

    const old = harness()
    await old.tracker.track(input(), 'm')
    old.at(CLAIM_BY)
    await old.tracker.sweep()
    expect(old.mails[0].fields).not.toHaveProperty('spendBy')
  })

  it('any SPENT after claimBy without a claimed notice: no email, dropped', async () => {
    const h = harness({ states: () => ['SPENT', 'UNSPENT'] })
    await h.tracker.track(input(), 'm')
    h.at(CLAIM_BY + 1)
    await h.tracker.sweep()
    expect(h.mails).toHaveLength(0)
    expect(h.store.rows).toEqual({})
  })

  it('PENDING / UNKNOWN / mint down: try next pass, no email', async () => {
    for (const states of [() => ['PENDING', 'UNSPENT'] as ProofState[], () => ['UNKNOWN', 'UNKNOWN'] as ProofState[]]) {
      const h = harness({ states })
      await h.tracker.track(input(), 'm')
      h.at(CLAIM_BY)
      await h.tracker.sweep()
      expect(h.mails).toHaveLength(0)
      expect(h.store.rows[DRAFT]).toBeDefined()
    }
    const h = harness({ mintThrows: true })
    await h.tracker.track(input(), 'm')
    await h.tracker.sweep()
    expect(h.store.rows[DRAFT]).toBeDefined()
    expect(renderMetrics()).toMatch(/gift_sweep_errors_total 1/)
  })

  it('asks the mint at most every 10 min per gift', async () => {
    const h = harness()
    await h.tracker.track(input(), 'm')
    await h.tracker.sweep()
    h.at(T0 + SWEEP_EVERY_MS - 1)
    await h.tracker.sweep()
    expect(h.asked).toHaveLength(1)
    h.at(T0 + SWEEP_EVERY_MS)
    await h.tracker.sweep()
    expect(h.asked).toHaveLength(2)
  })

  it('every row is deleted at claimBy + 7 d, unasked', async () => {
    const h = harness()
    await h.tracker.track(input(), 'm')
    h.at(CLAIM_BY + KEEP_AFTER_CLAIM_BY_MS)
    await h.tracker.sweep()
    expect(h.store.rows).toEqual({})
    expect(h.asked).toHaveLength(0)
  })

  it('guest howBack names the return-link email and its date; without a date says "the return link we emailed you"', async () => {
    expect(howBack({ guest: true, stall: 'Alice Bakery', returnMailDate: '28 Oct 2026' })).toBe(
      'Take it back with the return link we emailed you on 28 Oct 2026 (subject "If your Alice Bakery gift isn\'t claimed").',
    )
    expect(howBack({ guest: true, stall: 'Alice Bakery', returnMailDate: null })).toMatch(/^Take it back with the return link we emailed you \(subject/)
    const h = harness()
    await h.tracker.track(input({ guest: true, returnMailDate: '28 Oct 2026' }), 'm')
    h.at(CLAIM_BY)
    await h.tracker.sweep()
    expect(String(h.mails[0].fields!.howBack)).toContain('on 28 Oct 2026')
  })

  it('the fields render with the real built-in templates (no url field)', async () => {
    const h = harness()
    await h.tracker.track(input({ guest: true }), 'm')
    h.at(CLAIM_BY)
    await h.tracker.sweep()
    const t = compile('gift-expired', BUILTIN_TEMPLATES['gift-expired'])
    const r = render(t, resolveFields(t, h.mails[0].fields!, { hosts: [], allowHttp: false }))
    expect(r.subject).toBe("Your Alice Bakery gift wasn't claimed")
    expect(r.text).not.toMatch(/https?:/)
  })

  it('logs nothing that names the buyer, the draft or the amount', async () => {
    const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')].map((s) => s.mockImplementation(() => {}))
    const h = harness({ states: () => ['SPENT', 'SPENT'], mail: () => ({ ok: false, status: 422, error: 'recipient_refused', message: 'no', retryable: false }) })
    await h.tracker.track(input(), 'm')
    await h.tracker.sweep()
    const logged = JSON.stringify(spies.map((s) => s.mock.calls))
    expect(logged).not.toMatch(/ann@|d-1111|€20/)
    expect(renderMetrics()).not.toMatch(/ann@|d-1111/)
  })
})

describe('worker pass runs the sweep, and a failing sweep never fails the pass', () => {
  const deps = (sweep: () => Promise<unknown>) => ({
    api: { owed: async () => [] } as never,
    ports: {} as never,
    gatewayUrl: 'http://gw',
    livemode: false,
    giftTracker: { sweep },
  })
  it('sweeps', async () => {
    const sweep = vi.fn(async () => ({}))
    await runPass(deps(sweep))
    expect(sweep).toHaveBeenCalledOnce()
  })
  it('swallows a store error', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(runPass(deps(async () => { throw new Error('corrupt') }))).resolves.toBeDefined()
  })
})

describe('httpCheckStates (NUT-07)', () => {
  it('routes via the transport URL when set, else the coupon mint URL', async () => {
    const urls: string[] = []
    const f = (async (u: string, init: RequestInit) => {
      urls.push(u)
      const ys = (JSON.parse(String(init.body)) as { Ys: string[] }).Ys
      return new Response(JSON.stringify({ states: ys.map((Y) => ({ Y, state: 'SPENT' })) }))
    }) as unknown as typeof fetch
    const viaTransport = await httpCheckStates('http://localhost:27777', f)('http://127.0.0.1.mint:7777', YS)
    await httpCheckStates(null, f)('https://mint.example/', YS)
    expect(urls).toEqual(['http://localhost:27777/v1/checkstate', 'https://mint.example/v1/checkstate'])
    expect([...viaTransport.values()]).toEqual(['SPENT', 'SPENT'])
  })
  it('a non-2xx throws', async () => {
    const f = (async () => new Response('', { status: 500 })) as unknown as typeof fetch
    await expect(httpCheckStates(null, f)('https://m', YS)).rejects.toThrow(/500/)
  })
})

describe('owner: notices go to EVERY sender, signed in or guest', () => {
  it('a signed-in buyer gets gift-claimed for one gift and gift-expired for another; guest only changes howBack', async () => {
    const h = harness()
    await h.tracker.track(input({ draftId: 'signed-claimed', guest: false }), 'm')
    await h.tracker.track(input({ draftId: 'signed-expired', guest: false }), 'm')
    // First gift: both proofs spent before claimBy.
    h.setStates(() => ['SPENT', 'SPENT'])
    await h.tracker.sweep()
    expect(h.mails.map((m) => [m.template, m.to, m.idempotencyKey])).toEqual([
      ['gift-claimed', BUYER_EMAIL, 'signed-claimed:claimed'],
      ['gift-claimed', BUYER_EMAIL, 'signed-expired:claimed'],
    ])
    const h2 = harness()
    await h2.tracker.track(input({ draftId: 'signed-expired', guest: false }), 'm')
    h2.at(CLAIM_BY)
    await h2.tracker.sweep()
    expect(h2.mails).toHaveLength(1)
    expect(h2.mails[0]).toMatchObject({ template: 'gift-expired', to: BUYER_EMAIL, idempotencyKey: 'signed-expired:expired' })
    expect(h2.mails[0].fields!.howBack).toBe('Open your Imani wallet: it takes it back for you.')
  })
})

describe('#410 code gift row (public code-check, no secret)', () => {
  const CODE = 'IMANIABCD2345EFGH'
  function codeHarness(answers: Array<{ status: 'active' | 'in_use' | 'used' | 'expired'; remaining: number } | Error>) {
    let now = T0
    const store = memStore()
    const mails: SendRequest[] = []
    const asked: string[] = []
    const tracker = new GiftTracker(KEY, store, {
      now: () => now,
      sweepEveryMs: 1,
      checkStates: async () => {
        throw new Error('a code row never asks the mint')
      },
      checkCode: async (code) => {
        asked.push(code)
        const a = answers.shift() ?? new Error('no answer')
        if (a instanceof Error) throw a
        return a
      },
      sendMail: async (req) => (mails.push(req), { ok: true, status: 202, messageId: 'm', duplicate: false, sandboxed: true }),
    })
    return { tracker, store, mails, asked, tick: () => void (now += 1000), at: (ms: number) => void (now = ms) }
  }
  const codeInput = () => input({ kind: 'code', guest: true, returnMailDate: '05 Nov 2026', code: { code: CODE, amountMinor: 2000, decimals: 2, unit: 'EUR' } })

  it('the code is sealed at rest', async () => {
    const h = codeHarness([])
    await h.tracker.track(codeInput(), 'https://mint.example')
    expect(JSON.stringify(h.store.rows)).not.toContain(CODE)
  })

  it('mails gift-code-used each time remaining drops, and gift-code-expired with what was left', async () => {
    const h = codeHarness([
      { status: 'active', remaining: 2000 },
      { status: 'in_use', remaining: 2000 },
      { status: 'active', remaining: 1200 },
      new Error('down'),
      { status: 'expired', remaining: 0 },
    ])
    await h.tracker.track(codeInput(), 'https://mint.example')
    for (let i = 0; i < 5; i++) {
      h.tick()
      await h.tracker.sweep()
    }
    expect(h.asked.every((c) => c === CODE)).toBe(true)
    expect(h.mails.map((m) => [m.template, m.idempotencyKey])).toEqual([
      ['gift-code-used', `${DRAFT}:code-used:1200`],
      ['gift-code-expired', `${DRAFT}:code-expired`],
    ])
    expect(h.mails[0].fields).toMatchObject({ spent: '€8.00', remaining: '€12.00', recipient: 'bob@example.com' })
    expect(h.mails[1].fields).toMatchObject({ remaining: '€12.00', returnMailDate: '05 Nov 2026' })
    for (const m of h.mails) {
      const t = compile(m.template, BUILTIN_TEMPLATES[m.template])
      expect(() => render(t, resolveFields(t, m.fields!, { hosts: [], allowHttp: false }))).not.toThrow()
    }
    expect(h.store.rows[DRAFT]).toBeUndefined()
  })

  it('fully used: one used notice with no remaining, then the row is done', async () => {
    const h = codeHarness([{ status: 'used', remaining: 0 }])
    await h.tracker.track(codeInput(), 'https://mint.example')
    h.tick()
    await h.tracker.sweep()
    expect(h.mails).toHaveLength(1)
    expect(h.mails[0].fields).toMatchObject({ spent: '€20.00' })
    expect(h.mails[0].fields).not.toHaveProperty('remaining')
    expect(h.store.rows[DRAFT]).toBeUndefined()
  })

  it('expired with nothing left: no expired notice', async () => {
    const h = codeHarness([{ status: 'used', remaining: 0 }])
    await h.tracker.track(codeInput(), 'https://mint.example')
    h.tick()
    await h.tracker.sweep()
    expect(h.mails.map((m) => m.template)).toEqual(['gift-code-used'])
  })
})

describe('business metrics: claim outcomes reported to payment-adapter (the one owner of gift states)', () => {
  type Report = { draftId: string; outcome: GiftOutcome; remainingMinor?: number }
  function reporting(opts: { states: () => ProofState[]; answer?: () => ReportResult; code?: Array<{ status: 'active' | 'in_use' | 'used' | 'expired'; remaining: number }> }) {
    let now = T0
    const store = memStore()
    const reports: Report[] = []
    const tracker = new GiftTracker(KEY, store, {
      now: () => now,
      sweepEveryMs: 1,
      checkStates: async (_m, ys) => new Map(ys.map((y, i) => [y, opts.states()[i] ?? 'UNKNOWN'])),
      ...(opts.code ? { checkCode: async () => opts.code!.shift() ?? { status: 'active' as const, remaining: 2000 } } : {}),
      sendMail: async () => ({ ok: true, status: 202, messageId: 'm', duplicate: false, sandboxed: true }),
      reportOutcome: async (draftId, outcome, remainingMinor) => {
        reports.push({ draftId, outcome, ...(remainingMinor !== undefined ? { remainingMinor } : {}) })
        return opts.answer ? opts.answer() : 'ok'
      },
    })
    return { tracker, store, reports, at: (ms: number) => void (now = ms), tick: () => void (now += 1000) }
  }

  it('a claimed voucher is reported CLAIMED once, then the row is dropped', async () => {
    const h = reporting({ states: () => ['SPENT', 'SPENT'] })
    await h.tracker.track(input(), 'm')
    await h.tracker.sweep()
    h.tick()
    await h.tracker.sweep()
    expect(h.reports).toEqual([{ draftId: DRAFT, outcome: 'CLAIMED' }])
    expect(h.store.rows).toEqual({})
  })

  it('unspent past claimBy is EXPIRED, and a later take-back is RETURNED', async () => {
    let states: ProofState[] = ['UNSPENT', 'UNSPENT']
    const h = reporting({ states: () => states })
    await h.tracker.track(input(), 'm')
    h.at(CLAIM_BY)
    await h.tracker.sweep()
    h.at(CLAIM_BY + 1000)
    await h.tracker.sweep()
    states = ['SPENT', 'SPENT']
    h.at(CLAIM_BY + 2000)
    await h.tracker.sweep()
    expect(h.reports.map((r) => r.outcome)).toEqual(['EXPIRED', 'RETURNED'])
    expect(h.store.rows).toEqual({})
  })

  it('a report payment-adapter could not take is kept and retried, and the finished row waits for it', async () => {
    let answer: ReportResult = 'retry'
    const h = reporting({ states: () => ['SPENT', 'SPENT'], answer: () => answer })
    await h.tracker.track(input(), 'm')
    await h.tracker.sweep()
    expect(h.store.rows[DRAFT]).toMatchObject({ finished: true, report: { outcome: 'CLAIMED' } })
    answer = 'ok'
    h.tick()
    await h.tracker.sweep()
    expect(h.reports.map((r) => r.outcome)).toEqual(['CLAIMED', 'CLAIMED'])
    expect(h.store.rows).toEqual({})
    // Only one claimed email for all that: the notice is not re-sent while the report waits.
  })

  it('a code gift reports PARTLY_USED with what is left, then CLAIMED when spent', async () => {
    const h = reporting({
      states: () => [],
      code: [
        { status: 'active', remaining: 1200 },
        { status: 'active', remaining: 0 },
      ],
    })
    await h.tracker.track(input({ kind: 'code', code: { code: 'IMANIABCD2345EFGH', amountMinor: 2000, decimals: 2, unit: 'EUR' } }), 'm')
    h.tick()
    await h.tracker.sweep()
    h.tick()
    await h.tracker.sweep()
    expect(h.reports).toEqual([
      { draftId: DRAFT, outcome: 'PARTLY_USED', remainingMinor: 1200 },
      { draftId: DRAFT, outcome: 'CLAIMED', remainingMinor: 0 },
    ])
    expect(h.store.rows).toEqual({})
  })

  it('a code that expires with value left reports EXPIRED with the last balance', async () => {
    const h = reporting({ states: () => [], code: [{ status: 'active', remaining: 500 }, { status: 'expired', remaining: 0 }] })
    await h.tracker.track(input({ kind: 'code', code: { code: 'IMANIABCD2345EFGH', amountMinor: 2000, decimals: 2, unit: 'EUR' } }), 'm')
    h.tick()
    await h.tracker.sweep()
    h.tick()
    await h.tracker.sweep()
    expect(h.reports.at(-1)).toEqual({ draftId: DRAFT, outcome: 'EXPIRED', remainingMinor: 500 })
  })

  it('httpReportOutcome posts the outcome with the bearer token and classifies answers', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const answers = [204, 200, 404, 409, 503]
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return new Response(null, { status: answers.shift()! })
    }) as unknown as typeof fetch
    const report = httpReportOutcome('http://pa:8080/', 'tok', fetchImpl)
    expect(await report('d-1', 'PARTLY_USED', 300)).toBe('ok')
    expect(await report('d-1', 'CLAIMED')).toBe('ok')
    expect(await report('d-1', 'CLAIMED')).toBe('gone')
    expect(await report('d-1', 'CLAIMED')).toBe('gone')
    expect(await report('d-1', 'CLAIMED')).toBe('retry')
    expect(calls[0].url).toBe('http://pa:8080/api/v1/purchases/gifts/d-1/outcome')
    expect(calls[0].init.headers).toMatchObject({ Authorization: 'Bearer tok' })
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ outcome: 'PARTLY_USED', remainingMinor: 300 })
    const down = httpReportOutcome('http://pa', 't', (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch)
    expect(await down('d', 'CLAIMED')).toBe('retry')
  })
})
