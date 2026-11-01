/**
 * How a voucher's evidence is said to a merchant.
 *
 * The wording is tested apart from the screen because these sentences are the
 * product, not decoration: each one is a claim about money that a reader could
 * take for more than it says. Three rules, and every case below is one of them:
 *
 *  1. Absence is never approval.
 *  2. Authorisation is not payment.
 *  3. Only a mismatch is an alarm.
 */
import { describe, it, expect } from 'vitest'

import {
  describeRail,
  describeWarrant,
  describeAttestation,
  describeCashbackKind,
  describeCashbackClaim,
  describeUnderstatedSale,
  describeUnderstatedLine,
  type EvidenceLine,
} from '../issuedVoucherWording'
import { formatFace } from '../format'

const DATE = (ms: number) => `day ${ms}`
const claimLine = (status: string | undefined, expired = false, claimedAt?: number) =>
  describeCashbackClaim({ status, expired, claimedAt }, DATE)

/** Every line the three describers can produce, for the rules that hold across all of them. */
const EVERY_LINE: EvidenceLine[] = [
  describeRail({ kind: 'card' }),
  describeRail({ kind: 'card', reference: 'pi_123' }),
  describeRail({ kind: 'counter' }),
  describeRail({ kind: 'unknown' }),
  describeWarrant({ verdict: 'verified' }),
  describeWarrant({ verdict: 'claimed' }),
  describeWarrant({ verdict: 'absent' }),
  describeWarrant({ verdict: 'unwarranted' }),
  describeWarrant({ verdict: 'failed', reason: 'signature did not verify' }),
  describeAttestation({ verdict: 'attested' }),
  describeAttestation({ verdict: 'none' }),
  describeAttestation({ verdict: 'invalid', reason: 'names a different stall' }),
  describeCashbackKind(),
  claimLine('Claimed', false, 1),
  claimLine('Claimed'),
  claimLine('Unclaimed'),
  claimLine(undefined),
  claimLine(undefined, true),
  claimLine('Expired', true),
  claimLine('Revoked'),
  claimLine('ManualAttention'),
  claimLine('SomethingNew'),
]

describe('every line of evidence', () => {
  it('always carries a tone, so the screen never has to guess', () => {
    // The tone is what picks the glyph. A line without one would render with
    // no mark at all, which on a screen where two of the three rows normally
    // carry a tick reads as a rendering fault rather than as a third state.
    for (const line of EVERY_LINE) {
      expect(['confirmed', 'neutral', 'alarming'], line.label).toContain(line.tone)
    }
  })

  it('always says what it does not establish', () => {
    // A bare verdict is the thing this module exists to avoid. Every label is
    // one someone could over-read, so each carries its own sentence.
    for (const line of EVERY_LINE) {
      expect(line.detail, line.label).toBeTruthy()
    }
  })
})

describe('only a mismatch is an alarm', () => {
  it('alarms on a signature that no longer covers its sale', () => {
    // One of the two records was altered after the fact, which is exactly what
    // an audit is looking for.
    expect(describeWarrant({ verdict: 'failed', reason: 'x' }).tone).toBe('alarming')
    expect(describeAttestation({ verdict: 'invalid', reason: 'x' }).tone).toBe('alarming')
  })

  it('does NOT alarm on a sale that simply carries no signature', () => {
    // Every sale made before warrants shipped, and every sale from a till the
    // stall has not attested. Colouring these red would bury
    // the one row that actually disagrees with itself.
    expect(describeWarrant({ verdict: 'absent' }).tone).toBe('neutral')
    expect(describeWarrant({ verdict: 'unwarranted' }).tone).toBe('neutral')
  })

  // The terminal wording was true while a till's key could not stand for the stall. Since owner
  // attestation (#160 decision 5) an attested till's sales read `verified`, so the copy must no
  // longer say that every terminal sale is unsigned.
  it('no longer says every terminal sale is unsigned', () => {
    expect(describeRail({ kind: 'unknown' }).detail).not.toMatch(/terminal/)
    const unwarranted = describeWarrant({ verdict: 'unwarranted' }).detail ?? ''
    expect(unwarranted).not.toMatch(/That is what a terminal issues/)
    expect(unwarranted).not.toMatch(/a terminal’s key is not the stall’s/)
    expect(unwarranted).toMatch(/till you have not set up again/)
  })

  it('does NOT alarm on a sale with no customer receipt', () => {
    // Most sales have none. Its absence is never a fault — it is evidence a
    // customer can offer, not something a sale requires.
    const line = describeAttestation({ verdict: 'none' })
    expect(line.tone).toBe('neutral')
    expect(line.detail).toMatch(/never a fault/)
  })

  it('does NOT alarm on a sale whose rail was never recorded', () => {
    const line = describeRail({ kind: 'unknown' })
    expect(line.tone).toBe('neutral')
    expect(line.detail).toMatch(/not a sign that anything went wrong/)
  })
})

describe('authorisation is not payment', () => {
  it('says so on the line a merchant is most likely to over-read', () => {
    // "Signed by this stall" reads as "and I was paid" to anyone not thinking
    // about it, and on the counter rail nothing else can ever say money
    // arrived.
    expect(describeWarrant({ verdict: 'verified' }).detail).toMatch(
      /does not prove you were paid/,
    )
  })

  it('will not tick a processor record it cannot check', () => {
    // Referenced rather than verified — the record is the processor's, not
    // this device's, and the verifier returns a different verdict for exactly
    // that reason. A tick here would overstate it.
    const line = describeWarrant({ verdict: 'claimed' })
    expect(line.tone).toBe('neutral')
    expect(line.detail).toMatch(/referenced rather than checked/)
  })
})

describe('the payment rail', () => {
  it('names the processor reference, which is the handle a merchant can chase', () => {
    expect(describeRail({ kind: 'card', reference: 'pi_123' }).detail).toMatch(/pi_123/)
  })

  it('says card without one when the warrant carried no reference', () => {
    const line = describeRail({ kind: 'card' })
    expect(line.label).toBe('Card')
    expect(line.detail).not.toMatch(/undefined/)
  })

  it('never claims cash, only that the sale happened at the counter', () => {
    // The signature witnesses that the stall signed for the sale on its own
    // device. What changed hands - notes, a transfer, a favour - is not
    // something any record here saw.
    const line = describeRail({ kind: 'counter' })
    expect(line.label).toBe('At the counter')
    expect(`${line.label} ${line.detail}`.toLowerCase()).not.toMatch(/\bcash\b/)
  })
})

describe('a cashback claim', () => {
  it('reads claimed, with its date, only when the portal said Claimed', () => {
    const line = claimLine('Claimed', false, 42)
    expect(line.label).toBe('Claimed on day 42')
    expect(line.tone).toBe('confirmed')
  })

  it('drops the date rather than printing "Claimed on " when it does not format', () => {
    expect(describeCashbackClaim({ status: 'Claimed', claimedAt: 1, expired: false }, () => '').label).toBe(
      'Claimed',
    )
  })

  it.each([
    ['no status', undefined, false],
    ['no status, past expiry', undefined, true],
    ['Unclaimed', 'Unclaimed', false],
    ['Expired', 'Expired', true],
    ['Revoked', 'Revoked', false],
    ['ManualAttention', 'ManualAttention', false],
    ['a status this build does not know', 'SomethingNew', false],
  ])('never reads %s as claimed (absence is never approval)', (_name, status, expired) => {
    const line = claimLine(status, expired)
    expect(line.tone).not.toBe('confirmed')
    expect(line.label).not.toMatch(/^Claimed/)
  })

  it('does not say "unclaimed" past expiry when the portal never answered', () => {
    // Nothing asks about a code past its expiry and only final answers are
    // stored, so a claim made just before expiry may not have reached here.
    const line = claimLine(undefined, true)
    expect(line.label).toBe('No claim on record')
    expect(`${line.label} ${line.detail}`).not.toMatch(/unclaimed|did not claim/i)
  })

  it('says unclaimed past expiry when the portal itself said Expired', () => {
    expect(claimLine('Expired', true).label).toBe('Expired unclaimed')
  })

  it('never borrows the Sell receipt wording', () => {
    for (const line of [describeCashbackKind(), claimLine(undefined), claimLine('Claimed', false, 1)]) {
      expect(line.label).not.toBe('Not collected')
      expect(line.label).not.toBe('At the counter')
    }
  })
})


describe('a sale delivered short of its signature (#462)', () => {
  const eur = (minor: number) => formatFace(minor, { unit: 'EUR', decimals: 2 })

  it('states the figures, never a signature failure', () => {
    const line = describeUnderstatedSale(
      { signedMinor: 100_000, deliveredMinor: 20_000, partlyDelivered: true },
      eur,
    )
    expect(line.tone).not.toBe('alarming')
    expect(line.label).toBe('Partly delivered')
    expect(line.detail).toContain('sale signed')
    expect(line.detail).toContain('missing')
    expect(line.detail).not.toMatch(/does not match/i)
  })

  it('gives the panel one line with the count', () => {
    const text = describeUnderstatedLine(
      { understatedSignedMinor: 100_000, understatedMinor: 20_000, counts: { understated: 1 } },
      eur,
    )
    expect(text).toBe(
      `${eur(100_000)} sale signed, ${eur(20_000)} delivered: ${eur(80_000)} missing, 1 sale to look at.`,
    )
  })
})
