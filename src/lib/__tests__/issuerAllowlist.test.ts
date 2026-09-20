import { describe, expect, it, vi, afterEach } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'

import { checkIssuer, allowedIssuerKeys } from '../issuerAllowlist'
import { parseVoucherToken } from '../voucherToken'
import { buildVoucherToken } from './voucherFixtures'

/**
 * Which signing keys this build believes.
 *
 * Closes the offline half of Finding 2: `verifyVoucher` checks a signature
 * against a key the voucher itself names, so it can never establish WHO signed.
 * In production the mint refuses a self-issued voucher at the swap; offline
 * there is no backstop, and `voucherToken.ts` promises there should be one.
 *
 * The first test is the one that shaped the design, and it reads real captured
 * tokens rather than asserting a belief about them.
 */

afterEach(() => {
  vi.unstubAllEnvs()
})

const allow = (...keys: string[]) =>
  vi.stubEnv('VITE_VOUCHER_ISSUER_PUBKEYS', keys.join(','))

describe('what the real tokens say about issuer keys', () => {
  /**
   * The measurement that refused the recommendation as written.
   *
   * The audit review said to mirror `VITE_LICENCE_ISSUER_PUBKEY`: ONE key, in
   * the bundle. Parsing the captured tokens shows several distinct
   * `issuerPublicKey` values, so a single pinned key would refuse most genuine
   * coupons — the same class of mistake as errata item 1, which also came from
   * assuming this field was a constant.
   *
   * Asserted rather than described, so that if the fixtures ever collapse to
   * one key this turns red and whoever sees it can simplify deliberately.
   */
  it('shows more than one signing key across captured tokens', () => {
    const dir = 'src/lib/__tests__/fixtures'
    const keys = new Set<string>()

    for (const file of readdirSync(dir).filter((f) => f.endsWith('.token'))) {
      try {
        keys.add(parseVoucherToken(readFileSync(`${dir}/${file}`, 'utf8').trim()).voucher.issuerPublicKey)
      } catch {
        // Not every fixture is a readable voucher — some are deliberately
        // malformed for other suites. They simply do not contribute a key.
      }
    }

    expect(keys.size).toBeGreaterThan(1)
  })
})

describe('with no allowlist configured', () => {
  it('reads as unchecked, so nothing is refused', () => {
    // The opposite of the licence rule, and deliberately. Failing closed here
    // would refuse every coupon on every deployment that has not set the
    // variable — which is all of them today. A gate on money must not be able
    // to strand it.
    vi.stubEnv('VITE_VOUCHER_ISSUER_PUBKEYS', '')
    const { token } = buildVoucherToken()

    expect(checkIssuer(parseVoucherToken(token))).toBe('unchecked')
  })

  it('parses an unset variable as an empty list rather than one empty key', () => {
    // A naive split produces `['']`, which is a list of length one — so the
    // "is anything configured?" test would pass and every real key would then
    // fail to match it. Silent, and total.
    vi.stubEnv('VITE_VOUCHER_ISSUER_PUBKEYS', '')
    expect(allowedIssuerKeys()).toEqual([])
  })
})

describe('with an allowlist configured', () => {
  it('accepts a coupon signed by an allowed key', () => {
    const { token, voucher } = buildVoucherToken()
    allow(voucher.issuerPublicKey)

    expect(checkIssuer(parseVoucherToken(token))).toBe('allowed')
  })

  it('refuses a coupon signed by a key it does not know', () => {
    // The finding, closed. This voucher's signature verifies perfectly — it is
    // self-issued and internally consistent — and that is exactly why the
    // signature alone was never enough.
    const { token } = buildVoucherToken()
    allow('ab'.repeat(32))

    expect(checkIssuer(parseVoucherToken(token))).toBe('unknown-issuer')
  })

  it('accepts any of several keys, so a keyset rotation needs no flag day', () => {
    // Keys are per mint and per keyset and they rotate. An either/or would
    // force every wallet to update in lockstep with the mint.
    const { token, voucher } = buildVoucherToken()
    allow('ab'.repeat(32), voucher.issuerPublicKey, 'cd'.repeat(32))

    expect(checkIssuer(parseVoucherToken(token))).toBe('allowed')
  })

  it('compares case-insensitively and ignores surrounding whitespace', () => {
    // The configured value is hand-written into a deployment env file. A
    // stray space or an uppercase key would refuse every genuine coupon, and
    // that failure looks exactly like the attack this check exists to stop.
    const { token, voucher } = buildVoucherToken()
    vi.stubEnv(
      'VITE_VOUCHER_ISSUER_PUBKEYS',
      `  ${voucher.issuerPublicKey.toUpperCase()} , ${'ab'.repeat(32)}  `,
    )

    expect(checkIssuer(parseVoucherToken(token))).toBe('allowed')
  })
})
