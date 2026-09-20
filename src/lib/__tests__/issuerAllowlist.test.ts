import { describe, expect, it, vi, afterEach } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'

import { checkIssuer, allowedIssuerKeys } from '../issuerAllowlist'
import { parseVoucherToken, tokenProofs } from '../voucherToken'
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
   * `issuerPublicKey` values, so a single pinned key would refuse genuine
   * coupons — the same class of mistake as errata item 1, which also came from
   * assuming this field was a constant.
   *
   * **What the count is not.** An earlier version of this comment said the key
   * varied "by mint and keyset". Checked, and wrong on both: all eight tokens
   * share ONE keyset (`00e3372e61d05605`), and one mint accounts for three of
   * the four values. The values actually partition by capture session — these
   * are local dev stacks whose issuer key is regenerated on rebuild — so four
   * is an artefact of this repo, not a protocol quantity.
   *
   * The assertion is `> 1` rather than `=== 4` precisely because the number is
   * incidental: pinning it would make this test a tripwire for adding a
   * fixture. What must stay true is that the field is NOT a constant, which is
   * the only premise the allowlist design rests on.
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

  it('rules out the explanations that would have allowed a single pin', () => {
    // Three hypotheses, each of which would have meant the key IS derivable
    // from something stable and so could be pinned or computed. All three are
    // refuted by the same eight tokens, and the refutation is asserted here
    // because the first write-up of this module asserted two of them as FACT.
    const dir = 'src/lib/__tests__/fixtures'
    const parsed: Array<{ pub: string; mint: string; issuer: string; keyset: string }> = []

    for (const file of readdirSync(dir).filter((f) => f.endsWith('.token'))) {
      try {
        const raw = readFileSync(`${dir}/${file}`, 'utf8').trim()
        const token = parseVoucherToken(raw)
        parsed.push({
          pub: token.voucher.issuerPublicKey,
          mint: token.mintUrl,
          issuer: token.voucher.issuerId,
          keyset: tokenProofs(raw)[0].id,
        })
      } catch {
        // Not a readable voucher; contributes nothing either way.
      }
    }

    const distinct = <T>(xs: T[]) => new Set(xs).size

    // NOT keysets. If the signing key were a property of the keyset, several
    // keysets would be needed to explain several keys. There is exactly one.
    expect(distinct(parsed.map((p) => p.keyset))).toBe(1)
    expect(distinct(parsed.map((p) => p.pub))).toBeGreaterThan(1)

    // NOT per-mint. One mint carries more than one key on its own.
    const perMint = new Map<string, Set<string>>()
    for (const p of parsed) perMint.set(p.mint, (perMint.get(p.mint) ?? new Set()).add(p.pub))
    expect(Math.max(...[...perMint.values()].map((s) => s.size))).toBeGreaterThan(1)

    // NOT per-stall. One stall's coupons carry more than one key.
    const perStall = new Map<string, Set<string>>()
    for (const p of parsed) perStall.set(p.issuer, (perStall.get(p.issuer) ?? new Set()).add(p.pub))
    expect(Math.max(...[...perStall.values()].map((s) => s.size))).toBeGreaterThan(1)
  })

  it('shows one signing key serving SEVERAL stalls, so it is not a stall key', () => {
    // The question this answers is the natural one: surely `issuerPublicKey`
    // is the merchant's own key? It is not, and this is the cleanest possible
    // refutation — a single key that signs vouchers for two DIFFERENT stalls
    // cannot be either stall's identity.
    //
    // `issuerPublicKey` is the SERVICE's signing key. The stall lives in
    // `issuerId`, inside the bytes that key signs, so the structure is "the
    // issuing service attests that stall X issued this coupon" rather than
    // "stall X signed this coupon".
    //
    // That is why `credentialActor` compares `issuerId` and never
    // `issuerPublicKey` (errata 1), and why the allowlist checks the latter:
    // one asks WHICH STALL, the other asks WHOSE SOFTWARE MINTED IT.
    const dir = 'src/lib/__tests__/fixtures'
    const stallsPerKey = new Map<string, Set<string>>()

    for (const file of readdirSync(dir).filter((f) => f.endsWith('.token'))) {
      try {
        const v = parseVoucherToken(readFileSync(`${dir}/${file}`, 'utf8').trim()).voucher
        stallsPerKey.set(
          v.issuerPublicKey,
          (stallsPerKey.get(v.issuerPublicKey) ?? new Set()).add(v.issuerId.toLowerCase()),
        )
      } catch {
        // Not a readable voucher.
      }
    }

    expect(Math.max(...[...stallsPerKey.values()].map((s) => s.size))).toBeGreaterThan(1)
  })

  it('never equals the stall it names, on any captured token', () => {
    // The direct form of the same point, asserted because the assumption that
    // these two fields are the same thing has now caused two separate errors
    // in this work (errata 1 and 9a).
    const dir = 'src/lib/__tests__/fixtures'

    for (const file of readdirSync(dir).filter((f) => f.endsWith('.token'))) {
      try {
        const v = parseVoucherToken(readFileSync(`${dir}/${file}`, 'utf8').trim()).voucher
        expect(v.issuerPublicKey.toLowerCase()).not.toBe(v.issuerId.toLowerCase())
      } catch {
        // Not a readable voucher.
      }
    }
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
