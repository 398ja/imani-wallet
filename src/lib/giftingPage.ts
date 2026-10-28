/** The stall's gifting page on gifting.imani.casa (#410). */

/** The gifting site's origin (#410 G0), `VITE_GIFTING_ORIGIN`. */
export const GIFTING_ORIGIN: string =
  (import.meta.env.VITE_GIFTING_ORIGIN as string | undefined)?.replace(/\/+$/, '') || 'https://gifting.imani.casa'

/** The handle domain whose names go bare in the URL (`/shop/alice`). */
const HANDLE_DOMAIN: string = (import.meta.env.VITE_GIFTING_HANDLE_DOMAIN as string | undefined)?.toLowerCase() || 'imani.casa'

/**
 * A stall's gifting page link: `/shop/<name>` on the default domain, the full handle elsewhere.
 * Null without a handle: the page is addressed by handle only (no hexpub URL, owner edit 1).
 */
export function giftingPageUrl(nip05: string | undefined): string | null {
  const h = nip05?.trim().toLowerCase()
  if (!h || !/^[a-z0-9._-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(h)) return null
  const [local, domain] = h.split('@')
  const segment = domain === HANDLE_DOMAIN && local !== '_' ? local : encodeURIComponent(h)
  return `${GIFTING_ORIGIN}/shop/${segment}`
}
