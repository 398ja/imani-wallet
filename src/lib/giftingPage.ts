import { giftingSiteUrl } from './sisterSites'

/**
 * The stall's gifting page (#410), on whichever gifting site THIS build is configured for:
 * `VITE_GIFTING_SITE_URL` (sisterSites.ts). Staging links to gifting.staging.398ja.xyz, production
 * to gifting.imani.casa. There is no hard-coded fallback: a build without a gifting site gets no
 * link, the same rule sisterSites.ts applies to every sister site (a staging wallet once sent
 * stalls to the production gifting site because this module defaulted to it).
 */

/** The configured gifting site's origin, or null when this build has none. */
export function giftingOrigin(): string | null {
  const url = giftingSiteUrl()
  if (!url) return null
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/**
 * The handle domain whose names go bare in the URL (`/shop/alice`), `VITE_GIFTING_HANDLE_DOMAIN`.
 * Must match the gifting site's own setting (same build arg in imani-deploy). Defaults to the
 * gifting site's host minus a leading `gifting.`, so gifting.staging.398ja.xyz -> staging.398ja.xyz.
 */
function handleDomain(origin: string): string {
  const configured = (import.meta.env.VITE_GIFTING_HANDLE_DOMAIN as string | undefined)?.trim().toLowerCase()
  if (configured) return configured
  return new URL(origin).host.replace(/^gifting\./, '')
}

/**
 * A stall's gifting page link: `/shop/<name>` on the handle domain, the full handle elsewhere.
 * Null without a handle (the page is addressed by handle only, no hexpub URL, owner edit 1), or
 * when this build has no gifting site.
 */
export function giftingPageUrl(nip05: string | undefined): string | null {
  const origin = giftingOrigin()
  if (!origin) return null
  const h = nip05?.trim().toLowerCase()
  if (!h || !/^[a-z0-9._-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(h)) return null
  const [local, domain] = h.split('@')
  const segment = domain === handleDomain(origin) && local !== '_' ? local : encodeURIComponent(h)
  return `${origin}/shop/${segment}`
}
