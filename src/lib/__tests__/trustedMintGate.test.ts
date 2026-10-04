import { describe, expect, it, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'

import { candidateClaim } from '../claimReconcile'
import { checkTokenBacking } from '../trustedMint'
import { parseVoucherToken } from '../voucherToken'
import { gatewayAnswers, gatewayUnreachable, resetGate } from './trustedMintKit'
import { buildLegacyToken, buildPlainToken, buildVoucherToken } from './voucherFixtures'

/**
 * The mint gate, where it decides money rather than where it is defined.
 *
 * `trustedMint.test.ts` proves the verdicts are right. This proves the callers
 * act on them, which is the part that can silently regress: an import removed,
 * a verdict compared with the wrong string, and every test above still passes
 * while the gate does nothing.
 *
 * The claim tests are written against a REAL captured token, so a coupon that
 * genuinely exists is the one being accepted and refused.
 *
 * `witness-positive.token` specifically, because it is one of the captured
 * tokens whose issuer signature actually verifies. Most do not: their fixtures
 * were captured from dev stacks whose issuer keys have since been regenerated.
 * Using one of those would make the "refused" test pass for the wrong reason,
 * and the control test below is what catches that.
 */

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  resetGate()
})

const token = readFileSync('src/lib/__tests__/fixtures/witness-positive.token', 'utf8').trim()
const parsed = parseVoucherToken(token)
const stall = parsed.voucher.issuerId

describe('crediting a coupon depends on where its value is', () => {
  /**
   * The control. With the coupon's own mint trusted, this token is claimable,
   * so the refusals below are caused by the mint and not by anything else about
   * the fixture.
   */
  it('accepts the coupon when its mint is trusted', () => {
    vi.stubEnv('VITE_TRUSTED_MINT_URLS', parsed.mintUrl)
    expect(candidateClaim({ amount: 0 }, token, stall)).toBeDefined()
  })

  /**
   * The finding this gate exists for. The token is byte-identical and its
   * signature still verifies. Only the configured mint differs, and that is
   * enough to make its value somebody else's.
   */
  it('refuses the same coupon when its mint is not trusted', () => {
    vi.stubEnv('VITE_TRUSTED_MINT_URLS', 'https://mint.example.test')
    expect(candidateClaim({ amount: 0 }, token, stall)).toBeUndefined()
  })

  /**
   * The crediting path's documented direction, kept on purpose. A deployment whose
   * gateway has ANSWERED and named no mint is exactly as exposed as before this
   * gate, and no worse; refusing would strand a coupon already held. Only reachable
   * when the gateway really says so: an unloaded list is `not-ready` (next test).
   */
  it('accepts the coupon when the gateway has answered and names no mint', async () => {
    vi.stubEnv('VITE_TRUSTED_MINT_URLS', '')
    await gatewayAnswers('')
    expect(candidateClaim({ amount: 0 }, token, stall)).toBeDefined()
  })

  /**
   * And refuses it while the trusted list is unknown. Before #133 this was every
   * build's default state, and it read as "no mint configured" and passed.
   */
  it('refuses the coupon before the gateway config has been loaded', () => {
    vi.stubEnv('VITE_TRUSTED_MINT_URLS', '')
    expect(candidateClaim({ amount: 0 }, token, stall)).toBeUndefined()
  })
})

describe('the redemption gate dm-poll asks before every redeem (#131)', () => {
  /**
   * The finding in full: a copy of a genuine signed voucher backed by proofs at a
   * rogue mint. The signature verifies; only the backing gives it away. Built with
   * a fresh issuer key so it is a real, valid voucher in every checkable way.
   */
  it('refuses a genuine-looking voucher whose proofs are at a rogue mint', async () => {
    await gatewayAnswers('https://mint.staging.398ja.xyz')
    const { token: voucherAtFixtureMint } = buildVoucherToken()
    // The fixture builder stamps `http://mint.test`, which is not the trusted mint.
    expect(checkTokenBacking(voucherAtFixtureMint)).toMatchObject({ outcome: 'refuse', reason: 'untrusted-mint' })
  })

  /** Plain ecash from a rogue mint is refused too: forging a coupon is not required. */
  it('refuses plain ecash from a rogue mint', async () => {
    await gatewayAnswers('https://mint.staging.398ja.xyz')
    expect(checkTokenBacking(buildPlainToken('https://rogue-mint.example.test'))).toMatchObject({
      outcome: 'refuse',
      reason: 'untrusted-mint',
    })
  })

  /** A legacy V3 token is read too, so the old format is not a way round the gate. */
  it('refuses a legacy cashuA token from a rogue mint', async () => {
    await gatewayAnswers('https://mint.staging.398ja.xyz')
    expect(checkTokenBacking(buildLegacyToken('https://rogue-mint.example.test'))).toMatchObject({
      outcome: 'refuse',
      reason: 'untrusted-mint',
    })
  })

  /** Proofs at our own mint in another unit are refused, with that reason. */
  it('refuses a token at the trusted mint in the wrong unit', async () => {
    await gatewayAnswers('https://mint.staging.398ja.xyz')
    expect(checkTokenBacking(buildPlainToken('https://mint.staging.398ja.xyz', 'usd'))).toMatchObject({
      outcome: 'refuse',
      reason: 'wrong-unit',
    })
  })

  /** Something that is not a Cashu token is refused, never waved through. */
  it('refuses a token it cannot read', async () => {
    await gatewayAnswers('https://mint.staging.398ja.xyz')
    expect(checkTokenBacking('cashuB!!!not-cbor')).toMatchObject({ outcome: 'refuse', reason: 'undecodable' })
  })

  /**
   * The public mint URL the gateway serves, against a token whose `m` has a
   * trailing slash: the same mint, accepted. The captured coupon is accepted the
   * same way against its own mint.
   */
  it('accepts tokens at the trusted mint, whatever the trailing slash', async () => {
    await gatewayAnswers('https://mint.staging.398ja.xyz')
    expect(checkTokenBacking(buildPlainToken('https://mint.staging.398ja.xyz/'))).toEqual({ outcome: 'accept' })

    await gatewayAnswers(parsed.mintUrl + '/')
    expect(checkTokenBacking(token)).toEqual({ outcome: 'accept' })
  })

  /**
   * Before the list has loaded the answer is DEFER, not accept and not refuse:
   * dm-poll leaves the delivery unconsumed and offers it again once the list is in.
   */
  it.each([
    ['nothing has been loaded', async () => {}],
    ['the config fetch failed', gatewayUnreachable],
  ])('defers when %s', async (_name, arrange) => {
    vi.stubEnv('VITE_TRUSTED_MINT_URLS', '')
    await arrange()
    expect(checkTokenBacking(buildPlainToken('https://rogue-mint.example.test'))).toMatchObject({ outcome: 'defer' })
  })
})
