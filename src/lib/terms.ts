/**
 * The Terms and Conditions every new account accepts (imani-wallet#357).
 *
 * The terms live on the public website, at `<VITE_WEBSITE_BASE_URL>/terms.html`
 * (today https://www.imani.casa/terms.html). The base URL is a build-time
 * `VITE_*` value like the relay and mint URLs: compiled into the bundle, not a
 * secret. The image build refuses to run without it
 * (scripts/check-website-base-url-build.sh), and a bundle built some other way
 * without it refuses to create accounts rather than link to a page that does
 * not exist. Nothing here ever renders a link it could not build.
 *
 * WHAT IS RECORDED: the exact URL that was linked and the moment the box was
 * ticked. The page carries its own version and date ("Version 1.1, last
 * updated ..."), but the website sends no CORS headers, so the wallet cannot
 * read it, and the URL plus the time pins which text was live then. The record
 * goes on the account's profile record (`Profile.termsAccepted`), which is what
 * a backup file and the Drive backup carry, so a restored account keeps it.
 */

/** Where the terms sit under the website base URL. */
export const TERMS_PATH = '/terms.html'

/** What a person accepted, and when. Stored with the profile, travels with backups. */
export interface TermsAcceptance {
  /** The terms page that was linked, e.g. `https://www.imani.casa/terms.html`. */
  url: string
  /** When the box was ticked, ms since the epoch. */
  acceptedAt: number
}

/** Said when this build names no terms page. Plain words: the person cannot fix it. */
export const TERMS_NOT_CONFIGURED_COPY =
  "New accounts can't be created in this version of the app. Please try again later, or log in to an account you already have."

/** Said when an account is created without the box ticked. */
export const TERMS_NOT_ACCEPTED_COPY = 'Accept the Terms and Conditions to create your account.'

export class TermsNotConfiguredError extends Error {
  constructor() {
    super(TERMS_NOT_CONFIGURED_COPY)
    this.name = 'TermsNotConfiguredError'
  }
}

export class TermsNotAcceptedError extends Error {
  constructor() {
    super(TERMS_NOT_ACCEPTED_COPY)
    this.name = 'TermsNotAcceptedError'
  }
}

/**
 * The website base URL this build was given, normalised (no trailing slash), or
 * null when it is missing or unusable. Only an absolute http(s) URL with a host
 * and no userinfo, query or fragment counts: anything else would make a broken
 * or misleading link, so it is treated as not configured at all.
 *
 * Read on every call, not once at module load, so tests can stub the env.
 */
export function websiteBaseUrl(raw: unknown = import.meta.env.VITE_WEBSITE_BASE_URL): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  if (value === '') return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (!url.hostname || url.username || url.password || url.search || url.hash) return null
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '')
}

/** `<base>/terms.html`, or null when the build names no website. */
export function termsUrl(): string | null {
  const base = websiteBaseUrl()
  return base === null ? null : `${base}${TERMS_PATH}`
}

/**
 * The record of ticking the box, now.
 *
 * @throws TermsNotConfiguredError when this build names no terms page
 */
export function acceptTerms(now: number = Date.now()): TermsAcceptance {
  const url = termsUrl()
  if (url === null) throw new TermsNotConfiguredError()
  return { url, acceptedAt: now }
}

/**
 * Refuse unless `acceptance` is a real acceptance of THIS build's terms. The
 * gate `register` runs first, so no caller can create an account without one.
 *
 * @throws TermsNotConfiguredError when this build names no terms page
 * @throws TermsNotAcceptedError when the acceptance is missing, malformed or for another page
 */
export function requireTermsAccepted(acceptance: unknown): TermsAcceptance {
  const url = termsUrl()
  if (url === null) throw new TermsNotConfiguredError()
  const valid = readTermsAcceptance(acceptance)
  if (!valid || valid.url !== url) throw new TermsNotAcceptedError()
  return valid
}

/**
 * A stored or restored acceptance, or undefined when it is not one.
 *
 * The profile record comes back out of backup files the user was handed, so
 * this is a trust boundary: only an http(s) URL and a positive, finite time are
 * kept, and nothing else rides along.
 */
export function readTermsAcceptance(value: unknown): TermsAcceptance | undefined {
  if (!value || typeof value !== 'object') return undefined
  const { url, acceptedAt } = value as { url?: unknown; acceptedAt?: unknown }
  if (typeof url !== 'string' || typeof acceptedAt !== 'number') return undefined
  if (!Number.isFinite(acceptedAt) || acceptedAt <= 0) return undefined
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined
  } catch {
    return undefined
  }
  return { url, acceptedAt }
}
