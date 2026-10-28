import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure'
import { bytesToHex } from '@noble/hashes/utils'
import { schnorr } from '@noble/curves/secp256k1.js'

import { limitsFor, parseBusinessSenders, LinkLimitsConfigError } from '@imani/wallet-core'

import { hashToCurveHex } from '../links.js'
import { businessSendersFrom, couponVerdict, latestX, linksPlan, parseLinksPlanRequest, windowProblem, MAX_PLAN_COUPONS } from '../linkPlan.js'
import { server, setMintFetch, resetMintFetch, setBusinessSenders, loadBusinessSenders } from '../server.js'
import { buildLockedCredentialToken, buildVoucherToken } from '../../../src/lib/__tests__/voucherFixtures.js'
import { lockWindowProblem } from '../../../src/lib/cashlinkLock.js'
import { tokenProofs } from '../../../src/lib/voucherToken.js'

/**
 * #366: Cashlinks for automated senders, wallet-api's half. Read-only and keyless, like
 * `/v1/links/status`: limits per account type, a plan before sending, the lock window, and the same
 * refusal of anything shaped like a key.
 */

const MINT = 'http://mint.test'
const NOW = 1_800_000_000
const DAY = 86_400
const Y1 = hashToCurveHex('["VOUCHER","aa","n1",[]]')
const Y2 = hashToCurveHex('["VOUCHER","aa","n2",[]]')
const Y3 = hashToCurveHex('["VOUCHER","aa","n3",[]]')

const parse = (body: unknown) => parseLinksPlanRequest(body, MINT, NOW)

describe('the lock window matches the wallet’s, number for number', () => {
  it.each([
    [NOW + 3600, undefined],
    [NOW + 3600 + 301, undefined],
    [NOW + 30 * DAY, undefined],
    [NOW + 30 * DAY + 1, undefined],
    [NOW + 5 * DAY, NOW + 6 * DAY],
    [NOW + 5 * DAY, NOW + 6 * DAY + 301],
    [NOW + 5 * DAY, NOW + 10 * DAY],
  ])('x=%i, coupon expires %s', (x, expires) => {
    expect(windowProblem(x, expires, NOW)).toBe(lockWindowProblem(x, expires, NOW))
  })

  it('latestX is the furthest x the gateway would accept, or null', () => {
    expect(latestX(undefined, NOW)).toBe(NOW + 30 * DAY)
    expect(latestX(NOW + 10 * DAY, NOW)).toBe(NOW + 9 * DAY - 300)
    expect(windowProblem(latestX(NOW + 10 * DAY, NOW)!, NOW + 10 * DAY, NOW)).toBeNull()
    expect(latestX(NOW + DAY, NOW)).toBeNull()
  })
})

describe('couponVerdict', () => {
  const x = NOW + 7 * DAY
  it('names every reason a link with this coupon could not come back on its own', () => {
    const { token } = buildVoucherToken({ expiresAt: NOW + 3 * DAY })
    const v = couponVerdict(token, 0, x, NOW, 'ee'.repeat(32))
    expect(v.armable).toBe(false)
    // Test fixtures carry no DLEQ (real minted coupons do), and expire too soon for this x.
    expect(v.blockers).toEqual(['no_amount_proof', 'too_close_to_expiry'])
    expect(v).toMatchObject({ unit: 'GBP', faceValue: 1000, expiresAt: NOW + 3 * DAY })
  })
  it('a forged coupon, a locked one and the sender’s own stall', () => {
    const forged = buildVoucherToken({}, [1000], { faceValue: 99999 }).token
    expect(couponVerdict(forged, 0, x, NOW, 'ee'.repeat(32)).blockers).toContain('unverified')
    const locked = buildLockedCredentialToken({ stallKey: schnorr.utils.randomSecretKey(), devicePubkey: 'ab'.repeat(32) })
    expect(couponVerdict(locked, 0, x, NOW, 'ee'.repeat(32)).blockers).toContain('not_a_bearer_voucher')
    const own = buildVoucherToken()
    expect(couponVerdict(own.token, 0, x, NOW, own.voucher.issuerPublicKey).blockers).toContain('own_stall')
    expect(couponVerdict('cashuBgarbage', 0, x, NOW, 'ee'.repeat(32)).blockers).toEqual(['not_a_bearer_voucher'])
  })
})

describe('parseLinksPlanRequest', () => {
  it('refuses anything shaped like a key, anywhere, before reading the rest', () => {
    const sk = bytesToHex(generateSecretKey())
    for (const [body, field] of [
      [{ links: [{ x: NOW, ys: [sk] }] }, 'links[0].ys[0]'],
      [{ coupons: [], k: 'x' }, 'k'],
      [{ links: [{ id: 'A'.repeat(43), x: NOW, ys: [Y1] }] }, 'links[0].id'],
      [{ refundSecret: 'x' }, 'refundSecret'],
    ] as const) {
      const r = parse(body)
      expect(r.ok, JSON.stringify(field)).toBe(false)
      if (!r.ok) {
        expect(r.error.field).toBe(field === 'refundSecret' ? 'refundSecret' : field)
        expect(JSON.stringify(r.error)).not.toContain(sk)
      }
    }
  })
  it('reads links, coupons, x and wanted; wanted defaults to the coupons, else 1', () => {
    const { token } = buildVoucherToken()
    const r = parse({ links: [{ id: 'a', x: NOW + DAY, ys: [Y1] }], coupons: [token, token], x: NOW + 7 * DAY })
    expect(r.ok && r.value).toMatchObject({ wanted: 2, x: NOW + 7 * DAY, coupons: [token, token] })
    expect(parse({}).ok && (parse({}) as { value: { wanted: number } }).value.wanted).toBe(1)
  })
  it('refuses malformed requests by field', () => {
    const { token } = buildVoucherToken()
    expect(parse({ coupons: [token] })).toMatchObject({ ok: false, error: { field: 'x' } })
    expect(parse({ coupons: [token], x: NOW * 1000 })).toMatchObject({ ok: false, error: { field: 'x' } })
    expect(parse({ coupons: [token], x: NOW + DAY, wanted: 3 })).toMatchObject({ ok: false, error: { field: 'wanted' } })
    expect(parse({ coupons: Array(MAX_PLAN_COUPONS + 1).fill(token), x: NOW + DAY })).toMatchObject({ ok: false, error: { field: 'coupons' } })
    expect(parse({ coupons: ['nope'], x: NOW + DAY })).toMatchObject({ ok: false, error: { field: 'coupons[0]' } })
    expect(parse({ links: [{ x: NOW }] })).toMatchObject({ ok: false, error: { field: 'links[0].ys' } })
    expect(parse({ links: [{ x: NOW, ys: [Y1], kind: 'merchant' }] })).toMatchObject({ ok: false, error: { field: 'links[0].kind' } })
    expect(parse({ wanted: 0 })).toMatchObject({ ok: false, error: { field: 'wanted' } })
    expect(parse({ extra: 1 })).toMatchObject({ ok: false, error: { field: 'extra' } })
  })
  it('turns a link’s coupons into Y points at the configured mint only', () => {
    const { token } = buildVoucherToken({}, [500])
    const r = parse({ links: [{ x: NOW, tokens: [token] }] })
    expect(r.ok && r.value.links[0].ys).toEqual([hashToCurveHex(tokenProofs(token)[0].secret)])
  })
})

describe('linksPlan', () => {
  const states = (map: Record<string, string>) =>
    (async (_url: unknown, init?: RequestInit) => {
      const { Ys } = JSON.parse(String(init?.body)) as { Ys: string[] }
      return Response.json({ states: Ys.map((Y) => ({ Y, state: map[Y] ?? 'UNSPENT' })) })
    }) as typeof fetch
  const individual = parseBusinessSenders('')
  const sender = 'ee'.repeat(32)

  it('counts the caller’s links from the mint: claimed frees a slot, unknown and pending never do', async () => {
    const input = {
      links: [
        { id: 'claimed', kind: 'customer' as const, x: NOW + DAY, ys: [Y1] },
        { id: 'open', kind: 'customer' as const, x: NOW + DAY, ys: [Y2] },
        { id: 'expired', kind: 'customer' as const, x: NOW - DAY, ys: [Y3] },
        { id: 'unknown', kind: 'customer' as const, x: NOW - DAY, ys: [hashToCurveHex('x')] },
      ],
      coupons: [],
      x: null,
      wanted: 1,
      now: NOW,
    }
    const out = await linksPlan(input, sender, individual, MINT, states({ [Y1]: 'SPENT', [hashToCurveHex('x')]: 'UNKNOWN' }))
    expect(out.counts).toEqual({ outstanding: 2, expiredUnreturned: 1, claimed: 1, unknown: 1 })
    expect(out.unknownLinks).toEqual(['unknown'])
    expect(out.allowance).toEqual({ ok: true, remaining: 7 })
    expect(out.limits.accountType).toBe('individual')
  })

  it('an employer listed as a business gets its own limit; a batch beyond it is refused before anything is sent', async () => {
    const business = parseBusinessSenders(JSON.stringify({ maxOutstanding: 50, pubkeys: [sender] }))
    const { token } = buildVoucherToken()
    const many = Array.from({ length: 45 }, (_, i) => ({ id: `l${i}`, kind: 'customer' as const, x: NOW + DAY, ys: [hashToCurveHex(`s${i}`)] }))
    const five = await linksPlan({ links: many, coupons: Array(5).fill(token), x: NOW + 2 * DAY, wanted: 5, now: NOW }, sender, business, MINT, states({}))
    expect(five.limits).toEqual(limitsFor('business', 50))
    expect(five.allowance).toEqual({ ok: true, remaining: 0 })
    const six = await linksPlan({ links: many, coupons: Array(6).fill(token), x: NOW + 2 * DAY, wanted: 6, now: NOW }, sender, business, MINT, states({}))
    expect(six.allowance).toEqual({ ok: false, reason: 'too_many_outstanding', limit: 50 })
    expect(six.coupons).toHaveLength(6)
  })

  it('asks the mint nothing when the caller has no links yet', async () => {
    let asked = 0
    const out = await linksPlan({ links: [], coupons: [], x: null, wanted: 1, now: NOW }, sender, individual, MINT, (async () => {
      asked++
      return Response.json({ states: [] })
    }) as typeof fetch)
    expect(asked).toBe(0)
    expect(out.allowance).toEqual({ ok: true, remaining: 9 })
  })
})

describe('business senders from the environment', () => {
  const list = JSON.stringify({ maxOutstanding: 200, pubkeys: ['ab'.repeat(32)] })
  it('inline or from a file, never both, and malformed refuses', () => {
    expect(businessSendersFrom({ WALLET_API_BUSINESS_SENDERS: list }, () => '').maxOutstanding).toBe(200)
    expect(businessSendersFrom({ WALLET_API_BUSINESS_SENDERS_FILE: '/x' }, () => list).pubkeys.has('ab'.repeat(32))).toBe(true)
    expect(() => businessSendersFrom({ WALLET_API_BUSINESS_SENDERS: list, WALLET_API_BUSINESS_SENDERS_FILE: '/x' }, () => list)).toThrow(/not both/)
    expect(() => businessSendersFrom({ WALLET_API_BUSINESS_SENDERS: '{' }, () => '')).toThrow(LinkLimitsConfigError)
    expect(businessSendersFrom({}, () => '').pubkeys.size).toBe(0)
  })
  it('the server refuses to start on a malformed list', () => {
    expect(() => loadBusinessSenders({ WALLET_API_BUSINESS_SENDERS: '{"pubkeys":["nope"]}' })).toThrow(LinkLimitsConfigError)
    loadBusinessSenders({})
  })
})

// ─── Over HTTP, signed ──────────────────────────────────────────────────────

;(globalThis as { window?: unknown }).window = { location: { origin: 'http://127.0.0.1' } }
const { nip98Header } = await import('../../../src/lib/nip98.js')
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
;(globalThis as { window?: unknown }).window = { location: { origin: base } }
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

const employerSecret = generateSecretKey()
const employer = getPublicKey(employerSecret)
const sign = { signEvent: async (t: never) => finalizeEvent(t, employerSecret) }

async function call(method: 'GET' | 'POST', path: string, body?: unknown) {
  const raw = body === undefined ? undefined : JSON.stringify(body)
  return fetch(`${base}${path}`, {
    method,
    headers: { ...(raw ? { 'content-type': 'application/json' } : {}), authorization: await nip98Header(path, method, raw, sign) },
    ...(raw ? { body: raw } : {}),
  })
}

describe('GET /v1/links/limits and POST /v1/links/plan', () => {
  let asked = 0
  beforeEach(() => {
    process.env.WALLET_API_MINT_URL = MINT
    asked = 0
    setMintFetch(async (_url, init) => {
      asked++
      const { Ys } = JSON.parse(String(init?.body)) as { Ys: string[] }
      return Response.json({ states: Ys.map((Y) => ({ Y, state: 'UNSPENT' })) })
    })
  })
  afterEach(() => {
    delete process.env.WALLET_API_MINT_URL
    resetMintFetch()
    setBusinessSenders(parseBusinessSenders(''))
  })

  it('both need a signature', async () => {
    expect((await fetch(`${base}/v1/links/limits`)).status).toBe(401)
    expect((await fetch(`${base}/v1/links/plan`, { method: 'POST', body: '{}' })).status).toBe(401)
  })

  it('limits are the signer’s: individual until the deployment lists them as a business', async () => {
    expect(await (await call('GET', '/v1/links/limits')).json()).toEqual({ pubkey: employer, limits: limitsFor('individual') })
    setBusinessSenders(parseBusinessSenders(JSON.stringify({ maxOutstanding: 300, pubkeys: [employer] })))
    expect(((await (await call('GET', '/v1/links/limits')).json()) as { limits: unknown }).limits).toEqual(limitsFor('business', 300))
  })

  it('plans a batch against the signer’s links, from one checkstate', async () => {
    setBusinessSenders(parseBusinessSenders(JSON.stringify({ maxOutstanding: 20, pubkeys: [employer] })))
    const { token } = buildVoucherToken({ expiresAt: Math.floor(Date.now() / 1000) + 60 * DAY })
    const res = await call('POST', '/v1/links/plan', {
      links: [{ id: 'a', x: 4_000_000_000, ys: [Y1] }, { id: 'b', x: 4_000_000_000, ys: [Y2] }],
      coupons: [token, token],
      x: Math.floor(Date.now() / 1000) + 7 * DAY,
    })
    expect(res.status).toBe(200)
    const out = (await res.json()) as { allowance: unknown; counts: unknown; coupons: Array<{ blockers: string[] }> }
    expect(out.counts).toMatchObject({ outstanding: 2 })
    expect(out.allowance).toEqual({ ok: true, remaining: 16 })
    expect(out.coupons.map((c) => c.blockers)).toEqual([['no_amount_proof'], ['no_amount_proof']])
    expect(asked).toBe(1)
  })

  it('refuses a key with 400 and never asks the mint; 502 when the mint is down; 503 when unconfigured', async () => {
    const r = await call('POST', '/v1/links/plan', { links: [{ x: 1, ys: [bytesToHex(generateSecretKey())] }] })
    expect(r.status).toBe(400)
    expect(asked).toBe(0)
    setMintFetch(async () => new Response('down', { status: 500 }))
    expect((await call('POST', '/v1/links/plan', { links: [{ x: 1, ys: [Y1] }] })).status).toBe(502)
    delete process.env.WALLET_API_MINT_URL
    expect((await call('POST', '/v1/links/plan', {})).status).toBe(503)
  })
})
