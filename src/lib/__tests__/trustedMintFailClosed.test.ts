import { afterEach, describe, expect, it, vi } from 'vitest'

import { clearConfigCache, gatewayMintConfig } from '../config'
import {
  checkMintAndUnit,
  checkTokenBacking,
  loadTrustedMints,
  normaliseMintUrl,
  onTrustedMintsChange,
  trustedMintUrls,
} from '../trustedMint'
import { candidateClaim } from '../claimReconcile'
import { gatewayAnswers, configBody, resetGate } from './trustedMintKit'
import { buildPlainToken, buildVoucherToken } from './voucherFixtures'

/**
 * The second review of #131/#133.
 *
 * The first fix made "not loaded yet" a deferral rather than a pass. The review
 * found the gate was still OFF wherever the gateway answered and named no mint
 * (beta and prod, where `mint_url` was never configured), and that a mismatch
 * between the two services' mint settings DROPPED coupons for good. These tests
 * pin the corrected behaviour.
 */

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  resetGate()
})

const STAGING = 'https://mint.staging.398ja.xyz'

describe('a build that knows no trusted mint from any source (HIGH-1)', () => {
  /**
   * The #133 symptom again: the gateway answers, names no mint, and the build
   * names none. That used to read as `unchecked` and credit coupons from any mint.
   * It is now its own verdict, and it is not a pass.
   */
  it('reports no-trusted-mint rather than unchecked', async () => {
    vi.stubEnv('VITE_TRUSTED_MINT_URLS', '')
    await gatewayAnswers('')
    expect(checkMintAndUnit({ mintUrl: 'https://rogue.example.test', unit: 'sat' })).toBe('no-trusted-mint')
  })

  /**
   * Crediting holds the coupon instead of redeeming it: dm-poll keeps the delivery
   * and the wallet shows it as waiting to be verified. Nothing is swapped.
   */
  it('holds a coupon for crediting instead of accepting it', async () => {
    vi.stubEnv('VITE_TRUSTED_MINT_URLS', '')
    await gatewayAnswers('')
    expect(checkTokenBacking(buildPlainToken('https://rogue.example.test'))).toMatchObject({
      outcome: 'hold',
      reason: 'no-trusted-mint',
    })
  })

  /** The stall's claim sweep skips such a coupon too, until a mint is known. */
  it('skips the coupon in the claim sweep', async () => {
    vi.stubEnv('VITE_TRUSTED_MINT_URLS', '')
    await gatewayAnswers('')
    const { token, voucher } = buildVoucherToken()
    expect(candidateClaim({ amount: 0 }, token, voucher.issuerId)).toBeUndefined()
  })

  /**
   * The dev escape hatch: explicit, only in a dev build, and it says so in the
   * console every time it lets something through.
   */
  it('accepts with the explicit dev escape hatch, and logs that it did', async () => {
    vi.stubEnv('VITE_TRUSTED_MINT_URLS', '')
    vi.stubEnv('VITE_ALLOW_ANY_MINT_IN_DEV', 'true')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await gatewayAnswers('')
    expect(checkTokenBacking(buildPlainToken('https://rogue.example.test'))).toEqual({ outcome: 'accept' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('VITE_ALLOW_ANY_MINT_IN_DEV'))
    warn.mockRestore()
  })

  /** The same flag in a production build is ignored: the coupon is still held. */
  it('ignores the escape hatch in a production build', async () => {
    vi.stubEnv('VITE_TRUSTED_MINT_URLS', '')
    vi.stubEnv('VITE_ALLOW_ANY_MINT_IN_DEV', 'true')
    vi.stubEnv('DEV', false)
    vi.stubEnv('PROD', true)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await gatewayAnswers('')
    expect(checkTokenBacking(buildPlainToken('https://rogue.example.test'))).toMatchObject({ outcome: 'hold' })
  })
})

describe('the mints customer-wallet stamps into tokens (HIGH-2)', () => {
  /**
   * The source-of-truth fix: the gateway now serves the URL customer-wallet
   * stamps into `m` as `token_mint_urls`. A token at that mint is trusted even
   * when `mint_url` (the client-mint setting) names a different address.
   */
  it('trusts a token whose mint is in token_mint_urls even when mint_url differs', async () => {
    vi.stubEnv('VITE_TRUSTED_MINT_URLS', '')
    await gatewayAnswers('https://mint-internal.example.test', [STAGING])
    expect(trustedMintUrls()).toContain(STAGING)
    expect(checkTokenBacking(buildPlainToken(STAGING))).toEqual({ outcome: 'accept' })
  })

  /** token_mint_urls alone is enough: the gateway need not name a client-mint URL. */
  it('trusts token_mint_urls when mint_url is absent', async () => {
    vi.stubEnv('VITE_TRUSTED_MINT_URLS', '')
    await gatewayAnswers('', [STAGING])
    expect(checkMintAndUnit({ mintUrl: STAGING, unit: 'sat' })).toBe('trusted')
  })

  /**
   * A mismatch is never terminal. A token at a mint nobody named is HELD, so the
   * delivery stays unconsumed and is offered again after a config change, rather
   * than refused and marked processed.
   */
  it('holds, never refuses, a token at an unlisted mint', async () => {
    await gatewayAnswers(STAGING, [STAGING])
    expect(checkTokenBacking(buildPlainToken('https://mint.imani.casa'))).toMatchObject({
      outcome: 'hold',
      reason: 'untrusted-mint',
    })
  })

  /** Junk in the list is dropped rather than trusted. */
  it('ignores entries in token_mint_urls that are not mint URLs', async () => {
    vi.stubEnv('VITE_TRUSTED_MINT_URLS', '')
    await gatewayAnswers('', ['', 'not a url', 'https://user:pw@mint.example.test', STAGING])
    expect(trustedMintUrls()).toEqual([STAGING])
  })
})

describe('reading the mint config does not depend on the NIP-05 domain (MEDIUM-2)', () => {
  /**
   * A gateway that answers without a NIP-05 domain used to throw in the config
   * parser, so the mint was never learned and every coupon deferred for ever.
   */
  it('reads the mints from a config that names no NIP-05 domain', async () => {
    clearConfigCache()
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ mint_url: STAGING, token_mint_urls: [STAGING] })))
    await expect(gatewayMintConfig()).resolves.toEqual({ mintUrl: STAGING, tokenMintUrls: [STAGING] })
  })

  /** And the gate learns the mint from that same config. */
  it('lets the gate learn the mint from a config with no NIP-05 domain', async () => {
    vi.stubEnv('VITE_TRUSTED_MINT_URLS', '')
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ mint_url: STAGING })))
    await loadTrustedMints()
    expect(checkMintAndUnit({ mintUrl: STAGING, unit: 'sat' })).toBe('trusted')
  })
})

describe('a deferral heals itself (MEDIUM-2)', () => {
  /**
   * The config fetch fails at start-up. Nothing has to happen for the gate to
   * recover: it retries on a backoff, and when the gateway answers it tells its
   * listeners, which is what triggers the poller's catch-up.
   */
  it('retries a failed config load on a backoff and announces the recovery', async () => {
    vi.useFakeTimers()
    vi.stubEnv('VITE_TRUSTED_MINT_URLS', '')
    let reachable = false
    const fetch = vi.fn(async () => {
      if (!reachable) throw new TypeError('network down')
      return Response.json(configBody(STAGING))
    })
    vi.stubGlobal('fetch', fetch)
    const changed = vi.fn()
    const unsubscribe = onTrustedMintsChange(changed)

    await loadTrustedMints()
    expect(checkMintAndUnit({ mintUrl: STAGING, unit: 'sat' })).toBe('not-ready')

    // The first retry, five seconds on, still fails.
    await vi.advanceTimersByTimeAsync(5_000)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(changed).not.toHaveBeenCalled()

    // The gateway comes back; the next retry (ten seconds later) succeeds.
    reachable = true
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(changed).toHaveBeenCalledTimes(1)
    expect(checkMintAndUnit({ mintUrl: STAGING, unit: 'sat' })).toBe('trusted')
    unsubscribe()
  })

  /** The backoff is capped at five minutes, so a long outage is still retried. */
  it('caps the retry interval at five minutes', async () => {
    vi.useFakeTimers()
    vi.stubEnv('VITE_TRUSTED_MINT_URLS', '')
    const fetch = vi.fn(async () => {
      throw new TypeError('network down')
    })
    vi.stubGlobal('fetch', fetch)

    await loadTrustedMints()
    // 5 + 10 + 20 + 40 + 80 + 160 seconds, then 300 each.
    await vi.advanceTimersByTimeAsync(315_000)
    const before = fetch.mock.calls.length
    await vi.advanceTimersByTimeAsync(300_000)
    expect(fetch.mock.calls.length).toBe(before + 1)
  })

  /**
   * A gateway that answers but names no mint is also re-asked, so fixing the
   * config releases the held coupons without a page reload.
   */
  it('re-asks a gateway that named no mint and announces when it names one', async () => {
    vi.useFakeTimers()
    vi.stubEnv('VITE_TRUSTED_MINT_URLS', '')
    let named = ''
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(configBody(named))))
    const changed = vi.fn()
    const unsubscribe = onTrustedMintsChange(changed)

    await loadTrustedMints()
    expect(checkMintAndUnit({ mintUrl: STAGING, unit: 'sat' })).toBe('no-trusted-mint')

    named = STAGING
    await vi.advanceTimersByTimeAsync(5_000)
    expect(changed).toHaveBeenCalled()
    expect(checkMintAndUnit({ mintUrl: STAGING, unit: 'sat' })).toBe('trusted')
    unsubscribe()
  })
})

describe('normaliseMintUrl refuses URL components a mint URL never has (LOW-1)', () => {
  /**
   * Userinfo, a query or a fragment would let two different strings name "the
   * same" mint, or smuggle credentials into a URL the wallet sends money to.
   * Each normalises to '', which is never trusted.
   */
  it.each([
    ['userinfo', 'https://user:pw@mint.example.test'],
    ['a bare username', 'https://user@mint.example.test'],
    ['an empty userinfo', 'https://@mint.example.test'],
    ['a query', 'https://mint.example.test/?x=1'],
    ['an empty query', 'https://mint.example.test/?'],
    ['a fragment', 'https://mint.example.test/#frag'],
    ['an empty fragment', 'https://mint.example.test#'],
  ])('refuses %s', (_name, url) => {
    expect(normaliseMintUrl(url)).toBe('')
  })

  /** The control: the plain URL still normalises. */
  it('still accepts a plain mint URL', () => {
    expect(normaliseMintUrl('https://Mint.Example.test/cashu/')).toBe('https://mint.example.test/cashu')
  })
})
