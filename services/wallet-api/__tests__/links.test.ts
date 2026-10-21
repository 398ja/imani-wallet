import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure'
import { bytesToHex } from '@noble/hashes/utils'
import { hashToCurve } from '@cashu/crypto/modules/common'

import {
  KEY_REFUSAL,
  MAX_LINKS,
  hashToCurveHex,
  keyLikeField,
  linkStatus,
  linksMintUrl,
  parseLinksStatusRequest,
} from '../links.js'
import { server, setMintFetch, resetMintFetch } from '../server.js'
import { buildVoucherToken } from '../../../src/lib/__tests__/voucherFixtures.js'
import { tokenProofs } from '../../../src/lib/voucherToken.js'

/**
 * `POST /v1/links/status` (#295 phase 0): NUT-07 over the caller's own link records, with no key
 * held or sent. Mostly negatives: every refusal below is a request that would have put a spending
 * key, or a link's secret, in front of a service whose whole safety argument is that it never sees
 * one (ADR 0001, 0002).
 */

const MINT = 'http://mint.test'
const NOW = 1_850_000_000
const Y1 = hashToCurveHex('["VOUCHER","aa","n1",[]]')
const Y2 = hashToCurveHex('["VOUCHER","aa","n2",[]]')

const parse = (body: unknown) => parseLinksStatusRequest(body, MINT, NOW)

describe('the Y points', () => {
  it('match the wallet’s own hash_to_curve, byte for byte', () => {
    for (const secret of ['a', '["VOUCHER","00","n",[]]', 'x'.repeat(500)]) {
      expect(hashToCurveHex(secret)).toBe(hashToCurve(new TextEncoder().encode(secret)).toHex(true))
    }
  })
})

describe('refusing anything that looks like a key', () => {
  const sk = bytesToHex(generateSecretKey())
  const linkSecret = 'A'.repeat(43)

  it.each([
    ['a raw 64-hex private key in ys', { links: [{ x: NOW, ys: [sk] }] }, 'links[0].ys[0]'],
    ['an nsec', { links: [{ x: NOW, ys: ['nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqq'] }] }, 'links[0].ys[0]'],
    ['a Cashlink secret as the id', { links: [{ id: linkSecret, x: NOW, ys: [Y1] }] }, 'links[0].id'],
    ['a field named k', { links: [{ k: 'whatever', x: NOW, ys: [Y1] }] }, 'links[0].k'],
    ['a field named secret', { links: [{ secret: 'whatever', x: NOW, ys: [Y1] }] }, 'links[0].secret'],
    ['a field named privkey at the top', { privkey: 'x', links: [{ x: NOW, ys: [Y1] }] }, 'privkey'],
    ['a field named nsec', { nsec: 'x', links: [] }, 'nsec'],
    ['a link URL carrying k=', { links: [{ id: 'a', x: NOW, ys: [Y1], tokens: ['https://w/g#v=1&k=abc&x=1'] }] }, 'links[0].tokens[0]'],
    ['a key hidden deep in an unknown field', { links: [{ x: NOW, ys: [Y1], extra: { deeper: [sk] } }] }, 'links[0].extra.deeper[0]'],
  ])('refuses %s, by field, without echoing it', (_name, body, field) => {
    const r = parse(body)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.field).toBe(field)
      expect(r.error.detail).toBe(KEY_REFUSAL)
      expect(JSON.stringify(r.error)).not.toContain(sk)
      expect(JSON.stringify(r.error)).not.toContain(linkSecret)
    }
  })

  it('does not mistake a Y point (33 bytes) for a key (32 bytes)', () => {
    expect(keyLikeField({ links: [{ x: NOW, ys: [Y1, Y2] }] })).toBeNull()
  })
})

describe('reading the request', () => {
  it('accepts Y points, defaulting kind to customer and id to the position', () => {
    const r = parse({ links: [{ x: NOW + 60, ys: [Y1, Y2] }] })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.links).toEqual([{ id: '0', kind: 'customer', x: NOW + 60, ys: [Y1, Y2] }])
  })

  it.each([
    ['no links', {}, 'links'],
    ['empty links', { links: [] }, 'links'],
    ['too many links', { links: Array.from({ length: MAX_LINKS + 1 }, () => ({ x: NOW, ys: [Y1] })) }, 'links'],
    ['x in milliseconds', { links: [{ x: NOW * 1000, ys: [Y1] }] }, 'links[0].x'],
    ['no x', { links: [{ ys: [Y1] }] }, 'links[0].x'],
    ['no proofs', { links: [{ x: NOW }] }, 'links[0].ys'],
    ['a Y that is not a point', { links: [{ x: NOW, ys: ['02' + 'f'.repeat(64)] }] }, 'links[0].ys[0]'],
    ['a bad kind', { links: [{ x: NOW, kind: 'stall', ys: [Y1] }] }, 'links[0].kind'],
    ['an unknown field', { links: [{ x: NOW, ys: [Y1], mint: 'http://evil' }] }, 'links[0].mint'],
    ['a caller-named mint', { mint: 'http://evil', links: [{ x: NOW, ys: [Y1] }] }, 'mint'],
  ])('refuses %s, naming the field', (_name, body, field) => {
    const r = parse(body)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.field).toBe(field)
  })

  it('ignores a caller clock unless test seams are on', () => {
    const r = parse({ now: 1, links: [{ x: NOW, ys: [Y1] }] })
    expect(r.ok && r.value.now).toBe(NOW)
  })

  it('takes the coupons themselves, turning each proof into its Y and keeping nothing else', () => {
    const coupon = buildVoucherToken({}, [8, 2])
    const r = parse({ links: [{ id: 'g', x: NOW, tokens: [coupon.token] }] })
    expect(r.ok).toBe(true)
    if (r.ok) {
      const expected = tokenProofs(coupon.token).map((p) => hashToCurve(new TextEncoder().encode(p.secret)).toHex(true))
      expect(r.value.links[0].ys).toEqual(expected)
      expect(JSON.stringify(r.value)).not.toContain('cashuB')
    }
  })

  it('refuses a coupon from a mint this service does not check', () => {
    const coupon = buildVoucherToken({}, [8])
    const r = parseLinksStatusRequest({ links: [{ x: NOW, tokens: [coupon.token] }] }, 'https://other.mint', NOW)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.field).toBe('links[0].tokens[0]')
  })
})

describe('the answer per link', () => {
  const states = (m: Record<string, 'SPENT' | 'UNSPENT' | 'PENDING'>) => new Map(Object.entries(m))
  const link = { id: 'a', kind: 'customer' as const, x: NOW, ys: [Y1, Y2] }

  it('claimed when every proof is spent', () => {
    expect(linkStatus(link, states({ [Y1]: 'SPENT', [Y2]: 'SPENT' }), NOW - 10).status).toBe('claimed')
  })
  it('outstanding before x while any proof is unspent', () => {
    expect(linkStatus(link, states({ [Y1]: 'UNSPENT', [Y2]: 'SPENT' }), NOW - 10).status).toBe('outstanding')
  })
  it('expired_unreturned at or after x, for a customer link, which comes back', () => {
    const a = linkStatus(link, states({ [Y1]: 'UNSPENT', [Y2]: 'UNSPENT' }), NOW)
    expect(a).toMatchObject({ status: 'expired_unreturned', comesBack: true, kind: 'customer' })
  })
  it('expired, for a stall’s Cashlink, which does not come back', () => {
    const a = linkStatus({ ...link, kind: 'merchant' }, states({ [Y1]: 'UNSPENT', [Y2]: 'UNSPENT' }), NOW + 1)
    expect(a).toMatchObject({ status: 'expired', comesBack: false, kind: 'merchant' })
  })
  it('unknown when the mint did not answer for a proof, pending when one is in flight', () => {
    expect(linkStatus(link, states({ [Y1]: 'UNSPENT' }), NOW - 10).status).toBe('unknown')
    expect(linkStatus(link, states({ [Y1]: 'UNSPENT', [Y2]: 'PENDING' }), NOW - 10).status).toBe('pending')
  })
})

describe('the mint URL', () => {
  it('has no default and refuses a non-http value', () => {
    expect(linksMintUrl({})).toBeNull()
    expect(linksMintUrl({ WALLET_API_MINT_URL: 'file:///etc/passwd' })).toBeNull()
    expect(linksMintUrl({ WALLET_API_MINT_URL: 'https://mint.example/' })).toBe('https://mint.example')
  })
})

// ─── Over HTTP, signed, with the mint faked at its transport ────────────────

const ORIGIN = 'http://127.0.0.1'
;(globalThis as { window?: unknown }).window = { location: { origin: ORIGIN } }
const { nip98Header } = await import('../../../src/lib/nip98.js')

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = (server.address() as { port: number }).port
const base = `http://127.0.0.1:${port}`
;(globalThis as { window?: unknown }).window = { location: { origin: base } }
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

function signer() {
  const secret = generateSecretKey()
  return { pubkey: getPublicKey(secret), signer: { signEvent: async (t: never) => finalizeEvent(t, secret) } }
}

async function post(body: unknown) {
  const raw = JSON.stringify(body)
  const { signer: s } = signer()
  return fetch(`${base}/v1/links/status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: await nip98Header('/v1/links/status', 'POST', raw, s) },
    body: raw,
  })
}

describe('POST /v1/links/status', () => {
  let asked: Array<{ url: string; body: string }> = []
  beforeEach(() => {
    process.env.WALLET_API_MINT_URL = MINT
    asked = []
    setMintFetch(async (url, init) => {
      asked.push({ url: String(url), body: String(init?.body) })
      const { Ys } = JSON.parse(String(init?.body)) as { Ys: string[] }
      return Response.json({ states: Ys.map((Y) => ({ Y, state: Y === Y1 ? 'SPENT' : 'UNSPENT' })) })
    })
  })
  afterEach(() => {
    delete process.env.WALLET_API_MINT_URL
    resetMintFetch()
  })

  it('refuses without a NIP-98 signature', async () => {
    const res = await fetch(`${base}/v1/links/status`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(401)
    expect(asked).toHaveLength(0)
  })

  it('answers per link from one checkstate at the configured mint, sending only Ys', async () => {
    const res = await post({
      links: [
        { id: 'gift-1', x: 1, ys: [Y1] },
        { id: 'gift-2', x: 1, ys: [Y2] },
        { id: 'stall-1', kind: 'merchant', x: 1, ys: [Y2] },
        { id: 'later', x: 4_000_000_000, ys: [Y2] },
      ],
    })
    expect(res.status).toBe(200)
    const out = (await res.json()) as { links: Array<{ id: string; status: string; comesBack: boolean }> }
    expect(out.links.map((l) => [l.id, l.status, l.comesBack])).toEqual([
      ['gift-1', 'claimed', true],
      ['gift-2', 'expired_unreturned', true],
      ['stall-1', 'expired', false],
      ['later', 'outstanding', true],
    ])
    expect(asked).toHaveLength(1)
    expect(asked[0].url).toBe(`${MINT}/v1/checkstate`)
    expect(JSON.parse(asked[0].body)).toEqual({ Ys: [Y1, Y2] })
  })

  it('refuses a key with 400 and never asks the mint', async () => {
    const res = await post({ links: [{ x: 1, ys: [bytesToHex(generateSecretKey())] }] })
    expect(res.status).toBe(400)
    const out = (await res.json()) as { error: string; field: string }
    expect(out).toMatchObject({ error: 'invalid-request', field: 'links[0].ys[0]' })
    expect(asked).toHaveLength(0)
  })

  it('says 502 when the mint does not answer, and 503 when no mint is configured', async () => {
    setMintFetch(async () => new Response('down', { status: 500 }))
    expect((await post({ links: [{ x: 1, ys: [Y1] }] })).status).toBe(502)
    delete process.env.WALLET_API_MINT_URL
    expect((await post({ links: [{ x: 1, ys: [Y1] }] })).status).toBe(503)
  })
})
