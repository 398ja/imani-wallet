/**
 * @vitest-environment jsdom
 *
 * #558 / imani-gateway-core#209: the gateway requires a payload tag on every state-changing
 * method and hashes the body it received, which for a bodyless DELETE is zero bytes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure'

vi.mock('../nap', () => ({ getSigner: vi.fn() }))

import { EMPTY_BODY_SHA256, nip98Header, signedFetch } from '../nip98'
import { deleteHandle, DELETE_COPY, REASON_COPY } from '../accountDeletion'

const secret = generateSecretKey()
const signer = {
  async signEvent(t: { kind: number; created_at: number; tags: string[][]; content: string }) {
    return finalizeEvent(t, secret)
  },
}
const payloadOf = (header: string) =>
  (JSON.parse(Buffer.from(header.slice(6), 'base64').toString()) as { tags: string[][] }).tags.find(
    (t) => t[0] === 'payload',
  )?.[1]

// What the gateway computes: DigestPool.sha256 over the cached body, empty for no body.
const gatewayEmptyHash = createHash('sha256').update(Buffer.alloc(0)).digest('hex')

afterEach(() => vi.unstubAllGlobals())

describe('payload tag', () => {
  it('a DELETE without a body carries the gateway empty-body hash', async () => {
    expect(EMPTY_BODY_SHA256).toBe(gatewayEmptyHash)
    expect(payloadOf(await nip98Header('/api/v1/nip05?nip05=a', 'DELETE', undefined, signer))).toBe(gatewayEmptyHash)
    expect(payloadOf(await nip98Header('/x', 'delete', undefined, signer))).toBe(gatewayEmptyHash)
  })

  it('POST with a body is unchanged: hash of that body', async () => {
    const body = '{"a":1}'
    expect(payloadOf(await nip98Header('/x', 'POST', body, signer))).toBe(createHash('sha256').update(body).digest('hex'))
  })

  it('GET still has no payload tag', async () => {
    expect(payloadOf(await nip98Header('/x', 'GET', undefined, signer))).toBeUndefined()
  })

  it('signedFetch sends no body or Content-Type for a bodyless DELETE', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    await signedFetch('/x', 'DELETE', undefined, signer)
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect(init.body).toBeUndefined()
    expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined()
    expect(payloadOf((init.headers as Record<string, string>).Authorization)).toBe(gatewayEmptyHash)
  })
})

describe('deleteHandle status mapping', () => {
  const answer = (status: number) => vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status })))

  it('401 is unauthorized, not network', async () => {
    answer(401)
    const r = await deleteHandle('a@imani.casa', signer)
    expect(r).toBe('unauthorized')
    expect(DELETE_COPY[REASON_COPY.unauthorized]).toBe('We could not confirm it is you. Nothing was deleted.')
  })

  it('501 is unavailable', async () => {
    answer(501)
    const r = await deleteHandle('a@imani.casa', signer)
    expect(r).toBe('unavailable')
    expect(DELETE_COPY[REASON_COPY.unavailable]).toBe('Deleting accounts is not available yet. Nothing was deleted.')
  })

  it('500 is still network', async () => {
    answer(500)
    expect(await deleteHandle('a@imani.casa', signer)).toBe('network')
  })
})
