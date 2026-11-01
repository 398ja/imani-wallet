import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * How the login gate decides an account has a profile (#325, owner rule).
 *
 * Standard NIP-05 verification: the account's kind-0 names a handle, and that
 * handle must resolve forwards to the same key. NOT the gateway's reverse
 * lookup `/api/v1/resolve/pubkey/{hex}`, which on staging answers 404 for real
 * bottin accounts (samson) and would have locked every one of them out.
 */

const relay = vi.hoisted(() => ({ events: [] as Array<{ pubkey: string; content: string; created_at: number }> }))
vi.mock('../relay', async (orig) => ({
  ...(await orig<typeof import('../relay')>()),
  allEvents: async () => relay.events,
}))

const { verifiedHandle, DirectoryUnavailableError } = await import('../profileGate')

const SAMSON = '42a7dfe3aef93eafc347a60bd7f2dd8c8cf5c42e71fcecc7c5b56c4cf78408e7'
const OTHER = 'a'.repeat(64)
const HANDLE = 'samson@staging.398ja.xyz'

type Route = (url: string) => Response | Promise<Response>
let routes: { query: Route; resolve: Route }

const kind0 = (nip05: string | undefined, createdAt = 1) =>
  JSON.stringify({ events: [{ pubkey: SAMSON, kind: 0, createdAt, content: JSON.stringify({ name: 'samson', nip05 }) }] })
const resolvesTo = (hex: string) => new Response(JSON.stringify({ nip05: HANDLE, hex_pubkey: hex, source: 'EXTERNAL' }))

beforeEach(() => {
  relay.events = []
  routes = {
    query: () => new Response(kind0(HANDLE)),
    resolve: () => resolvesTo(SAMSON),
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/v1/nostr/query') return routes.query(url)
      if (url.startsWith('/api/v1/resolve/pubkey/')) throw new Error('the reverse lookup must not be used')
      if (url.startsWith('/api/v1/resolve/')) return routes.resolve(url)
      return new Response('{}', { status: 404 })
    }),
  )
})

afterEach(() => vi.unstubAllGlobals())

describe('verifiedHandle', () => {
  // The staging case that broke the first version: a bottin handle, found via
  // the kind-0 and verified by the forward lookup, passes.
  it('passes a bottin account whose kind-0 handle resolves to it', async () => {
    expect(await verifiedHandle(SAMSON)).toBe(HANDLE)
  })

  // The handle in the kind-0 is a claim; the forward lookup must agree.
  it('fails when the handle resolves to someone else', async () => {
    routes.resolve = () => resolvesTo(OTHER)
    expect(await verifiedHandle(SAMSON)).toBeNull()
  })

  // A handle nobody holds does not verify.
  it('fails when the handle resolves to nobody', async () => {
    routes.resolve = () => new Response('{}', { status: 404 })
    expect(await verifiedHandle(SAMSON)).toBeNull()
  })

  // No kind-0 anywhere: an account that never finished its profile.
  it('fails when the account has no kind-0', async () => {
    routes.query = () => new Response(JSON.stringify({ events: [] }))
    expect(await verifiedHandle(SAMSON)).toBeNull()
  })

  // A kind-0 without a handle is a profile with no directory identity.
  it('fails when the kind-0 names no handle', async () => {
    routes.query = () => new Response(kind0(undefined))
    expect(await verifiedHandle(SAMSON)).toBeNull()
  })

  // The relay is read too, newest wins: a kind-0 published straight to the
  // relay (never in the gateway cache) still counts.
  it('reads the relay when the gateway cache has nothing', async () => {
    routes.query = () => new Response(JSON.stringify({ events: [] }))
    relay.events = [{ pubkey: SAMSON, created_at: 5, content: JSON.stringify({ nip05: HANDLE }) }]
    expect(await verifiedHandle(SAMSON)).toBe(HANDLE)
  })

  // Unreachable is not "no profile": it fails closed with a retry message.
  it('fails closed when the gateway is down and the relay has nothing', async () => {
    routes.query = () => new Response('{}', { status: 502 })
    await expect(verifiedHandle(SAMSON)).rejects.toBeInstanceOf(DirectoryUnavailableError)
  })

  it('fails closed when the forward lookup is down', async () => {
    routes.resolve = () => new Response('{}', { status: 503 })
    await expect(verifiedHandle(SAMSON)).rejects.toBeInstanceOf(DirectoryUnavailableError)
  })
})
