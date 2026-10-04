import type { BackingVerdict } from '@imani/dm-poll'

import { gatewayMintConfig } from './config'
import { decodeCbor, type ParsedVoucherToken } from './voucherToken'

/**
 * Which mint, and which unit, this build will credit a coupon from.
 *
 * ## The hole this closes
 *
 * A coupon's value is not in the coupon. It is in the proofs, at a mint. The
 * issuer signature covers the voucher's terms and says nothing about which mint
 * holds the value behind them, so a copy of a genuine signed voucher backed by
 * proofs from a mint nobody has heard of verifies exactly as well as the real
 * one. `verifyVoucher` cannot catch that, because there is nothing wrong with
 * the signature.
 *
 * It matters more once the wallet swaps its own receives, because the mint URL
 * stops being a field we record and becomes the address we send money to.
 * See `docs/explanation/the-wallet-swaps-its-own-receives.md`.
 *
 * ## Where the trusted list comes from (#133)
 *
 * Three sources, combined:
 *
 * 1. `VITE_TRUSTED_MINT_URLS`, baked in at build time. The Dockerfile refuses to
 *    build a non-dev image without it, so every deployed image carries its mint.
 * 2. `token_mint_urls` on `GET /api/v1/config`: the PUBLIC mint URL(s)
 *    customer-wallet stamps into each token's `m` (`GATEWAY_WALLET_MINT_PUBLIC_URL`),
 *    served by gateway-core from the same setting. This is the source of truth for
 *    what a genuine token says.
 * 3. `mint_url` on the same response: gateway-core's `gateway.bottin.mint-url`
 *    (`CASHU_MINT_URL` / `GATEWAY_BOTTIN_MINT_URL`), the mint the browser uses for
 *    client-side minting. A DIFFERENT setting from the one tokens are stamped
 *    with, so it is accepted as a source but never relied on alone.
 *
 * The config is read by {@link loadTrustedMints}, which the app awaits before the
 * coupon poller starts, and which keeps re-asking on a backoff until the gateway
 * names a mint (see "Healing" below).
 *
 * ## `unknown` is not `none`, and `none` is not a pass
 *
 * Until the config has been read, the trusted set is UNKNOWN (`not-ready`), and
 * callers defer. Once it has been read and NO source names a mint, the answer is
 * `no-trusted-mint`, and that is not a pass either. It used to be (`unchecked`):
 * on beta and prod, where `mint_url` was never configured, the gateway answered
 * with nothing, and every coupon from every mint was credited. That was #133
 * itself. Now crediting HOLDS such a coupon (visible, re-offered, never dropped)
 * and swapping refuses it. A dev build may opt out with
 * `VITE_ALLOW_ANY_MINT_IN_DEV=true`, which is ignored in a production build and
 * logged every time it is used.
 *
 * ## Holding, not refusing, an unlisted mint
 *
 * A token whose mint is not on the list is HELD, not refused. The list is built
 * from settings in two services, and when they disagree (a mint migration, an
 * internal URL configured for client-mint) a refusal would have dropped every
 * genuine coupon for good. A hold redeems nothing, consumes nothing, shows the
 * coupon as waiting, and lets it through as soon as the configuration agrees.
 * Only what no configuration can change, a foreign unit or an unreadable token,
 * is refused.
 *
 * ## Healing
 *
 * A failed or empty config is re-asked on a backoff (5s doubling to 5 minutes).
 * When the answer changes, {@link onTrustedMintsChange} listeners hear about it,
 * and the poller runs a catch-up, which offers every held or deferred delivery
 * again.
 *
 * ## `voucher.unit` is deliberately not what this checks
 *
 * Measured on the captured fixtures, EVERY token's `u` is `sat`, while
 * `voucher.unit` ranges over currencies: `live-licence.token` is a GBP coupon.
 * `u` is what the proofs are denominated in; `voucher.unit` is what the face
 * value is denominated in. A rule over `voucher.unit` would refuse every
 * foreign-currency coupon we issue. `trustedMint.test.ts` pins the distinction.
 */

/**
 * The unit the proofs must be denominated in.
 *
 * Not configurable, unlike the mint list. A wallet that credits proofs in some
 * other unit has no way to convert them, so allowing it to be relaxed would only
 * ever be a way to get the check wrong.
 */
export const TOKEN_UNIT = 'sat'

/**
 * A mint URL with the incidental differences removed, for comparison.
 *
 * Parsed as a URL, so the scheme and host are lower-cased, a default port is
 * dropped and a trailing slash is ignored, while the PATH keeps its case: a mint
 * mounted at `/Cashu` is not the one at `/cashu`. Anything that does not parse
 * as an http(s) URL normalises to the empty string, which is never trusted.
 *
 * So does a URL carrying userinfo, a query or a fragment, even an empty one. A
 * mint URL has none of them, and each is a way for two different strings to name
 * "the same" mint here while meaning something else to the HTTP client that
 * later sends money there (credentials in the authority, a query the mint
 * ignores but a proxy does not).
 *
 * Exported for the other gates that need to say "same mint" (#131).
 */
export function normaliseMintUrl(url: string): string {
  const raw = url.trim()
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return ''
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return ''
  // `URL` drops an EMPTY query, fragment or userinfo (`https://@h`, `h/?`, `h#`),
  // so the raw string is checked as well as the parsed parts.
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return ''
  const authority = raw.slice(raw.indexOf('//') + 2).split(/[/?#]/, 1)[0]
  if (authority.includes('@') || raw.includes('?') || raw.includes('#')) return ''
  // `URL` already lower-cases the scheme and host and drops a default port.
  const path = parsed.pathname.replace(/\/+$/, '')
  return `${parsed.protocol}//${parsed.host}${path}`
}

/** What `/api/v1/config` said, normalised, or `undefined` while it has not answered. */
let gatewayMints: string[] | undefined
let loading: Promise<void> | undefined
let retryTimer: ReturnType<typeof setTimeout> | undefined
let retryDelayMs = 0
const listeners = new Set<() => void>()

/** The first retry after a failed or empty answer. Doubles up to {@link MAX_RETRY_MS}. */
const FIRST_RETRY_MS = 5_000
/** A gateway that keeps failing is still asked every five minutes. */
const MAX_RETRY_MS = 5 * 60_000

/**
 * Learn the gateway's mints. Awaited at start-up, before any coupon is received.
 *
 * Never rejects: a gateway that cannot be reached leaves the set UNKNOWN, and
 * the gates defer on that, so there is nothing for a caller to handle.
 *
 * Self-healing (#133 review, MEDIUM-2). After a failure, or an answer that names
 * no mint while the build names none either, it schedules another attempt on a
 * backoff, and keeps doing so until a mint is known. Each answer that changes the
 * trusted set is announced to {@link onTrustedMintsChange} listeners, which is how
 * the poller knows to offer its held and deferred coupons again.
 */
export function loadTrustedMints(): Promise<void> {
  if (gatewayMints !== undefined && gatewayMints.length > 0) return Promise.resolve()
  return askGateway(false)
}

function askGateway(fresh: boolean): Promise<void> {
  loading ??= gatewayMintConfig({ fresh })
    .then(({ mintUrl, tokenMintUrls }) => {
      const next = [...new Set([...tokenMintUrls, mintUrl].map(normaliseMintUrl).filter((u) => u.length > 0))]
      const before = trustedMintUrls().join(',')
      const wasKnown = trustedMintsKnown()
      gatewayMints = next
      if (!wasKnown || trustedMintUrls().join(',') !== before) announce()
      if (trustedMintUrls().length === 0) scheduleRetry()
      else retryDelayMs = 0
    })
    .catch((error: unknown) => {
      console.warn('[trustedMint] gateway config unavailable, the trusted mint is still unknown:', error)
      scheduleRetry()
    })
    .finally(() => {
      loading = undefined
    })
  return loading
}

function scheduleRetry(): void {
  if (retryTimer !== undefined) return
  retryDelayMs = retryDelayMs === 0 ? FIRST_RETRY_MS : Math.min(retryDelayMs * 2, MAX_RETRY_MS)
  retryTimer = setTimeout(() => {
    retryTimer = undefined
    // Fresh: the cached config said nothing useful, so ask the gateway again.
    void askGateway(true)
  }, retryDelayMs)
}

function announce(): void {
  for (const listener of listeners) {
    try {
      listener()
    } catch (error) {
      console.warn('[trustedMint] a trusted-mint listener threw:', error)
    }
  }
}

/**
 * Be told when the trusted set changes: the gateway answered for the first time,
 * or answered differently. Returns the unsubscribe function.
 */
export function onTrustedMintsChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Forget what the gateway said and stop retrying. For tests, and logout. */
export function resetTrustedMints(): void {
  if (retryTimer !== undefined) clearTimeout(retryTimer)
  retryTimer = undefined
  retryDelayMs = 0
  gatewayMints = undefined
  loading = undefined
}

/**
 * Whether the gate can answer yet: the gateway's config has arrived, or the
 * build names a mint of its own and needs no gateway to be sure.
 */
export function trustedMintsKnown(): boolean {
  return gatewayMints !== undefined || buildMints().length > 0
}

/** The build's own list, normalised, with empty and unparseable entries dropped. */
function buildMints(): string[] {
  const configured = (import.meta.env.VITE_TRUSTED_MINT_URLS as string | undefined) ?? ''
  return configured
    .split(',')
    .map(normaliseMintUrl)
    .filter((u) => u.length > 0)
}

/**
 * The mints this build will credit from, normalised, or an empty array when
 * nothing names one (yet).
 *
 * Read through a FUNCTION rather than a module constant, for the reason
 * `allowedIssuerKeys` gives: a constant is fixed at import, which makes the one
 * security-critical input the one input a test cannot vary.
 *
 * A LIST, not a single value, because a mint migration spans two mints at once.
 *
 * ## Public and internal mint URLs
 *
 * The gateway calls its mint on an internal address (`http://imani-mint-rest:7777`)
 * but stamps tokens with the PUBLIC one (`GATEWAY_WALLET_MINT_PUBLIC_URL`, e.g.
 * `https://mint.staging.398ja.xyz`), which `/api/v1/config` serves as
 * `token_mint_urls`. So the token's `m` and this list agree on the public URL, and
 * an internal address is never trusted unless a build names it explicitly, which
 * a browser could not reach anyway.
 */
export function trustedMintUrls(): string[] {
  return [...new Set([...buildMints(), ...(gatewayMints ?? [])])]
}

/**
 * Whether this build may treat "no trusted mint known" as a pass: a DEV build
 * that set `VITE_ALLOW_ANY_MINT_IN_DEV=true`. Never a production build, whatever
 * it was given, so the flag cannot leak into a deployed image and turn the gate
 * off there.
 */
function anyMintAllowedInDev(): boolean {
  const requested = String(import.meta.env.VITE_ALLOW_ANY_MINT_IN_DEV ?? '').toLowerCase() === 'true'
  if (!requested) return false
  if (import.meta.env.PROD || !import.meta.env.DEV) {
    console.error('[trustedMint] VITE_ALLOW_ANY_MINT_IN_DEV is set in a production build and is IGNORED.')
    return false
  }
  return true
}

/** Why a token's backing was or was not accepted. */
export type MintVerdict =
  /**
   * The gateway HAS answered and no source names a mint. The wallet can verify
   * nothing, so it credits nothing: crediting HOLDS the coupon, swapping refuses.
   * This used to be `unchecked` and a pass, which was #133 on beta and prod.
   */
  | 'no-trusted-mint'
  /**
   * The trusted set is not yet known: the gateway's config has not arrived (or
   * could not be fetched) and the build names no mint. NOT a pass: wait and ask
   * again rather than credit on this.
   */
  | 'not-ready'
  /** The proofs are at a mint this build trusts, in the unit it understands. */
  | 'trusted'
  /**
   * The proofs are at some other mint. Not ours to credit NOW; held rather than
   * refused, because a configuration change may make it so.
   */
  | 'untrusted-mint'
  /** The proofs are not denominated in sat, so their amounts mean nothing here. */
  | 'wrong-unit'

/** The two facts the gate reads off a token. */
export type TokenBacking = Pick<ParsedVoucherToken, 'mintUrl' | 'unit'>

/**
 * Are this token's proofs at a mint we trust, in a unit we understand?
 *
 * Takes the parsed fields, so the caller pays for the decode once, and this stays
 * free of I/O. Says nothing about the signature: `verifyVoucher` answers that,
 * and both must hold.
 *
 * The unit is checked FIRST, and checked even when no mint is configured. It
 * needs no configuration to be meaningful, so there is no reason for it to lapse
 * along with the mint list.
 */
export function checkMintAndUnit(backing: TokenBacking): MintVerdict {
  if (backing.unit.trim().toLowerCase() !== TOKEN_UNIT) return 'wrong-unit'

  const trusted = trustedMintUrls()
  if (trusted.length === 0) return trustedMintsKnown() ? 'no-trusted-mint' : 'not-ready'

  // A token with no (or an unparseable) mint URL normalises to the empty string,
  // which `trustedMintUrls` never contains, so it lands on `untrusted-mint`.
  return trusted.includes(normaliseMintUrl(backing.mintUrl)) ? 'trusted' : 'untrusted-mint'
}

/**
 * The mint and unit any Cashu token string names, voucher or plain ecash, V4 or V3.
 *
 * `parseVoucherToken` only reads vouchers, so plain ecash had no reader at all,
 * and a gate that cannot read a token cannot refuse it. Throws on anything it
 * cannot decode; a caller must treat that as a refusal, never as a pass.
 *
 * A V3 token may omit its unit, which by NUT-00 means sat. A V4 token must name it.
 */
export function readTokenBacking(token: string): TokenBacking {
  const trimmed = token.trim()
  if (trimmed.startsWith('cashuB')) {
    const root = decodeCbor(base64UrlToBytes(trimmed.slice(6))) as Record<string, unknown>
    return { mintUrl: stringOr(root.m, ''), unit: stringOr(root.u, '') }
  }
  if (trimmed.startsWith('cashuA')) {
    const json = new TextDecoder().decode(base64UrlToBytes(trimmed.slice(6)))
    const root = JSON.parse(json) as { token?: Array<{ mint?: unknown }>; unit?: unknown }
    const mints = new Set((root.token ?? []).map((entry) => stringOr(entry.mint, '')))
    // A V3 token can span mints. One whose entries disagree has no single answer,
    // so it reads as no mint at all and is refused.
    const mintUrl = mints.size === 1 ? [...mints][0] : ''
    return { mintUrl, unit: root.unit === undefined ? TOKEN_UNIT : stringOr(root.unit, '') }
  }
  throw new Error('not a Cashu token (cashuA or cashuB)')
}


/**
 * The redemption gate dm-poll asks before every redeem (`RedemptionAdapter.checkBacking`, #131).
 *
 * Reads ANY token, voucher or plain ecash, so a rogue mint cannot slip past by not
 * being a voucher. Maps the verdict onto what the poller does with it:
 *
 * - `trusted` -> accept.
 * - `untrusted-mint` or `no-trusted-mint` -> HOLD. Nothing is swapped and the
 *   delivery is not consumed: it is shown as waiting to be verified and redeemed
 *   as soon as the configuration names its mint. Never terminal (#133 review).
 * - `wrong-unit`, or a token it cannot read -> refuse, before any swap. Terminal:
 *   no configuration change can make those creditable.
 * - `not-ready` -> defer. Offered again on a later poll, by which time the trusted
 *   list has loaded. Never a pass.
 *
 * `no-trusted-mint` is accepted only in a dev build that opted in with
 * `VITE_ALLOW_ANY_MINT_IN_DEV=true`, and says so in the console each time.
 */
export function checkTokenBacking(token: string): BackingVerdict {
  let backing: TokenBacking
  try {
    backing = readTokenBacking(token)
  } catch (error) {
    return { outcome: 'refuse', reason: 'undecodable', detail: `token could not be read: ${String(error)}` }
  }

  const verdict = checkMintAndUnit(backing)
  switch (verdict) {
    case 'trusted':
      return { outcome: 'accept' }
    case 'no-trusted-mint':
      if (anyMintAllowedInDev()) {
        console.warn(
          `[trustedMint] VITE_ALLOW_ANY_MINT_IN_DEV: crediting a token at ${backing.mintUrl || '(no mint)'} ` +
            'with no trusted mint configured. Dev builds only.',
        )
        return { outcome: 'accept' }
      }
      return { outcome: 'hold', reason: verdict, detail: 'no trusted mint is configured for this wallet' }
    case 'not-ready':
      return { outcome: 'defer', detail: 'the trusted mint list has not loaded yet' }
    case 'untrusted-mint':
      return { outcome: 'hold', reason: verdict, detail: `proofs are at a mint this wallet does not list: ${backing.mintUrl || '(none named)'}` }
    case 'wrong-unit':
      return { outcome: 'refuse', reason: verdict, detail: `proofs are in ${backing.unit || '(no unit)'}, not ${TOKEN_UNIT}` }
  }
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function base64UrlToBytes(s: string): Uint8Array {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}
