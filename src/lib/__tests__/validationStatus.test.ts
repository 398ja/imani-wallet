import { describe, expect, it } from 'vitest'

import {
  VALIDATION_SUMMARY,
  hasPublishedAttestation,
  hasValidationClaim,
  validationStatus,
} from '../validationStatus'
import type { WalletTransaction } from '../transactions'

/**
 * One reading of the checks, shared by the list badge and the detail page.
 *
 * These two surfaces used to read `validation` independently. That is how a row
 * ends up showing a green dot in the list and "Not checked" when you open it —
 * the exact contradiction that makes a security indicator worthless.
 */
const verified = {
  signatureValid: true,
  legacyCanonical: true,
  signedFaceValue: 1000,
  cappedAtFaceValue: false,
  // A checked, authorised coupon. Carrying a warrant verdict is now part of
  // what "verified" MEANS: a record without one was never asked the question,
  // and `unchecked` is the honest answer for it. See the pre-warrant case
  // below, which pins that deliberately rather than by omission.
  warrant: 'verified' as const,
}

/** The `verified` record as it looked before the warrant field existed. */
const preWarrantRecord = () => {
  const record = { ...verified } as Partial<typeof verified>
  delete record.warrant
  return record as Omit<typeof verified, 'warrant'>
}

const tx = (over: Partial<WalletTransaction> = {}): WalletTransaction =>
  ({
    id: 'received:tok-1',
    type: 'received',
    direction: 'in',
    at: 0,
    amount: 1000,
    unit: 'XAF',
    decimals: 0,
    voucherId: 'vou-1',
    ...over,
  }) as WalletTransaction

describe('validationStatus', () => {
  it('reports a checked signature as verified', () => {
    expect(validationStatus(verified)).toBe('verified')
  })

  it('reports an absent record as unchecked, never as a pass', () => {
    // Rows written before verification existed. Silence must not be mistaken
    // for approval — this is the whole reason the third state exists.
    expect(validationStatus(undefined)).toBe('unchecked')
  })

  it('reports a signature that did not verify as failed', () => {
    expect(validationStatus({ ...verified, signatureValid: false })).toBe('failed')
  })

  it('reports a clamped value as failed even though the signature verified', () => {
    // The derived amount exceeded what the issuer signed, which on a legacy
    // voucher is what a rewritten issuance_ratio looks like. The signature is
    // genuine; the coupon is still not worth what it claimed.
    expect(validationStatus({ ...verified, cappedAtFaceValue: true })).toBe('failed')
  })

  it('reports a record predating the warrant field as unchecked', () => {
    // Every row stored before warrants shipped. NOT verified: the question was
    // never asked, and a green dot would leave those rows reading as approved
    // forever. NOT failed either - the coupon may be perfectly good.
    expect(validationStatus(preWarrantRecord())).toBe('unchecked')
  })

  it('reports an unwarranted coupon as failed', () => {
    // Nothing outside the issuing service vouches for it, which is exactly the
    // coupon a compromised service mints.
    expect(validationStatus({ ...verified, warrant: 'absent' })).toBe('failed')
    expect(validationStatus({ ...verified, warrant: 'unwarranted' })).toBe('failed')
  })

  it('reports a clamped value as failed even when the warrant was never checked', () => {
    // Ordering. A clamped coupon is a known failure whether or not the warrant
    // question was asked, so it must not be downgraded to "unchecked".
    expect(validationStatus({ ...preWarrantRecord(), cappedAtFaceValue: true })).toBe('failed')
  })

  it('does not treat legacyCanonical as a problem', () => {
    // True for every voucher issued to date. Surfacing it would paint the whole
    // existing estate as suspect and tell a merchant nothing actionable.
    expect(validationStatus({ ...verified, legacyCanonical: true })).toBe('verified')
    expect(validationStatus({ ...verified, legacyCanonical: false })).toBe('verified')
  })
})

describe('hasValidationClaim', () => {
  it('is true for an arriving coupon, which is the only thing with a claim', () => {
    expect(hasValidationClaim(tx())).toBe(true)
  })

  it('is false for outgoing rows — this wallet\'s own act, nothing to verify', () => {
    for (const type of ['payment', 'issued', 'sent'] as const) {
      expect(hasValidationClaim(tx({ type, direction: 'out' })), type).toBe(false)
    }
  })

  it('is false for plain ecash, which carries no issuer claim', () => {
    // A badge on every payment ever made is noise, and noise is how the signal
    // that matters gets ignored.
    expect(hasValidationClaim(tx({ voucherId: undefined }))).toBe(false)
  })
})

describe('the summary line', () => {
  it('never says "valid", which promises more than a signature check delivers', () => {
    for (const summary of Object.values(VALIDATION_SUMMARY)) {
      expect(summary.toLowerCase()).not.toContain('valid')
    }
  })

  it('gives every status its own words', () => {
    const all = Object.values(VALIDATION_SUMMARY)
    expect(new Set(all).size).toBe(all.length)
  })
})

/**
 * The attestation gate (DEV-246).
 *
 * `RecordDetailPages` renders the "Published to the public ledger" line and the
 * two ledger ids behind this predicate. It lives here rather than inline in the
 * JSX precisely so it can be asserted: the repo has no DOM environment, so a
 * rule expressed in a component is a rule nothing checks.
 */
describe('hasPublishedAttestation', () => {
  it('is true only once a relay accepted the record', () => {
    expect(hasPublishedAttestation(tx({ attestationEventId: 'e'.repeat(64) }))).toBe(true)
  })

  it('is FALSE on a row that carries only a nullifier', () => {
    // The trap the card named, and the reason this is not a one-liner inline.
    // Every redemption stamps a nullifier — it must be computed before the mint
    // swap destroys the token it hashes — so gating on it would read
    // "published" on plain ecash and on every customer row alike.
    expect(hasPublishedAttestation(tx({ attestationNullifier: 'a'.repeat(64) }))).toBe(false)
  })

  it('is false on a row predating the feature', () => {
    // Renders nothing rather than "not published": a merchant can do nothing
    // about a record that was never written, and a permanent negative on a
    // completed sale reads as a fault.
    expect(hasPublishedAttestation(tx())).toBe(false)
  })

  it('refuses an empty string, which is not an event id', () => {
    // A blank id would address no event, so a receipt claiming one would send
    // an auditor looking for something that does not exist.
    expect(hasPublishedAttestation(tx({ attestationEventId: '' }))).toBe(false)
  })
})
