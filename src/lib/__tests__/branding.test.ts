import { describe, expect, it } from 'vitest'

import { brandingFromKind0 } from '../branding'

describe('brandingFromKind0', () => {
  it('maps a kind-0 profile onto MerchantBranding', () => {
    // The field names are not ours to choose — MerchantBranding's javadoc names
    // kind-0 name/picture/banner as the source, so these four are a contract.
    const branding = brandingFromKind0(
      JSON.stringify({
        name: 'Rosa Green Farm',
        picture: 'https://example.test/logo.png',
        banner: 'https://example.test/banner.png',
        about: 'Organic veg, Saturdays',
      }),
    )

    expect(branding.organizationName).toBe('Rosa Green Farm')
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
    // A bad image must not cost the farmer their name — the pass still needs to
    // say who it is from.
    const branding = brandingFromKind0(
      JSON.stringify({ name: 'Rosa Green Farm', picture: 'javascript:alert(1)' }),
    )

    expect(branding.organizationName).toBe('Rosa Green Farm')
    expect(branding.logoUrl).toBeUndefined()
  })
})
