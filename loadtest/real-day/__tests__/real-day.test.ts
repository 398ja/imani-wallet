import { describe, expect, it, beforeEach } from 'vitest'
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools'
import { bytesToHex } from '@noble/hashes/utils'
import { amountMinor, nextJourney, pickWeighted, rng, seedFor, smokePlan, thinkMs, JOURNEYS, WEIGHTS } from '../schedule.mts'
import { conserve, expectedDeltas, parseBalancePanel, type Movement } from '../ledger.mts'
import { clearSecrets, redact, redactDeep, registerSecret } from '../redact.mts'
import { buildResult, journeyStats, percentile, renderMarkdown, resultName, summariseK6, timeline, type Attempt, type Population } from '../report.mts'
import { decodeRealStalls, KeyFileError, parseEnvFile } from '../keys.mts'
import { classify429, tokenBucket } from '../pacing.mts'

describe('schedule', () => {
  it('is reproducible from the seed and differs between personas', () => {
    const a = rng(seedFor(550, 'cust0001'))
    const b = rng(seedFor(550, 'cust0001'))
    const c = rng(seedFor(550, 'cust0002'))
    const sa = Array.from({ length: 20 }, () => nextJourney(a, { holdsCoupons: true }))
    const sb = Array.from({ length: 20 }, () => nextJourney(b, { holdsCoupons: true }))
    const sc = Array.from({ length: 20 }, () => nextJourney(c, { holdsCoupons: true }))
    expect(sa).toEqual(sb)
    expect(sa).not.toEqual(sc)
  })

  it('draws journeys in proportion to their weights', () => {
    const r = rng(1)
    const counts: Record<string, number> = {}
    const n = 20_000
    for (let i = 0; i < n; i++) {
      const k = pickWeighted(r, WEIGHTS)
      counts[k] = (counts[k] ?? 0) + 1
    }
    const total = Object.values(WEIGHTS).reduce((s, w) => s + w, 0)
    for (const [k, w] of Object.entries(WEIGHTS)) expect(Math.abs((counts[k] ?? 0) / n - w / total)).toBeLessThan(0.02)
  })

  it('never draws a zero-weight journey, and buys first when nothing is held', () => {
    const r = rng(7)
    for (let i = 0; i < 500; i++) {
      const j = nextJourney(r, { holdsCoupons: false }, { card: 0 })
      expect(j).not.toBe('card')
      expect(['pay', 'send', 'link', 'online']).not.toContain(j)
    }
  })

  it('keeps think time and amounts in range', () => {
    const r = rng(3)
    for (let i = 0; i < 1000; i++) {
      const t = thinkMs(r)
      expect(t).toBeGreaterThanOrEqual(5000)
      expect(t).toBeLessThanOrEqual(40000)
      const a = amountMinor(r)
      expect(a % 50).toBe(0)
      expect(a).toBeGreaterThanOrEqual(50)
      expect(a).toBeLessThanOrEqual(200)
    }
  })

  it('smoke plan runs every journey type at least once', () => {
    const plan = smokePlan(['a', 'b', 'c'])
    for (const j of JOURNEYS) expect(plan.some((p) => p.journey === j)).toBe(true)
    // each customer arrives before anything else they do
    for (const who of ['a', 'b', 'c']) expect(plan.findIndex((p) => p.persona === who)).toBe(plan.findIndex((p) => p.persona === who && p.journey === 'arrive'))
    // pay/send/link/online come after the buys of the same customer
    const first = plan.filter((p) => p.persona === 'a').map((p) => p.journey)
    expect(first.indexOf('buy')).toBeLessThan(first.indexOf('pay'))
  })
})

describe('ledger', () => {
  const day: Movement[] = [
    { kind: 'sale', stall: 'corda', to: 'c1', minor: 200, unit: 'GBP' },
    { kind: 'sale', stall: 'bart', to: 'c1', minor: 150, unit: 'EUR' },
    { kind: 'send', from: 'c1', to: 'c2', minor: 50, unit: 'GBP' },
    { kind: 'pay', from: 'c1', stall: 'corda', minor: 100, unit: 'GBP' },
    { kind: 'link-send', from: 'c2', minor: 50, unit: 'GBP' },
    { kind: 'link-claim', to: 'c3', minor: 50, unit: 'GBP' },
    { kind: 'code', from: 'c1', minor: 100, unit: 'EUR' },
    { kind: 'cashlink', stall: 'bart', to: 'c3', minor: 100, unit: 'EUR' },
  ]

  it('derives every persona’s expected change', () => {
    expect(expectedDeltas(day)).toEqual({
      c1: { GBP: 50, EUR: 50 },
      c2: { GBP: 0 },
      c3: { GBP: 50, EUR: 100 },
      corda: { GBP: 0 },
    })
  })

  it('passes when the app showed exactly the expected movements, real stalls included', () => {
    const before = { c1: { GBP: 0 }, c2: {}, c3: { EUR: 500 }, corda: { GBP: 1234 }, bart: { EUR: 999 } }
    const after = { c1: { GBP: 50, EUR: 50 }, c2: { GBP: 0 }, c3: { GBP: 50, EUR: 600 }, corda: { GBP: 1234 }, bart: { EUR: 999 } }
    const r = conserve(before, after, day)
    expect(r.ok).toBe(true)
    expect(r.totals.GBP).toMatchObject({ issued: 200, burnt: 100, outstandingLinks: 0, observed: 100, expected: 100 })
    expect(r.totals.EUR).toMatchObject({ issued: 250, burnt: 100 })
  })

  it('fails and names the personas on a mismatch or an unread balance', () => {
    const before = { c1: { GBP: 0 }, c2: {}, c3: {}, corda: { GBP: 1234 } }
    const after = { c1: { GBP: 40, EUR: 50 }, c2: { GBP: 0 }, c3: { GBP: Number.NaN }, corda: { GBP: 1334 } }
    const r = conserve(before, after, day)
    expect(r.ok).toBe(false)
    expect(r.mismatches.map((m) => m.persona).sort()).toEqual(['c1', 'corda'])
    expect(r.unread).toEqual(['c3'])
  })

  it('reads the balance panel as the en-GB app shows it', () => {
    expect(parseBalancePanel('€1,234.56')).toEqual({ EUR: 123456 })
    expect(parseBalancePanel('£2.50\n+ €0.50')).toEqual({ GBP: 250, EUR: 50 })
    expect(parseBalancePanel('€0.00')).toEqual({ EUR: 0 })
    expect(parseBalancePanel('?')).toEqual({})
  })
})

describe('redaction', () => {
  beforeEach(() => clearSecrets())

  it('removes nsecs, private keys, full codes, tokens, requests and claim fragments', () => {
    const sk = generateSecretKey()
    const nsec = nip19.nsecEncode(sk)
    const hex = bytesToHex(sk)
    registerSecret(nsec, hex)
    const text = [
      `nsec ${nsec}`, `hex ${hex}`, `other ${nip19.nsecEncode(generateSecretKey())}`,
      'code IMANI-ABCD-EFGH-JKLM', 'cashback CB-ABCDE-FG1', 'token cashuBeyJ0b2tlbiI6W3sibWludCI6Imh0dHBzOi8v',
      'req vreqAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'link https://w.example/g#abc.def', 'claim /c/xyz#k=SECRETKEY',
    ].join('\n')
    const out = redact(text)
    expect(out).not.toContain(nsec)
    expect(out).not.toContain(hex)
    expect(out).not.toMatch(/nsec1[02-9ac-hj-np-z]{20,}/)
    expect(out).not.toContain('IMANI-ABCD-EFGH-JKLM')
    expect(out).toContain('IMANI-AB…')
    expect(out).not.toContain('CB-ABCDE-FG1')
    expect(out).not.toContain('eyJ0b2tlbiI6W3sibWludCI6Imh0dHBzOi8v')
    expect(out).not.toContain('SECRETKEY')
    expect(out).not.toContain('abc.def')
    expect(out).not.toMatch(/[0-9a-f]{64}/)
  })

  it('redacts deep, keys included', () => {
    const hex = bytesToHex(generateSecretKey())
    expect(JSON.stringify(redactDeep({ [hex]: [{ x: hex }] }))).not.toContain(hex)
  })
})

/** A run that used corda and bart, with their real-shaped keys, must report neither key. */
describe('report hygiene with real-stall personas', () => {
  beforeEach(() => clearSecrets())

  it('contains no nsec, no 64-hex private key, no full code or token', () => {
    const keys = [generateSecretKey(), generateSecretKey()]
    const nsecs = keys.map((k) => nip19.nsecEncode(k))
    const hexes = keys.map((k) => bytesToHex(k))
    // The loader registers the keys with the redactor as it decodes them. Prefix checks are
    // exercised in the keys tests; here the prefixes are taken from the keys themselves.
    const prefixes = keys.map((k) => getPublicKey(k).slice(0, 8))
    keys.forEach((_, i) => registerSecret(nsecs[i]!, hexes[i]!))
    expect(prefixes).toHaveLength(2)

    const t0 = Date.parse('2026-11-07T10:00:00Z')
    const leak = `${nsecs[0]} ${hexes[1]} IMANI-WXYZ-1234-5678 cashuAeyJ0b2tlbiI6W3sibWludCI6aGVsbG8 /g#key.fragment`
    const attempts: Attempt[] = [
      { journey: 'arrive', persona: 'corda', outcome: 'ok', startedAt: t0, endedAt: t0 + 4000, visibleMs: 4000 },
      { journey: 'buy', persona: 'cust0001', outcome: 'ok', startedAt: t0 + 60_000, endedAt: t0 + 70_000, visibleMs: 9000 },
      { journey: 'online', persona: 'cust0001', outcome: 'fail', startedAt: t0 + 80_000, endedAt: t0 + 90_000, detail: `screen: ${leak}` },
      { journey: 'card', persona: 'cust0002', outcome: 'skip', startedAt: t0, endedAt: t0, detail: `reason ${leak}` },
    ]
    const population: Population = { customers: 3, browserCustomers: 3, k6Customers: 0, stalls: 2, stallNames: ['0:corda', '1:bart'], mode: 'smoke', day: '5m', seed: 1, base: 'https://w' }
    const result = buildResult({
      population, startedAt: new Date(t0).toISOString(), durationS: 100, conservation: null, k6: null,
      rateLimitProbe: 'ok', limits: ['register: 8/min'], notes: [`note ${leak}`], attempts,
      pageErrors: [`err ${hexes[0]}`], unsavedReceives: [], startMs: t0,
    })
    const md = renderMarkdown(result)
    const json = JSON.stringify(result)
    for (const out of [md, json]) {
      for (const s of [...nsecs, ...hexes]) expect(out).not.toContain(s)
      expect(out).not.toMatch(/nsec1[02-9ac-hj-np-z]{20,}/)
      expect(out).not.toMatch(/[0-9a-f]{64}/)
      expect(out).not.toContain('IMANI-WXYZ-1234-5678')
      expect(out).not.toContain('key.fragment')
    }
    expect(md).toContain('3 customers + 2 stalls (0:corda, 1:bart)')
    expect(md).toContain('3 customers and 2 stalls in the real app')
  })
})

describe('report', () => {
  const t0 = 1_000_000
  const at = (journey: Attempt['journey'], outcome: Attempt['outcome'], ms: number, offsetS = 0): Attempt => ({ journey, persona: 'p', outcome, startedAt: t0 + offsetS * 1000, endedAt: t0 + offsetS * 1000 + ms, visibleMs: outcome === 'ok' ? ms : undefined })

  it('computes percentiles, success, and keeps 429s and pacing apart', () => {
    expect(percentile([], 50)).toBeNull()
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10)
    const s = journeyStats([at('buy', 'ok', 1000), at('buy', 'ok', 3000), at('buy', 'rate-limited', 0), at('buy', 'pacing', 0), at('card', 'skip', 0)])
    const buy = s.find((x) => x.journey === 'buy')!
    expect(buy).toMatchObject({ ok: 2, rateLimited: 1, pacing: 1, p50: 1000 })
    expect(buy.successRate).toBeCloseTo(2 / 3)
    expect(s.find((x) => x.journey === 'card')!.successRate).toBeNull()
  })

  it('gates: 95% success, p95 bounds, pacing, conservation', () => {
    const many = Array.from({ length: 20 }, (_, i) => at('buy', 'ok', 5000 + i))
    const pass = buildResult({ population: {} as Population, startedAt: '', durationS: 0, conservation: null, k6: null, rateLimitProbe: '', limits: [], notes: [], attempts: many, pageErrors: [], unsavedReceives: [], startMs: t0 })
    expect(pass.pass).toBe(true)
    const slow = buildResult({ population: {} as Population, startedAt: '', durationS: 0, conservation: null, k6: null, rateLimitProbe: '', limits: [], notes: [], attempts: [...many, at('buy', 'ok', 25_000), at('buy', 'ok', 25_000)], pageErrors: [], unsavedReceives: [], startMs: t0 })
    expect(slow.gates.find((g) => g.name === 'buy p95 < 20s')!.ok).toBe(false)
    const paced = buildResult({ population: {} as Population, startedAt: '', durationS: 0, conservation: null, k6: null, rateLimitProbe: '', limits: [], notes: [], attempts: [...many, at('arrive', 'pacing', 0)], pageErrors: [], unsavedReceives: [], startMs: t0 })
    expect(paced.pass).toBe(false)
    expect(paced.gates.find((g) => g.name.startsWith('harness paced'))!.detail).toMatch(/harness pacing failure, not an app failure/)
  })

  it('builds a per-minute timeline and a dated name', () => {
    const tl = timeline([at('buy', 'ok', 1000, 0), at('pay', 'fail', 1000, 61), at('send', 'ok', 1000, 125)], t0)
    expect(tl).toEqual([
      { minute: 0, started: 1, completed: 1, failed: 0 },
      { minute: 1, started: 1, completed: 0, failed: 1 },
      { minute: 2, started: 1, completed: 1, failed: 0 },
    ])
    const pop: Population = { customers: 100, browserCustomers: 30, k6Customers: 70, stalls: 10, stallNames: [], mode: 'full', day: '20m', seed: 1, base: '' }
    expect(resultName(new Date('2026-11-07T10:00:00Z'), pop)).toBe('2026-11-07-real-day-100c10s')
  })

  it('reads k6 gates from its summary', () => {
    const s = summariseK6({ metrics: { sale_delivered: { values: { rate: 0.9 }, thresholds: { 'rate>0.95': { ok: false } } }, coupons_acquired: { values: { count: 7 } } } }, 99)
    expect(s).toMatchObject({ saleDelivered: 0.9, thresholdsCrossed: ['sale_delivered'], counters: { coupons_acquired: 7 } })
  })
})

describe('merchant keys file', () => {
  beforeEach(() => clearSecrets())

  it('parses KEY=value lines without sourcing', () => {
    expect(parseEnvFile('# c\nexport A=1\nB = "two"\n\nC=\'3\'\nnot a line')).toEqual({ A: '1', B: 'two', C: '3' })
  })

  it('refuses a key whose pubkey has the wrong prefix, without echoing the key', () => {
    const nsec = nip19.nsecEncode(generateSecretKey())
    let err: unknown
    try {
      decodeRealStalls({ CORDA_NSEC: nsec, BART_NSEC: nsec })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(KeyFileError)
    expect(String(err)).toMatch(/CORDA_NSEC decodes to a pubkey starting [0-9a-f]{8}, expected 1c4be7be/)
    expect(String(err)).not.toContain(nsec)
    // and the key was registered with the redactor before the check failed
    expect(redact(nsec)).toBe('[REDACTED]')
  })

  it('refuses a missing or malformed key by name', () => {
    expect(() => decodeRealStalls({})).toThrow(/CORDA_NSEC is missing/)
    expect(() => decodeRealStalls({ CORDA_NSEC: 'nsec1nope' })).toThrow(/CORDA_NSEC is not a valid nsec/)
  })
})

describe('pacing', () => {
  it('hands out slots no faster than the rate', async () => {
    let now = 0
    const waits: number[] = []
    const b = tokenBucket('register', 8, () => now, async (ms) => { now += ms })
    for (let i = 0; i < 10; i++) waits.push(await b.take())
    // 10 registrations at 8/min: the 10th starts 9 * 7.5s after the first.
    expect(now).toBe(9 * 7500)
    expect(waits[0]).toBe(0)
  })

  it('classifies 429s from the un-lifted limiters', () => {
    expect(classify429('/api/v1/nip05')).toBe('register')
    expect(classify429('/api/v1/accounts/register')).toBe('register')
    expect(classify429('/v1/checkout-codes/IMANI-X/redeem')).toBe('codes')
    expect(classify429('/api/v1/portal/cashback/by-code/CB-1')).toBe('claims')
    expect(classify429('/api/v1/wallet/receive')).toBeNull()
  })
})
