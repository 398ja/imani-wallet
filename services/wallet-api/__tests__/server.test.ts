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
import { nip17 } from 'nostr-tools'

import {
  server,
  metrics,
  guards,
  setStallLookup,
  resetStallLookup,
  setGatewayFetch,
  resetGatewayFetch,
} from '../server.js'
import { SPLIT_PATH } from '../prepare.js'
import { verifyNip98, FRESHNESS_WINDOW_SECONDS } from '../nip98.js'
import { REPLAY_TTL_MS, RATE_LIMIT } from '../guards.js'

/**
 * A JSON body, typed loosely enough to assert on.
 *
 * `Response.json()` returns `unknown`, so every `(await jsonOf(res)).error` in
 * this file was a type error the moment `tsconfig.services.json` gained the
 * `paths` that let its imports resolve (API ticket 07). Sixty-nine of them,
 * none new: they were invisible because an unresolved `@imani/wallet-core`
 * meant the file never typechecked far enough to notice.
 *
 * A named helper rather than a cast at each site, so the looseness is declared
 * once and a reader can see exactly how much is being assumed.
 *
 * `any`, deliberately, and only here. These assertions reach into nested
 * response shapes — `body.stores.replay`, `body.event.kind` — and a stricter
 * type would be re-declaring the whole API surface in the test file, which is a
 * second source of truth for shapes the endpoints already own. The looseness is
 * confined to one function that does nothing else.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function jsonOf(res: Response): Promise<any> {
  return await res.json()
}


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
    expect(await jsonOf(res)).toEqual({ pubkey })
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
    expect((await jsonOf(res)).error).toBe('unsigned')
  })

  it('refuses a header that is not a signed event', async () => {
    const res = await fetch(`${base}/v1/whoami`, {
      headers: { authorization: 'Nostr not-base64-at-all!!' },
    })
    expect((await jsonOf(res)).error).toBe('malformed')
  })

  it('refuses a signature for a different path', async () => {
    const { signer } = makeSigner()
    const res = await fetch(`${base}/v1/whoami`, {
      // Signed for a route that exists, sent to another: without the URL check
      // any signed request could be replayed against any endpoint.
      headers: { authorization: await nip98Header('/v1/something-else', 'GET', undefined, signer) },
    })
    expect(res.status).toBe(401)
    expect((await jsonOf(res)).error).toBe('url-mismatch')
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
    expect((await jsonOf(res)).error).toBe('url-mismatch')
  })

  it('accepts a signature whose query matches exactly', async () => {
    const { pubkey, signer } = makeSigner()
    const res = await fetch(`${base}/v1/whoami?limit=1`, {
      headers: {
        authorization: await nip98Header('/v1/whoami?limit=1', 'GET', undefined, signer),
      },
    })
    expect(res.status).toBe(200)
    expect(await jsonOf(res)).toEqual({ pubkey })
  })

  it('refuses a GET signature replayed as a POST', async () => {
    const { signer } = makeSigner()
    const res = await fetch(`${base}/v1/whoami`, {
      method: 'POST',
      body: '{}',
      headers: { authorization: await nip98Header('/v1/whoami', 'GET', undefined, signer) },
    })
    expect((await jsonOf(res)).error).toBe('method-mismatch')
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
    expect((await jsonOf(res)).error).toBe('bad-signature')
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
    expect((await jsonOf(res)).error).toBe('bad-signature')
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
    expect((await jsonOf(res)).error).toBe('bad-signature')
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
    expect((await jsonOf(res)).error).toBe('malformed')
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
    expect(await jsonOf(res)).toEqual({ status: 'ok' })
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
    expect((await jsonOf(res)).error).toBe('payload-mismatch')
  })

  it('refuses a body sent under a signature that covered no body', async () => {
    const { signer } = makeSigner()
    const res = await fetch(`${base}/v1/whoami`, {
      method: 'POST',
      body: JSON.stringify({ amount: 1000000 }),
      headers: { authorization: await nip98Header('/v1/whoami', 'POST', undefined, signer) },
    })
    expect((await jsonOf(res)).error).toBe('payload-mismatch')
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
    return { status: res.status, body: await jsonOf(res) }
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
      const body = await jsonOf(res)
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
      expect((await jsonOf(res)).field).toBe('coupons[0].token_amount')
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
      expect((await jsonOf(res)).error).toBe('invalid-json')
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
    expect((await jsonOf(res)).error).toBe('unsigned')
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
    expect((await jsonOf(res)).error).toBe('payload-mismatch')
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

      const body = await jsonOf(second)
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
      expect((await jsonOf(second)).error).toBe('replay')
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
      expect(await jsonOf(retry)).toEqual({ pubkey })
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
      expect((await jsonOf(first)).pubkey).toBe(a.pubkey)

      const other = await fetch(`${base}/v1/whoami`, {
        headers: await signedGet(b.signer, { 'idempotency-key': key }),
      })

      // B gets B's answer, not A's.
      expect((await jsonOf(other)).pubkey).toBe(b.pubkey)
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
      const firstBody = await jsonOf(first)
      const retry = await send()

      expect(retry.headers.get('idempotency-replayed')).toBe('true')
      expect(await jsonOf(retry)).toEqual(firstBody)
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
      const body = await jsonOf(throttled!)
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
      expect((await jsonOf(other)).pubkey).toBe(quiet.pubkey)
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

      const metricsBody = await jsonOf(await fetch(`${base}/metrics`))
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
    return { status: res.status, body: await jsonOf(res) }
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
      return jsonOf(res)
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

/**
 * Refusing a send the receiving stall could never honour.
 *
 * The rule itself is tested pure in `@imani/wallet-core`, and its agreement
 * with the app is pinned by `src/lib/__tests__/recipientParity.test.ts`. What
 * is tested here is the thing only a request can show: that the refusal happens
 * during planning before anything moves, and — most importantly — that an
 * unreachable relay refuses rather than allows.
 *
 * The lookup is substituted rather than mocked at the module level, because the
 * outage branch is the one that matters and a guarantee that cannot be
 * exercised under failure is not a guarantee.
 */
describe('refusing a send the recipient could not honour', () => {
  const STALL = 'a'.repeat(64)
  const OTHER_STALL = 'b'.repeat(64)
  const CUSTOMER = 'c'.repeat(64)

  /** A lookup with a fixed answer, and a record of whether it was consulted. */
  function lookupReturning(role: 'stall' | 'customer' | 'unknown') {
    const calls: string[] = []
    setStallLookup({
      async role(pubkey: string) {
        calls.push(pubkey)
        return role
      },
      clear() {},
    })
    return calls
  }

  beforeEach(() => {
    guards.clear()
    resetStallLookup()
  })
  afterAll(() => resetStallLookup())

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

  async function plan(over: Record<string, unknown> = {}, signer?: unknown) {
    const payload = {
      coupons: [coupon()],
      stallId: STALL,
      currency: 'EUR',
      amount: 400,
      ...over,
    }
    const body = JSON.stringify(payload)
    const res = await fetch(`${base}/v1/spend/plan`, {
      method: 'POST',
      body,
      headers: {
        authorization: await nip98Header(
          '/v1/spend/plan',
          'POST',
          body,
          (signer ?? makeSigner().signer) as never,
        ),
      },
    })
    return { status: res.status, body: await jsonOf(res) }
  }

  describe('a redemption', () => {
    /**
     * The overwhelmingly common case, and the one a market stall depends on.
     * Decided from the keys alone, so it keeps working during an outage — which
     * is precisely what makes refusing on `unknown` affordable elsewhere.
     */
    it('is allowed with NO network lookup performed', async () => {
      const calls = lookupReturning('unknown')

      const res = await plan({ recipientPubkey: STALL })

      expect(res.status).toBe(200)
      expect(res.body.refusal).toBeNull()
      expect(res.body.parts).toHaveLength(1)
      // The assertion that matters: the relay was never asked.
      expect(calls).toEqual([])
    })

    it('is allowed even when every lookup would fail', async () => {
      setStallLookup({
        async role() {
          throw new Error('the relay is down')
        },
        clear() {},
      })

      const res = await plan({ recipientPubkey: STALL })
      expect(res.body.refusal).toBeNull()
      expect(res.body.parts).toHaveLength(1)
    })
  })

  it('allows a send to someone who is not a stall', async () => {
    lookupReturning('customer')

    const res = await plan({ recipientPubkey: CUSTOMER })
    expect(res.body.refusal).toBeNull()
    expect(res.body.parts).toHaveLength(1)
  })

  it('refuses another stall’s coupons, naming the mismatch', async () => {
    lookupReturning('stall')

    const res = await plan({ recipientPubkey: OTHER_STALL })

    expect(res.status).toBe(200)
    expect(res.body.refusal).toMatchObject({ reason: 'wrong-stall' })
    expect(res.body.refusal.detail).toContain(STALL)
    expect(res.body.refusal.detail).toContain(OTHER_STALL)
    // Nothing was planned: the refusal happened before the money question.
    expect(res.body.parts).toEqual([])
  })

  describe('an unreachable network', () => {
    /**
     * The requirement that must not be softened into a warning.
     *
     * A send blocked by an outage is retried a minute later; a coupon that
     * lands on a stall which cannot honour it is money the customer no longer
     * holds and the merchant cannot give back. Only the second is
     * unrecoverable.
     */
    it('refuses the send rather than allowing it', async () => {
      lookupReturning('unknown')

      const res = await plan({ recipientPubkey: OTHER_STALL })

      expect(res.body.refusal).toMatchObject({ reason: 'recipient-unknown' })
      expect(res.body.parts).toEqual([])
    })

    it('says the check could not be made, and that nothing has moved', async () => {
      lookupReturning('unknown')

      const res = await plan({ recipientPubkey: OTHER_STALL })

      expect(res.body.refusal.detail).toContain('Could not check')
      expect(res.body.refusal.detail).toContain('Nothing has moved')
      // And tells the caller what to do about it.
      expect(res.body.refusal.detail).toContain('Retry')
    })

    it('refuses distinguishably from a wrong stall', async () => {
      lookupReturning('unknown')
      const outage = await plan({ recipientPubkey: OTHER_STALL })

      lookupReturning('stall')
      const wrong = await plan({ recipientPubkey: OTHER_STALL })

      expect(outage.body.refusal.reason).toBe('recipient-unknown')
      expect(wrong.body.refusal.reason).toBe('wrong-stall')
    })

    /**
     * A lookup that THROWS, rather than one that reports `unknown`. The store
     * must not turn a thrown error into an allowed send at any layer.
     */
    it('refuses when the lookup throws outright', async () => {
      setStallLookup({
        async role() {
          throw new Error('relay unreachable')
        },
        clear() {},
      })

      const res = await plan({ recipientPubkey: OTHER_STALL })

      // A 500 would be wrong even though it does not ALLOW the send: "internal
      // error" leaves a caller unable to tell a refusal from a half-completed
      // send. This was a real 500 until the handler caught it.
      expect(res.status).toBe(200)
      expect(res.body.refusal).toMatchObject({ reason: 'recipient-unknown' })
      expect(res.body.refusal.detail).toContain('Nothing has moved')
      expect(res.body.parts).toEqual([])
    })
  })

  describe('a send to the caller’s own key', () => {
    it('is refused', async () => {
      const { pubkey, signer } = makeSigner()
      lookupReturning('customer')

      const res = await plan({ recipientPubkey: pubkey }, signer)

      expect(res.body.refusal).toMatchObject({ reason: 'self-send' })
      expect(res.body.parts).toEqual([])
    })

    /**
     * Even when it would otherwise be a redemption. A stall sending to itself
     * still burns a coupon and mints an equal one for a fee, and that is the
     * identity where a loop bug is most likely.
     */
    it('is refused even when the caller is the issuing stall', async () => {
      const { pubkey, signer } = makeSigner()
      const calls = lookupReturning('stall')

      const res = await plan({ recipientPubkey: pubkey, stallId: pubkey }, signer)

      expect(res.body.refusal).toMatchObject({ reason: 'self-send' })
      expect(calls).toEqual([])
    })
  })

  describe('validation', () => {
    it('refuses a malformed recipient key rather than looking it up', async () => {
      const calls = lookupReturning('customer')

      const res = await plan({ recipientPubkey: 'not-a-key' })

      expect(res.status).toBe(400)
      expect(res.body.field).toBe('recipientPubkey')
      // A typo must not become a lookup that finds nothing and reads as
      // "customer", which would allow the send.
      expect(calls).toEqual([])
    })

    it('plans without a recipient at all, for a caller only asking what it can afford', async () => {
      const calls = lookupReturning('unknown')

      const res = await plan()

      expect(res.body.refusal).toBeNull()
      expect(res.body.parts).toHaveLength(1)
      expect(calls).toEqual([])
    })
  })

  it('counts refusals separately, and by reason', async () => {
    const before = { ...metrics.recipientRefusals }

    lookupReturning('stall')
    await plan({ recipientPubkey: OTHER_STALL })
    lookupReturning('unknown')
    await plan({ recipientPubkey: OTHER_STALL })

    expect(metrics.recipientRefusals['wrong-stall']).toBe((before['wrong-stall'] ?? 0) + 1)
    expect(metrics.recipientRefusals['recipient-unknown']).toBe(
      (before['recipient-unknown'] ?? 0) + 1,
    )
    // Separate from validation errors and from auth refusals, so an operator
    // can tell a caller's bug from a relay outage.
    expect(metrics.recipientRefusals).not.toHaveProperty('replay')
  })
})

/**
 * Preparing a part.
 *
 * The gateway is substituted, the rest is real: a signed request over a socket,
 * through the guards, into the shipping handler. The substitution exists
 * because the behaviours that matter here happen when the gateway FAILS, and a
 * guarantee that cannot be exercised under failure is a claim.
 *
 * The signing is checked in the strongest available way — `nip17.wrapEvent`
 * from nostr-tools consumes the returned rumor, and the recipient unwraps it —
 * so "valid gift wrap once signed" is demonstrated rather than asserted about
 * the shape of an object.
 */
describe('preparing a part', () => {
  const STALL = 'a'.repeat(64)
  const RECIPIENT = 'c'.repeat(63) + 'd'

  const SPLIT = {
    send_token: 'cashuB-sent',
    keep_token: 'cashuB-change',
    send_face_value: 200,
    keep_face_value: 800,
    send_token_amount: 20,
    keep_token_amount: 80,
    sent_voucher_id: 'sent-1',
    issuer_id: STALL,
    face_unit: 'EUR',
    face_decimals: 2,
    is_full_send: false,
  }

  /** A gateway with a fixed answer, and a record of every call it received. */
  function gatewayReturning(
    status: number,
    payload: unknown,
    ) {
    const calls: { url: string; authorization: string | null; body: string }[] = []
    setGatewayFetch((async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        authorization:
          (init?.headers as Record<string, string> | undefined)?.authorization ?? null,
        body: String(init?.body ?? ''),
      })
      return new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch)
    return calls
  }

  /** A gateway that cannot be reached at all. */
  function gatewayDown() {
    const calls: string[] = []
    setGatewayFetch((async (url: string | URL | Request) => {
      calls.push(String(url))
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch)
    return calls
  }

  beforeEach(() => {
    guards.clear()
    resetGatewayFetch()
    // The recipient is an ordinary customer unless a test says otherwise, so
    // the recipient guard is not what these assertions are measuring.
    setStallLookup({ async role() { return 'customer' }, clear() {} })
  })
  afterAll(() => {
    resetGatewayFetch()
    resetStallLookup()
  })

  const request = (over: Record<string, unknown> = {}) => ({
    token: 'cashuB-source',
    amount: 200,
    recipientPubkey: RECIPIENT,
    stallId: STALL,
    currency: 'EUR',
    decimals: 2,
    couponId: 'coupon-1',
    gatewayAuthorization: 'Nostr caller-signed-credential',
    ...over,
  })

  async function prepare(over: Record<string, unknown> = {}, headers: Record<string, string> = {}, s?: ReturnType<typeof makeSigner>) {
    const signer = s ?? makeSigner()
    const payload = JSON.stringify(request(over))
    const res = await fetch(`${base}/v1/spend/parts/prepare`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: await nip98Header('/v1/spend/parts/prepare', 'POST', payload, signer.signer),
        ...headers,
      },
      body: payload,
    })
    return { status: res.status, headers: res.headers, body: await jsonOf(res), signer }
  }

  it('returns the replacement coupons and an unsigned event', async () => {
    gatewayReturning(200, SPLIT)

    const res = await prepare()

    expect(res.status).toBe(200)
    expect(res.body.prepared.sent.token).toBe('cashuB-sent')
    expect(res.body.prepared.sent.faceValue).toBe(200)
    expect(res.body.prepared.change.token).toBe('cashuB-change')
    expect(res.body.prepared.change.faceValue).toBe(800)
    // Which coupon these two replace, so the caller's write is one statement:
    // remove that, add these.
    expect(res.body.prepared.replaces).toBe('coupon-1')
    expect(res.body.prepared.unsignedEvent.kind).toBe(14)
    // FALSE on the one path where the gateway actually split. A caller that
    // reads this as true skips the write and loses both coupons, so the
    // success case must assert it as loudly as every failure case does.
    expect(res.body.holdingUnchanged).toBe(false)
  })

  it('returns an event that is genuinely unsigned', async () => {
    gatewayReturning(200, SPLIT)

    const { body } = await prepare()
    const event = body.prepared.unsignedEvent

    // All three, because any ONE of them present would make this a thing the
    // service produced rather than a template the caller completes.
    expect(event).not.toHaveProperty('id')
    expect(event).not.toHaveProperty('pubkey')
    expect(event).not.toHaveProperty('sig')
    // And nothing anywhere in the response looks like a signature.
    expect(JSON.stringify(body)).not.toMatch(/"sig"\s*:/)
  })

  it('returns an event that becomes a valid gift wrap once the caller signs it', async () => {
    gatewayReturning(200, SPLIT)

    // A real recipient, so the wrap can actually be unwrapped.
    const recipientSecret = generateSecretKey()
    const recipientPubkey = getPublicKey(recipientSecret)
    const { body, signer } = await prepare({ recipientPubkey })

    // The CALLER's own key does the sealing and wrapping, locally. This is the
    // step the service cannot perform, performed by the only party who can.
    const wrap = nip17.wrapEvent(
      signer.secret,
      { publicKey: recipientPubkey },
      body.prepared.unsignedEvent.content,
    )

    expect(wrap.kind).toBe(1059)
    // The outer wrap is signed by a THROWAWAY key, never the sender's — that is
    // what NIP-59 is for, and asserting it here pins that the caller's identity
    // is not on the outside of the envelope.
    expect(wrap.pubkey).not.toBe(signer.pubkey)

    const rumor = nip17.unwrapEvent(wrap, recipientSecret)
    // The inner rumor carries the sender's real identity, which is how the
    // recipient knows who paid.
    expect(rumor.pubkey).toBe(signer.pubkey)

    const payload = JSON.parse(rumor.content)
    expect(payload.type).toBe('cashu_token_transfer')
    expect(payload.token).toBe('cashuB-sent')
    expect(payload.face_value).toBe(200)
  })

  it('addresses the event to the intended recipient and carries the intended part', async () => {
    gatewayReturning(200, SPLIT)

    const { body } = await prepare()
    const event = body.prepared.unsignedEvent

    // The `p` tag is what makes the wrap reach anyone at all: the recipient
    // subscribes on it. A wrap without it reaches the relay and nobody.
    expect(event.tags).toContainEqual(['p', RECIPIENT])

    const payload = JSON.parse(event.content)
    expect(payload.token).toBe(SPLIT.send_token)
    expect(payload.face_value).toBe(200)
    expect(payload.face_unit).toBe('EUR')
    expect(payload.issuer_id).toBe(STALL)
  })

  it('names the caller as the sender from the SIGNATURE, not from the body', async () => {
    gatewayReturning(200, SPLIT)

    // A caller claiming to be somebody else. The field is not read.
    const { body, signer } = await prepare({ sender_pubkey: 'f'.repeat(64), senderPubkey: 'f'.repeat(64) })

    expect(JSON.parse(body.prepared.unsignedEvent.content).sender_pubkey).toBe(signer.pubkey)
  })

  it('calls the gateway with the caller’s own signature, never one it produced', async () => {
    const calls = gatewayReturning(200, SPLIT)

    await prepare({ gatewayAuthorization: 'Nostr the-callers-own-credential' })

    expect(calls).toHaveLength(1)
    // Verbatim. The service is a courier for a credential it cannot forge, and
    // substituting one of its own would be exactly the custody this design
    // refuses.
    expect(calls[0].authorization).toBe('Nostr the-callers-own-credential')
    expect(calls[0].url).toContain(SPLIT_PATH)
  })

  it('sends the gateway the exact bytes it told the caller to sign', async () => {
    const calls = gatewayReturning(200, SPLIT)
    const signer = makeSigner()

    // What the service says to sign...
    const askPayload = JSON.stringify({ token: 'cashuB-source', amount: 200 })
    const ask = await fetch(`${base}/v1/spend/parts/gateway-request`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: await nip98Header('/v1/spend/parts/gateway-request', 'POST', askPayload, signer.signer),
      },
      body: askPayload,
    })
    const advice = await jsonOf(ask)

    // ...must be byte for byte what it then posts, or the caller's payload hash
    // will not match and the gateway refuses a request nobody altered.
    await prepare({}, {}, signer)

    expect(calls[0].body).toBe(advice.body)
    expect(advice.url).toContain(SPLIT_PATH)
    expect(advice.method).toBe('POST')
  })

  it('refuses a request with no gateway credential, and says what to sign', async () => {
    const calls = gatewayReturning(200, SPLIT)

    const res = await prepare({ gatewayAuthorization: undefined })

    expect(res.status).toBe(400)
    expect(res.body.field).toBe('gatewayAuthorization')
    // The service holds no credential of its own to fall back on, and saying so
    // is the difference between a caller adding a header and a caller filing a
    // bug about a missing feature.
    expect(res.body.detail).toContain(SPLIT_PATH)
    expect(calls).toEqual([])
  })

  describe('when the gateway fails', () => {
    it('leaves the holding unchanged and says so plainly when it cannot be reached', async () => {
      const calls = gatewayDown()

      const res = await prepare()

      expect(res.status).toBe(502)
      expect(res.body.error).toBe('gateway-unreachable')
      // The load-bearing field: a caller that cannot tell "refused" from
      // "half-done" must reconcile after every error.
      expect(res.body.holdingUnchanged).toBe(true)
      expect(res.body.detail).toContain('holding is unchanged')
      expect(calls).toHaveLength(1)
    })

    it('passes a refused signature back as a 401 rather than a server error', async () => {
      gatewayReturning(401, { error_code: 'AUTH_002', error_message: 'NIP-98 payload hash mismatch' })

      const res = await prepare()

      // The CALLER's signature was refused, and no amount of retrying by this
      // service would fix it — so the caller is told, not the operator.
      expect(res.status).toBe(401)
      expect(res.body.holdingUnchanged).toBe(true)
      expect(res.body.detail).toContain('payload hash mismatch')
    })

    it('refuses a success that carries no send token', async () => {
      gatewayReturning(200, { ...SPLIT, send_token: undefined })

      const res = await prepare()

      // Building an event around `undefined` would publish a send containing no
      // money, which the recipient's wallet would accept as an arrival.
      expect(res.status).toBe(502)
      expect(res.body.error).toBe('gateway-incomplete')
    })

    it('does not store a failure against the idempotency key', async () => {
      gatewayDown()
      const signer = makeSigner()
      const first = await prepare({}, { 'Idempotency-Key': 'retry-me' }, signer)
      expect(first.status).toBe(502)

      // The same key now succeeds, because only 2xx is remembered. A caller
      // whose gateway was briefly down must be able to retry, not be handed the
      // outage forever.
      gatewayReturning(200, SPLIT)
      const second = await prepare({}, { 'Idempotency-Key': 'retry-me' }, signer)

      expect(second.status).toBe(200)
      expect(second.headers.get('idempotency-replayed')).toBeNull()
    })

    it('counts failures by reason, separately from other errors', async () => {
      const before = { ...metrics.prepareFailures }
      gatewayDown()

      await prepare()

      expect(metrics.prepareFailures['gateway-unreachable']).toBe(
        (before['gateway-unreachable'] ?? 0) + 1,
      )
    })
  })

  describe('retrying', () => {
    it('returns the first answer and does not mint again', async () => {
      const calls = gatewayReturning(200, SPLIT)
      const signer = makeSigner()

      const first = await prepare({}, { 'Idempotency-Key': 'pay-supplier-1' }, signer)
      const second = await prepare({}, { 'Idempotency-Key': 'pay-supplier-1' }, signer)

      expect(second.status).toBe(200)
      expect(second.headers.get('idempotency-replayed')).toBe('true')
      expect(second.body).toEqual(first.body)
      // THE assertion. A second call to the gateway is a second split, which is
      // a coupon divided twice and half of it stranded server-side.
      expect(calls).toHaveLength(1)
    })

    it('keeps one caller’s key clear of another’s', async () => {
      const calls = gatewayReturning(200, SPLIT)

      await prepare({}, { 'Idempotency-Key': 'shared-name' }, makeSigner())
      const other = await prepare({}, { 'Idempotency-Key': 'shared-name' }, makeSigner())

      expect(other.headers.get('idempotency-replayed')).toBeNull()
      expect(calls).toHaveLength(2)
    })
  })

  it('does not affect any other part of a plan', async () => {
    const calls = gatewayReturning(200, SPLIT)
    const signer = makeSigner()

    // Two parts of one plan, prepared independently, each with its own key.
    await prepare({ token: 'cashuB-part-one', couponId: 'coupon-1' }, { 'Idempotency-Key': 'plan-x-part-0' }, signer)
    await prepare({ token: 'cashuB-part-two', couponId: 'coupon-2' }, { 'Idempotency-Key': 'plan-x-part-1' }, signer)

    expect(calls).toHaveLength(2)
    // Each carries its OWN coupon. One part's failure or retry cannot reach
    // another, because nothing ties them together on this service at all.
    expect(calls[0].body).toContain('cashuB-part-one')
    expect(calls[1].body).toContain('cashuB-part-two')
  })

  it('refuses a send the recipient could not honour, before splitting anything', async () => {
    const calls = gatewayReturning(200, SPLIT)
    setStallLookup({ async role() { return 'stall' }, clear() {} })

    // A different stall from the one that issued these coupons.
    const res = await prepare({ recipientPubkey: 'b'.repeat(64) })

    expect(res.status).toBe(200)
    expect(res.body.prepared).toBeNull()
    expect(res.body.refusal.reason).toBe('wrong-stall')
    expect(res.body.holdingUnchanged).toBe(true)
    // The check runs BEFORE the split, which is the only ordering that leaves
    // the coupon whole. Afterwards the caller would hold a sent half addressed
    // to a stall that cannot honour it.
    expect(calls).toEqual([])
  })

  it('refuses when the recipient could not be checked at all', async () => {
    const calls = gatewayReturning(200, SPLIT)
    setStallLookup({ async role() { return 'unknown' }, clear() {} })

    const res = await prepare({ recipientPubkey: 'e'.repeat(64) })

    // Fail-closed, and for the asymmetry the plan documents: a send blocked by
    // an outage is retried, a coupon landing on the wrong stall is gone.
    expect(res.body.refusal.reason).toBe('recipient-unknown')
    expect(calls).toEqual([])
  })

  it('reports a full send as no change rather than a worthless coupon', async () => {
    gatewayReturning(200, { ...SPLIT, keep_token: null, keep_face_value: 0, is_full_send: true })

    const { body } = await prepare({ amount: 1000 })

    // A zero-valued coupon cannot be spent and would sit in a holding forever.
    expect(body.prepared.change).toBeNull()
    expect(body.prepared.sent.token).toBe('cashuB-sent')
  })

  describe('validation', () => {
    const cases: [string, Record<string, unknown>, string][] = [
      ['a missing token', { token: undefined }, 'token'],
      ['a fractional amount', { amount: 2.5 }, 'amount'],
      ['a negative amount', { amount: -1 }, 'amount'],
      ['a missing recipient', { recipientPubkey: undefined }, 'recipientPubkey'],
      ['a malformed recipient', { recipientPubkey: 'not-a-key' }, 'recipientPubkey'],
    ]

    for (const [name, over, field] of cases) {
      it(`refuses ${name} and names the field`, async () => {
        const calls = gatewayReturning(200, SPLIT)

        const res = await prepare(over)

        expect(res.status).toBe(400)
        expect(res.body.field).toBe(field)
        // Nothing reached the gateway, so nothing moved.
        expect(calls).toEqual([])
      })
    }

    it('explains that amounts are minor units when given euros', async () => {
      gatewayReturning(200, SPLIT)
      const res = await prepare({ amount: 2.5 })
      expect(res.body.detail).toContain('cents, not euros')
    })
  })
})
