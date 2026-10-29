/**
 * @vitest-environment jsdom
 *
 * Artefacts produced by the subscription.imani.casa CONTAINER (services/subscription/Dockerfile),
 * run against the real staging gateway on 2026-10-27:
 *  - a hand grant issued through POST /v1/admin/grants and minted by gateway-customer;
 *  - the signed catalog served at GET /v1/catalog.
 * The wallet must read, verify and apply both with its own code.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { acceptCatalog, BUNDLED_CATALOG, entitlementOf, maySell, verifyLicence } from '@imani/licence'

import { catalogSignatureValid } from '../entitlement'
import { licenceFromToken, licenceSignatureVerifier } from '../licences'
import { parseVoucherToken } from '../voucherToken'

const fx = (f: string) => readFileSync(join(__dirname, 'fixtures', f), 'utf8').trim()
const TOKEN = fx('service-hand-grant.staging-token')
const CUSTOMER = fx('service-hand-grant.customer')
const SIGNED_CATALOG = JSON.parse(fx('service-catalog.json')) as { body: string; signature: string }
const SELLER = '62dd912f098cb439e97e0bfe3e6513b27b0cecc9f262a1778635c6fe18545c01'

const voucher = parseVoucherToken(TOKEN).voucher
const licence = licenceFromToken(TOKEN)!
const NOW = licence.validFrom! + 3600

describe('a grant issued by the subscription service, minted by staging', () => {
  it('is sold by the staging seller and carries the grant in the signed bytes', () => {
    expect(licence).toMatchObject({
      issuerId: SELLER,
      tier: 'custom',
      grantKind: 'custom',
      pilot: true,
      limits: { sales: { period: 'window', amounts: { GBP: 20000 } }, terminals: 5 },
    })
  })

  it('verifies for its stall, with the seller pinned, and gives 200 GBP and 5 tills', () => {
    const v = verifyLicence(licence, {
      issuerPublicKey: voucher.issuerPublicKey,
      sellerPublicKey: SELLER,
      now: NOW,
      presenter: CUSTOMER,
      verifySignature: licenceSignatureVerifier({ token: TOKEN }),
    })
    expect(v.granted).toBe(true)
    if (!v.granted) return
    const e = entitlementOf({ catalog: BUNDLED_CATALOG, grants: [v.grant], currency: 'GBP', now: NOW })
    expect(e).toMatchObject({ terminals: 5, sales: { amount: 20000 } })
    expect(maySell(e, 0, 22000).allowed).toBe(true)
    expect(maySell(e, 0, 22001).allowed).toBe(false)
  })
})

describe('the catalog served by the subscription service', () => {
  it('is signed by the seller key the wallet pins, and is adopted over the bundled one', () => {
    expect(catalogSignatureValid(SIGNED_CATALOG, SELLER)).toBe(true)
    const v = acceptCatalog(SIGNED_CATALOG, { verifySignature: (s) => catalogSignatureValid(s, SELLER), current: BUNDLED_CATALOG })
    expect(v.accepted && v.catalog.version).toBe(2)
    expect(v.accepted && v.catalog.fx?.XAF).toEqual({ perUsd: 600, decimals: 0 })
  })

  it('a stall selling in XAF gets the USD 100 converted at the published rate', () => {
    const v = acceptCatalog(SIGNED_CATALOG, { verifySignature: (s) => catalogSignatureValid(s, SELLER), current: BUNDLED_CATALOG })
    if (!v.accepted) throw new Error('catalog refused')
    const e = entitlementOf({ catalog: v.catalog, grants: [], currency: 'XAF', now: NOW })
    expect(e.sales).toMatchObject({ amount: 60000, currency: 'XAF' })
  })
})
