/**
 * What Settings → About shows: which release is running and where the legal pages live.
 *
 * DEPLOY VERSION: the imani-deploy release this wallet was shipped in. Passed as the
 * `VITE_DEPLOY_VERSION` build arg by imani-deploy's scripts/deploy-staging.sh (from
 * `git describe --tags --always` of the deploy checkout). A local or hand-made build has
 * none, and says so ("dev") rather than guessing.
 */
import { websiteBaseUrl } from './terms'

export const DEPLOY_VERSION_FALLBACK = 'dev'

/** The deploy release, or "dev" when the build was given none. Read per call so tests can stub it. */
export function deployVersion(raw: unknown = import.meta.env.VITE_DEPLOY_VERSION): string {
  if (typeof raw !== 'string') return DEPLOY_VERSION_FALLBACK
  const v = raw.trim()
  return v === '' ? DEPLOY_VERSION_FALLBACK : v
}

/** The wallet's own version, from package.json (vite.config.ts). */
export function appVersion(): string {
  return typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : DEPLOY_VERSION_FALLBACK
}

/** When the bundle was built, as YYYY-MM-DD, or null if unknown. */
export function buildDate(raw: unknown = typeof __BUILD_DATE__ === 'string' ? __BUILD_DATE__ : undefined): string | null {
  if (typeof raw !== 'string' || raw === '') return null
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
}

/** A page on the public website (`VITE_WEBSITE_BASE_URL`), or null when the build names none. */
export function websitePage(path: string): string | null {
  const base = websiteBaseUrl()
  return base === null ? null : `${base}${path}`
}

export const PRIVACY_PATH = '/privacy.html'
export const COOKIES_PATH = '/cookies.html'
/** The contact address the public website lists. */
export const SUPPORT_EMAIL = 'hello@imani.casa'
