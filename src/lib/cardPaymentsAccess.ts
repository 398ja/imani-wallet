import { FREE_TIER, GRACE_REASONS } from '@imani/licence'

import { entitlementFor } from './entitlement'
import type { LicenceStatus } from './licenceStatus'

/**
 * Whether this stall's plan includes card payments: Essentials and above, never Starter.
 *
 * Read as "any paid plan is in force", not as a named licence feature. Features are signed into
 * each licence when it is sold, so a new feature name would lock out every Essentials and Pro
 * subscriber holding a licence issued before it existed. Every paid tier, a legacy licence and a
 * partnership tier included, ranks above `free`, so the entitlement's tier answers it with no
 * reissue.
 *
 * - `included`: a paid plan is in force (verified now, or carried by the grace window).
 * - `not-included`: the stall is on Starter, or its plan ended.
 * - `unknown`: the plan could not be checked. The caller changes nothing on this: it neither starts
 *   an offer nor withdraws one, as an unreachable merchant service does for Stripe.
 *
 * An outage does not always arrive as a thrown error. `licenceStatus` resolves a wallet store it
 * could not read as a refusal with a GRACE reason (`never-verified`, `grace-elapsed`): no grant,
 * and no answer either. Read as Starter, that would withdraw a paying stall's offer over a storage
 * fault, so it is `unknown`. Only an answered refusal (absent, expired, revoked...) is Starter.
 */
export type CardPaymentsPlan = 'included' | 'not-included' | 'unknown'

export function cardPaymentsPlan(status: LicenceStatus | null): CardPaymentsPlan {
  if (status === null) return 'unknown'
  if (entitlementFor(status, 'USD').tier !== FREE_TIER) return 'included'
  const decision = status.decision
  if (!decision.granted && isGraceReason(decision.reason)) return 'unknown'
  return 'not-included'
}

const OUTAGE_REASONS: readonly string[] = Object.values(GRACE_REASONS)

function isGraceReason(reason: string): boolean {
  return OUTAGE_REASONS.includes(reason)
}

/** The lowest plan that includes card payments, as it is sold. The tier is `basic` in the catalog. */
export const CARD_PAYMENTS_PLAN_NAME = 'Essentials'

/** Why the offer was withdrawn, finishing "Card payments are off: …". */
export const CARD_PAYMENTS_NOT_IN_PLAN_REASON = `card payments are part of ${CARD_PAYMENTS_PLAN_NAME} and above`
