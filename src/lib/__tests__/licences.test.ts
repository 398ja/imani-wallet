import { describe, it, expect, beforeEach } from 'vitest'
import type { VoucherRow } from '@imani/wallet-storage'
import { verifyLicence } from '@imani/licence'

import {
  forgetLicenceParses,
  heldLicences,
  isLicence,
  licenceFromToken,
  licenceIn,
  licenceSignatureVerifier,
} from '../licences'
import { spendable, toMerchants, walletTotals, couponsFor } from '../merchants'
import { buildVoucherToken } from './voucherFixtures'

/**
 * A licence must never be money.
 *
 * These are deliberately negative assertions. A confirmatory test — "the licence
 * is recognised" — passes against a wallet that recognises it AND still offers it
 * for spending, which is the actual failure: a merchant's takings figure silently
 * including the subscription they bought.
 */

const SUBSCRIPTION = 'sub_9f2c11'

function licenceMetadata(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    subscription_id: SUBSCRIPTION,
    features: ['terminals'],
    ...over,
  })
}

/** A real, signed voucher whose issuer marked it a licence. */
function licenceToken(over: Record<string, unknown> = {}, expiresAt = 1900000000) {
  return buildVoucherToken({
    merchantMetadata: licenceMetadata(over),
    expiresAt,
    faceValue: 4000,
    unit: 'GBP',
  })
}

function rowFor(token: string, extra: Partial<VoucherRow> = {}): VoucherRow {
  return {
    token_id: `id-${token.slice(-24)}`,
    token,
    amount: 1782,
    face_value: 4000,
    face_unit: 'GBP',
    face_decimals: 2,
    token_amount: 1782,
    issuer_id: 'a'.repeat(64),
    status: 'active',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...extra,
  }
}

beforeEach(() => {
  // The parse cache is keyed on token_id, and these tests mint fresh tokens per
  // case; clearing keeps one test's fixture from answering for another's.
  forgetLicenceParses()
})

describe('recognising a licence', () => {
  it('reads the licence out of a voucher its issuer marked as one', () => {
    const { token } = licenceToken()
    const licence = licenceFromToken(token)

    expect(licence).not.toBeNull()
    expect(licence!.subscriptionId).toBe(SUBSCRIPTION)
    expect(licence!.features).toEqual(['terminals'])
    // The credential is its own receipt: what was paid, and until when.
    expect(licence!.faceValue).toBe(4000)
    expect(licence!.faceUnit).toBe('GBP')
    expect(licence!.expiresAt).toBe(1900000000)
    expect(licence!.pilot).toBe(false)
  })

  it('does not mistake an ordinary coupon for a licence', () => {
    expect(licenceFromToken(buildVoucherToken().token)).toBeNull()
  })

  it('does not mistake a merchant name in metadata for a licence', () => {
    // The common real content of merchant_metadata. A recogniser keying on the
    // field's PRESENCE would demonetise every coupon in the wallet.
    const { token } = buildVoucherToken({
      merchantMetadata: JSON.stringify({ merchant_name: 'Rosa Green Farm' }),
    })
    expect(licenceFromToken(token)).toBeNull()
  })

  it('needs BOTH a subscription id and features, so neither alone demonetises a coupon', () => {
    expect(licenceFromToken(buildVoucherToken({
      merchantMetadata: JSON.stringify({ subscription_id: SUBSCRIPTION }),
    }).token)).toBeNull()

    expect(licenceFromToken(buildVoucherToken({
      merchantMetadata: JSON.stringify({ features: ['terminals'] }),
    }).token)).toBeNull()
  })

  it('ignores a marker the SENDER put on the DM envelope', () => {
    // The envelope is unauthenticated (voucherToken.ts's header). If a marker
    // there counted, anyone could make a merchant's coupon vanish from their own
    // balance by claiming it was a subscription.
    const { token } = buildVoucherToken()
    const row = rowFor(token, { memo: licenceMetadata() } as Partial<VoucherRow>)
    expect(isLicence(row)).toBe(false)
  })

  it('is not a licence when the marker was added after signing', () => {
    // `tamper` applies after the signature, which is what an altered voucher
    // actually looks like. The DM path refuses such a message outright; here the
    // point is that recognition never rests on unsigned bytes.
    const { token } = buildVoucherToken({}, [1000], {
      merchantMetadata: licenceMetadata(),
    })
    const licence = licenceFromToken(token)
    if (licence) {
      // Parsing may still read the altered field — the signature is what decides
      // whether it means anything, and it must not.
      expect(verifyLicence(licence, {
        issuerPublicKey: licence.issuerPublicKey,
        now: 1,
        presenter: licence.lockKey ?? 'x',
        verifySignature: licenceSignatureVerifier({ token }),
      }).granted).toBe(false)
    }
  })

  it('treats unreadable and non-voucher tokens as not-a-licence', () => {
    expect(licenceFromToken('cashuBnot-a-real-token')).toBeNull()
    expect(licenceFromToken(undefined)).toBeNull()
    expect(licenceFromToken('')).toBeNull()
  })
})

describe('a licence is never money', () => {
  it('is not offered for spending', () => {
    const licence = rowFor(licenceToken().token)
    const coupon = rowFor(buildVoucherToken().token, { token_id: 'coupon-1' })

    const offered = spendable([licence, coupon])

    expect(offered).toHaveLength(1)
    expect(offered[0].token_id).toBe('coupon-1')
    expect(offered).not.toContain(licence)
  })

  it('does not sum into a wallet total', () => {
    const licence = rowFor(licenceToken().token)
    const withLicence = walletTotals(toMerchants([licence]))

    // Not "smaller than" — zero. The only holding is a licence, so every unit
    // total must be absent rather than reduced.
    expect(withLicence).toEqual([])
  })

  it('does not change a total that already has money in it', () => {
    const coupon = rowFor(buildVoucherToken().token, { token_id: 'coupon-1' })
    const licence = rowFor(licenceToken().token)

    const moneyOnly = walletTotals(toMerchants([coupon]))
    const withLicence = walletTotals(toMerchants([coupon, licence]))

    expect(withLicence).toEqual(moneyOnly)
  })

  it('does not appear in a merchant\'s coupon list', () => {
    const issuer = 'b'.repeat(64)
    const licence = rowFor(licenceToken().token, { issuer_id: issuer })
    const coupon = rowFor(buildVoucherToken().token, { token_id: 'coupon-1', issuer_id: issuer })

    const listed = couponsFor([licence, coupon], issuer)

    expect(listed.map((r) => r.token_id)).toEqual(['coupon-1'])
  })

  it('stays out of the balance even when it has expired', () => {
    // An expired licence grants nothing, and it is still not money. A wallet
    // that only excluded LIVE licences would resurrect a lapsed subscription as
    // spendable value.
    const expired = rowFor(licenceToken({}, 1000).token)
    expect(spendable([expired])).toEqual([])
  })
})

describe('holding one licence per subscription', () => {
  it('replaces a held licence when one with a later expiry arrives', () => {
    const older = rowFor(licenceToken({}, 1_800_000_000).token, { token_id: 'old' })
    const renewal = rowFor(licenceToken({}, 1_900_000_000).token, { token_id: 'new' })

    const held = heldLicences([older, renewal])

    expect(held).toHaveLength(1)
    expect(held[0].row.token_id).toBe('new')
    expect(held[0].licence.expiresAt).toBe(1_900_000_000)
  })

  it('picks the renewal whichever order the rows arrive in', () => {
    // Arrival order is a relay's choice. A rule keyed on it would downgrade a
    // paid-up stall the moment an old voucher was re-delivered.
    const older = rowFor(licenceToken({}, 1_800_000_000).token, { token_id: 'old' })
    const renewal = rowFor(licenceToken({}, 1_900_000_000).token, { token_id: 'new' })

    expect(heldLicences([renewal, older])[0].row.token_id).toBe('new')
    expect(heldLicences([older, renewal])[0].row.token_id).toBe('new')
  })

  it('does not produce two licences for one subscription id', () => {
    const rows = [
      rowFor(licenceToken({}, 1_800_000_000).token, { token_id: 'a' }),
      rowFor(licenceToken({}, 1_850_000_000).token, { token_id: 'b' }),
      rowFor(licenceToken({}, 1_900_000_000).token, { token_id: 'c' }),
    ]

    const held = heldLicences(rows)

    expect(held).toHaveLength(1)
    expect(held[0].licence.subscriptionId).toBe(SUBSCRIPTION)
  })

  it('keeps two DIFFERENT subscriptions apart', () => {
    const one = rowFor(licenceToken().token, { token_id: 'one' })
    const other = rowFor(
      licenceToken({ subscription_id: 'sub_other' }).token,
      { token_id: 'other' },
    )

    expect(heldLicences([one, other])).toHaveLength(2)
  })

  it('does not let an older re-delivery unseat the renewal on a tie', () => {
    const first = rowFor(licenceToken({}, 1_900_000_000).token, { token_id: 'first' })
    const redelivered = rowFor(licenceToken({}, 1_900_000_000).token, { token_id: 'second' })

    const held = heldLicences([first, redelivered])
    expect(held).toHaveLength(1)
    expect(held[0].row.token_id).toBe('first')
  })

  it('prefers a dated licence over one carrying no expiry', () => {
    // `verifyLicence` refuses a licence with no expiry, so electing one over a
    // dated licence would lock out a stall that is paid up.
    const undated = rowFor(buildVoucherToken({
      merchantMetadata: licenceMetadata(),
      expiresAt: undefined,
    }).token, { token_id: 'undated' })
    const dated = rowFor(licenceToken().token, { token_id: 'dated' })

    expect(heldLicences([undated, dated])[0].row.token_id).toBe('dated')
    expect(heldLicences([dated, undated])[0].row.token_id).toBe('dated')
  })

  it('holds nothing when the wallet holds only coupons', () => {
    expect(heldLicences([rowFor(buildVoucherToken().token)])).toEqual([])
  })
})

describe('the signature verifier handed to @imani/licence', () => {
  it('accepts a genuine licence and refuses a tampered one', () => {
    const { token } = licenceToken()
    const licence = licenceIn(rowFor(token))!
    expect(licenceSignatureVerifier({ token })(licence)).toBe(true)

    const forged = buildVoucherToken(
      { merchantMetadata: licenceMetadata() },
      [1000],
      { faceValue: 999999 },
    )
    expect(licenceSignatureVerifier({ token: forged.token })(licence)).toBe(false)
  })

  it('refuses rather than throwing on an unreadable token', () => {
    const licence = licenceIn(rowFor(licenceToken().token))!
    expect(licenceSignatureVerifier({ token: 'nonsense' })(licence)).toBe(false)
  })
})
