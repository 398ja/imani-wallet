/**
 * Runtime configuration from the gateway.
 *
 * `GET /api/v1/config` is account-app's, not customer-wallet's — see the proxy
 * rule in vite.config.ts. It is the only place the NIP-05 domain and the Blossom
 * media host are named, and both are deployment-specific, so neither may be
 * hardcoded in the app.
 *
 * Its `relay_url` is deliberately NOT read here. See lib/relay.ts.
 */

export interface GatewayConfig {
  /** The domain handles are claimed under, e.g. `imani.local`. */
  nip05Domain: string
  /** Where avatars and banners are uploaded, or null when unconfigured. */
  blossomServerUrl: string | null
  /**
   * Hosts a cashback claim URL may point at, lower-cased.
   *
   * Empty means the cashback feature is OFF for this deployment, which is the
   * gateway's default and is deliberate (spec 010 FR-009, fail-closed): a claim
   * URL is fetched and decrypted by this app, so an unvalidated host would be a
   * place to send someone's claim key. Both cashback entry points are hidden
   * when this is empty — see `cashbackEnabled`.
   */
  cashbackOrigins: string[]
  /**
   * How long a cashback code stays claimable, in days.
   *
   * Deployment policy rather than a merchant choice, so it is served rather
   * than picked on the issue screen. Falls back to `DEFAULT_CASHBACK_EXPIRY_DAYS`
   * when the gateway does not report it — an older gateway, or one that never
   * set it. Unlike `cashbackOrigins` this does NOT fail closed: an expiry is
   * not a trust boundary, and refusing to issue over an unset optional number
   * would take the feature down for no safety gain.
   */
  cashbackExpiryDays: number
}

/** What a cashback code is worth when the gateway names no term of its own. */
export const DEFAULT_CASHBACK_EXPIRY_DAYS = 5

interface RawConfig {
  nip05_domain?: unknown
  default_domain?: unknown
  blossom_server_url?: unknown
  cashback_origins?: unknown
  cashback_expiry_days?: unknown
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * One fetch per session. The config is deployment state — it cannot change while
 * the app is open — and both the registration form and the profile editor read
 * it, so caching the promise keeps a request off the second caller.
 */
let pending: Promise<GatewayConfig> | undefined

async function fetchConfig(): Promise<GatewayConfig> {
  const response = await fetch('/api/v1/config', { credentials: 'include' })
  if (!response.ok) throw new Error(`Could not read the gateway configuration (${response.status}).`)

  const raw = (await response.json()) as RawConfig

  // `default_domain` is the documented fallback: both fields are populated on
  // this stack, but only nip05_domain is named for this purpose.
  const domain = str(raw.nip05_domain) ?? str(raw.default_domain)
  if (!domain) throw new Error('The gateway did not report a NIP-05 domain.')

  return {
    nip05Domain: domain,
    // The gateway normalises an unset BLOSSOM_SERVER_URL to null rather than "",
    // deliberately, so that "no media server" is distinguishable from a bad one.
    // Callers disable their file inputs on null rather than failing at upload.
    blossomServerUrl: str(raw.blossom_server_url) ?? null,
    // Anything that is not a list of non-empty strings collapses to [], which
    // reads as "cashback off" — the same answer as an absent field. A partly
    // malformed allowlist must not be treated as a partly valid one.
    cashbackOrigins: Array.isArray(raw.cashback_origins)
      ? raw.cashback_origins.flatMap((o) => {
          const host = str(o)
          return host ? [host.toLowerCase()] : []
        })
      : [],
    cashbackExpiryDays: positiveInt(raw.cashback_expiry_days) ?? DEFAULT_CASHBACK_EXPIRY_DAYS,
  }
}

/** A whole number of days, or undefined for anything that is not one. */
function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

/** Whether this deployment can validate a claim URL at all. */
export function cashbackEnabled(config: GatewayConfig): boolean {
  return config.cashbackOrigins.length > 0
}

export function gatewayConfig(): Promise<GatewayConfig> {
  if (!pending) {
    pending = fetchConfig().catch((e: unknown) => {
      // Do not cache a failure — a transient network error at startup would
      // otherwise disable registration for the rest of the session.
      pending = undefined
      throw e
    })
  }
  return pending
}

/** Exported for tests, which must not share a cache between cases. */
export function clearConfigCache(): void {
  pending = undefined
}
