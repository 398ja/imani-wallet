/**
 * One issued voucher, read back as a whole.
 *
 * The cases worth pinning are the ones where a plausible shortcut gives a
 * different answer from the right one:
 *
 *  - Claimed is a SUM over several returns, not a flag, because a coupon is
 *    spent down rather than used up.
 *  - The stall's own issuance row must never count as a claim against itself,
 *    which is a real trap: the stored `direction` field is hardcoded `'in'` by
 *    the writer, so anything reading it off the row rather than through
 *    `toTransaction` consumes the whole voucher on the day it is issued.
 *  - The rail has THREE values. An unwarranted sale is not a cash sale, and
 *    reporting it as one would be this wallet inventing a fact about money.
 */
import { describe, it, expect } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'

import { issuedVoucher, issuedVouchers, isExpired, paymentRail } from '../issuedVoucher'
import { parseIssuanceWarrant, warrantSaleDigest } from '../issuanceWarrant'
import { serialiseCashAttestation, signCashAttestation } from '../cashAttestation'
import type { WalletTransaction } from '../transactions'

const STALL_SK = '9'.repeat(63) + '1'
const STALL = bytesToHex(schnorr.getPublicKey(hexToBytes(STALL_SK)))

const CUSTOMER_SK = hexToBytes('7'.repeat(63) + '3')
const CUSTOMER = bytesToHex(schnorr.getPublicKey(CUSTOMER_SK))

const NOW = 1_800_000_000_000
const DAY = 86_400_000

const NONCE = 'nonce-one'

/** A genuine merchant warrant over a sale total, signed by the stall. */
function warrantFor(total: number, { nonce = NONCE, unit = 'XAF', decimals = 0 } = {}): string {
  return JSON.stringify({
    form: 'merchant',
    sale_total: total,
    face_decimals: decimals,
    unit,
    nonce,
    sig: bytesToHex(
      schnorr.sign(warrantSaleDigest(STALL, total, decimals, unit, nonce), hexToBytes(STALL_SK)),
    ),
  })
}

function issued(
  voucherId: string,
  amount: number,
  over: Partial<WalletTransaction> = {},
): WalletTransaction {
  return {
    id: `issued:${voucherId}`,
    type: 'issued',
    // As `toTransaction` derives it for an `issued` row: money leaving.
    direction: 'out',
    at: NOW - DAY,
    amount,
    unit: 'XAF',
    decimals: 0,
    voucherId,
    counterparty: CUSTOMER,
    memo: `Voucher ${voucherId}`,
    ...over,
  }
}

/** A coupon coming home: an incoming row against the same voucher id. */
function claim(voucherId: string, amount: number, at = NOW): WalletTransaction {
  return {
    id: `received:${voucherId}-${amount}`,
    type: 'received',
    direction: 'in',
    at,
    amount,
    unit: 'XAF',
    decimals: 0,
    voucherId,
    merchantId: STALL,
  }
}

describe('the vouchers a stall has issued', () => {
  it('leaves out expired ones by default, and includes them on request', () => {
    const rows = [
      issued('live', 1000, { expiresAt: NOW + DAY }),
      issued('gone', 500, { expiresAt: NOW - DAY }),
    ]

    expect(issuedVouchers(rows, { now: NOW }).map((r) => r.voucherId)).toEqual(['live'])
    expect(
      issuedVouchers(rows, { now: NOW, includeExpired: true }).map((r) => r.voucherId).sort(),
    ).toEqual(['gone', 'live'])
  })

  it('keeps a voucher with no expiry, which is not the same as an expired one', () => {
    // Absent means "never expires" here, and a filter that dropped it would
    // hide live money from the merchant holding the liability for it.
    expect(issuedVouchers([issued('forever', 1000)], { now: NOW })).toHaveLength(1)
    expect(isExpired(issued('forever', 1000), NOW)).toBe(false)
  })

  it('counts a voucher expiring exactly now as expired', () => {
    // The boundary matters at a counter: a coupon whose last second has passed
    // is one a merchant is deciding whether to honour.
    expect(isExpired(issued('edge', 1000, { expiresAt: NOW }), NOW)).toBe(true)
  })

  it('lists only issuances, not the coupons that came back', () => {
    const rows = [issued('v1', 1000), claim('v1', 400)]
    expect(issuedVouchers(rows, { now: NOW }).map((r) => r.id)).toEqual(['issued:v1'])
  })

  it('leaves cashback out, which has no voucher to claim against', () => {
    // A cashback is an issuance for reconciliation and not a voucher: there is
    // no recipient wallet, so its "claimed" figure could only ever be zero.
    const rows = [
      issued('v1', 1000),
      { ...issued('c1', 500), type: 'cashback', id: 'cashback:c1' },
    ]
    expect(issuedVouchers(rows, { now: NOW }).map((r) => r.voucherId)).toEqual(['v1'])
  })

  it('puts the newest first', () => {
    const rows = [
      issued('old', 100, { at: NOW - 5 * DAY }),
      issued('new', 100, { at: NOW - DAY }),
    ]
    expect(issuedVouchers(rows, { now: NOW }).map((r) => r.voucherId)).toEqual(['new', 'old'])
  })

  it('drops a row with no voucher id, which has nowhere to link to', () => {
    // Every row on this list links to `/merchant/coupon/<voucherId>`. An empty
    // id makes that `/merchant/coupon/`, which matches no route and falls
    // through App's catch-all to the till — a merchant taps a coupon and lands
    // on the home screen with nothing explaining why.
    const rows = [issued('v1', 1000), issued('', 500, { voucherId: undefined })]
    expect(issuedVouchers(rows, { now: NOW }).map((r) => r.voucherId)).toEqual(['v1'])
  })
})

describe('one issued voucher', () => {
  const opts = { now: NOW, stallPubkey: STALL }

  it('sums what has come back across several claims', () => {
    // A coupon is spent down, not used up: one issuance legitimately returns
    // more than once, so the answer is a sum rather than a flag.
    const rows = [issued('v1', 1000), claim('v1', 400), claim('v1', 250)]
    const voucher = issuedVoucher(rows, 'v1', opts)

    expect(voucher?.claimedMinor).toBe(650)
    expect(voucher?.outstandingMinor).toBe(350)
    expect(voucher?.claims).toHaveLength(2)
  })

  it('never counts the issuance itself as a claim against itself', () => {
    // The trap this exists to catch: stored rows carry a hardcoded
    // `direction: 'in'`, so anything reading direction off the row rather than
    // through `toTransaction` would report a voucher fully claimed the moment
    // it was sold.
    const voucher = issuedVoucher([issued('v1', 1000)], 'v1', opts)

    expect(voucher?.claimedMinor).toBe(0)
    expect(voucher?.outstandingMinor).toBe(1000)
    expect(voucher?.claims).toEqual([])
  })

  it('ignores claims against a different voucher', () => {
    const rows = [issued('v1', 1000), claim('v2', 900)]
    expect(issuedVoucher(rows, 'v1', opts)?.claimedMinor).toBe(0)
  })

  it('refuses to subtract a claim in another currency', () => {
    // Numbers in different currencies are not comparable, which is why the
    // warrant verifier checks denomination FIRST and why every total in this
    // wallet is per-unit. Without the guard a 900 XAF row would settle a
    // EUR 9.00 voucher and report nothing outstanding.
    const rows = [issued('v1', 900), { ...claim('v1', 900), unit: 'EUR', decimals: 2 }]
    const voucher = issuedVoucher(rows, 'v1', opts)

    expect(voucher?.claimedMinor).toBe(0)
    expect(voucher?.outstandingMinor).toBe(900)
    expect(voucher?.claims).toEqual([])
  })

  it('refuses a claim whose decimals differ, at the same unit name', () => {
    // The subtler half of the same check: `displayDecimals` has corrected XAF
    // rows from 2 to 0, so a pre-fix row and a post-fix row can share a unit
    // and mean amounts a hundredfold apart.
    const rows = [issued('v1', 900), { ...claim('v1', 900), decimals: 2 }]
    expect(issuedVoucher(rows, 'v1', opts)?.claimedMinor).toBe(0)
  })

  it('floors what is outstanding at zero', () => {
    // History restored in pieces can leave more coming back than one row
    // recorded going out. A negative liability would read as the stall being
    // owed money by a coupon it issued, which is the wrong way to be wrong.
    const rows = [issued('v1', 1000), claim('v1', 1400)]
    expect(issuedVoucher(rows, 'v1', opts)?.outstandingMinor).toBe(0)
  })

  it('puts the newest claim first, so the last thing that happened leads', () => {
    const rows = [
      issued('v1', 1000),
      claim('v1', 100, NOW - 3 * DAY),
      claim('v1', 200, NOW - DAY),
    ]
    expect(issuedVoucher(rows, 'v1', opts)?.claims.map((c) => c.amount)).toEqual([200, 100])
  })

  it('answers undefined for a voucher this history has never seen', () => {
    // "Not in my records", never "not issued": a coupon sold on another
    // terminal is not in this history either.
    expect(issuedVoucher([issued('v1', 1000)], 'other', opts)).toBeUndefined()
    expect(issuedVoucher([issued('v1', 1000)], '', opts)).toBeUndefined()
  })
})

describe('what stands behind a voucher', () => {
  const opts = { now: NOW, stallPubkey: STALL }

  it('verifies a genuine warrant against the stall', () => {
    const rows = [issued('v1', 1000, { issuanceWarrant: warrantFor(1000) })]
    expect(issuedVoucher(rows, 'v1', opts)?.warrantVerdict).toEqual({ verdict: 'verified' })
  })

  it('refuses a warrant whose row has been edited since it was signed', () => {
    // The whole reason the warrant is stored: a row and the signature filed
    // beside it disagreeing means one of the two changed after the fact.
    const rows = [issued('v1', 9000, { issuanceWarrant: warrantFor(1000) })]
    expect(issuedVoucher(rows, 'v1', opts)?.warrantVerdict.verdict).toBe('failed')
  })

  it('reads a sale with no warrant as absent, not as a failure', () => {
    // Every sale made before warrants shipped. Ordinary, not an alarm.
    expect(issuedVoucher([issued('v1', 1000)], 'v1', opts)?.warrantVerdict).toEqual({
      verdict: 'absent',
    })
  })

  it('keeps the customer attestation separate from the stall authorisation', () => {
    // Authorisation and consideration are different claims. A warrant says the
    // stall meant to issue; only this says money arrived.
    const attestation = serialiseCashAttestation(
      signCashAttestation(CUSTOMER_SK, CUSTOMER, {
        stallPubkey: STALL,
        saleTotalMinor: 1000,
        faceDecimals: 0,
        unit: 'XAF',
        saleNonce: NONCE,
      }),
    )
    const rows = [
      issued('v1', 1000, { issuanceWarrant: warrantFor(1000), cashAttestation: attestation }),
    ]
    const voucher = issuedVoucher(rows, 'v1', opts)

    expect(voucher?.warrantVerdict).toEqual({ verdict: 'verified' })
    expect(voucher?.attestationVerdict).toEqual({ verdict: 'attested' })
    expect(voucher?.attestation?.customerPubkey).toBe(CUSTOMER)
  })

  it('reports a missing attestation as none, which is the ordinary case', () => {
    const rows = [issued('v1', 1000, { issuanceWarrant: warrantFor(1000) })]
    expect(issuedVoucher(rows, 'v1', opts)?.attestationVerdict).toEqual({ verdict: 'none' })
  })

  it('reports an attestation with no warrant as none, having nothing to bind to', () => {
    // No warrant means no sale nonce, so there is nothing an attestation could
    // be checked against. The attestation is not wrong; it is uncheckable.
    const rows = [issued('v1', 1000, { cashAttestation: '{"customer":"x"}' })]
    expect(issuedVoucher(rows, 'v1', opts)?.attestationVerdict).toEqual({ verdict: 'none' })
  })
})

describe('which rail paid for a voucher', () => {
  it('calls a processor warrant a card payment, and keeps its reference', () => {
    const warrant = parseIssuanceWarrant(
      JSON.stringify({
        form: 'processor',
        sale_total: 1000,
        face_decimals: 0,
        unit: 'XAF',
        nonce: NONCE,
        ref: 'pi_123',
      }),
    )
    expect(paymentRail(warrant)).toEqual({ kind: 'card', reference: 'pi_123' })
  })

  it('calls a stall-signed sale a counter sale', () => {
    expect(paymentRail(parseIssuanceWarrant(warrantFor(1000)))).toEqual({ kind: 'counter' })
  })

  it('refuses to call an unwarranted sale cash', () => {
    // A signed `none` is what every terminal issues, because a terminal's key
    // is not the stall's. Printing "cash" over it would assert a payment
    // method nothing in the record witnessed.
    expect(paymentRail(parseIssuanceWarrant(JSON.stringify({ form: 'none' })))).toEqual({
      kind: 'unknown',
    })
  })

  it('refuses to name a rail for a sale with no warrant at all', () => {
    expect(paymentRail(parseIssuanceWarrant(undefined))).toEqual({ kind: 'unknown' })
  })

  it('refuses to name a rail for an unreadable warrant', () => {
    expect(paymentRail(parseIssuanceWarrant('not json'))).toEqual({ kind: 'unknown' })
  })
})

describe('the sale a voucher came from', () => {
  const opts = { now: NOW, stallPubkey: STALL }

  it('finds the siblings minted beside it', () => {
    const siblings = ['a', 'b', 'c']
    const rows = siblings.map((id) =>
      issued(id, 1000, { issuanceWarrant: warrantFor(3000), saleVoucherIds: siblings }),
    )
    const voucher = issuedVoucher(rows, 'a', opts)

    expect(voucher?.sale.map((r) => r.voucherId).sort()).toEqual(siblings)
    expect(voucher?.saleComplete).toBe(true)
  })

  it('notices when part of a sale is missing from these records', () => {
    // The shape of a partial delivery, a device that failed mid-sale, or
    // history that has been edited. Distinguishing those is a human's job.
    const siblings = ['a', 'b', 'c']
    const rows = [issued('a', 1000, { saleVoucherIds: siblings })]
    expect(issuedVoucher(rows, 'a', opts)?.saleComplete).toBe(false)
  })

  it('treats a single-coupon sale as its own whole sale', () => {
    const voucher = issuedVoucher([issued('v1', 1000)], 'v1', opts)
    expect(voucher?.sale).toHaveLength(1)
    expect(voucher?.saleComplete).toBe(true)
  })
})
