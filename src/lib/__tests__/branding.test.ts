import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  brandingFromKind0,
  clearBrandingCache,
  fetchNewestKind0,
  merchantBranding,
} from '../branding'
import { allEvents } from '../relay'

vi.mock('../relay', () => ({ allEvents: vi.fn() }))

const gatewayReturns = (body: unknown, ok = true) =>
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok, json: async () => body } as unknown as Response),
  )

const PUBKEY = 'ab'.repeat(32)

describe('fetchNewestKind0', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.mocked(allEvents).mockReset()
  })

  it('falls back to the relay when the gateway cache has nothing', async () => {
    // The failure this exists for: the wallet PUBLISHES profiles to the relay
    // and READS them from the gateway's nostrdb, so a cold or lagging cache
    // reports no profile for a profile that is sitting on the relay — a blank
    // avatar after login, and merchants' coupons with no merchant on them.
    gatewayReturns({ events: [] })
    vi.mocked(allEvents).mockResolvedValue([
      { content: '{"name":"Older"}', created_at: 100 },
      { content: '{"name":"Rosa Green Farm"}', created_at: 900 },
    ] as never)

    expect(await fetchNewestKind0(PUBKEY)).toEqual({
      content: '{"name":"Rosa Green Farm"}',
      createdAt: 900,
    })
  })

  it('falls back when the gateway rejects the request outright', async () => {
    gatewayReturns({}, false)
    vi.mocked(allEvents).mockResolvedValue([{ content: '{}', created_at: 1 }] as never)

    expect(await fetchNewestKind0(PUBKEY)).not.toBeNull()
  })

  it('prefers the relay when it holds a newer profile than the cache', async () => {
    // The failure this exists for: the gateway's relay ingest subscribes to
    // kind 1059 only, so a profile published to the relay never reaches its
    // nostrdb. Answering from the cache because it answered at all pins every
    // merchant to the profile they registered with — upload a logo, see it on
    // your own profile, and every customer keeps seeing your initials.
    gatewayReturns({ events: [{ content: '{"name":"Rosa"}', createdAt: 900 }] })
    vi.mocked(allEvents).mockResolvedValue([
      { content: '{"name":"Rosa","picture":"http://blossom/logo.webp"}', created_at: 1200 },
    ] as never)

    expect(await fetchNewestKind0(PUBKEY)).toEqual({
      content: '{"name":"Rosa","picture":"http://blossom/logo.webp"}',
      createdAt: 1200,
    })
  })

  it('keeps the cached profile when the relay only has an older one', async () => {
    gatewayReturns({ events: [{ content: '{"name":"Rosa"}', createdAt: 900 }] })
    vi.mocked(allEvents).mockResolvedValue([{ content: '{"name":"Stale"}', created_at: 100 }] as never)

    expect(await fetchNewestKind0(PUBKEY)).toEqual({ content: '{"name":"Rosa"}', createdAt: 900 })
  })

  it('keeps the cached profile when the relay is unreachable', async () => {
    gatewayReturns({ events: [{ content: '{"name":"Rosa"}', createdAt: 900 }] })
    vi.mocked(allEvents).mockRejectedValue(new Error('no relay'))

    expect(await fetchNewestKind0(PUBKEY)).toEqual({ content: '{"name":"Rosa"}', createdAt: 900 })
  })

  it('returns null, not a rejection, when neither store answers', async () => {
    gatewayReturns({ events: [] })
    vi.mocked(allEvents).mockRejectedValue(new Error('no relay'))

    expect(await fetchNewestKind0(PUBKEY)).toBeNull()
  })
})

describe('brandingFromKind0', () => {
  it('maps a kind-0 profile onto MerchantBranding', () => {
    // The field names are not ours to choose — MerchantBranding's javadoc names
    // kind-0 name/picture/banner as the source, so these four are a contract.
    const branding = brandingFromKind0(
      JSON.stringify({
        name: 'Rosa Green Farm',
        nip05: 'rosa@x.test',
        picture: 'https://example.test/logo.png',
        banner: 'https://example.test/banner.png',
        about: 'Organic veg, Saturdays',
      }),
    )

    expect(branding.organizationName).toBe('Rosa Green Farm')
    // Carried so every screen that names someone gets their handle from the
    // fetch it already makes, instead of a second lookup per merchant.
    expect(branding.nip05).toBe('rosa@x.test')
    expect(branding.logoUrl).toBe('https://example.test/logo.png')
    expect(branding.bannerUrl).toBe('https://example.test/banner.png')
    expect(branding.storeDescription).toBe('Organic veg, Saturdays')
  })

  it('falls back to display_name only when name is absent', () => {
    expect(brandingFromKind0(JSON.stringify({ display_name: 'Rosa' })).organizationName).toBe(
      'Rosa',
    )
    expect(
      brandingFromKind0(JSON.stringify({ name: 'Rosa Green Farm', display_name: 'Rosa' }))
        .organizationName,
    ).toBe('Rosa Green Farm')
  })

  it.each([
    ['malformed JSON', 'not json at all'],
    ['a JSON null', 'null'],
    ['an empty object', '{}'],
    ['blank strings', JSON.stringify({ name: '   ', picture: '' })],
    ['non-string fields', JSON.stringify({ name: 42, picture: { url: 'x' } })],
  ])('yields empty branding for %s rather than throwing', (_label, content) => {
    // kind-0 content is user-authored and arrives as a string inside a string.
    // A profile we cannot read is not an error: the pass has a full set of
    // defaults, so the card renders either way.
    const branding = brandingFromKind0(content)

    expect(branding.organizationName).toBeUndefined()
    expect(branding.logoUrl).toBeUndefined()
  })

  it('trims surrounding whitespace', () => {
    expect(brandingFromKind0(JSON.stringify({ name: '  Rosa  ' })).organizationName).toBe('Rosa')
  })

  it.each([
    ['https', 'https://example.test/logo.png', true],
    ['data', 'data:image/png;base64,iVBORw0KGgo=', true],
    ['http', 'http://example.test/logo.png', false],
    ['javascript', 'javascript:alert(1)', false],
    ['protocol-relative', '//example.test/logo.png', false],
    ['not a url', 'definitely not a url', false],
    // Loopback http. The local Blossom server hands out
    // http://localhost:28089/<hash>.webp, that URL is what gets written into the
    // user's kind-0, and dropping it here made a saved avatar and banner vanish
    // on the next login — the fields were filtered out of the restored profile
    // and a logged-out device has no local copy left to fall back to.
    ['loopback http', 'http://localhost:28089/abc.webp', true],
    ['loopback http by ip', 'http://127.0.0.1:28089/abc.webp', true],
    ['loopback http ipv6', 'http://[::1]:28089/abc.webp', true],
    // The carve-out is on the parsed hostname, so a name that merely STARTS with
    // localhost resolves wherever its owner points it and stays rejected.
    ['lookalike host', 'http://localhost.evil.test/logo.png', false],
  ])('%s image URL is %s kept=%s', (_label, picture, kept) => {
    // These URLs come from a kind-0 the ISSUER publishes about themselves — a
    // host they may control — and there is no CSP on this app. Allow-list, not
    // deny-list, so an unanticipated scheme fails closed.
    const branding = brandingFromKind0(JSON.stringify({ picture, banner: picture }))

    expect(branding.logoUrl).toBe(kept ? picture : undefined)
    expect(branding.bannerUrl).toBe(kept ? picture : undefined)
  })

  it('keeps the name even when the picture is rejected', () => {
    // A bad image must not cost the merchant their name — the pass still needs to
    // say who it is from.
    const branding = brandingFromKind0(
      JSON.stringify({ name: 'Rosa Green Farm', picture: 'javascript:alert(1)' }),
    )

    expect(branding.organizationName).toBe('Rosa Green Farm')
    expect(branding.logoUrl).toBeUndefined()
  })
})

describe('merchantBranding', () => {
  afterEach(() => {
    clearBrandingCache()
    vi.unstubAllGlobals()
    vi.mocked(allEvents).mockReset()
  })

  const answers = (events: unknown[]) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false } as unknown as Response))
    vi.mocked(allEvents).mockResolvedValue(events as never)
  }

  it('caches a shop that was found — one fetch, not one per card', async () => {
    answers([{ content: '{"name":"Rosa Green Farm"}', created_at: 900 }])

    expect((await merchantBranding(PUBKEY)).organizationName).toBe('Rosa Green Farm')
    expect((await merchantBranding(PUBKEY)).organizationName).toBe('Rosa Green Farm')
    expect(allEvents).toHaveBeenCalledOnce()
  })

  it('does NOT cache a lookup that found nothing', async () => {
    // Caching the miss is what pinned a merchant's coupons to a truncated pubkey
    // and "Gift Card" for the life of the page, with the profile on the relay
    // the whole time.
    answers([])
    expect(await merchantBranding(PUBKEY)).toEqual({})

    answers([{ content: '{"name":"Rosa Green Farm"}', created_at: 900 }])
    expect((await merchantBranding(PUBKEY)).organizationName).toBe('Rosa Green Farm')
  })
})
