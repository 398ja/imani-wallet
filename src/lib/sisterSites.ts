/**
 * Where the sister sites live (#407, #410, #411). Configuration, never code: each environment
 * (local, staging, beta, production) has its own, so the URL comes only from the build's env:
 *
 *   VITE_SUBSCRIPTION_SITE_URL   the subscription site (Settings › Subscription › Upgrade my plan)
 *   VITE_GIFTING_SITE_URL        the gifting site
 *
 * Locally in `.env.local` (Vite loads it), elsewhere as Docker build args (Dockerfile).
 *
 * Unset (or not a URL) means the site is not part of this deployment: the button that opens it
 * says so instead of opening a guess, the catalog is not fetched from it, and the signer policy
 * (napSignerPolicy.ts) has no entry for it, so nothing can be signed for it either.
 *
 * Read through functions, at call time, so a test can vary them (the same reason as
 * `licenceIssuerPubkey`).
 */

function configured(value: unknown): string | null {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    return url.toString().replace(/\/+$/, '')
  } catch {
    return null
  }
}

/** The subscription site's URL, or null when this build has none. */
export function subscriptionSiteUrl(): string | null {
  return configured(import.meta.env.VITE_SUBSCRIPTION_SITE_URL)
}

/** The gifting site's URL, or null when this build has none. */
export function giftingSiteUrl(): string | null {
  return configured(import.meta.env.VITE_GIFTING_SITE_URL)
}

/** The origin of a configured URL, or null. */
export function originOf(url: string | null): string | null {
  return url ? new URL(url).origin : null
}
