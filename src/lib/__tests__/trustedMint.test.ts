import { describe, expect, it, vi, afterEach } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'

import {
  checkMintAndUnit,
  trustedMintUrls,
  gatewayConfigLoaded,
  TOKEN_UNIT,
} from '../trustedMint'
import { parseVoucherToken } from '../voucherToken'

/**
 * Which mint, and which unit, this build will credit a coupon from.
 *
 * ## The hole this closes
 *
 * A coupon's value does not live in the coupon. It lives in the proofs, at a
 * mint. `verifyVoucher` checks that the issuer signed the terms, and the issuer
 * signature covers no mint at all, so a copy of a perfectly genuine signed
 * voucher backed by proofs from a mint nobody has heard of verifies exactly as
 * well as the real one. Until this module the wallet read the token's mint URL
 * and unit and then checked neither.
 *
 * It matters more now the wallet swaps its own receives, because the mint URL
 * stops being a field we merely record and becomes the address we send money to.
 *
 * ## Why `voucher.unit` is deliberately NOT what is checked
 *
 * This looks like an off-by-one field and it is the trap worth naming. Measured
 * on the captured fixtures, every token's `u` is `sat`, while `voucher.unit`
 * ranges over currencies: `live-licence.token` is a GBP coupon. They are two
 * different facts. `u` is what the PROOFS are denominated in, `voucher.unit` is
 * what the FACE VALUE is denominated in.
 *
 * Checking `voucher.unit === 'sat'` would therefore refuse every foreign
 * currency coupon we issue, which is a large share of the product. The first
 * test below pins that distinction against the real tokens so nobody "fixes"
 * this into a currency check later.
 */

afterEach(() => {
  vi.unstubAllEnvs()
  delete (globalThis as { GatewayConfig?: unknown }).GatewayConfig
})

const trust = (...urls: string[]) => vi.stubEnv('VITE_TRUSTED_MINT_URLS', urls.join(','))

/**
 * The gateway having answered `/api/v1/config`.
 *
 * `whenReady` fires its callback SYNCHRONOUSLY once the real config module has
 * resolved, which is the contract `gatewayConfigLoaded` reads. Mirrored here rather
 * than faked with a boolean so the test exercises the same signal production does.
 */
const gatewaySays = (mintUrl: string) => {
  ;(globalThis as { GatewayConfig?: unknown }).GatewayConfig = {
    mintUrl,
    whenReady: (callback: () => void) => callback(),
  }
}

/**
 * The script loaded but the fetch still in flight, so `whenReady` DEFERS.
 *
 * This is the window that used to read as "no mint configured" and wave every
 * coupon through. Note it is indistinguishable from a ready gateway by `mintUrl`
 * alone, which is exactly why readiness is read from `whenReady` instead.
 */
const gatewayNotReady = () => {
  ;(globalThis as { GatewayConfig?: unknown }).GatewayConfig = {
    mintUrl: '',
    whenReady: () => {
      /* deferred until the fetch resolves, so never called here */
    },
  }
}

const fixture = (name: string) =>
  readFileSync(`src/lib/__tests__/fixtures/${name}`, 'utf8').trim()

const fixtureTokens = () =>
  readdirSync('src/lib/__tests__/fixtures').filter((f) => f.endsWith('.token'))

describe('what the real tokens say about units', () => {
  /**
   * The measurement that decides which field this module reads. Every captured
   * token denominates its proofs in sat, and at least one denominates its face
   * value in something else. So the two fields cannot be checked with one rule.
   */
  it('denominate proofs in sat while face value may be any currency', () => {
    const units = fixtureTokens().map((f) => {
      const parsed = parseVoucherToken(fixture(f))
      return { token: parsed.unit, voucher: parsed.voucher.unit }
    })

    expect(units.length).toBeGreaterThan(0)
    expect(units.every((u) => u.token === TOKEN_UNIT)).toBe(true)
    // The point of the test: at least one fixture proves the fields differ, so
    // a single rule over both would refuse a genuine coupon.
    expect(units.some((u) => u.voucher.toLowerCase() !== TOKEN_UNIT)).toBe(true)
  })

  /** A real GBP coupon must pass, because its PROOFS are still sat. */
  it('accepts a foreign-currency coupon whose proofs are sat', () => {
    const parsed = parseVoucherToken(fixture('live-licence.token'))
    expect(parsed.voucher.unit).not.toBe(TOKEN_UNIT)

    trust(parsed.mintUrl)
    expect(checkMintAndUnit(parsed)).toBe('trusted')
  })
})

describe('the unit of the proofs', () => {
  const parsedFixture = () => parseVoucherToken(fixture('control-unlocked.token'))

  it('refuses a token whose proofs are not sat', () => {
    const parsed = parsedFixture()
    trust(parsed.mintUrl)
    expect(checkMintAndUnit({ ...parsed, unit: 'usd' })).toBe('wrong-unit')
  })

  it('refuses a token with no unit at all', () => {
    const parsed = parsedFixture()
    trust(parsed.mintUrl)
    expect(checkMintAndUnit({ ...parsed, unit: '' })).toBe('wrong-unit')
  })

  /**
   * `SAT` and `sat` are the same unit. A case-sensitive compare here would
   * refuse money over a capital letter.
   */
  it('accepts sat in any case', () => {
    const parsed = parsedFixture()
    trust(parsed.mintUrl)
    expect(checkMintAndUnit({ ...parsed, unit: 'SAT' })).toBe('trusted')
  })
})

describe('the mint the proofs came from', () => {
  const parsedFixture = () => parseVoucherToken(fixture('control-unlocked.token'))

  it('accepts a mint on the trusted list', () => {
    const parsed = parsedFixture()
    trust(parsed.mintUrl)
    expect(checkMintAndUnit(parsed)).toBe('trusted')
  })

  it('refuses a mint that is not on the list', () => {
    const parsed = parsedFixture()
    trust('https://mint.example.test')
    expect(checkMintAndUnit(parsed)).toBe('untrusted-mint')
  })

  it('refuses a token carrying no mint URL', () => {
    trust('https://mint.example.test')
    expect(checkMintAndUnit({ ...parsedFixture(), mintUrl: '' })).toBe('untrusted-mint')
  })

  /**
   * A rotation spans two mints at once, so the list is a list. A single pinned
   * value would force a flag day, which is the same finding that shaped
   * `issuerAllowlist`.
   */
  it('accepts any mint on a multi-entry list', () => {
    const parsed = parsedFixture()
    trust('https://mint.example.test', parsed.mintUrl, 'https://other.example.test')
    expect(checkMintAndUnit(parsed)).toBe('trusted')
  })

  /**
   * A trailing slash is the same mint. This is not cosmetic: the gateway's
   * config and a hand-typed environment variable disagree about it routinely,
   * and refusing money over one character would be the likeliest way this check
   * strands a real coupon.
   */
  it('ignores a trailing slash on either side', () => {
    const parsed = parsedFixture()
    trust(parsed.mintUrl + '/')
    expect(checkMintAndUnit(parsed)).toBe('trusted')

    trust(parsed.mintUrl.replace(/\/+$/, ''))
    expect(checkMintAndUnit({ ...parsed, mintUrl: parsed.mintUrl + '/' })).toBe('trusted')
  })

  /** Hostnames are case-insensitive, so the comparison must be too. */
  it('ignores case in the mint URL', () => {
    const parsed = parsedFixture()
    trust(parsed.mintUrl.toUpperCase())
    expect(checkMintAndUnit(parsed)).toBe('trusted')
  })
})

describe('when no mint is configured', () => {
  /**
   * The direction of the default, which is the one decision here that can strand
   * money.
   *
   * `issuerAllowlist` fails OPEN when unset, reasoning that refusing every coupon
   * on an unconfigured deployment turns money off. That carries over only when we
   * KNOW nothing is configured. This case is the gateway having answered and named
   * no mint, which is a genuine deployment choice.
   */
  it('makes no claim when the gateway has answered and names no mint', () => {
    vi.stubEnv('VITE_TRUSTED_MINT_URLS', '')
    gatewaySays('')
    expect(trustedMintUrls()).toEqual([])
    expect(checkMintAndUnit(parseVoucherToken(fixture('control-unlocked.token')))).toBe('unchecked')
  })

  /**
   * The unit is checked even with no mint configured. It needs no configuration,
   * so there is no reason to let it lapse with the mint.
   */
  it('still refuses a non-sat unit', () => {
    vi.stubEnv('VITE_TRUSTED_MINT_URLS', '')
    gatewaySays('')
    const parsed = parseVoucherToken(fixture('control-unlocked.token'))
    expect(checkMintAndUnit({ ...parsed, unit: 'usd' })).toBe('wrong-unit')
  })
})

describe('the gateway mint fallback', () => {
  /**
   * The fallback is the whole argument for the default direction, and it had no
   * test at all: replacing it with an empty array left all 19 tests green. The
   * module claims a wallet told which mint to use is "protected without anybody
   * configuring anything", and that claim now has evidence.
   */
  it('trusts the mint the gateway names, with nothing else configured', () => {
    vi.stubEnv('VITE_TRUSTED_MINT_URLS', '')
    const parsed = parseVoucherToken(fixture('control-unlocked.token'))
    gatewaySays(parsed.mintUrl)

    expect(trustedMintUrls()).toEqual([parsed.mintUrl.toLowerCase()])
    expect(checkMintAndUnit(parsed)).toBe('trusted')
  })

  /** And it still refuses a different mint, so the fallback is a gate not a pass. */
  it('refuses another mint even when the gateway names one', () => {
    vi.stubEnv('VITE_TRUSTED_MINT_URLS', '')
    gatewaySays('https://mint.example.test')
    expect(checkMintAndUnit(parseVoucherToken(fixture('control-unlocked.token')))).toBe(
      'untrusted-mint',
    )
  })

  /** Both sources combine, so a migration can span the configured and the reported mint. */
  it('combines the configured list with the gateway mint', () => {
    const parsed = parseVoucherToken(fixture('control-unlocked.token'))
    trust('https://mint.example.test')
    gatewaySays(parsed.mintUrl)

    expect(trustedMintUrls()).toHaveLength(2)
    expect(checkMintAndUnit(parsed)).toBe('trusted')
  })
})

describe('before the gateway config has arrived', () => {
  /**
   * The finding that mattered most in review. `/api/v1/config` is fetched
   * asynchronously, and `shared/gateway-config.js` is itself loaded lazily, so
   * there is a window where no mint is known.
   *
   * Treating that window as "nothing configured" returned `unchecked` and waved
   * every coupon through, which means anyone who can merely DELAY one request
   * turns the whole gate off. A slow network or an unretried 500 would do it. So
   * "not knowable yet" is now its own verdict and callers refuse on it.
   */
  it('reports not-ready rather than unchecked', () => {
    vi.stubEnv('VITE_TRUSTED_MINT_URLS', '')
    gatewayNotReady()
    expect(checkMintAndUnit(parseVoucherToken(fixture('control-unlocked.token')))).toBe('not-ready')
  })

  /**
   * A config script that was never loaded is NOT a pending fetch.
   *
   * `shared/gateway-config.js` is pulled in lazily by the legacy bridge, so on a
   * path that never touches it `GatewayConfig` is absent for ever rather than
   * briefly. Deferring on that would refuse every coupon permanently, which is the
   * opposite failure and a worse one. Only a config that is PRESENT and has not
   * resolved is worth waiting for.
   */
  it('does not defer when the config script was never loaded', () => {
    vi.stubEnv('VITE_TRUSTED_MINT_URLS', '')
    expect(gatewayConfigLoaded()).toBe(true)
    expect(checkMintAndUnit(parseVoucherToken(fixture('control-unlocked.token')))).toBe('unchecked')
  })

  /**
   * An explicitly configured list needs no gateway at all, so a deployment that
   * sets the variable is never subject to this race.
   */
  it('is unaffected when the list is configured explicitly', () => {
    const parsed = parseVoucherToken(fixture('control-unlocked.token'))
    trust(parsed.mintUrl)
    gatewayNotReady()
    expect(checkMintAndUnit(parsed)).toBe('trusted')
  })

  /** The unit is still checked: it depends on nothing that can be delayed. */
  it('still refuses a non-sat unit before the config arrives', () => {
    vi.stubEnv('VITE_TRUSTED_MINT_URLS', '')
    const parsed = parseVoucherToken(fixture('control-unlocked.token'))
    expect(checkMintAndUnit({ ...parsed, unit: 'usd' })).toBe('wrong-unit')
  })
})

describe('trustedMintUrls', () => {
  it('reads a comma-separated list, trimming and lowercasing', () => {
    trust(' https://A.example.test , https://b.example.test ')
    expect(trustedMintUrls()).toEqual(['https://a.example.test', 'https://b.example.test'])
  })

  it('drops empty entries rather than trusting the empty string', () => {
    trust('https://a.example.test', '', '  ')
    expect(trustedMintUrls()).toEqual(['https://a.example.test'])
  })

  it('normalises trailing slashes so the list and the token agree', () => {
    trust('https://a.example.test/')
    expect(trustedMintUrls()).toEqual(['https://a.example.test'])
  })
})
