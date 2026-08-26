import { describe, expect, it } from 'vitest'
import type { VoucherRow } from '@imani/wallet-storage'

import {
  BARCODE_FORMAT_QR,
  DEFAULT_BACKGROUND_COLOR,
  DEFAULT_DESCRIPTION,
  DEFAULT_FOREGROUND_COLOR,
  TERMS,
  toCouponPass,
  toMerchantPass,
} from '../pass'
import { toMerchants } from '../merchants'

const ISSUER = '7952939535a79edc46d86e103785cee6f8119e8533787de8352257b051548448'
const VOUCHER_ID = 'bbc1c485-122e-46c6-abc5-ee9f7174ecff'

/**
 * 5000 XAF backed by 200 sats — deliberately NOT the ratio-1.0 EUR shape the
 * live stack issues, where face minor units and sats are the same number and a
 * pass built from the wrong field would look perfectly correct.
 */
function row(overrides: Partial<VoucherRow> = {}): VoucherRow {
  return {
    token_id: 'e8c77f87a391a72391fafdaaef73918b',
    voucher_id: VOUCHER_ID,
    token: 'cashuBv2F0gb9haUg',
    amount: 200,
    face_value: 5000,
    face_unit: 'XAF',
    face_decimals: 0,
    token_amount: 200,
    issuer_id: ISSUER,
    status: 'active',
    created_at: '2026-08-12T09:00:00.000Z',
    updated_at: '2026-08-12T09:00:00.000Z',
    ...overrides,
  } as VoucherRow
}

describe('toCouponPass', () => {
  it('carries the face value, not the sats backing', () => {
    const [balance] = toCouponPass(row()).storeCard.primaryFields!

    expect(balance.key).toBe('balance')
    expect(balance.label).toBe('BALANCE')
    expect(balance.value).toBe(5000)
    expect(balance.currencyCode).toBe('XAF')
    expect(balance.decimals).toBe(0)
  })

  it('emits a redemption barcode, never the bearer token', () => {
    const pass = toCouponPass(row())
    const [code] = pass.barcodes!

    expect(code.format).toBe(BARCODE_FORMAT_QR)
    expect(code.message).toBe(`voucher:${VOUCHER_ID}`)
    // Bare id, no prefix — a cashier keys this in when a scanner fails.
    expect(code.altText).toBe(VOUCHER_ID)
    // The whole point of the prefix rule: a merchant scanning this must not
    // receive spendable value.
    expect(code.message).not.toContain('cashu')
  })

  it.each([
    ['epoch seconds', 1794346639],
    ['an ISO string', '2026-11-10T21:37:19.000Z'],
  ])('reads an expiry given as %s', (_label, value) => {
    const pass = toCouponPass(row({ expires_at: value as unknown as number }))

    expect(pass.expirationDate).toBe('2026-11-10T21:37:19.000Z')
    expect(pass.storeCard.auxiliaryFields).toHaveLength(1)
    expect(pass.storeCard.auxiliaryFields![0].label).toBe('EXPIRES')
  })

  it('omits the expiry group entirely when there is no expiry', () => {
    // Absent groups stay undefined rather than empty — PassJson's own rule.
    const pass = toCouponPass(row({ expires_at: undefined }))

    expect(pass.expirationDate).toBeUndefined()
    expect(pass.storeCard.auxiliaryFields).toBeUndefined()
  })

  it.each([
    ['redeemed', true],
    ['revoked', true],
    // expirationDate already conveys expiry, so it is not a void.
    ['expired', false],
    ['active', false],
  ])('marks a %s voucher voided=%s', (status, expected) => {
    expect(toCouponPass(row({ status })).voided).toBe(expected)
  })

  it('falls back to the mapper defaults when there is no branding', () => {
    const pass = toCouponPass(row())

    expect(pass.backgroundColor).toBe(DEFAULT_BACKGROUND_COLOR)
    expect(pass.foregroundColor).toBe(DEFAULT_FOREGROUND_COLOR)
    expect(pass.labelColor).toBe(pass.foregroundColor)
    expect(pass.description).toBe(DEFAULT_DESCRIPTION)
    // Branding absent → the issuer id stands in for a name...
    expect(pass.organizationName).toBe(ISSUER)
    // ...but logoText is branding-only, so it stays absent.
    expect(pass.logoText).toBeUndefined()
  })

  it('prefers branding over the fallbacks', () => {
    const pass = toCouponPass(row(), {
      organizationName: 'Rosa Green Farm',
      nip05: 'rosa@x.test',
      logoUrl: 'https://example.test/logo.png',
      bannerUrl: 'https://example.test/banner.png',
      backgroundColor: 'rgb(10,80,40)',
    })

    expect(pass.organizationName).toBe('Rosa Green Farm')
    // The card shows this under the name, in place of the short pubkey.
    expect(pass.userInfo.issuerNip05).toBe('rosa@x.test')
    expect(pass.logoText).toBe('Rosa Green Farm')
    expect(pass.backgroundColor).toBe('rgb(10,80,40)')
    // pass.json has no image fields; URLs ride in userInfo under these keys.
    expect(pass.userInfo.logoUrl).toBe('https://example.test/logo.png')
    expect(pass.userInfo.stripUrl).toBe('https://example.test/banner.png')
  })

  it('describes the voucher by its memo, never by the shop blurb', () => {
    const branding = { storeDescription: 'Organic veg, Tue & Sat' }

    expect(toCouponPass(row({ memo: 'Market day' }), branding).description).toBe('Market day')
    // The merchant's kind-0 `about` is about the merchant. On a coupon card it
    // took the one line that tells this coupon from the next one.
    expect(toCouponPass(row({ memo: undefined }), branding).description).toBe(DEFAULT_DESCRIPTION)
  })

  it('puts provenance on the back, and never the signature', () => {
    const back = toCouponPass(row()).storeCard.backFields!
    const keys = back.map((f) => f.key)

    expect(keys).toContain('voucherId')
    expect(keys).toContain('issuer')
    expect(back.find((f) => f.key === 'terms')!.value).toBe(TERMS)
    // Surfacing a signature in a UI invites treatment as a credential.
    expect(keys).not.toContain('issuerSig')
  })

  it.each([
    ['a non-ISO-4217 unit', row({ face_unit: 'SAT' })],
    ['no voucher id', row({ voucher_id: undefined })],
    ['no issuer', row({ issuer_id: undefined })],
    ['no face value', row({ face_value: undefined })],
  ])('renders rather than throwing given %s', (_label, r) => {
    // The Java mapper throws on each of these. On a render path a throw costs
    // the whole screen, so every one degrades instead.
    expect(() => toCouponPass(r)).not.toThrow()
  })

  it('addresses the pass by token_id when the voucher id is missing', () => {
    const pass = toCouponPass(row({ voucher_id: undefined }))
    expect(pass.serialNumber).toBe('e8c77f87a391a72391fafdaaef73918b')
  })

  it('carries no redemption code once redeemed', () => {
    // The proofs behind a redeemed coupon are burnt (burn.ts). Still showing
    // the QR would invite a cashier to scan a sale that already happened.
    const pass = toCouponPass(row({ status: 'redeemed' }))
    expect(pass.voided).toBe(true)
    expect(pass.barcodes).toBeUndefined()
  })
})

describe('toMerchantPass', () => {
  const merchantFrom = (rows: VoucherRow[]) => toMerchants(rows)[0]

  it('totals every voucher held from that shop', () => {
    const merchant = merchantFrom([row(), row({ token_id: 'b'.repeat(32), voucher_id: 'other' })])
    const [balance] = toMerchantPass(merchant).storeCard.primaryFields!

    expect(balance.value).toBe(10_000)
    expect(balance.currencyCode).toBe('XAF')
  })

  it('carries no barcode and no back fields', () => {
    // A barcode is a redemption id for ONE voucher. A merchant-level card has no
    // single voucher to redeem, and emitting one would aim a cashier's scanner
    // at an arbitrary coupon from the pile.
    const pass = toMerchantPass(merchantFrom([row()]))

    expect(pass.barcodes).toBeUndefined()
    expect(pass.storeCard.backFields).toBeUndefined()
  })

  it('is keyed by the shop, not by a voucher', () => {
    const pass = toMerchantPass(merchantFrom([row()]))

    expect(pass.serialNumber).toBe(ISSUER)
    expect(pass.userInfo.voucherId).toBe(ISSUER)
    expect(pass.voided).toBe(false)
  })
})
