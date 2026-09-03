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
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'

import { server, metrics, guards } from '../server.js'
import { verifyNip98, FRESHNESS_WINDOW_SECONDS } from '../nip98.js'
import { REPLAY_TTL_MS, RATE_LIMIT } from '../guards.js'

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

/**
 * Replay refusal, idempotency and throttling, over HTTP.
 *
 * The store's own behaviour is tested in `expiringMap.test.ts`. What is tested
 * here is what only a real request can show: that the guards run after
 * authentication and before any work, and that a caller can tell the three
 * refusals apart.
 *
 * `guards.clear()` between tests because the state is per process and these
 * tests share one server. Without it, one test's requests count against
 * another's rate limit and the failures look like flakes.
 */
describe('replay, idempotency and throttling', () => {
  beforeEach(() => guards.clear())

  /** A signed GET, reusable so a test can send the identical bytes twice. */
  async function signedGet(signer: unknown, extra: Record<string, string> = {}) {
    const authorization = await nip98Header('/v1/whoami', 'GET', undefined, signer as never)
    return { authorization, ...extra }
  }

  describe('a replayed signature', () => {
    it('is refused the second time, distinguishably from a bad signature', async () => {
      const { signer } = makeSigner()
      const headers = await signedGet(signer)

      const first = await fetch(`${base}/v1/whoami`, { headers })
      expect(first.status).toBe(200)

      // The IDENTICAL bytes, which is exactly what a captured request is.
      const second = await fetch(`${base}/v1/whoami`, { headers })
      expect(second.status).toBe(409)

      const body = await second.json()
      expect(body.error).toBe('replay')
      // NOT 401. The signature is perfectly valid, and saying otherwise sends a
      // caller to rotate a key that was never the problem.
      expect(second.status).not.toBe(401)
      expect(body.detail).toContain('already been seen')
    })

    it('does not refuse a fresh signature for the same request', async () => {
      const { signer } = makeSigner()
      const first = await fetch(`${base}/v1/whoami`, { headers: await signedGet(signer) })
      const second = await fetch(`${base}/v1/whoami`, { headers: await signedGet(signer) })

      expect(first.status).toBe(200)
      expect(second.status).toBe(200)
    })

    it('counts refusals so a retry loop is visible as a shape', async () => {
      const { signer } = makeSigner()
      const headers = await signedGet(signer)
      await fetch(`${base}/v1/whoami`, { headers })
      await fetch(`${base}/v1/whoami`, { headers })

      expect(guards.stats.replaysRefused).toBe(1)
    })

    /**
     * The guard has to run before the work. A replayed spend that is refused
     * only after spending is not replay protection.
     */
    it('refuses a replayed POST without doing the work again', async () => {
      const { signer } = makeSigner()
      const payload = JSON.stringify({ coupons: [] })
      const headers = {
        authorization: await nip98Header('/v1/holding/value', 'POST', payload, signer as never),
      }

      expect((await fetch(`${base}/v1/holding/value`, { method: 'POST', body: payload, headers })).status).toBe(200)
      const second = await fetch(`${base}/v1/holding/value`, { method: 'POST', body: payload, headers })
      expect(second.status).toBe(409)
      expect((await second.json()).error).toBe('replay')
    })
  })

  describe('a stale signature', () => {
    /**
     * The store's TTL is derived from the freshness window rather than picked,
     * so a signature is never forgotten while it could still verify. Pinned as
     * a relationship: change the window and this still holds.
     */
    it('is remembered no longer than it could still verify', () => {
      expect(REPLAY_TTL_MS).toBeGreaterThan(FRESHNESS_WINDOW_SECONDS * 2 * 1000)
    })

    it('is refused as stale rather than as a replay', async () => {
      const { signer } = makeSigner()
      const header = await nip98Header('/v1/whoami', 'GET', undefined, signer as never)
      const result = verifyNip98({
        header,
        url: `${base}/v1/whoami`,
        method: 'GET',
        now: Math.floor(Date.now() / 1000) + 61,
      })
      expect(result).toMatchObject({ ok: false, reason: 'stale' })
    })
  })

  describe('idempotency', () => {
    it('returns the first response without acting again', async () => {
      const { signer, pubkey } = makeSigner()
      const key = 'retry-after-timeout'

      const first = await fetch(`${base}/v1/whoami`, {
        headers: await signedGet(signer, { 'idempotency-key': key }),
      })
      expect(first.status).toBe(200)
      expect(first.headers.get('idempotency-replayed')).toBeNull()

      // A CORRECT retry: fresh signature, same key. The old signature would be
      // stale within a minute anyway, so this is what a real client does.
      const retry = await fetch(`${base}/v1/whoami`, {
        headers: await signedGet(signer, { 'idempotency-key': key }),
      })

      expect(retry.status).toBe(200)
      expect(await retry.json()).toEqual({ pubkey })
      // Marked, so a caller can tell "it ran twice" from "it ran once and I asked twice".
      expect(retry.headers.get('idempotency-replayed')).toBe('true')
      expect(guards.stats.idempotentReplays).toBe(1)
    })

    /**
     * The scoping test that matters. An unscoped key would let one caller's
     * choice of "retry-1" serve another caller's response: a cross-caller leak
     * dressed up as a convenience feature.
     */
    it('is unrelated between two callers using the same key', async () => {
      const a = makeSigner()
      const b = makeSigner()
      const key = 'retry-1'

      const first = await fetch(`${base}/v1/whoami`, {
        headers: await signedGet(a.signer, { 'idempotency-key': key }),
      })
      expect((await first.json()).pubkey).toBe(a.pubkey)

      const other = await fetch(`${base}/v1/whoami`, {
        headers: await signedGet(b.signer, { 'idempotency-key': key }),
      })

      // B gets B's answer, not A's.
      expect((await other.json()).pubkey).toBe(b.pubkey)
      expect(other.headers.get('idempotency-replayed')).toBeNull()
    })

    it('replays the body a caller actually got, not a recomputed one', async () => {
      const { signer } = makeSigner()
      const key = 'holding-retry'
      const payload = JSON.stringify({
        coupons: [
          {
            voucher_id: 'c1',
            token: 't',
            face_value: 500,
            face_unit: 'EUR',
            face_decimals: 2,
            issuer_id: 'a'.repeat(64),
            status: 'active',
          },
        ],
      })

      const send = async () =>
        fetch(`${base}/v1/holding/value`, {
          method: 'POST',
          body: payload,
          headers: {
            authorization: await nip98Header('/v1/holding/value', 'POST', payload, signer as never),
            'idempotency-key': key,
          },
        })

      const first = await send()
      const firstBody = await first.json()
      const retry = await send()

      expect(retry.headers.get('idempotency-replayed')).toBe('true')
      expect(await retry.json()).toEqual(firstBody)
    })

    /**
     * Replaying a 400 for 24 hours would keep telling a caller their request is
     * malformed after they had fixed it — and an error is the answer most worth
     * genuinely retrying.
     */
    it('does not memoise an error response', async () => {
      const { signer } = makeSigner()
      const key = 'bad-request'
      const payload = JSON.stringify({ coupons: 'not-an-array' })

      const send = async () =>
        fetch(`${base}/v1/holding/value`, {
          method: 'POST',
          body: payload,
          headers: {
            authorization: await nip98Header('/v1/holding/value', 'POST', payload, signer as never),
            'idempotency-key': key,
          },
        })

      expect((await send()).status).toBe(400)
      const retry = await send()
      expect(retry.status).toBe(400)
      expect(retry.headers.get('idempotency-replayed')).toBeNull()
    })

    it('leaves a request without a key entirely alone', async () => {
      const { signer } = makeSigner()
      const first = await fetch(`${base}/v1/whoami`, { headers: await signedGet(signer) })
      const second = await fetch(`${base}/v1/whoami`, { headers: await signedGet(signer) })

      expect(first.status).toBe(200)
      expect(second.status).toBe(200)
      expect(second.headers.get('idempotency-replayed')).toBeNull()
    })
  })

  describe('throttling', () => {
    it('tells a throttled caller that it was throttled, and for how long', async () => {
      const { signer } = makeSigner()

      let throttled: Response | undefined
      for (let i = 0; i < RATE_LIMIT + 5; i++) {
        const res = await fetch(`${base}/v1/whoami`, { headers: await signedGet(signer) })
        if (res.status === 429) {
          throttled = res
          break
        }
      }

      expect(throttled).toBeDefined()
      const body = await throttled!.json()
      expect(body.error).toBe('rate-limited')
      expect(body.retryAfterSeconds).toBeGreaterThan(0)
      // The header too, because that is what an HTTP client already understands.
      expect(Number(throttled!.headers.get('retry-after'))).toBeGreaterThan(0)
    })

    /**
     * The ticket's reason for per-key throttling, asserted directly: callers
     * share NATs and cloud egress ranges, so per-address limiting makes one
     * caller's retry loop another caller's outage.
     */
    it('does not let one caller throttle another', async () => {
      const noisy = makeSigner()
      const quiet = makeSigner()

      for (let i = 0; i < RATE_LIMIT + 2; i++) {
        await fetch(`${base}/v1/whoami`, { headers: await signedGet(noisy.signer) })
      }
      expect(guards.stats.throttled).toBeGreaterThan(0)

      // Same address, different key. Unaffected.
      const other = await fetch(`${base}/v1/whoami`, { headers: await signedGet(quiet.signer) })
      expect(other.status).toBe(200)
      expect((await other.json()).pubkey).toBe(quiet.pubkey)
    })
  })

  describe('what the guards do not touch', () => {
    /**
     * An orchestrator polling liveness has no key, so it cannot be throttled by
     * one — and a health check that goes red under load gets the container
     * restarted mid-incident.
     */
    it('never throttles health', async () => {
      for (let i = 0; i < RATE_LIMIT + 10; i++) {
        const res = await fetch(`${base}/health`)
        expect(res.status).toBe(200)
      }
    })

    it('exposes store sizes so boundedness is observable', async () => {
      const { signer } = makeSigner()
      await fetch(`${base}/v1/whoami`, { headers: await signedGet(signer) })

      const metricsBody = await (await fetch(`${base}/metrics`)).json()
      expect(metricsBody.stores.replay).toBeGreaterThan(0)
      expect(metricsBody.guards).toMatchObject({ replaysRefused: expect.any(Number) })
    })
  })
})

/**
 * Planning a spend, over HTTP.
 *
 * The planning rules are tested as pure functions in `@imani/wallet-core`, and
 * their agreement with the app is pinned by `src/lib/__tests__/planParity.test.ts`.
 * What is tested here is what only a request can show: the wire shape, the
 * validation, and that asking twice moves nothing.
 */
describe('planning a spend', () => {
  beforeEach(() => guards.clear())

  const STALL = 'a'.repeat(64)
  const OTHER_STALL = 'b'.repeat(64)

  const coupon = (over: Record<string, unknown> = {}) => ({
    voucher_id: 'c1',
    token: 'cashuBo...',
    face_value: 1000,
    face_unit: 'EUR',
    face_decimals: 2,
    token_amount: 1000,
    issuance_ratio: 1,
    issuer_id: STALL,
    status: 'active',
    ...over,
  })

  async function plan(payload: unknown) {
    const body = JSON.stringify(payload)
    const res = await fetch(`${base}/v1/spend/plan`, {
      method: 'POST',
      body,
      headers: {
        authorization: await nip98Header(
          '/v1/spend/plan',
          'POST',
          body,
          makeSigner().signer as never,
        ),
        'content-type': 'application/json',
      },
    })
    return { status: res.status, body: (await res.json()) as Record<string, never> }
  }

  const request = (over: Record<string, unknown> = {}) => ({
    coupons: [coupon()],
    stallId: STALL,
    currency: 'EUR',
    amount: 400,
    ...over,
  })

  it('returns the parts that satisfy an amount, and no obstacle', async () => {
    const res = await plan(request())

    expect(res.status).toBe(200)
    expect(res.body.obstacle).toBeNull()
    expect(res.body.parts).toEqual([
      { couponId: 'c1', amount: 400, faceValue: 1000, whole: false },
    ])
  })

  it('prefers an exact match over splitting a larger coupon', async () => {
    const res = await plan(
      request({
        coupons: [
          coupon({ voucher_id: 'big', face_value: 5000 }),
          coupon({ voucher_id: 'exact', face_value: 400 }),
        ],
      }),
    )

    expect(res.body.parts).toHaveLength(1)
    expect(res.body.parts[0]).toMatchObject({ couponId: 'exact', whole: true })
  })

  it('never draws another stall’s coupons into the plan', async () => {
    const res = await plan(
      request({
        amount: 1000,
        coupons: [
          coupon({ voucher_id: 'mine', face_value: 300 }),
          coupon({ voucher_id: 'theirs', face_value: 9000, issuer_id: OTHER_STALL }),
        ],
      }),
    )

    // The other stall's 9000 would have covered it, and must not be touched.
    expect(res.body.obstacle).toMatchObject({ kind: 'insufficient-value', available: 300 })
    expect(res.body.eligibleCount).toBe(1)
  })

  it('never draws another currency into the plan', async () => {
    const res = await plan(
      request({
        amount: 1000,
        coupons: [
          coupon({ voucher_id: 'eur', face_value: 300 }),
          coupon({ voucher_id: 'xaf', face_value: 9000, face_unit: 'XAF' }),
        ],
      }),
    )

    expect(res.body.obstacle).toMatchObject({ kind: 'insufficient-value', available: 300 })
  })

  describe('obstacles', () => {
    /**
     * A 200, not a 4xx. The question "can this be spent?" was answered
     * successfully, and the answer being "no" is a normal result — a 4xx would
     * fire a caller's error handling on it.
     */
    it('answers 200 with an obstacle rather than failing the request', async () => {
      const res = await plan(request({ amount: 99999 }))
      expect(res.status).toBe(200)
      expect(res.body.obstacle).not.toBeNull()
    })

    it('says insufficient-value when the holding does not add up', async () => {
      const res = await plan(request({ amount: 99999 }))

      expect(res.body.obstacle).toMatchObject({
        kind: 'insufficient-value',
        available: 1000,
        requested: 99999,
      })
      expect(res.body.parts).toEqual([])
    })

    /**
     * The distinction the ticket exists for. A ratio of 200 means the coupon
     * divides only in steps of 200, so 150 is unreachable from a nominally
     * sufficient 1000 — and waiting for more coupons would never help.
     */
    it('says not-splittable when the holding is enough but the amount is unreachable', async () => {
      const res = await plan(
        request({
          amount: 150,
          coupons: [coupon({ face_value: 1000, token_amount: 5, issuance_ratio: 200 })],
        }),
      )

      expect(res.body.obstacle).toMatchObject({
        kind: 'not-splittable',
        available: 1000,
        requested: 150,
        minimumStep: 200,
      })
    })

    it('distinguishes the two, so a caller knows whether waiting would help', async () => {
      const coarse = coupon({ face_value: 1000, token_amount: 5, issuance_ratio: 200 })

      const short = await plan(request({ amount: 99999, coupons: [coarse] }))
      const unreachable = await plan(request({ amount: 150, coupons: [coarse] }))

      expect(short.body.obstacle.kind).toBe('insufficient-value')
      expect(unreachable.body.obstacle.kind).toBe('not-splittable')
    })
  })

  describe('validation', () => {
    it('names a missing stallId', async () => {
      const rest = request() as Record<string, unknown>
      delete rest.stallId
      const res = await plan(rest)
      expect(res.status).toBe(400)
      expect(res.body.field).toBe('stallId')
    })

    it('names a missing currency', async () => {
      const rest = request() as Record<string, unknown>
      delete rest.currency
      expect((await plan(rest)).body.field).toBe('currency')
    })

    it('names a non-numeric amount', async () => {
      const res = await plan(request({ amount: '400' }))
      expect(res.body.field).toBe('amount')
      expect(res.body.detail).toContain('number')
    })

    /**
     * Amounts are minor units, which are whole by definition. A fractional
     * amount means the caller sent euros where cents were wanted, and flooring
     * it silently would spend the wrong amount.
     */
    it('refuses a fractional amount rather than rounding it', async () => {
      const res = await plan(request({ amount: 4.5 }))
      expect(res.status).toBe(400)
      expect(res.body.field).toBe('amount')
      expect(res.body.detail).toContain('cents')
    })

    it('refuses a zero or negative amount', async () => {
      expect((await plan(request({ amount: 0 }))).status).toBe(400)
      expect((await plan(request({ amount: -100 }))).status).toBe(400)
    })

    it('still names a bad coupon field, with its index', async () => {
      const res = await plan(request({ coupons: [coupon(), coupon({ face_value: 'x' })] }))
      expect(res.body.field).toBe('coupons[1].face_value')
    })

    it('accepts an empty holding and answers with an obstacle', async () => {
      const res = await plan(request({ coupons: [] }))
      expect(res.status).toBe(200)
      expect(res.body.obstacle).toMatchObject({ kind: 'insufficient-value', available: 0 })
    })
  })

  /**
   * The property that makes it safe to ask before committing.
   */
  it('moves nothing and changes nothing when asked twice', async () => {
    const payload = request({
      coupons: [coupon({ voucher_id: 'a', face_value: 500 }), coupon({ voucher_id: 'b', face_value: 700 })],
      amount: 900,
    })

    const first = await plan(payload)
    const second = await plan(payload)

    expect(second.body).toEqual(first.body)
    // And the holding a caller sent is still worth what it was: planning does
    // not spend, mark or consume anything.
    const value = await (async () => {
      const body = JSON.stringify({ coupons: payload.coupons })
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
      return res.json()
    })()

    expect(value.groups[0].faceValue).toBe(1200)
    expect(value.unusable).toEqual([])
  })

  it('requires a signature like every other route', async () => {
    const res = await fetch(`${base}/v1/spend/plan`, {
      method: 'POST',
      body: JSON.stringify(request()),
    })
    expect(res.status).toBe(401)
  })
})
