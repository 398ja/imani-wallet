import { parseIssuanceWarrant } from './issuanceWarrant'
import { paymentRail } from './issuedVoucher'

/** The card reference on a stored warrant, or undefined for any other rail. */
export function cardReferenceOf(issuanceWarrant: unknown): string | undefined {
  const rail = paymentRail(parseIssuanceWarrant(typeof issuanceWarrant === 'string' ? issuanceWarrant : undefined))
  return rail.kind === 'card' && rail.reference ? rail.reference : undefined
}

/** Shorten `pi_3PqRsTuVwXyZ…` for a list row, keeping the prefix recognisable. */
export function compactReference(ref: string): string {
  return ref.length <= 14 ? ref : `${ref.slice(0, 8)}…${ref.slice(-4)}`
}
