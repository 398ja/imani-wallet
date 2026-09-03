/**
 * Wallet API tests — over a real socket, signed by the real wallet signer.
 *
 * Two decisions carry this file.
 *
 * **Requests go through `server.listen` and `fetch`**, not by calling `route`
 * with fake objects, for the same reason the audit API tests do: header casing,
 * body streaming and status codes are exactly where the bugs are, and a mocked
 * `IncomingMessage` agrees with whatever the test author believed.
 *
 * **The signatures come from `src/lib/nip98.ts`** — the code the wallet
 * actually ships — rather than from an event built here. A verifier tested
 * against events its own test file constructed proves only that the file agrees
 * with itself; both halves could share a wrong idea of the tag names and every
 * test would pass while no real wallet could authenticate. Importing the
 * shipping signer means these tests fail if either side drifts.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'

import { server, metrics } from '../server.js'
import { verifyNip98 } from '../nip98.js'

// The signer is a browser module and reads `window.location.origin` to make the
// `u` tag absolute. Providing it is what lets the shipping signer run here.
const ORIGIN = 'http://127.0.0.1'
;(globalThis as { window?: unknown }).window = { location: { origin: ORIGIN } }

const { nip98Header } = await import('../../../src/lib/nip98.js')

/**
 * A real keypair, signing through nostr-tools' `finalizeEvent` — the exact
 * function every real signer in this project uses.
 *
 * Hand-rolling the id hash and schnorr signature here would be a second
 * implementation of event signing, and a verifier checked only against it would
 * prove the two agree rather than that either is correct.
 */
function makeSigner(secret = generateSecretKey()) {
  const pubkey = getPublicKey(secret)
  return {
    pubkey,
    // Exposed so a test can sign something OTHER than a NIP-98 header with the
    // same identity.
    secret,
    signer: {
      async signEvent(template: {
        kind: number
        created_at: number
        tags: string[][]
        content: string
      }) {
        return finalizeEvent(template, secret)
      },
    },
  }
}

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = (server.address() as { port: number }).port
const base = `http://127.0.0.1:${port}`
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

// The signer builds the `u` tag from `window.location.origin`, so the port has
// to be the real one for the URL binding to line up.
;(globalThis as { window?: unknown }).window = { location: { origin: base } }

describe('an authenticated request', () => {
  it('answers a request signed by the wallet with the signer’s pubkey', async () => {
    const { pubkey, signer } = makeSigner()
    const res = await fetch(`${base}/v1/whoami`, {
      headers: { authorization: await nip98Header('/v1/whoami', 'GET', undefined, signer) },
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ pubkey })
  })

  it('does not set a CORS wildcard, unlike the public audit API', async () => {
    const { signer } = makeSigner()
    const res = await fetch(`${base}/v1/whoami`, {
      headers: { authorization: await nip98Header('/v1/whoami', 'GET', undefined, signer) },
    })
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('distinguishes two callers by their keys alone', async () => {
    const a = makeSigner()
    const b = makeSigner()
    const call = async (s: typeof a) =>
      (await (
        await fetch(`${base}/v1/whoami`, {
          headers: { authorization: await nip98Header('/v1/whoami', 'GET', undefined, s.signer) },
        })
      ).json()) as { pubkey: string }

    expect((await call(a)).pubkey).toBe(a.pubkey)
    expect((await call(b)).pubkey).toBe(b.pubkey)
  })
})

describe('refusals', () => {
  it('refuses an unsigned request and names the scheme', async () => {
    const res = await fetch(`${base}/v1/whoami`)
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe('Nostr')
    expect((await res.json()).error).toBe('unsigned')
  })

  it('refuses a header that is not a signed event', async () => {
    const res = await fetch(`${base}/v1/whoami`, {
      headers: { authorization: 'Nostr not-base64-at-all!!' },
    })
    expect((await res.json()).error).toBe('malformed')
  })

  it('refuses a signature for a different path', async () => {
    const { signer } = makeSigner()
    const res = await fetch(`${base}/v1/whoami`, {
      // Signed for a route that exists, sent to another: without the URL check
      // any signed request could be replayed against any endpoint.
      headers: { authorization: await nip98Header('/v1/something-else', 'GET', undefined, signer) },
    })
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('url-mismatch')
  })

  /**
   * The query string is part of what was signed.
   *
   * Mutation testing found this untested: making `sameUrl` ignore the query
   * left every test green. It is the check that stops a signed request being
   * replayed against different arguments — the same path, the same method, a
   * valid signature, and a different meaning.
   */
  it('refuses a signature replayed against different query parameters', async () => {
    const { signer } = makeSigner()
    const res = await fetch(`${base}/v1/whoami?limit=1`, {
      headers: {
        authorization: await nip98Header('/v1/whoami?limit=1000', 'GET', undefined, signer),
      },
    })
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('url-mismatch')
  })

  it('accepts a signature whose query matches exactly', async () => {
    const { pubkey, signer } = makeSigner()
    const res = await fetch(`${base}/v1/whoami?limit=1`, {
      headers: {
        authorization: await nip98Header('/v1/whoami?limit=1', 'GET', undefined, signer),
      },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ pubkey })
  })

  it('refuses a GET signature replayed as a POST', async () => {
    const { signer } = makeSigner()
    const res = await fetch(`${base}/v1/whoami`, {
      method: 'POST',
      body: '{}',
      headers: { authorization: await nip98Header('/v1/whoami', 'GET', undefined, signer) },
    })
    expect((await res.json()).error).toBe('method-mismatch')
  })

  it('refuses a signature whose pubkey is not the one that signed', async () => {
    const { signer } = makeSigner()
    const other = makeSigner()
    const header = await nip98Header('/v1/whoami', 'GET', undefined, signer)
    const event = JSON.parse(Buffer.from(header.slice(6), 'base64').toString())
    // Claim someone else's identity while keeping the signature: the exact
    // forgery that a check of "is there a signature" rather than "does it
    // verify" would let through.
    event.pubkey = other.pubkey
    const res = await fetch(`${base}/v1/whoami`, {
      headers: {
        authorization: `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`,
      },
    })
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('bad-signature')
  })

  /**
   * Isolates the schnorr check.
   *
   * The forgery above swaps the pubkey, which also changes the derived event id
   * — so the id-integrity check refuses it and the signature is never verified.
   * Mutation testing caught that: replacing `schnorr.verify` with `true` kept
   * the whole suite green, meaning nothing here actually tested the signature.
   *
   * This swaps ONLY the signature, for one made by another key over the same
   * id. Every field stays self-consistent, the id still matches its contents,
   * and the sole thing wrong is that the signature is not this pubkey's.
   */
  it('refuses an event whose signature belongs to another key', async () => {
    const { signer } = makeSigner()
    const forger = makeSigner()
    const header = await nip98Header('/v1/whoami', 'GET', undefined, signer)
    const event = JSON.parse(Buffer.from(header.slice(6), 'base64').toString())
    const forged = await nip98Header('/v1/whoami', 'GET', undefined, forger.signer)
    event.sig = JSON.parse(Buffer.from(forged.slice(6), 'base64').toString()).sig

    const res = await fetch(`${base}/v1/whoami`, {
      headers: {
        authorization: `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`,
      },
    })
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('bad-signature')
  })

  /**
   * Isolates the event-id integrity check.
   *
   * Also found by mutation: disabling the id check broke nothing, because every
   * tampering the suite tried happened to break something else too.
   *
   * `content` is the field nothing else looks at. Changing it while keeping the
   * original id and signature leaves a request whose signature verifies
   * perfectly — it covers the id, and the id was not touched — while the event
   * it claims to sign is no longer the event being sent. Without the id check
   * this is accepted, which is the general form of "signed something else".
   */
  it('refuses an event edited after signing, even though its signature verifies', async () => {
    const { signer } = makeSigner()
    const header = await nip98Header('/v1/whoami', 'GET', undefined, signer)
    const event = JSON.parse(Buffer.from(header.slice(6), 'base64').toString())
    event.content = 'added after the signature was made'

    const res = await fetch(`${base}/v1/whoami`, {
      headers: {
        authorization: `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`,
      },
    })
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('bad-signature')
  })

  /**
   * A signature from another context is not an auth header.
   *
   * Mutation testing found the kind check untested. It matters because a nostr
   * key signs many things — notes, DMs, profile updates — and every one of
   * those is a valid signature by the right key. Without this, any event a user
   * ever published whose tags happened to line up could be presented here, and
   * a relay full of a user's signed events becomes a source of credentials.
   */
  it('refuses a validly signed event of the wrong kind', async () => {
    const { signer, secret } = makeSigner()
    const header = await nip98Header('/v1/whoami', 'GET', undefined, signer)
    const template = JSON.parse(Buffer.from(header.slice(6), 'base64').toString())
    // Re-signed as kind 1, so the event is entirely valid — correct id,
    // correct signature — and simply is not an HTTP auth event.
    const note = finalizeEvent(
      {
        kind: 1,
        created_at: template.created_at,
        tags: template.tags,
        content: template.content,
      },
      secret,
    )
    const res = await fetch(`${base}/v1/whoami`, {
      headers: {
        authorization: `Nostr ${Buffer.from(JSON.stringify(note)).toString('base64')}`,
      },
    })
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('malformed')
  })

  it('refuses a 404 to an unauthenticated caller as 401, not 404', async () => {
    // Route existence is not discoverable without a key.
    const res = await fetch(`${base}/v1/not-a-route`)
    expect(res.status).toBe(401)
  })

  it('404s a signed request to a route that does not exist', async () => {
    const { signer } = makeSigner()
    const res = await fetch(`${base}/v1/not-a-route`, {
      headers: { authorization: await nip98Header('/v1/not-a-route', 'GET', undefined, signer) },
    })
    expect(res.status).toBe(404)
  })

  it('counts refusals by reason', async () => {
    const before = metrics.refusals.unsigned ?? 0
    await fetch(`${base}/v1/whoami`)
    expect(metrics.refusals.unsigned).toBe(before + 1)
  })
})

describe('the health endpoint', () => {
  it('answers without a signature, because an orchestrator has no key', async () => {
    const res = await fetch(`${base}/health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })
})

/**
 * Freshness is checked against the verifier directly rather than over the wire,
 * because the only way to make a stale signature through `fetch` is to wait a
 * real minute.
 */
describe('freshness', () => {
  const signed = async () => {
    const { signer } = makeSigner()
    const header = await nip98Header('/v1/whoami', 'GET', undefined, signer)
    return { header, url: `${base}/v1/whoami` }
  }

  it('accepts a signature made now', async () => {
    const { header, url } = await signed()
    expect(verifyNip98({ header, url, method: 'GET' }).ok).toBe(true)
  })

  it('refuses one older than the window', async () => {
    const { header, url } = await signed()
    const result = verifyNip98({
      header,
      url,
      method: 'GET',
      now: Math.floor(Date.now() / 1000) + 61,
    })
    expect(result).toMatchObject({ ok: false, reason: 'stale' })
    // The detail has to point at the clock, because the fix is the clock.
    expect((result as { detail: string }).detail).toContain('clock')
  })

  it('refuses one from the future, not just the past', async () => {
    const { header, url } = await signed()
    const result = verifyNip98({
      header,
      url,
      method: 'GET',
      now: Math.floor(Date.now() / 1000) - 61,
    })
    expect(result).toMatchObject({ ok: false, reason: 'stale' })
    expect((result as { detail: string }).detail).toContain('future')
  })
})

describe('body binding', () => {
  it('accepts a POST whose body matches the payload hash', async () => {
    const { signer } = makeSigner()
    const payload = JSON.stringify({ hello: 'world' })
    const res = await fetch(`${base}/v1/whoami`, {
      method: 'POST',
      body: payload,
      headers: { authorization: await nip98Header('/v1/whoami', 'POST', payload, signer) },
    })
    // The route only answers GET, so a 404 here still proves the body check
    // passed: a payload mismatch would have been a 401 before routing.
    expect(res.status).toBe(404)
  })

  it('refuses a POST whose body was swapped after signing', async () => {
    const { signer } = makeSigner()
    const signedPayload = JSON.stringify({ amount: 1 })
    const res = await fetch(`${base}/v1/whoami`, {
      method: 'POST',
      body: JSON.stringify({ amount: 1000000 }),
      headers: { authorization: await nip98Header('/v1/whoami', 'POST', signedPayload, signer) },
    })
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('payload-mismatch')
  })

  it('refuses a body sent under a signature that covered no body', async () => {
    const { signer } = makeSigner()
    const res = await fetch(`${base}/v1/whoami`, {
      method: 'POST',
      body: JSON.stringify({ amount: 1000000 }),
      headers: { authorization: await nip98Header('/v1/whoami', 'POST', undefined, signer) },
    })
    expect((await res.json()).error).toBe('payload-mismatch')
  })
})

/**
 * Valuing a holding, over HTTP.
 *
 * The grouping rules themselves are tested as pure functions in
 * `@imani/wallet-core`, where they belong and where they need no server. What
 * is tested here is what only HTTP can show: that a caller's coupons survive
 * the wire intact, that a malformed body is refused by field, and that the
 * request has to be signed like any other.
 */
describe('valuing a holding', () => {
  const STALL_A = 'a'.repeat(64)
  const STALL_B = 'b'.repeat(64)

  const coupon = (over: Record<string, unknown> = {}) => ({
    voucher_id: 'c1',
    token: 'cashuBo...',
    face_value: 1000,
    face_unit: 'EUR',
    face_decimals: 2,
    token_amount: 500,
    issuer_id: STALL_A,
    status: 'active',
    ...over,
  })

  /** A signed POST, since every request here needs one. */
  async function value(payload: unknown, signer?: { signEvent: (t: never) => Promise<never> }) {
    const s = signer ?? makeSigner().signer
    const body = JSON.stringify(payload)
    const res = await fetch(`${base}/v1/holding/value`, {
      method: 'POST',
      body,
      headers: {
        authorization: await nip98Header('/v1/holding/value', 'POST', body, s as never),
        'content-type': 'application/json',
      },
    })
    return { status: res.status, body: (await res.json()) as Record<string, never> }
  }

  it('answers with value grouped by stall and currency', async () => {
    const res = await value({
      coupons: [coupon({ voucher_id: '1' }), coupon({ voucher_id: '2', face_value: 250 })],
    })

    expect(res.status).toBe(200)
    expect(res.body.groups).toHaveLength(1)
    expect(res.body.groups[0]).toMatchObject({
      stallId: STALL_A,
      currency: 'EUR',
      faceValue: 1250,
      couponCount: 2,
    })
  })

  it('never sums two stalls together', async () => {
    const res = await value({
      coupons: [coupon({ issuer_id: STALL_A }), coupon({ issuer_id: STALL_B })],
    })
    expect(res.body.groups).toHaveLength(2)
  })

  it('never sums two currencies from one stall together', async () => {
    const res = await value({
      coupons: [coupon({ face_unit: 'EUR' }), coupon({ face_unit: 'XAF', face_decimals: 0 })],
    })
    expect(res.body.groups).toHaveLength(2)
  })

  it('reports unspendable coupons rather than counting or dropping them', async () => {
    const res = await value({
      coupons: [
        coupon({ voucher_id: 'live' }),
        coupon({ voucher_id: 'gone', status: 'spent' }),
        coupon({ voucher_id: 'lapsed', expires_at: '2020-01-01T00:00:00Z' }),
      ],
    })

    expect(res.body.groups).toHaveLength(1)
    expect(res.body.unusable).toEqual([
      { couponId: 'gone', reason: 'spent' },
      { couponId: 'lapsed', reason: 'expired' },
    ])
    // Every coupon supplied is accounted for, which is what a reconciler needs.
    expect(res.body.couponCount).toBe(3)
  })

  it('treats an empty holding as a valid request with an empty answer', async () => {
    const res = await value({ coupons: [] })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ groups: [], unusable: [], couponCount: 0 })
  })

  describe('malformed holdings name the field at fault', () => {
    it('names a coupon field of the wrong type, with its index', async () => {
      const res = await value({ coupons: [coupon(), coupon({ face_value: '1000' })] })
      expect(res.status).toBe(400)
      expect(res.body.field).toBe('coupons[1].face_value')
      expect(res.body.detail).toContain('number')
    })

    it('names a missing required field', async () => {
      const holding = coupon() as Record<string, unknown>
      delete holding.token
      const res = await value({ coupons: [holding] })
      expect(res.body.field).toBe('coupons[0].token')
      expect(res.body.detail).toContain('required')
    })

    it('names a coupon that is not an object at all', async () => {
      const res = await value({ coupons: [coupon(), null] })
      expect(res.body.field).toBe('coupons[1]')
      expect(res.body.detail).toContain('null')
    })

    /**
     * Asserts the DETAIL, not just the field. Mutation testing found that
     * removing the missing-field check entirely still produced
     * `field: 'coupons'` — the array check caught it and said "expected an
     * array, got undefined". Distinguishing "you left it out" from "you sent
     * the wrong type" is the whole point of naming a field.
     */
    it('names a missing coupons array as missing, not as the wrong type', async () => {
      const res = await value({})
      expect(res.body.field).toBe('coupons')
      expect(res.body.detail).toContain('required')
    })

    /**
     * A string has a `length` and indexes like an array, so without the array
     * check the loop iterates its CHARACTERS and blames `coupons[0]` for not
     * being an object. The caller's actual mistake is one level up.
     */
    it('blames the coupons field itself when it is a string, not its characters', async () => {
      const res = await value({ coupons: 'not-an-array' })
      expect(res.body.field).toBe('coupons')
      expect(res.body.detail).toContain('array')
    })

    it('names the body when it is not an object', async () => {
      const res = await value([coupon()])
      expect(res.body.field).toBe('body')
    })

    /**
     * `typeof NaN === 'number'`, so a NaN face value passes a naive type check
     * and then poisons every sum it touches — a group total of `null` once
     * serialised, which reads as "no value" rather than "bad input".
     */
    /**
     * Infinity is reachable over the wire, but only as raw text.
     *
     * `JSON.stringify(Infinity)` is `null`, so a JS caller cannot send one by
     * accident — my first attempt at this test built the body with
     * `stringify` and asserted a 400 that could never come. The literal
     * `1e999` IS valid JSON and parses to Infinity, which is `typeof
     * 'number'`, passes a naive type check, and serialises back out as `null`.
     * A caller would read that group as worth nothing.
     *
     * So the body is written by hand, because that is the only way this
     * reaches the parser at all.
     */
    it('refuses a non-finite face value rather than answering with a null total', async () => {
      const raw = `{"coupons":[{"token":"t","face_value":1e999,"issuer_id":"${STALL_A}"}]}`
      const res = await fetch(`${base}/v1/holding/value`, {
        method: 'POST',
        body: raw,
        headers: {
          authorization: await nip98Header(
            '/v1/holding/value',
            'POST',
            raw,
            makeSigner().signer as never,
          ),
        },
      })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.field).toBe('coupons[0].face_value')
      expect(body.detail).toContain('finite')
    })

    it('refuses a non-finite token amount for the same reason', async () => {
      const raw = `{"coupons":[{"token":"t","face_value":10,"token_amount":1e999,"issuer_id":"${STALL_A}"}]}`
      const res = await fetch(`${base}/v1/holding/value`, {
        method: 'POST',
        body: raw,
        headers: {
          authorization: await nip98Header(
            '/v1/holding/value',
            'POST',
            raw,
            makeSigner().signer as never,
          ),
        },
      })
      expect(res.status).toBe(400)
      expect((await res.json()).field).toBe('coupons[0].token_amount')
    })

    it('refuses a body that is not JSON, without a stack trace', async () => {
      const body = '{not json'
      const res = await fetch(`${base}/v1/holding/value`, {
        method: 'POST',
        body,
        headers: {
          authorization: await nip98Header(
            '/v1/holding/value',
            'POST',
            body,
            makeSigner().signer as never,
          ),
        },
      })
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe('invalid-json')
    })
  })

  /**
   * `expires_at` is TYPED as a string and WRITTEN as a number by the redemption
   * path. Refusing the numeric form would refuse coupons the wallet itself
   * produced, so the endpoint has to accept what the wallet actually writes.
   */
  it('accepts the numeric expiry the wallet actually writes', async () => {
    const res = await value({
      coupons: [coupon({ expires_at: Math.floor(Date.parse('2020-01-01') / 1000) })],
    })
    expect(res.status).toBe(200)
    expect(res.body.unusable[0]).toMatchObject({ reason: 'expired' })
  })

  it('requires a signature like every other route', async () => {
    const res = await fetch(`${base}/v1/holding/value`, {
      method: 'POST',
      body: JSON.stringify({ coupons: [] }),
    })
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('unsigned')
  })

  /**
   * The body hash is what makes this safe to accept: without it a signature
   * over an empty holding could be replayed against any holding at all.
   */
  it('refuses a holding swapped after the signature was made', async () => {
    const signed = JSON.stringify({ coupons: [] })
    const res = await fetch(`${base}/v1/holding/value`, {
      method: 'POST',
      body: JSON.stringify({ coupons: [coupon()] }),
      headers: {
        authorization: await nip98Header(
          '/v1/holding/value',
          'POST',
          signed,
          makeSigner().signer as never,
        ),
      },
    })
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('payload-mismatch')
  })

  /**
   * ADR 0001: the service holds neither the key nor the coupons. Asserted by
   * sending a holding and then asking a DIFFERENT caller for an empty one — if
   * anything were retained between requests, the second answer would carry it.
   */
  it('retains nothing about a holding after the response', async () => {
    const first = await value({ coupons: [coupon({ voucher_id: 'secret-coupon' })] })
    expect(first.body.groups).toHaveLength(1)

    const second = await value({ coupons: [] }, makeSigner().signer as never)
    expect(second.body).toEqual({ groups: [], unusable: [], couponCount: 0 })

    // And the same caller asking again gets nothing carried over either.
    const third = await value({ coupons: [] })
    expect(third.body.couponCount).toBe(0)
  })
})
