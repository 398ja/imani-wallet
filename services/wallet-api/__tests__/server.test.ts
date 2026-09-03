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
