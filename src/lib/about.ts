/**
 * What Settings → About shows: which release is running and where the legal pages live.
 *
 * DEPLOY VERSION: the imani-deploy release this wallet was shipped in. Passed as the
 * `VITE_DEPLOY_VERSION` build arg by imani-deploy's scripts/deploy-staging.sh (from
 * `git describe --tags --match 'imani-deploy-v*' --always` of the deploy checkout, imani-deploy#361).
 * A local or hand-made build has none, and says so ("dev") rather than guessing.
 */
import { websiteBaseUrl } from './terms'

export const DEPLOY_VERSION_FALLBACK = 'dev'

/** The deploy release, or "dev" when the build was given none. Read per call so tests can stub it. */
export function deployVersion(raw: unknown = import.meta.env.VITE_DEPLOY_VERSION): string {
  if (typeof raw !== 'string') return DEPLOY_VERSION_FALLBACK
  const v = raw.trim()
  return v === '' ? DEPLOY_VERSION_FALLBACK : v
}

/**
 * The wallet's own release: the imani-wallet tag this image was built from (`VITE_WALLET_VERSION`,
 * passed by imani-deploy's deploy-staging.sh from build-refs.env, e.g. "v0.51.0"). package.json's
 * version is not bumped per release here (it reads 0.41.0 while v0.50.0 runs), so it is only the
 * fallback for a build given no tag, shown with "dev" so nobody mistakes it for a release.
 */
export function appVersion(raw: unknown = import.meta.env.VITE_WALLET_VERSION): string {
  if (typeof raw === 'string' && raw.trim() !== '') return raw.trim()
  const pkg = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : ''
  return pkg === '' ? DEPLOY_VERSION_FALLBACK : `${pkg} (${DEPLOY_VERSION_FALLBACK})`
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
/** Where Settings → About's Support row writes to. Not the website's general hello@ address. */
export const SUPPORT_EMAIL = 'support@imani.casa'
