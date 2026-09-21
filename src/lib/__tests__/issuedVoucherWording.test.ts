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
  type EvidenceLine,
} from '../issuedVoucherWording'

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
    // Every sale made before warrants shipped, and every sale made on a
    // terminal, whose key is not the stall's. Colouring these red would bury
    // the one row that actually disagrees with itself.
    expect(describeWarrant({ verdict: 'absent' }).tone).toBe('neutral')
    expect(describeWarrant({ verdict: 'unwarranted' }).tone).toBe('neutral')
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
