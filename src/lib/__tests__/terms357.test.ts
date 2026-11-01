import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'

import {
  acceptTerms,
  readTermsAcceptance,
  requireTermsAccepted,
  termsUrl,
  TermsNotAcceptedError,
  TermsNotConfiguredError,
  websiteBaseUrl,
} from '../terms'

/**
 * #357: every new account accepts the Terms and Conditions at
 * `<VITE_WEBSITE_BASE_URL>/terms.html`. The base URL is a build-time value; a
 * build without one never renders a link and never creates an account.
 */
afterEach(() => vi.unstubAllEnvs())

describe('the terms URL comes from VITE_WEBSITE_BASE_URL', () => {
  it('is <base>/terms.html', () => {
    vi.stubEnv('VITE_WEBSITE_BASE_URL', 'https://www.imani.casa')
    expect(termsUrl()).toBe('https://www.imani.casa/terms.html')
  })

  it('tolerates a trailing slash and a sub-path', () => {
    vi.stubEnv('VITE_WEBSITE_BASE_URL', 'https://www.imani.casa/')
    expect(termsUrl()).toBe('https://www.imani.casa/terms.html')
    vi.stubEnv('VITE_WEBSITE_BASE_URL', 'https://example.test/site/')
    expect(termsUrl()).toBe('https://example.test/site/terms.html')
  })

  it('follows whatever base the build names', () => {
    vi.stubEnv('VITE_WEBSITE_BASE_URL', 'https://staging.example.test')
    expect(termsUrl()).toBe('https://staging.example.test/terms.html')
  })

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['blank', '   '],
    ['not a URL', 'www.imani.casa'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a non-http scheme', 'ftp://imani.casa'],
    ['plain http (https only, review of #358)', 'http://www.imani.casa'],
    ['userinfo', 'https://u:p@imani.casa'],
    ['a query', 'https://imani.casa/?x=1'],
    ['a fragment', 'https://imani.casa/#x'],
  ])('is null when the base is %s (never a broken link)', (_name, value) => {
    vi.stubEnv('VITE_WEBSITE_BASE_URL', value as string)
    expect(websiteBaseUrl()).toBeNull()
    expect(termsUrl()).toBeNull()
  })
})

describe('acceptance', () => {
  it('records the linked URL and when', () => {
    vi.stubEnv('VITE_WEBSITE_BASE_URL', 'https://www.imani.casa')
    expect(acceptTerms(1_760_000_000_000)).toEqual({
      url: 'https://www.imani.casa/terms.html',
      acceptedAt: 1_760_000_000_000,
    })
  })

  it('refuses to record one when no terms page is configured', () => {
    vi.stubEnv('VITE_WEBSITE_BASE_URL', '')
    expect(() => acceptTerms()).toThrow(TermsNotConfiguredError)
  })

  it('requireTermsAccepted refuses a missing, malformed or foreign acceptance', () => {
    vi.stubEnv('VITE_WEBSITE_BASE_URL', 'https://www.imani.casa')
    expect(() => requireTermsAccepted(undefined)).toThrow(TermsNotAcceptedError)
    expect(() => requireTermsAccepted(true)).toThrow(TermsNotAcceptedError)
    expect(() => requireTermsAccepted({ url: 'https://www.imani.casa/terms.html' })).toThrow(TermsNotAcceptedError)
    expect(() => requireTermsAccepted({ url: 'https://other.test/terms.html', acceptedAt: 1 })).toThrow(
      TermsNotAcceptedError,
    )
    expect(requireTermsAccepted(acceptTerms(5))).toEqual({ url: 'https://www.imani.casa/terms.html', acceptedAt: 5 })
  })

  it('requireTermsAccepted refuses with plain copy when no terms page is configured', () => {
    vi.stubEnv('VITE_WEBSITE_BASE_URL', '')
    expect(() => requireTermsAccepted({ url: 'https://www.imani.casa/terms.html', acceptedAt: 1 })).toThrow(
      /New accounts can't be created/,
    )
  })

  it('readTermsAcceptance keeps only a well-formed record (backups are a trust boundary)', () => {
    expect(readTermsAcceptance({ url: 'https://a.test/terms.html', acceptedAt: 3, extra: 'x' })).toEqual({
      url: 'https://a.test/terms.html',
      acceptedAt: 3,
    })
    expect(readTermsAcceptance({ url: 'javascript:alert(1)', acceptedAt: 3 })).toBeUndefined()
    expect(readTermsAcceptance({ url: 'http://a.test/terms.html', acceptedAt: 3 })).toBeUndefined()
    expect(readTermsAcceptance({ url: 'https://a.test', acceptedAt: -1 })).toBeUndefined()
    expect(readTermsAcceptance({ url: 'https://a.test', acceptedAt: Number.NaN })).toBeUndefined()
    expect(readTermsAcceptance('yes')).toBeUndefined()
    expect(readTermsAcceptance(null)).toBeUndefined()
  })
})

/** The image build fails without the base URL, as it does without a trusted mint. */
describe('scripts/check-website-base-url-build.sh', () => {
  const build = (env: Record<string, string>) => {
    const r = spawnSync('sh', ['scripts/check-website-base-url-build.sh'], {
      env: { PATH: process.env.PATH ?? '', ...env },
      encoding: 'utf8',
    })
    return { status: r.status, out: `${r.stdout}${r.stderr}` }
  }

  it('fails when VITE_WEBSITE_BASE_URL is unset or blank', () => {
    const unset = build({})
    expect(unset.status).not.toBe(0)
    expect(unset.out).toContain('VITE_WEBSITE_BASE_URL is unset')
    expect(build({ VITE_WEBSITE_BASE_URL: '  ' }).status).not.toBe(0)
  })

  it.each([
    ['no scheme', 'www.imani.casa'],
    ['a non-http scheme', 'ftp://imani.casa'],
    ['plain http (https only, review of #358)', 'http://www.imani.casa'],
    ['userinfo', 'https://u@imani.casa'],
    ['a query', 'https://imani.casa/?x'],
    ['a fragment', 'https://imani.casa/#x'],
    ['no host', 'https:///x'],
  ])('fails for a base with %s', (_n, v) => {
    expect(build({ VITE_WEBSITE_BASE_URL: v }).status).not.toBe(0)
  })

  it('passes for https://www.imani.casa and names the terms page', () => {
    const r = build({ VITE_WEBSITE_BASE_URL: 'https://www.imani.casa' })
    expect(r.status).toBe(0)
    expect(r.out).toContain('https://www.imani.casa/terms.html')
  })
})
