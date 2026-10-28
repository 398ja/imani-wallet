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

/** The NAP completion proof and NIP-98 share one kind. Nothing else is ever signed for a sister site. */
const NAP_KIND = 27235

function origin(url: string | undefined, fallback: string): string {
  try {
    return new URL((url ?? '').trim() || fallback).origin
  } catch {
    return new URL(fallback).origin
  }
}

/**
 * The subscription site's origin. `VITE_SUBSCRIPTION_SITE_URL` points the wallet's "Upgrade" button
 * there too (`entitlement.ts`), so both read one setting.
 */
export const SUBSCRIPTION_ORIGIN = origin(import.meta.env.VITE_SUBSCRIPTION_SITE_URL as string | undefined, 'https://subscription.imani.casa')
export const GIFTING_ORIGIN = origin(import.meta.env.VITE_GIFTING_SITE_URL as string | undefined, 'https://gifting.imani.casa')

/** Five minutes is enough to complete one login. Nothing longer: a grant is a live signing capability. */
const GRANT_TTL_SECONDS = 300

/**
 * Each site may have signed only kind-27235 events whose single `u` tag is ON THAT SITE. So the
 * subscription site cannot obtain a proof for the gateway, for the gifting site, or for any other
 * NAP server (NAP RFC §7.1, origin substitution).
 */
export function signerPolicy(): CrossOriginPolicy {
  const entries: CrossOriginPolicy = {
    [SUBSCRIPTION_ORIGIN]: { kinds: [NAP_KIND], audiences: [SUBSCRIPTION_ORIGIN], maxTtlSeconds: GRANT_TTL_SECONDS },
  }
  if (GIFTING_ORIGIN !== SUBSCRIPTION_ORIGIN) {
    entries[GIFTING_ORIGIN] = { kinds: [NAP_KIND], audiences: [GIFTING_ORIGIN], maxTtlSeconds: GRANT_TTL_SECONDS }
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
  if (siteOrigin === SUBSCRIPTION_ORIGIN) return 'buy and manage your stall’s plan'
  if (siteOrigin === GIFTING_ORIGIN) return 'buy and send vouchers as gifts'
  return 'sign you in'
}
