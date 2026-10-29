/**
 * @vitest-environment jsdom
 *
 * The wallet signs sister sites' NAP logins (#411). What it may sign, for whom, and where the sites
 * are: per-environment configuration only (VITE_SUBSCRIPTION_SITE_URL, VITE_GIFTING_SITE_URL).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { giftingOrigin, signerPolicy, siteDescription, siteName, subscriptionOrigin } from '../napSignerPolicy'
import { giftingSiteUrl, subscriptionSiteUrl } from '../sisterSites'

const SUB = 'https://subscription.example.test'
const GIFT = 'https://gifting.example.test'

afterEach(() => vi.unstubAllEnvs())

function configure(sub = SUB, gift = GIFT) {
  vi.stubEnv('VITE_SUBSCRIPTION_SITE_URL', sub)
  vi.stubEnv('VITE_GIFTING_SITE_URL', gift)
}

describe('where the sister sites are', () => {
  it('comes only from the env: nothing configured, no site and nothing to sign for', () => {
    configure('', '')
    expect(subscriptionSiteUrl()).toBeNull()
    expect(giftingSiteUrl()).toBeNull()
    expect(signerPolicy()).toEqual({})
  })

  it('takes each environment\'s own URL, trailing slash or not', () => {
    configure(`${SUB}/`, 'http://localhost:18940')
    expect(subscriptionSiteUrl()).toBe(SUB)
    expect(giftingSiteUrl()).toBe('http://localhost:18940')
  })

  it('ignores a value that is not an http(s) URL', () => {
    configure('subscription.imani.casa', 'javascript:alert(1)')
    expect(subscriptionSiteUrl()).toBeNull()
    expect(giftingSiteUrl()).toBeNull()
  })
})

describe('the sister-site signer policy', () => {
  it('names the configured sites, each on its own origin', () => {
    configure()
    expect(subscriptionOrigin()).toBe(SUB)
    expect(giftingOrigin()).toBe(GIFT)
    expect(Object.keys(signerPolicy()).sort()).toEqual([GIFT, SUB].sort())
  })

  it('lets each site have signed only NAP proofs addressed to ITSELF', () => {
    configure()
    const policy = signerPolicy()
    expect(policy[SUB]).toMatchObject({ kinds: [27235], audiences: [SUB] })
    expect(policy[GIFT]).toMatchObject({ kinds: [27235], audiences: [GIFT] })
    // Neither may obtain a proof for the other, or for the wallet's own gateway.
    expect(policy[SUB].audiences).not.toContain(GIFT)
    expect(policy[SUB].audiences).not.toContain(window.location.origin)
  })

  it('keeps grants short: minutes, not a session', () => {
    configure()
    for (const entry of Object.values(signerPolicy())) expect(entry.maxTtlSeconds).toBeLessThanOrEqual(300)
  })

  it('describes the site by host, in words', () => {
    configure()
    expect(siteName(SUB)).toBe('subscription.example.test')
    expect(siteDescription(SUB)).toMatch(/plan/)
    expect(siteDescription(GIFT)).toMatch(/gift/)
  })
})
