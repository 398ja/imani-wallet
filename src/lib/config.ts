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

import { nip19 } from 'nostr-tools'

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
  /**
   * The mint this deployment's coupons are backed at, as stamped into each token's
   * `m` field (the gateway's PUBLIC mint URL), or '' when the gateway names none.
   *
   * The trusted-mint gate's gateway source (`trustedMint.loadTrustedMints`, #133).
   * '' is a real answer, "this deployment names no mint", and is distinct from the
   * config not having arrived, which the gate tracks itself.
   */
  mintUrl: string
}

/**
 * The two mint settings the trusted-mint gate reads from `/api/v1/config` (#133).
 *
 * Parsed on their OWN, by {@link gatewayMintConfig}, rather than as part of
 * {@link GatewayConfig}: that parser throws when the gateway names no NIP-05
 * domain, and a missing domain must not leave the gate unable to learn the mint
 * (which deferred every coupon for ever).
 */
export interface GatewayMintConfig {
  /**
   * `mint_url`: gateway-core's `gateway.bottin.mint-url`, the mint the browser
   * talks to for client-side minting. Usually the public mint, but it is a
   * DIFFERENT setting from the one tokens are stamped with, so it is not the
   * source of truth for `m` on its own.
   */
  mintUrl: string
  /**
   * `token_mint_urls`: the mint URL(s) customer-wallet stamps into each token's
   * `m` (`GATEWAY_WALLET_MINT_PUBLIC_URL`), served by gateway-core from the same
   * setting. The one the gate actually needs. Empty from a gateway that predates
   * the field.
   */
  tokenMintUrls: string[]
}

/** What a cashback code is worth when the gateway names no term of its own. */
export const DEFAULT_CASHBACK_EXPIRY_DAYS = 5

interface RawConfig {
  nip05_domain?: unknown
  default_domain?: unknown
  blossom_server_url?: unknown
  cashback_origins?: unknown
  cashback_expiry_days?: unknown
  mint_url?: unknown
  token_mint_urls?: unknown
  support_blossom_url?: unknown
  support_npub?: unknown
  support_blossom_ttl_seconds?: unknown
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * One fetch per session. The config is deployment state — it cannot change while
 * the app is open — and both the registration form and the profile editor read
 * it, so caching the promise keeps a request off the second caller.
 */
let pending: Promise<RawConfig> | undefined

async function fetchRaw(): Promise<RawConfig> {
  const response = await fetch('/api/v1/config', { credentials: 'include' })
  if (!response.ok) throw new Error(`Could not read the gateway configuration (${response.status}).`)

  const raw: unknown = await response.json()
  if (!raw || typeof raw !== 'object') throw new Error('The gateway configuration is not an object.')
  return raw as RawConfig
}

/** The mint settings alone, which need nothing else from the config to be read. */
function parseMints(raw: RawConfig): GatewayMintConfig {
  return {
    mintUrl: str(raw.mint_url) ?? '',
    // Anything that is not a list of strings collapses to [], the same answer as
    // an absent field; the gate normalises and filters each entry itself.
    tokenMintUrls: Array.isArray(raw.token_mint_urls)
      ? raw.token_mint_urls.flatMap((u) => {
          const url = str(u)
          return url ? [url] : []
        })
      : [],
  }
}

function parseConfig(raw: RawConfig): GatewayConfig {
  // `default_domain` is the documented fallback: both fields are populated on
  // this stack, but only nip05_domain is named for this purpose.
  const domain = str(raw.nip05_domain) ?? str(raw.default_domain)
  if (!domain) throw new Error('The service did not say which address domain to use. Try again in a moment.')

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
    mintUrl: parseMints(raw).mintUrl,
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

function rawConfig(): Promise<RawConfig> {
  if (!pending) {
    pending = fetchRaw().catch((e: unknown) => {
      // Do not cache a failure — a transient network error at startup would
      // otherwise disable registration for the rest of the session.
      pending = undefined
      throw e
    })
  }
  return pending
}

export function gatewayConfig(): Promise<GatewayConfig> {
  return rawConfig().then(parseConfig)
}

/**
 * The mint settings, for the trusted-mint gate (#133). Rejects only when the
 * config cannot be fetched at all; a config with no NIP-05 domain still answers.
 *
 * `fresh` drops the cached answer first. The gate passes it when re-asking a
 * gateway that named no mint, so a configuration fixed on the server releases
 * held coupons without a reload.
 */
export function gatewayMintConfig(options: { fresh?: boolean } = {}): Promise<GatewayMintConfig> {
  if (options.fresh) pending = undefined
  return rawConfig().then(parseMints)
}

/**
 * The support snapshot settings (#589): where snapshots are uploaded, the key the handoff DM is
 * sealed to, and the blob TTL. Null unless BOTH the URL and a valid npub are served, which hides
 * the feature (criterion 13). Parsed on their own so a config without them breaks nothing else.
 */
export interface SupportSnapshotConfig {
  blossomUrl: string
  supportPubkey: string
  ttlSeconds: number
}

export function parseSupportSnapshot(raw: Record<string, unknown>): SupportSnapshotConfig | null {
  const url = str(raw.support_blossom_url)
  const npub = str(raw.support_npub)
  if (!url || !npub || !/^https?:\/\//.test(url)) return null
  let pubkey: string
  try {
    const d = nip19.decode(npub)
    if (d.type !== 'npub') return null
    pubkey = d.data
  } catch {
    return null
  }
  return {
    blossomUrl: url.replace(/\/+$/, ''),
    supportPubkey: pubkey,
    ttlSeconds: positiveInt(raw.support_blossom_ttl_seconds) ?? 7 * 86400,
  }
}

export function supportSnapshotConfig(): Promise<SupportSnapshotConfig | null> {
  return rawConfig().then((r) => parseSupportSnapshot(r as Record<string, unknown>))
}

/** Exported for tests, which must not share a cache between cases. */
export function clearConfigCache(): void {
  pending = undefined
}
