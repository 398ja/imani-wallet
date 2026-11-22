import { LICENCE_FEATURES } from './licenceIssue'
import { hasFeature } from './entitlement'
import type { LicenceStatus } from './licenceStatus'
import type { TerminalRecord } from './terminalRoster'

/**
 * Whether this stall may connect an online shop, and what Settings › Online shop shows.
 *
 * The plan decides (`ecommerce`, Pro today, read from the signed tier catalog through
 * `hasFeature`, so a catalog change moves it without a release). The screen is LISTED for every
 * merchant and shows a lock below Pro: hiding it would leave the Subscription page as the only
 * place a merchant learns online shops exist.
 *
 * A lapse lets codes already outstanding finish and refuses only new ones. gateway-customer is the
 * authority for both halves (`422 FEATURE_NOT_IN_PLAN` on a new shop's credential and on a new
 * code's lock); this is the honest client's half, so the owner is told before anything is signed.
 *
 * - `available`: the plan includes online shops.
 * - `locked`: it does not, and no shop is connected. The screen explains and links to plans.
 * - `lapsed`: it does not, but a shop is still connected (a Pro plan ended). The shop keeps
 *   finishing the codes it holds and takes no new ones; the owner can renew or disconnect.
 */
export type OnlineShopAccess = 'available' | 'locked' | 'lapsed'

/** The roster's live online shop, if any: a shop row that is not revoked. */
export function connectedShop(rows: readonly TerminalRecord[]): TerminalRecord | null {
  const live = rows.filter((r) => r.shop && r.revokedAt === undefined).sort((a, b) => b.enrolledAt - a.enrolledAt)
  return live[0] ?? null
}

export function onlineShopAccess(status: LicenceStatus, rows: readonly TerminalRecord[]): OnlineShopAccess {
  if (hasFeature(status, LICENCE_FEATURES.ECOMMERCE)) return 'available'
  return connectedShop(rows) ? 'lapsed' : 'locked'
}

/** The refusal code gateway-customer answers when the stall's plan lacks the feature. */
export const FEATURE_NOT_IN_PLAN = 'FEATURE_NOT_IN_PLAN'

/** The owner's words for that refusal, on the connect screen. */
export const ONLINE_SHOP_NOT_IN_PLAN_MESSAGE =
  'Online shops are part of the Pro plan. Upgrade to connect your shop. Nothing was set up.'

/** The plan name shown on the lock. The tier is `pro` in the catalog; Pro is what it is sold as. */
export const ONLINE_SHOP_PLAN_NAME = 'Pro'
