/**
 * Reconciling a merchant's own history against what they signed.
 *
 * The case that matters most is the tampered row: a warrant that verified when
 * it was written must STOP verifying if the amount beside it is edited. That is
 * the difference between a ledger you trust because it is yours and one anyone
 * can re-check, and it is the whole reason the warrant is stored at all.
 */
import { describe, it, expect } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'

import {
  summariseReconciliation,
  reconcileIssuances,
  totalReconciliation,
  reconcileByUnit,
  saleFor,
  saleIsComplete,
} from '../reconcileIssuance'
import { warrantSaleDigest } from '../issuanceWarrant'
import { serialiseCashAttestation, signCashAttestation } from '../cashAttestation'
import type { WalletTransaction } from '../transactions'

const STALL_SK = '9'.repeat(63) + '1'
const STALL = bytesToHex(schnorr.getPublicKey(hexToBytes(STALL_SK)))

const OTHER_SK = '8'.repeat(63) + '2'

function warrantFor(total: number, unit = 'XAF', decimals = 0, sk = STALL_SK): string {
  const nonce = 'n-' + total + unit
  return JSON.stringify({
    form: 'merchant',
    sale_total: total,
    face_decimals: decimals,
    unit,
    nonce,
    sig: bytesToHex(
      schnorr.sign(warrantSaleDigest(STALL, total, decimals, unit, nonce), hexToBytes(sk)),
    ),
  })
}

function issued(
  amount: number,
  over: Partial<WalletTransaction> = {},
  unit = 'XAF',
  decimals = 0,
): WalletTransaction {
  return {
    id: `issued:v-${amount}-${unit}`,
    type: 'issued',
    direction: 'out',
    at: 0,
    amount,
    unit,
    decimals,
    voucherId: `v-${amount}`,
    issuanceWarrant: warrantFor(amount, unit, decimals),
    ...over,
  } as unknown as WalletTransaction
}

describe("a day's takings, re-checked", () => {
  it('reports sales the stall can prove it authorised', () => {
    const result = reconcileIssuances([issued(2500), issued(1000)], STALL)

    expect(result.map((r) => r.verdict)).toEqual(['authorised', 'authorised'])
  })

  it('separates the figure a merchant can vouch for from the one they cannot', () => {
    const totals = totalReconciliation(
      reconcileIssuances(
        [issued(2500), issued(1000), issued(500, { issuanceWarrant: undefined })],
        STALL,
      ),
    )

    expect(totals.authorisedMinor).toBe(3500)
    expect(totals.unwarrantedMinor).toBe(500)
    expect(totals.counts).toEqual({ authorised: 2, unwarranted: 1, mismatch: 0, understated: 0 })
  })

  it('ignores rows that are not issuances', () => {
    // A reconciliation listing every receipt as "not an issuance" is noise that
    // trains people to skim past the rows that matter.
    const received = { ...issued(2500), type: 'received' } as unknown as WalletTransaction

    expect(reconcileIssuances([received], STALL)).toHaveLength(0)
  })
})

describe('tampering is what this is for', () => {
  it('a row whose AMOUNT was edited no longer reconciles', () => {
    // The adversarial case: someone rewrites the history to understate a sale.
    // The warrant was signed over 2500 and the row now claims 900, so the two
    // disagree and the check says so.
    const tampered = issued(2500)
    ;(tampered as { amount: number }).amount = 900

    const [result] = reconcileIssuances([tampered], STALL)

    // Still caught, as `understated` (#462): the row no longer sums to its
    // signed sale, and the 1600 gap is what the merchant is shown. Edited
    // history and a partly delivered sale have the same shape, so neither is
    // worded as a forged signature.
    expect(result.verdict).toBe('understated')
    expect(result.sale).toMatchObject({ signedMinor: 2500, deliveredMinor: 900 })
  })

  it('a row whose CURRENCY was edited no longer reconciles', () => {
    // 2500 XAF and 2500 EUR are different amounts of money wearing the same
    // number. The denomination check catches the swap.
    const tampered = issued(2500)
    ;(tampered as { unit: string }).unit = 'EUR'
    ;(tampered as { decimals: number }).decimals = 2

    expect(reconcileIssuances([tampered], STALL)[0].verdict).toBe('mismatch')
  })

  it('a warrant signed by another key does not reconcile as the stall', () => {
    // A terminal, or anyone else, cannot file sales into a stall's history and
    // have them read as authorised.
    const foreign = issued(2500, { issuanceWarrant: warrantFor(2500, 'XAF', 0, OTHER_SK) })

    expect(reconcileIssuances([foreign], STALL)[0].verdict).toBe('mismatch')
  })

  it('a mismatch carries its reason, so an audit says what is wrong', () => {
    const tampered = issued(2500)
    ;(tampered as { amount: number }).amount = 900_000

    expect(reconcileIssuances([tampered], STALL)[0].reason).toBeDefined()
  })
})

describe('what counts as unwarranted rather than wrong', () => {
  it('a row written before warrants existed', () => {
    // Every row in the estate today. Not a failure, and reporting it as one
    // would make the whole history look tampered with.
    const legacy = issued(2500, { issuanceWarrant: undefined })

    expect(reconcileIssuances([legacy], STALL)[0].verdict).toBe('unwarranted')
  })

  it('a sale the stall signed as `none`', () => {
    // A terminal issuing within its limits: it cannot produce a merchant
    // warrant, and it said so rather than staying silent. An honest record of
    // an unbacked sale reconciles as unwarranted, not as a mismatch.
    const none = issued(2500, { issuanceWarrant: JSON.stringify({ form: 'none' }) })

    expect(reconcileIssuances([none], STALL)[0].verdict).toBe('unwarranted')
  })
})

describe('currencies are totalled separately', () => {
  it('does not add XAF to EUR', () => {
    // The same class of error the warrant's own denomination check exists to
    // catch. 2500 XAF plus 2500 EUR is a number that means nothing.
    const byUnit = reconcileByUnit(
      [issued(2500, {}, 'XAF', 0), issued(2500, {}, 'EUR', 2)],
      STALL,
    )

    expect(byUnit.get('XAF')?.authorisedMinor).toBe(2500)
    expect(byUnit.get('EUR')?.authorisedMinor).toBe(2500)
    expect([...byUnit.keys()].sort()).toEqual(['EUR', 'XAF'])
  })
})


describe('finding the sale a returned coupon came from', () => {
  // One EUR 25.00 sale that the portal split into three coupons. Every part
  // carries the same warrant and the same sibling list.
  const ids = ['v-a', 'v-b', 'v-c']
  const part = (id: string, amount: number): WalletTransaction =>
    ({
      id: `issued:${id}`,
      type: 'issued',
      direction: 'out',
      at: 0,
      amount,
      unit: 'XAF',
      decimals: 0,
      voucherId: id,
      issuanceWarrant: warrantFor(2500),
      saleVoucherIds: ids,
    }) as unknown as WalletTransaction

  const history = [part('v-a', 834), part('v-b', 833), part('v-c', 833)]

  it('returns every coupon of the sale, from any one of them', () => {
    // The question at the till: a customer presents one coupon, and the
    // merchant wants the sale behind it.
    expect(saleFor(history, 'v-b').map((r) => r.voucherId)).toEqual(ids)
  })

  it('reports a complete sale as complete', () => {
    expect(saleIsComplete(history, 'v-b')).toBe(true)
  })

  it('reports a sale with a missing row as incomplete', () => {
    // The shape of a partial delivery, a device that died mid-sale, or edited
    // history. Which of those it is takes a human; that they differ is this.
    expect(saleIsComplete([history[0], history[1]], 'v-a')).toBe(false)
  })

  it('treats a single-coupon sale as its own whole sale', () => {
    // No sibling list is written for these, so the absence must not read as a
    // sale whose parts are all missing.
    const solo = issued(2500)
    expect(saleFor([solo], solo.voucherId!)).toHaveLength(1)
    expect(saleIsComplete([solo], solo.voucherId!)).toBe(true)
  })

  it('returns nothing for a coupon this device never issued', () => {
    // An empty result means "not in my records", never "not issued" - another
    // terminal's sale is simply not here.
    expect(saleFor(history, 'v-elsewhere')).toHaveLength(0)
    expect(saleIsComplete(history, 'v-elsewhere')).toBe(false)
  })

  it('catches a split sale whose rows no longer sum to the warrant', () => {
    // The understatement that a per-row ceiling check cannot see: each part
    // verifies on its own, because a warrant for 2500 legitimately covers 833.
    // Only summing the siblings shows one is missing.
    const short = [part('v-a', 834), part('v-b', 833)]
    const verdicts = reconcileIssuances(short, STALL).map((r) => r.verdict)

    // Understated, not mismatch (#462): the signatures hold, and calling it
    // a mismatch read as forgery for what is usually a partial delivery.
    expect(verdicts).toEqual(['understated', 'understated'])
  })

  it('reports an overstated split sale as overstated, counted with mismatches', () => {
    const over = [part('v-a', 1500), part('v-b', 1500)]
    const result = reconcileIssuances(over, STALL)
    expect(result.map((r) => r.verdict)).toEqual(['overstated', 'overstated'])
    expect(result[0].reason).toMatch(/overstated/)
    const totals = totalReconciliation(result)
    expect(totals.mismatchedMinor).toBe(3000)
    expect(totals.counts.mismatch).toBe(2)
    expect(totals.counts.understated).toBe(0)
  })

  it('accepts a split sale whose rows DO sum to the warrant', () => {
    expect(reconcileIssuances(history, STALL).map((r) => r.verdict)).toEqual([
      'authorised',
      'authorised',
      'authorised',
    ])
  })
})


describe('consideration is reported separately from authorisation', () => {
  // The same sale, with and without the customer's signature on it.
  const NONCE = 'n-2500XAF'
  const CUSTOMER_SK = hexToBytes('5'.repeat(63) + '3')
  const CUSTOMER = bytesToHex(schnorr.getPublicKey(CUSTOMER_SK))

  const attested = () =>
    serialiseCashAttestation(
      signCashAttestation(CUSTOMER_SK, CUSTOMER, {
        stallPubkey: STALL,
        saleTotalMinor: 2500,
        faceDecimals: 0,
        unit: 'XAF',
        saleNonce: NONCE,
      }),
    )

  it('a sale nobody corroborated is still authorised', () => {
    // Most cash sales. Not a fault, and the verdict must not suggest it is.
    const [result] = reconcileIssuances([issued(2500)], STALL)

    expect(result.verdict).toBe('authorised')
    expect(result.paid).toBe('none')
  })

  it('a sale the customer signed for reports both', () => {
    const [result] = reconcileIssuances(
      [issued(2500, { cashAttestation: attested() })],
      STALL,
    )

    expect(result.verdict).toBe('authorised')
    expect(result.paid).toBe('attested')
  })

  it('totals keep the corroborated figure below the authorised one', () => {
    // The gap is what a merchant would have to defend if a sale were disputed.
    const totals = totalReconciliation(
      reconcileIssuances(
        [issued(2500, { cashAttestation: attested() }), issued(1000)],
        STALL,
      ),
    )

    expect(totals.authorisedMinor).toBe(3500)
    expect(totals.attestedMinor).toBe(2500)
  })

  it('a forged attestation does not read as paid', () => {
    // A merchant cannot sign on the customer's behalf.
    const forged = serialiseCashAttestation(
      signCashAttestation(hexToBytes('4'.repeat(63) + '4'), CUSTOMER, {
        stallPubkey: STALL,
        saleTotalMinor: 2500,
        faceDecimals: 0,
        unit: 'XAF',
        saleNonce: NONCE,
      }),
    )

    const [result] = reconcileIssuances([issued(2500, { cashAttestation: forged })], STALL)

    // Still authorised - the STALL's warrant is fine - but not corroborated.
    expect(result.verdict).toBe('authorised')
    expect(result.paid).toBe('invalid')
  })
})


describe('the summary a merchant actually sees', () => {
  it('carries each unit\'s own decimals', () => {
    // Caught in review. The panel formats with these, and hardcoding 0 renders
    // EUR 2500 as "EUR 2,500" instead of "EUR 25.00" - a hundredfold error in
    // the one number a merchant is checking against their till.
    const eur = issued(2500, {}, 'EUR', 2)
    const [line] = summariseReconciliation([eur], STALL)

    expect(line.unit).toBe('EUR')
    expect(line.decimals).toBe(2)
  })

  it('flags mismatches for attention and nothing else', () => {
    // Unwarranted sales are every sale issued before warrants shipped, and
    // every sale a terminal made. Raising them all would bury the one row that
    // actually disagrees with its own signature.
    const clean = summariseReconciliation([issued(2500)], STALL)
    expect(clean[0].needsAttention).toBe(false)

    const legacy = summariseReconciliation([issued(2500, { issuanceWarrant: undefined })], STALL)
    expect(legacy[0].needsAttention).toBe(false)

    const tampered = issued(2500)
    ;(tampered as { amount: number }).amount = 900
    expect(summariseReconciliation([tampered], STALL)[0].needsAttention).toBe(true)
  })

  it('leads with the currency the stall actually trades in', () => {
    // Rather than whichever row happened to be stored first.
    const lines = summariseReconciliation(
      [issued(100, {}, 'EUR', 2), issued(90_000, {}, 'XAF', 0)],
      STALL,
    )

    expect(lines[0].unit).toBe('XAF')
  })

  it('renders nothing when nothing was issued', () => {
    // A panel of zeroes teaches a merchant that this screen is usually blank,
    // which is how a panel stops being read.
    expect(summariseReconciliation([], STALL)).toEqual([])
  })
})


describe('cashback is reconciled too', () => {
  // The one rail the receipt-time attestation cannot reach: there is no
  // recipient to send a receipt back from, because the whole point of the flow
  // is reaching someone who has no wallet yet. So the merchant's own warrant
  // is the ONLY evidence a cashback will ever carry, which makes leaving it
  // out of the audit worse than leaving out a coupon.
  const cashback = (amount: number, over: Partial<WalletTransaction> = {}) =>
    ({
      id: `cashback:c-${amount}`,
      type: 'cashback',
      direction: 'out',
      at: 0,
      amount,
      unit: 'XAF',
      decimals: 0,
      issuanceWarrant: warrantFor(amount),
      ...over,
    }) as unknown as WalletTransaction

  it('counts a warranted cashback as authorised', () => {
    const [result] = reconcileIssuances([cashback(2500)], STALL)

    expect(result.verdict).toBe('authorised')
  })

  it('catches a tampered cashback row', () => {
    const tampered = cashback(2500)
    ;(tampered as { amount: number }).amount = 900

    expect(reconcileIssuances([tampered], STALL)[0].verdict).toBe('understated')
  })

  it('reports an unwarranted cashback rather than ignoring it', () => {
    // Before this, a cashback was invisible to the audit entirely - a merchant
    // could mint codes all day and the reconciliation would show nothing.
    const [result] = reconcileIssuances(
      [cashback(2500, { issuanceWarrant: undefined })],
      STALL,
    )

    expect(result.verdict).toBe('unwarranted')
  })

  it('never reports a cashback as customer-attested', () => {
    // There is no recipient, so there is nobody who could have signed. If this
    // ever says otherwise, something is filing attestations onto rows that
    // cannot have them.
    const [result] = reconcileIssuances([cashback(2500)], STALL)

    expect(result.paid).toBe('none')
  })

  it('totals cashback alongside coupons in the same currency', () => {
    const totals = totalReconciliation(
      reconcileIssuances([issued(1000), cashback(2500)], STALL),
    )

    expect(totals.authorisedMinor).toBe(3500)
    expect(totals.counts.authorised).toBe(2)
  })
})


describe('a sale signed for more than was delivered (#462)', () => {
  // The issue's case: a EUR 1000.00 warrant, one EUR 200.00 part delivered.
  const shortRow = (over: Partial<WalletTransaction> = {}): WalletTransaction =>
    ({
      id: 'issued:v-short',
      type: 'issued',
      direction: 'out',
      at: 0,
      amount: 20_000,
      unit: 'EUR',
      decimals: 2,
      voucherId: 'v-short',
      issuanceWarrant: warrantFor(100_000, 'EUR', 2),
      ...over,
    }) as unknown as WalletTransaction

  it('is understated with the missing amount, not a mismatch', () => {
    const [item] = reconcileIssuances([shortRow()], STALL)
    expect(item.verdict).toBe('understated')
    expect(item.reason).toBeUndefined()
    expect(item.sale).toMatchObject({ signedMinor: 100_000, deliveredMinor: 20_000, partlyDelivered: false })
  })

  it('reads the row\'s own partial-delivery record when it has one', () => {
    const [item] = reconcileIssuances(
      [shortRow({ saleTotalMinor: 100_000, deliveredMinor: 20_000 })],
      STALL,
    )
    expect(item.sale?.partlyDelivered).toBe(true)
  })

  it('totals every row exactly once and counts the sale once', () => {
    const second = shortRow({ id: 'issued:v-short2', voucherId: 'v-short2' })
    const rows = [shortRow(), second, issued(500, {}, 'EUR', 2), issued(300, { issuanceWarrant: undefined, id: 'u' }, 'EUR', 2)]
    const totals = totalReconciliation(reconcileIssuances(rows, STALL))
    expect(totals.authorisedMinor).toBe(500)
    expect(totals.unwarrantedMinor).toBe(300)
    expect(totals.mismatchedMinor).toBe(0)
    expect(totals.understatedMinor).toBe(40_000)
    expect(totals.understatedSignedMinor).toBe(100_000)
    expect(totals.missingMinor).toBe(60_000)
    expect(totals.counts).toEqual({ authorised: 1, unwarranted: 1, mismatch: 0, understated: 1 })
    const sum =
      totals.authorisedMinor + totals.unwarrantedMinor + totals.mismatchedMinor + totals.understatedMinor
    expect(sum).toBe(rows.reduce((t, r) => t + r.amount, 0))
  })

  it('needs attention in the summary', () => {
    const [line] = summariseReconciliation([shortRow()], STALL)
    expect(line.needsAttention).toBe(true)
    expect(line.missingMinor).toBe(80_000)
    expect(line.counts.mismatch).toBe(0)
  })
})
