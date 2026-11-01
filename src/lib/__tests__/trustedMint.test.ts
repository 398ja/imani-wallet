import { describe, expect, it, vi, afterEach } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'

import {
  checkMintAndUnit,
  normaliseMintUrl,
  readTokenBacking,
  trustedMintUrls,
  trustedMintsKnown,
  TOKEN_UNIT,
} from '../trustedMint'
import { parseVoucherToken } from '../voucherToken'
import { gatewayAnswers, gatewayUnreachable, resetGate } from './trustedMintKit'
import { buildLegacyToken, buildPlainToken } from './voucherFixtures'

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
  vi.unstubAllGlobals()
  resetGate()
})

const trust = (...urls: string[]) => vi.stubEnv('VITE_TRUSTED_MINT_URLS', urls.join(','))

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

  /** Proofs in dollars at our own mint are still refused: we cannot read their amounts. */
  it('refuses a token whose proofs are not sat', () => {
    const parsed = parsedFixture()
    trust(parsed.mintUrl)
    expect(checkMintAndUnit({ ...parsed, unit: 'usd' })).toBe('wrong-unit')
  })

  /** A token that declines to name its unit is refused, not assumed to be sat. */
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

  /** The coupon's own mint, on the list, is accepted. */
  it('accepts a mint on the trusted list', () => {
    const parsed = parsedFixture()
    trust(parsed.mintUrl)
    expect(checkMintAndUnit(parsed)).toBe('trusted')
  })

  /** The same coupon is refused when the list names a different mint. */
  it('refuses a mint that is not on the list', () => {
    const parsed = parsedFixture()
    trust('https://mint.example.test')
    expect(checkMintAndUnit(parsed)).toBe('untrusted-mint')
  })

  /** A token that says nothing about where its value is cannot be at a trusted mint. */
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

  /**
   * The PUBLIC mint URL is what the gateway stamps into a token's `m` and serves
   * as `mint_url`, while it calls the mint on an internal address. A token from
   * our own staging mint must therefore pass against the public URL, with or
   * without the trailing slash a hand-typed variable tends to carry.
   */
  it.each([
    ['the public URL', 'https://mint.staging.398ja.xyz'],
    ['the public URL with a trailing slash', 'https://mint.staging.398ja.xyz/'],
    ['the public URL with an explicit default port', 'https://mint.staging.398ja.xyz:443'],
    ['the public URL in capitals', 'HTTPS://MINT.STAGING.398JA.XYZ'],
  ])('accepts a staging token when the list names %s', (_name, listed) => {
    trust(listed)
    const token = buildPlainToken('https://mint.staging.398ja.xyz/')
    expect(checkMintAndUnit(readTokenBacking(token))).toBe('trusted')
  })

  /**
   * The internal address is a different mint as far as the gate can tell, and a
   * browser could not reach it anyway. A token naming it is refused against the
   * public URL, so nobody can route a coupon at an address that merely resolves
   * to our mint inside the stack.
   */
  it('refuses a token naming the internal mint address when only the public one is trusted', () => {
    trust('https://mint.staging.398ja.xyz')
    const token = buildPlainToken('http://imani-mint-rest:7777')
    expect(checkMintAndUnit(readTokenBacking(token))).toBe('untrusted-mint')
  })

  /**
   * A lookalike host is a different mint. Normalisation must not be so loose that
   * a suffix, a subdomain or a different scheme compares equal.
   */
  it.each([
    ['a lookalike suffix', 'https://mint.staging.398ja.xyz.evil.test'],
    ['a different subdomain', 'https://evil.mint.staging.398ja.xyz'],
    ['plain http', 'http://mint.staging.398ja.xyz'],
    ['a different port', 'https://mint.staging.398ja.xyz:8443'],
    ['userinfo smuggling the host', 'https://mint.staging.398ja.xyz@evil.test'],
  ])('refuses %s of the trusted mint', (_name, rogue) => {
    trust('https://mint.staging.398ja.xyz')
    expect(checkMintAndUnit(readTokenBacking(buildPlainToken(rogue)))).toBe('untrusted-mint')
  })
})

describe('normaliseMintUrl', () => {
  /** Scheme and host case, a default port and a trailing slash are incidental. */
  it('drops what does not change which mint is meant', () => {
    expect(normaliseMintUrl(' HTTPS://Mint.Example.Test:443/ ')).toBe('https://mint.example.test')
  })

  /** The path is part of the mint's address, and its case is significant. */
  it('keeps the path and its case', () => {
    expect(normaliseMintUrl('https://mint.example.test/Cashu/')).toBe('https://mint.example.test/Cashu')
  })

  /** Anything that is not an http(s) URL reads as no mint, which is never trusted. */
  it.each(['', 'not a url', 'javascript:alert(1)', 'ftp://mint.example.test'])(
    'reads %j as no mint at all',
    (input) => {
      expect(normaliseMintUrl(input)).toBe('')
    },
  )
})

describe('readTokenBacking', () => {
  /** A plain ecash V4 token, which `parseVoucherToken` cannot read, still has a mint and a unit. */
  it('reads the mint and unit of plain ecash', () => {
    expect(readTokenBacking(buildPlainToken('https://rogue.example.test', 'usd'))).toEqual({
      mintUrl: 'https://rogue.example.test',
      unit: 'usd',
    })
  })

  /** A real captured voucher reads the same as `parseVoucherToken` does. */
  it('agrees with the voucher parser on a captured coupon', () => {
    const token = fixture('live-licence.token')
    const parsed = parseVoucherToken(token)
    expect(readTokenBacking(token)).toEqual({ mintUrl: parsed.mintUrl, unit: parsed.unit })
  })

  /** A V3 token may omit its unit, which by NUT-00 means sat. */
  it('reads a legacy token without a unit as sat', () => {
    expect(readTokenBacking(buildLegacyToken('https://mint.example.test'))).toEqual({
      mintUrl: 'https://mint.example.test',
      unit: 'sat',
    })
  })

  /** A V3 token that names a foreign unit is read as that unit, so the gate refuses it. */
  it('reads a legacy token that names its unit', () => {
    expect(readTokenBacking(buildLegacyToken('https://mint.example.test', 'usd')).unit).toBe('usd')
  })

  /** Anything that is not a Cashu token throws, and a gate must treat that as a refusal. */
  it('throws on something that is not a token', () => {
    expect(() => readTokenBacking('hello')).toThrow()
  })
})

describe('when the gateway has answered and names no mint', () => {
  /**
   * The gateway's config ARRIVED and named no mint, and the build names none
   * either. This used to be `unchecked`, a pass for crediting; since the #133
   * review it is `no-trusted-mint`, which no path treats as a pass (see
   * trustedMintFailClosed.test.ts).
   */
  it('reports that no trusted mint is known', async () => {
    vi.stubEnv('VITE_TRUSTED_MINT_URLS', '')
    await gatewayAnswers('')
    expect(trustedMintUrls()).toEqual([])
    expect(checkMintAndUnit(parseVoucherToken(fixture('control-unlocked.token')))).toBe('no-trusted-mint')
  })

  /**
   * The unit is checked even with no mint configured. It needs no configuration,
   * so there is no reason to let it lapse with the mint.
   */
  it('still refuses a non-sat unit', async () => {
    vi.stubEnv('VITE_TRUSTED_MINT_URLS', '')
    await gatewayAnswers('')
    const parsed = parseVoucherToken(fixture('control-unlocked.token'))
    expect(checkMintAndUnit({ ...parsed, unit: 'usd' })).toBe('wrong-unit')
  })
})

describe('the mint the gateway names on /api/v1/config', () => {
  /**
   * A wallet told which mint to use by its own gateway is protected with no build
   * argument at all, which is what keeps a local or dev build gated.
   */
  it('is trusted, with nothing else configured', async () => {
    vi.stubEnv('VITE_TRUSTED_MINT_URLS', '')
    const parsed = parseVoucherToken(fixture('control-unlocked.token'))
    await gatewayAnswers(parsed.mintUrl)

    expect(trustedMintUrls()).toEqual([normaliseMintUrl(parsed.mintUrl)])
    expect(checkMintAndUnit(parsed)).toBe('trusted')
  })

  /** And a different mint is still refused, so the gateway source is a gate, not a pass. */
  it('does not make another mint trusted', async () => {
    vi.stubEnv('VITE_TRUSTED_MINT_URLS', '')
    await gatewayAnswers('https://mint.example.test')
    expect(checkMintAndUnit(parseVoucherToken(fixture('control-unlocked.token')))).toBe(
      'untrusted-mint',
    )
  })

  /** Both sources combine, so a migration can span the configured and the reported mint. */
  it('combines with the configured list', async () => {
    const parsed = parseVoucherToken(fixture('control-unlocked.token'))
    trust('https://mint.example.test')
    await gatewayAnswers(parsed.mintUrl)

    expect(trustedMintUrls()).toHaveLength(2)
    expect(checkMintAndUnit(parsed)).toBe('trusted')
  })

  /**
   * Staging's real answer, with the trailing slash a token's `m` may carry. This is
   * the shape `curl https://wallet.staging.398ja.xyz/api/v1/config` returns.
   */
  it('trusts the staging public mint whether or not the token adds a slash', async () => {
    vi.stubEnv('VITE_TRUSTED_MINT_URLS', '')
    await gatewayAnswers('https://mint.staging.398ja.xyz')
    expect(checkMintAndUnit(readTokenBacking(buildPlainToken('https://mint.staging.398ja.xyz/')))).toBe(
      'trusted',
    )
  })
})

describe('before the gateway config has arrived (#133)', () => {
  /**
   * The hole #133 is about. The gate used to read a global that only the legacy
   * bridge ever loaded, and treated its ABSENCE as "this deployment names no
   * mint", so on every path that had not touched the bridge it answered
   * `unchecked` and credited coupons from any mint. Not knowing is now its own
   * answer, and nothing has been loaded here.
   */
  it('reports not-ready, never unchecked, when nothing has been loaded', () => {
    vi.stubEnv('VITE_TRUSTED_MINT_URLS', '')
    expect(trustedMintsKnown()).toBe(false)
    expect(checkMintAndUnit(parseVoucherToken(fixture('control-unlocked.token')))).toBe('not-ready')
  })

  /**
   * A legacy `globalThis.GatewayConfig` saying "no mint" is no longer a source at
   * all. Only the config this module loaded itself counts, so the gate cannot be
   * switched off by whatever another script left on the global object.
   */
  it('ignores a GatewayConfig global left behind by the legacy bridge', () => {
    vi.stubEnv('VITE_TRUSTED_MINT_URLS', '')
    vi.stubGlobal('GatewayConfig', { mintUrl: '', whenReady: (callback: () => void) => callback() })
    expect(checkMintAndUnit(parseVoucherToken(fixture('control-unlocked.token')))).toBe('not-ready')
  })

  /**
   * A gateway that cannot be reached leaves the set UNKNOWN, not empty. Otherwise
   * anyone able to block one request would turn the gate off.
   */
  it('stays not-ready when the config fetch fails', async () => {
    vi.stubEnv('VITE_TRUSTED_MINT_URLS', '')
    await gatewayUnreachable()
    expect(checkMintAndUnit(parseVoucherToken(fixture('control-unlocked.token')))).toBe('not-ready')
  })

  /** A failed load is retried on the next call rather than remembered as "no mint". */
  it('learns the mint on a later load after a failed one', async () => {
    vi.stubEnv('VITE_TRUSTED_MINT_URLS', '')
    const parsed = parseVoucherToken(fixture('control-unlocked.token'))
    await gatewayUnreachable()
    await gatewayAnswers(parsed.mintUrl)
    expect(checkMintAndUnit(parsed)).toBe('trusted')
  })

  /**
   * A build that names its mint needs no gateway at all, so a deployment built
   * with VITE_TRUSTED_MINT_URLS is never subject to this window.
   */
  it('is unaffected when the build names the mint', () => {
    const parsed = parseVoucherToken(fixture('control-unlocked.token'))
    trust(parsed.mintUrl)
    expect(checkMintAndUnit(parsed)).toBe('trusted')
  })

  /** The unit is still checked: it depends on nothing that can be delayed. */
  it('still refuses a non-sat unit', () => {
    vi.stubEnv('VITE_TRUSTED_MINT_URLS', '')
    const parsed = parseVoucherToken(fixture('control-unlocked.token'))
    expect(checkMintAndUnit({ ...parsed, unit: 'usd' })).toBe('wrong-unit')
  })
})

describe('trustedMintUrls', () => {
  /** The build list is comma-separated, and spaces and host case do not matter. */
  it('reads a comma-separated list, trimming and lowercasing', () => {
    trust(' https://A.example.test , https://b.example.test ')
    expect(trustedMintUrls()).toEqual(['https://a.example.test', 'https://b.example.test'])
  })

  /** An empty entry is dropped, never trusted as the empty string. */
  it('drops empty entries rather than trusting the empty string', () => {
    trust('https://a.example.test', '', '  ')
    expect(trustedMintUrls()).toEqual(['https://a.example.test'])
  })

  /** A trailing slash on the configured value does not change which mint it means. */
  it('normalises trailing slashes so the list and the token agree', () => {
    trust('https://a.example.test/')
    expect(trustedMintUrls()).toEqual(['https://a.example.test'])
  })

  /**
   * A build list made only of junk names no mint, and must not count as "the build
   * knows its mint", or the gate would skip waiting for the gateway and answer
   * `unchecked`.
   */
  it('treats a list of unparseable entries as naming nothing', () => {
    trust('not a url', ' ')
    expect(trustedMintUrls()).toEqual([])
    expect(trustedMintsKnown()).toBe(false)
  })
})
