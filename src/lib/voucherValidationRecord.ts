/**
 * The `validation` record a receive writes on its row, built in ONE place.
 *
 * Two receive paths record what they checked about a coupon: a DM
 * (`dmCrypto.verifiedVoucherFrom`) and a cashback redeem (`cashbackValidation`).
 * They differ in what they do with a failure, and that difference is real: a DM
 * is retried and its sender is a stranger, so it refuses; a cashback claim is
 * one-shot, so it records. What they must NOT differ in is the record itself,
 * because the detail screen and the list badge read it through one
 * `validationStatus`, and a field one path fills and the other forgets is how a
 * badge drifts.
 *
 * So the gates stay with their callers and the record is built here.
 */
import { parseIssuanceWarrant, verifyIssuanceWarrant } from './issuanceWarrant'
import {
  creditableFaceValue,
  type ParsedVoucherToken,
  type VoucherValidation,
  type VoucherVerification,
} from './voucherToken'

export interface BuiltValidation {
  /** The value this coupon may be credited for, clamped to the signed face. */
  faceValue: number
  record: VoucherValidation
  /** Why a present warrant was refused, for the caller's log. */
  warrantRefusal?: string
}

/**
 * The record for a parsed voucher, given the caller's signature verdict.
 *
 * `signatureValid` is the CALLER's: it may fold in checks this function does not
 * make (the issuer allowlist, for one), and it is written through verbatim.
 */
export function buildValidationRecord(
  parsed: ParsedVoucherToken,
  { signatureValid, legacyCanonical }: VoucherVerification,
): BuiltValidation {
  const { faceValue, cappedAtFaceValue } = creditableFaceValue(parsed)

  // Checked against the CREDITABLE value, not the signed face value. A warrant
  // bounds what this coupon may be worth now, and `faceValue` is what is about
  // to be credited - verifying against the signed face would let a clamped or
  // split coupon pass a check its actual credit never faced.
  const warrant = parseIssuanceWarrant(parsed.voucher.issuanceWarrant)
  const verdict = verifyIssuanceWarrant(warrant, parsed.voucher.issuerId, {
    faceValueMinor: faceValue,
    // The coupon's OWN unit and decimals, from its signed tags. Passing the
    // warrant's back to itself would let a warrant for XAF 2500 authorise a
    // EUR 2500 coupon worth a hundred times more - the signature verifies and
    // the ceiling passes, because both compare bare numbers.
    unit: parsed.voucher.unit,
    faceDecimals: parsed.voucher.faceDecimals,
  })

  return {
    faceValue,
    record: {
      signatureValid,
      legacyCanonical,
      signedFaceValue: parsed.voucher.faceValue,
      cappedAtFaceValue,
      warrant: verdict.verdict,
      ...(warrant.state === 'present' ? { warrantedSaleTotal: warrant.saleTotalMinor } : {}),
    },
    ...(verdict.verdict === 'failed' ? { warrantRefusal: verdict.reason } : {}),
  }
}
