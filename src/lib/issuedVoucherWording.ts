/**
 * How an issued voucher's evidence is said to a merchant.
 *
 * Separated from the screen so the wording is testable without rendering, and
 * separated from `issuedVoucher.ts` so the domain module stays about facts and
 * this one stays about how they read. That split matters here more than usual,
 * because almost every line below is a sentence someone could over-read into a
 * guarantee it does not make.
 *
 * Three rules run through all of it:
 *
 *  1. **Absence is never approval.** A row with no warrant is "no signature on
 *     file", not "unsigned and fine"; a coupon with no attestation is a normal
 *     coupon, not an unpaid one. `validationStatus.ts` makes the same point
 *     about verification and it applies with equal force to evidence.
 *  2. **Authorisation is not payment.** A warrant says the stall meant to issue
 *     the value. Only the customer's attestation says money arrived, and on the
 *     counter rail nothing else ever can — so the two are never collapsed into
 *     one "verified" line.
 *  3. **Only a mismatch is an alarm.** Unwarranted sales are every sale made
 *     before warrants shipped and every sale made on a terminal, so colouring
 *     them red would bury the one row that disagrees with its own signature.
 *     `IssuanceReconciliation` already draws that line; this follows it.
 */
import type { CashAttestationVerdict } from './cashAttestation'
import type { WarrantVerdict } from './issuanceWarrant'
import type { PaymentRail } from './issuedVoucher'

/**
 * How strongly a line of evidence stands behind itself.
 *
 * A tone rather than a colour, so the screen decides how to draw it and this
 * module keeps saying only what is true. Three values rather than two because
 * the middle one is the common case and must not borrow either neighbour's
 * weight: most sales carry no signature and no receipt, and painting those
 * with the alarm colour would cry wolf over the ordinary state of a stall's
 * own history — the mistake `ValidationBadge` documents at length and the
 * reason its `unchecked` is grey rather than amber.
 */
export type EvidenceTone =
  /** Checked, and it held. */
  | 'confirmed'
  /** Nothing to check. Ordinary, never a fault. */
  | 'neutral'
  /** Present and does not hold. The only one that wants a human. */
  | 'alarming'

/** A line of evidence: what it says, how firmly, and what it does not claim. */
export interface EvidenceLine {
  /** The short answer, for the value column. */
  label: string
  /** What it does and does not establish. Absent when the label says it all. */
  detail?: string
  tone: EvidenceTone
}

/**
 * Cash or card, in a merchant's words.
 *
 * "At the counter" rather than "cash", deliberately. What the record supports
 * is that the stall signed for this sale on its own device with a customer in
 * front of it; whether the notes were cash, a bank transfer on someone's phone,
 * or a favour is not something any signature here witnesses. Saying "cash"
 * would be this wallet asserting a payment method it never saw.
 */
export function describeRail(rail: PaymentRail): EvidenceLine {
  switch (rail.kind) {
    case 'card':
      return {
        label: 'Card',
        tone: 'confirmed',
        detail: rail.reference
          ? `Paid through a payment processor, which holds the record (${rail.reference}).`
          : 'Paid through a payment processor, which holds the record.',
      }
    case 'counter':
      return {
        label: 'At the counter',
        tone: 'confirmed',
        detail:
          'Sold on this stall’s own device and signed for with its key. No processor was involved, so nothing outside this record witnessed the payment.',
      }
    case 'unknown':
      return {
        label: 'Not recorded',
        tone: 'neutral',
        detail:
          'Nothing on this sale says how it was paid for. That is every sale made before signing was added, and every sale made on a terminal — not a sign that anything went wrong.',
      }
  }
}

/** What re-checking the stored warrant concluded. */
export function describeWarrant(verdict: WarrantVerdict): EvidenceLine {
  switch (verdict.verdict) {
    case 'verified':
      return {
        label: 'Signed by this stall',
        tone: 'confirmed',
        detail:
          'The signature filed with this sale still matches its amount and currency. It proves you authorised issuing this value; it does not prove you were paid.',
      }
    case 'claimed':
      return {
        label: 'Recorded by a processor',
        // Not `confirmed`: this is referenced rather than checked, and the
        // verifier returns a different verdict for exactly that reason. A tick
        // beside a claim this device cannot verify would overstate it.
        tone: 'neutral',
        detail:
          'A payment processor’s record stands behind this sale. It is referenced rather than checked here, because the record is theirs and not this device’s.',
      }
    case 'absent':
      return {
        label: 'No signature on file',
        tone: 'neutral',
        detail:
          'This sale predates signed issuance, so only this device’s own record says it happened. Ordinary for older sales.',
      }
    case 'unwarranted':
      return {
        label: 'Issued unsigned',
        tone: 'neutral',
        detail:
          'The issuer stated that nothing outside the issuing service authorised this. That is what a terminal issues, because a terminal’s key is not the stall’s.',
      }
    case 'failed':
      return {
        // The one line that wants a human: a stored signature that no longer
        // covers the row beside it means one of the two changed after the fact.
        label: 'Does not match its signature',
        tone: 'alarming',
        detail: `${verdict.reason}. The sale and the signature filed with it disagree, which is worth looking at.`,
      }
  }
}

/** Whether the customer themselves said they paid. */
export function describeAttestation(verdict: CashAttestationVerdict): EvidenceLine {
  switch (verdict.verdict) {
    case 'attested':
      return {
        label: 'Customer signed for it',
        tone: 'confirmed',
        detail:
          'The customer’s own key asserts they paid for this sale, at this amount, to this stall.',
      }
    case 'none':
      return {
        label: 'Not collected',
        tone: 'neutral',
        detail:
          'Most sales have none, and its absence is never a fault — it is evidence a customer can offer, not something a sale requires.',
      }
    case 'invalid':
      return {
        label: 'Does not hold',
        tone: 'alarming',
        detail: `${verdict.reason}.`,
      }
  }
}
