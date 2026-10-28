/**
 * @vitest-environment jsdom
 *
 * The wallet signs sister sites' NAP logins (#411). What it may sign, for whom.
 */
import { describe, expect, it } from 'vitest'

import { GIFTING_ORIGIN, signerPolicy, siteDescription, siteName, SUBSCRIPTION_ORIGIN } from '../napSignerPolicy'

describe('the sister-site signer policy', () => {
  it('names the subscription and gifting sites, each on its own origin', () => {
    expect(SUBSCRIPTION_ORIGIN).toBe('https://subscription.imani.casa')
    expect(GIFTING_ORIGIN).toBe('https://gifting.imani.casa')
    expect(Object.keys(signerPolicy()).sort()).toEqual([GIFTING_ORIGIN, SUBSCRIPTION_ORIGIN].sort())
  })

  it('lets each site have signed only NAP proofs addressed to ITSELF', () => {
    const policy = signerPolicy()
    expect(policy[SUBSCRIPTION_ORIGIN]).toMatchObject({ kinds: [27235], audiences: [SUBSCRIPTION_ORIGIN] })
    expect(policy[GIFTING_ORIGIN]).toMatchObject({ kinds: [27235], audiences: [GIFTING_ORIGIN] })
    // Neither may obtain a proof for the other, or for the wallet's own gateway.
    expect(policy[SUBSCRIPTION_ORIGIN].audiences).not.toContain(GIFTING_ORIGIN)
    expect(policy[SUBSCRIPTION_ORIGIN].audiences).not.toContain(window.location.origin)
  })

  it('keeps grants short: minutes, not a session', () => {
    for (const entry of Object.values(signerPolicy())) expect(entry.maxTtlSeconds).toBeLessThanOrEqual(300)
  })

  it('describes the site by host, in words', () => {
    expect(siteName(SUBSCRIPTION_ORIGIN)).toBe('subscription.imani.casa')
    expect(siteDescription(SUBSCRIPTION_ORIGIN)).toMatch(/plan/)
  })
})
