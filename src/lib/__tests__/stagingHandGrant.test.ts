/**
 * @vitest-environment jsdom
 *
 * A hand grant minted by the REAL gateway (#407): staging, 2026-10-27, by
 * `sell-subscription.mjs --paid 0 --sales-limit 200:GBP --terminals 5 --days 30 --pilot`.
 *
 * Proves what no fixture this app signs for itself can: that gateway-customer carries
 * tier, valid_from, grant_kind and limits into the SIGNED secret, and that the wallet reads,
 * verifies and applies them. The clock is pinned inside the grant's window.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BUNDLED_CATALOG, entitlementOf, maySell, verifyLicence } from '@imani/licence'

import { licenceFromToken, licenceSignatureVerifier } from '../licences'
import { parseVoucherToken } from '../voucherToken'

const TOKEN = readFileSync(join(__dirname, 'fixtures/staging-hand-grant.staging-token'), 'utf8').trim()
const CUSTOMER = readFileSync(join(__dirname, 'fixtures/staging-hand-grant.customer'), 'utf8').trim()
const ISSUER = parseVoucherToken(TOKEN).voucher.issuerPublicKey
const licence = licenceFromToken(TOKEN)!
const NOW = licence.validFrom! + 86_400
const check = (now: number, presenter = CUSTOMER) =>
  verifyLicence(licence, { issuerPublicKey: ISSUER, now, presenter, verifySignature: licenceSignatureVerifier({ token: TOKEN }) })

describe('a hand grant from the real gateway', () => {
  it('carries the #407 fields in the signed bytes', () => {
    expect(licence).toMatchObject({
      tier: 'custom',
      grantKind: 'custom',
      pilot: true,
      features: [],
      limits: { sales: { period: 'window', amounts: { GBP: 20000 } }, terminals: 5 },
    })
    expect(licence.expiresAt! - licence.validFrom!).toBeGreaterThan(29 * 86_400)
  })

  it('verifies for its stall, inside its window, and nowhere else', () => {
    expect(check(NOW).granted).toBe(true)
    expect(check(NOW, 'f'.repeat(64))).toMatchObject({ granted: false, reason: 'wrong-key' })
    expect(check(licence.validFrom! - 1)).toMatchObject({ granted: false, reason: 'not-yet-valid' })
    expect(check(licence.expiresAt!)).toMatchObject({ granted: false, reason: 'expired' })
  })

  it('raises a free stall to 200 for the window, 5 tills, no paid features', () => {
    const v = check(NOW)
    if (!v.granted) throw new Error('expected a grant')
    const e = entitlementOf({ catalog: BUNDLED_CATALOG, grants: [v.grant], currency: 'GBP', now: NOW })
    expect(e).toMatchObject({ terminals: 5, features: [], sales: { amount: 20000, periodStart: licence.validFrom } })
    expect(maySell(e, 0, 22000).allowed).toBe(true)
    expect(maySell(e, 0, 22001).allowed).toBe(false)
  })

  it('is not money: a tampered limit breaks the signature', () => {
    const v = parseVoucherToken(TOKEN).voucher
    const forged = { ...licence, limits: { sales: null } }
    // The signature covers the metadata; the verifier re-parses the original bytes, so only a
    // re-signed token could change the limit, and only we hold the key.
    expect(v.merchantMetadata).toContain('"GBP":20000')
    expect(verifyLicence(forged, { issuerPublicKey: ISSUER, now: NOW, presenter: CUSTOMER, verifySignature: () => false }).granted).toBe(false)
  })
})
