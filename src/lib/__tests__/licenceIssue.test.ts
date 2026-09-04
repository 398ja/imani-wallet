import { describe, it, expect, beforeEach } from 'vitest'
import { verifyLicence, DENIAL_REASONS } from '@imani/licence'

import {
  LICENCE_FEATURES,
  LICENCE_TERMS,
  TERM_DAYS,
  licenceIssueParams,
  licenceMetadataJson,
  newSubscriptionId,
  paidFor,
  renewalTerms,
  type LicenceTerms,
} from '../licenceIssue'
import { forgetLicenceParses, heldLicences, licenceFromToken, licenceSignatureVerifier } from '../licences'
import { spendable, toMerchants, walletTotals } from '../merchants'
import { buildVoucherToken } from './voucherFixtures'
import type { VoucherRow } from '@imani/wallet-storage'

/**
 * Selling a subscription by hand.
 *
 * These tests are deliberately ROUND TRIPS rather than assertions about JSON.
 * The seller writes metadata and the wallet reads it, and the failure worth
 * catching is the two disagreeing — a renamed key, a value written as a string
 * where a number is read. A test that asserted the minted shape would pass
 * against a mint the wallet cannot recognise, which is the whole bug.
 *
 * So each one goes: terms -> metadata -> a REAL signed voucher token -> the
 * wallet's own recogniser and verifier.
 */

const CUSTOMER_KEY = 'b'.repeat(64)
const ISSUER_KEY = 'a'.repeat(64)

function terms(over: Partial<LicenceTerms> = {}): LicenceTerms {
  return {
    lockKey: CUSTOMER_KEY,
    subscriptionId: 'sub_9f2c11',
    paidAmountMinor: 4000,
    paidCurrency: 'GBP',
    ...over,
  }
}

/**
 * Mint a real, signed voucher carrying these licence terms.
 *
 * Returns the issuer key alongside the token because that is what the check
 * needs: `verifyLicence` takes OUR key as `issuerPublicKey` and refuses
 * everything else, so a test that did not pass the fixture's own key would be
 * asserting WRONG_ISSUER on every case and calling it a pass.
 */
function mint(t: LicenceTerms, expiresAt = 1900000000) {
  const params = licenceIssueParams(t)
  const built = buildVoucherToken({
    merchantMetadata: params.merchantMetadata,
    faceValue: params.faceValueMinor,
    unit: params.currency,
    expiresAt,
  })
  return { ...built, issuerPublicKey: built.voucher.issuerPublicKey }
}

/**
 * `token_id` must be derived from the WHOLE token, as the store derives it.
 *
 * Spec 017 makes it `sha256(token)`, and `licenceIn` caches parses under it. Two
 * licences for one subscription differ only in metadata and expiry — bytes that
 * sit in the middle of a ~4KB token — so a fixture keying on a slice handed both
 * rows the same id, the cache answered the renewal with the original's parse,
 * and the renewal appeared to lose. The bug was in the fixture; keying on the
 * content, like the real store, is what makes the test honest.
 */
function idFor(token: string): string {
  let hash = 0
  for (let i = 0; i < token.length; i += 1) {
    hash = (Math.imul(hash, 31) + token.charCodeAt(i)) | 0
  }
  return `id-${hash}`
}

function rowFor(token: string, extra: Partial<VoucherRow> = {}): VoucherRow {
  return {
    token_id: idFor(token),
    token,
    amount: 1782,
    face_value: 4000,
    face_unit: 'GBP',
    face_decimals: 2,
    token_amount: 1782,
    issuer_id: ISSUER_KEY,
    status: 'active',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...extra,
  }
}

beforeEach(() => {
  forgetLicenceParses()
})

describe('minting a licence for a customer', () => {
  it('produces a voucher the wallet recognises and the check GRANTS', () => {
    const { token, issuerPublicKey } = mint(terms())

    const licence = licenceFromToken(token)
    expect(licence).not.toBeNull()

    const verdict = verifyLicence(licence, {
      issuerPublicKey,
      now: 1800000000,
      presenter: CUSTOMER_KEY,
      verifySignature: licenceSignatureVerifier({ token }),
    })

    // The point of the whole ticket: a licence sold by hand actually unlocks.
    expect(verdict.granted).toBe(true)
    if (verdict.granted) {
      expect(verdict.grant.features).toEqual([LICENCE_FEATURES.TERMINALS])
      expect(verdict.grant.subscriptionId).toBe('sub_9f2c11')
      expect(verdict.grant.pilot).toBe(false)
    }
  })

  it('locks the licence to the customer key, so nobody else can present it', () => {
    const { token, issuerPublicKey } = mint(terms())

    const verdict = verifyLicence(licenceFromToken(token), {
      issuerPublicKey,
      now: 1800000000,
      // Someone else's key, with a genuine voucher. This is the check that
      // makes a licence non-transferable: without `lock_key` in the minted
      // metadata, `verifyLicence` refuses everything as UNLOCKED and no
      // customer could ever use what they bought.
      presenter: 'c'.repeat(64),
      verifySignature: licenceSignatureVerifier({ token }),
    })

    expect(verdict.granted).toBe(false)
    if (!verdict.granted) expect(verdict.reason).toBe(DENIAL_REASONS.WRONG_KEY)
  })

  it('refuses to mint a licence that could never grant anything', () => {
    // Each of these produces a well-formed voucher that verifies and unlocks
    // nothing, so the customer discovers the mistake instead of the seller.
    expect(() => licenceMetadataJson(terms({ lockKey: '' }))).toThrow(/locked/)
    expect(() => licenceMetadataJson(terms({ subscriptionId: '' }))).toThrow(/subscription id/)
    expect(() => licenceMetadataJson(terms({ features: [] }))).toThrow(/feature/)
  })

  it('is not money, however it was priced', () => {
    const { token } = mint(terms())
    const row = rowFor(token)

    expect(spendable([row])).toEqual([])
    // Zero, not merely smaller: the only holding is a licence, so every unit
    // total must be absent rather than reduced.
    expect(walletTotals(toMerchants([row]))).toEqual([])
  })
})

describe('the term', () => {
  it('is annual by default, and monthly when asked for', () => {
    expect(licenceIssueParams(terms()).expiryDays).toBe(TERM_DAYS.annual)
    expect(licenceIssueParams(terms(), LICENCE_TERMS.MONTHLY).expiryDays).toBe(TERM_DAYS.monthly)
  })

  it('expires the licence at the end of the term and not before', () => {
    const soldAt = 1800000000
    const expiresAt = soldAt + TERM_DAYS.annual * 86400
    const { token, issuerPublicKey } = mint(terms(), expiresAt)

    const check = (now: number) =>
      verifyLicence(licenceFromToken(token), {
        issuerPublicKey,
        now,
        presenter: CUSTOMER_KEY,
        verifySignature: licenceSignatureVerifier({ token }),
      })

    // A second before the year is up, and a second after. Moving the clock
    // rather than waiting is the reason the verifier takes one.
    expect(check(expiresAt - 1).granted).toBe(true)
    expect(check(expiresAt + 1).granted).toBe(false)
  })
})

describe('the price paid', () => {
  it('records what the customer actually handed over, in their currency', () => {
    const { token } = mint(terms({ paidAmountMinor: 4000, paidCurrency: 'GBP' }))
    const parsed = licenceFromToken(token)

    expect(parsed?.faceValue).toBe(4000)
    expect(parsed?.faceUnit).toBe('GBP')
  })

  it('records a sats payment as sats, not as the fiat it was quoted in', () => {
    // "A stall in Douala thinks in XAF and a sats-native buyer should not pay an
    // FX spread." The voucher records what was PAID, which is the only thing a
    // receipt can honestly say.
    const { token } = mint(terms({ paidAmountMinor: 62000, paidCurrency: 'sat' }))

    const paid = paidFor({
      faceValue: 62000,
      unit: 'sat',
      merchantMetadata: licenceMetadataJson(terms({ paidAmountMinor: 62000, paidCurrency: 'sat' })),
    })
    expect(paid).toEqual({ amountMinor: 62000, currency: 'sat' })
    expect(licenceFromToken(token)?.faceUnit).toBe('sat')
  })

  it('still answers for a voucher carrying no paid fields at all', () => {
    // An ordinary coupon, or a licence minted before the fields existed. It
    // falls back to the signed face value rather than showing a blank.
    expect(paidFor({ faceValue: 500, unit: 'EUR', merchantMetadata: null })).toEqual({
      amountMinor: 500,
      currency: 'EUR',
    })
  })
})

describe('a pilot', () => {
  it('holds a real licence, marked as a pilot', () => {
    const { token, issuerPublicKey } = mint(terms({ pilot: true }))

    const verdict = verifyLicence(licenceFromToken(token), {
      issuerPublicKey,
      now: 1800000000,
      presenter: CUSTOMER_KEY,
      verifySignature: licenceSignatureVerifier({ token }),
    })

    // Real, not a bypass: it goes through the same verification a paying
    // customer's does, which is the point of not having a build-time flag.
    expect(verdict.granted).toBe(true)
    if (verdict.granted) expect(verdict.grant.pilot).toBe(true)
  })

  it('is distinguishable from a paying customer without asking them', () => {
    expect(licenceFromToken(mint(terms({ pilot: true })).token)?.pilot).toBe(true)
    expect(licenceFromToken(mint(terms()).token)?.pilot).toBe(false)
  })

  it('does not write a pilot marker onto a paying customer licence', () => {
    expect(licenceMetadataJson(terms())).not.toContain('pilot')
  })
})

describe('renewal keeps one relationship', () => {
  it('reuses the subscription id, so a year of renewals is one customer', () => {
    const first = terms()
    const second = renewalTerms(first, {
      lockKey: CUSTOMER_KEY,
      paidAmountMinor: 4200,
      paidCurrency: 'GBP',
    })

    expect(second.subscriptionId).toBe(first.subscriptionId)
  })

  it('survives a re-issue to a NEW key after the customer lost theirs', () => {
    const original = terms({ pilot: true })
    const replacementKey = 'd'.repeat(64)

    const reissued = renewalTerms(original, {
      lockKey: replacementKey,
      paidAmountMinor: 0,
      paidCurrency: 'GBP',
    })

    // The id is the thread support follows, and it is the ONLY thing that
    // survives here: the key changed, and the voucher id will too.
    expect(reissued.subscriptionId).toBe(original.subscriptionId)
    expect(reissued.lockKey).toBe(replacementKey)
    // Carried over, so a customer who lost a phone does not also lose what they
    // bought or stop being a pilot.
    expect(reissued.pilot).toBe(true)

    const { token, issuerPublicKey } = mint(reissued)
    const verdict = verifyLicence(licenceFromToken(token), {
      issuerPublicKey,
      now: 1800000000,
      presenter: replacementKey,
      verifySignature: licenceSignatureVerifier({ token }),
    })
    expect(verdict.granted).toBe(true)
  })

  it('leaves the wallet holding ONE licence, the renewal, not two', () => {
    const first = terms()
    const soldAt = 1800000000

    const original = mint(first, soldAt + TERM_DAYS.annual * 86400)
    const renewal = mint(
      renewalTerms(first, { lockKey: CUSTOMER_KEY, paidAmountMinor: 4200, paidCurrency: 'GBP' }),
      soldAt + 2 * TERM_DAYS.annual * 86400,
    )

    const held = heldLicences([rowFor(original.token), rowFor(renewal.token)])

    expect(held).toHaveLength(1)
    expect(held[0].licence.expiresAt).toBe(soldAt + 2 * TERM_DAYS.annual * 86400)
  })

  it('creates a SECOND relationship when a fresh id is used by mistake', () => {
    // The negative of the above, and the reason `renewalTerms` exists: minting
    // a renewal with a new id produces a perfectly valid licence and quietly
    // turns one customer into two.
    const soldAt = 1800000000
    const first = mint(terms(), soldAt + 86400)
    const wrong = mint(terms({ subscriptionId: 'sub_other' }), soldAt + 2 * 86400)

    expect(heldLicences([rowFor(first.token), rowFor(wrong.token)])).toHaveLength(2)
  })
})

describe('a subscription id', () => {
  it('is unique per customer, so two sales are never one relationship', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newSubscriptionId()))
    expect(ids.size).toBe(50)
  })

  it('reveals nothing about the customer it belongs to', () => {
    // Derived from randomness, not from the key or the name: it is carried in a
    // credential the customer hands to their own devices.
    const id = newSubscriptionId()
    expect(id).toMatch(/^sub_[0-9a-f]{16}$/)
    expect(id).not.toContain(CUSTOMER_KEY.slice(0, 8))
  })
})

describe('the seller script writes what the wallet reads', () => {
  /**
   * `scripts/sell-subscription.mjs` is the tool that actually sells one, and it
   * cannot import this app's TypeScript without a build step — so it restates
   * `licenceMetadataJson`. A restatement is a copy, and a copy drifts.
   *
   * The drift is silent in the worst way: the script keeps minting vouchers,
   * they keep verifying, and the wallet stops recognising them as licences — so
   * a paying customer's subscription quietly becomes a coupon in their balance.
   * Comparing the two outputs byte for byte is the only thing that catches it.
   */
  it('produces byte-identical metadata to the definition it restates', async () => {
    const script = await import('../../../scripts/sell-subscription.mjs')

    for (const pilot of [false, true]) {
      const t = terms({ pilot })
      expect(
        script.licenceMetadata({
          lockKey: t.lockKey,
          subscriptionId: t.subscriptionId,
          features: [LICENCE_FEATURES.TERMINALS],
          pilot,
          paidAmountMinor: t.paidAmountMinor,
          paidCurrency: t.paidCurrency,
        }),
      ).toBe(licenceMetadataJson(t))
    }
  })

  it('mints something the wallet recognises, using the SCRIPT\'s metadata', async () => {
    // The round trip that matters: the script's own bytes, through a real signed
    // voucher, into the wallet's recogniser and check.
    const { licenceMetadata } = await import('../../../scripts/sell-subscription.mjs')

    const { token, voucher } = buildVoucherToken({
      merchantMetadata: licenceMetadata({
        lockKey: CUSTOMER_KEY,
        subscriptionId: 'sub_from_script',
        features: ['terminals'],
        paidAmountMinor: 4000,
        paidCurrency: 'GBP',
      }),
      faceValue: 4000,
      unit: 'GBP',
      expiresAt: 1900000000,
    })

    const verdict = verifyLicence(licenceFromToken(token), {
      issuerPublicKey: voucher.issuerPublicKey,
      now: 1800000000,
      presenter: CUSTOMER_KEY,
      verifySignature: licenceSignatureVerifier({ token }),
    })

    expect(verdict.granted).toBe(true)
    if (verdict.granted) expect(verdict.grant.subscriptionId).toBe('sub_from_script')
  })
})
