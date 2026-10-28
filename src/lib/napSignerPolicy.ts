/**
 * Which sister sites this wallet signs in, and what each may have signed (#411, NAP extension 0002).
 *
 * Sister sites (subscription.imani.casa, gifting.imani.casa) never hold the stall's key. They get
 * their NAP login signed by the wallet over `postMessage`, in one of two ways, both bound by THIS
 * policy:
 * - the wallet opened the site (Settings › Subscription › Upgrade), and the unlocked wallet tab
 *   answers it (`sisterSiteSigner.ts`);
 * - the site opened the wallet's `/nap/signer` popup (gifting's "Sign in with Imani wallet"), which
 *   unlocks the stored key there, asks once, and answers (`napSignerPage.ts`).
 * Either way nap checks who is asking with the browser-reported origin, and signs only proofs
 * addressed to that site.
 *
 * It is code, on purpose: a policy the relying site could influence would be no policy at all.
 */
import type { CrossOriginPolicy } from '@imani/nap-client-web'

import { giftingSiteUrl, originOf, subscriptionSiteUrl } from './sisterSites'

/** The NAP completion proof and NIP-98 share one kind. Nothing else is ever signed for a sister site. */
const NAP_KIND = 27235

/**
 * The sister sites' origins, from the same settings that point the wallet's buttons at them
 * (`sisterSites.ts`: VITE_SUBSCRIPTION_SITE_URL, VITE_GIFTING_SITE_URL), so the two cannot disagree.
 * Null when this build has none.
 */
export const subscriptionOrigin = (): string | null => originOf(subscriptionSiteUrl())
export const giftingOrigin = (): string | null => originOf(giftingSiteUrl())

/** Five minutes is enough to complete one login. Nothing longer: a grant is a live signing capability. */
const GRANT_TTL_SECONDS = 300

/**
 * Each site may have signed only kind-27235 events whose single `u` tag is ON THAT SITE. So the
 * subscription site cannot obtain a proof for the gateway, for the gifting site, or for any other
 * NAP server (NAP RFC §7.1, origin substitution).
 *
 * Only the sites this build is configured with. A build with none returns an empty policy, which
 * nap refuses to mount: nothing is signed for anyone.
 */
export function signerPolicy(): CrossOriginPolicy {
  const entries: CrossOriginPolicy = {}
  for (const origin of [subscriptionOrigin(), giftingOrigin()]) {
    if (origin && !entries[origin]) entries[origin] = { kinds: [NAP_KIND], audiences: [origin], maxTtlSeconds: GRANT_TTL_SECONDS }
  }
  return entries
}

/** The name a person recognises: `subscription.imani.casa`, not `https://subscription.imani.casa`. */
export function siteName(siteOrigin: string): string {
  try {
    return new URL(siteOrigin).host
  } catch {
    return siteOrigin
  }
}

/** What the site is for, said on the consent screen. Unknown origins never get this far. */
export function siteDescription(siteOrigin: string): string {
  if (siteOrigin === subscriptionOrigin()) return 'buy and manage your stall’s plan'
  if (siteOrigin === giftingOrigin()) return 'buy and send vouchers as gifts'
  return 'sign you in'
}

/**
 * Which accounts may sign in to which site (owner decisions, 2026-10-28):
 * - the subscription site is for stalls only (#411);
 * - the gifting site is for customers and guests only (#410). A stall does not buy gifts there.
 *
 * The wallet checks this before it decrypts anything, so a wrong account is told why, in the
 * wallet, instead of the site refusing it later. Each site's server refuses the wrong role too:
 * this is the courtesy, not the boundary.
 */
export type SiteAudience = 'merchants' | 'customers'

export function siteAudience(siteOrigin: string): SiteAudience | null {
  if (siteOrigin === subscriptionOrigin()) return 'merchants'
  if (siteOrigin === giftingOrigin()) return 'customers'
  return null
}

/** May an account that is (or is not) a stall sign in to this site? */
export function accountMaySignIn(siteOrigin: string, isMerchant: boolean): boolean {
  const audience = siteAudience(siteOrigin)
  if (audience === 'merchants') return isMerchant
  if (audience === 'customers') return !isMerchant
  return false
}
