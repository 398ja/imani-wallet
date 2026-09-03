/**
 * @vitest-environment jsdom
 *
 * jsdom because `nip98Header` builds its `u` tag from `window.location.origin`
 * — the signature is bound to an absolute URL, and in the app that origin is
 * the page's. The repository's convention is this per-file pragma rather than a
 * global environment.
 *
 * The wallet's NIP-98 signer.
 *
 * Untested until now, which is how the missing nonce survived: every consumer
 * signed one request at a time and never compared two.
 */
import { describe, expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure'

import { nip98Header } from '../nip98'

const signerFor = (secret = generateSecretKey()) => ({
  async signEvent(template: {
    kind: number
    created_at: number
    tags: string[][]
    content: string
  }) {
    return finalizeEvent(template, secret)
  },
})

const decode = (header: string) =>
  JSON.parse(Buffer.from(header.slice('Nostr '.length), 'base64').toString()) as {
    id: string
    kind: number
    tags: string[][]
  }

const tag = (event: { tags: string[][] }, name: string) =>
  event.tags.find((t) => t[0] === name)?.[1]

describe('the signed event', () => {
  it('is a NIP-98 auth event bound to the url and method', async () => {
    const header = await nip98Header('/v1/whoami', 'get', undefined, signerFor())
    const event = decode(header)

    expect(event.kind).toBe(27235)
    expect(tag(event, 'u')).toBe(`${window.location.origin}/v1/whoami`)
    // Upper-cased, because the server compares against the method it received.
    expect(tag(event, 'method')).toBe('GET')
  })

  it('covers the body with a payload hash when there is one', async () => {
    const withBody = decode(await nip98Header('/v1/x', 'POST', '{"a":1}', signerFor()))
    const without = decode(await nip98Header('/v1/x', 'POST', undefined, signerFor()))

    expect(tag(withBody, 'payload')).toMatch(/^[0-9a-f]{64}$/)
    expect(tag(without, 'payload')).toBeUndefined()
  })
})

/**
 * The nonce, and why it is not decoration.
 *
 * NIP-98's `created_at` is in SECONDS and the rest of the event is a pure
 * function of the request, so without a nonce two identical requests in the
 * same second produce a byte-identical event with an identical id. A server
 * doing replay protection then cannot distinguish an honest second request
 * from a captured one resent, and must refuse one of them.
 *
 * This was found by the wallet API's replay tests failing: two legitimate
 * consecutive requests collided as a replay.
 */
describe('uniqueness', () => {
  it('gives two identical requests different ids, in the same second', async () => {
    const signer = signerFor()
    const a = decode(await nip98Header('/v1/whoami', 'GET', undefined, signer))
    const b = decode(await nip98Header('/v1/whoami', 'GET', undefined, signer))

    // The precondition. If this ever fails the test below proves nothing,
    // because the clock did the work rather than the nonce.
    const at = (e: { tags: string[][] }) => tag(e, 'nonce')
    expect(at(a)).toBeDefined()
    expect(at(a)).not.toBe(at(b))
    expect(a.id).not.toBe(b.id)
  })

  it('carries a nonce with enough entropy to not collide', async () => {
    const signer = signerFor()
    const nonces = new Set<string>()
    for (let i = 0; i < 200; i++) {
      nonces.add(tag(decode(await nip98Header('/v1/x', 'GET', undefined, signer)), 'nonce')!)
    }

    expect(nonces.size).toBe(200)
    // 16 bytes as hex. Short enough to be cheap, long enough that a birthday
    // collision inside a two-minute replay window is not a real event.
    expect([...nonces][0]).toMatch(/^[0-9a-f]{32}$/)
  })
})
