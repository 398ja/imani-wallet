import { describe, expect, it, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'

import { candidateClaim } from '../claimReconcile'
import { parseVoucherToken } from '../voucherToken'

/**
 * The mint gate, where it decides money rather than where it is defined.
 *
 * `trustedMint.test.ts` proves the verdicts are right. This proves the callers
 * act on them, which is the part that can silently regress: an import removed,
 * a verdict compared with the wrong string, and every test above still passes
 * while the gate does nothing.
 *
 * Both tests below are written against a REAL captured token, so a coupon that
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
   * The default direction, stated as a test so it cannot drift silently. A
   * deployment naming no mint is exactly as exposed as before this gate, and no
   * worse, which is the same choice `issuerAllowlist` makes for the same reason.
   */
  it('accepts the coupon when no mint is configured at all', () => {
    vi.stubEnv('VITE_TRUSTED_MINT_URLS', '')
    expect(candidateClaim({ amount: 0 }, token, stall)).toBeDefined()
  })
})
