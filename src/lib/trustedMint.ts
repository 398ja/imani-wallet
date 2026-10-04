import type { BackingVerdict } from '@imani/dm-poll'

import { gatewayConfig } from './config'
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
 * Two sources, combined:
 *
 * 1. `VITE_TRUSTED_MINT_URLS`, baked in at build time. The Dockerfile refuses to
 *    build without it, so every deployed image carries its mint.
 * 2. The `mint_url` the gateway serves on `GET /api/v1/config`, read ONCE by
 *    {@link loadTrustedMints}, which the app awaits before the coupon poller
 *    starts. A local or dev build, which has no build argument, is protected by
 *    this one.
 *
 * This used to read `globalThis.GatewayConfig`, a classic script that only the
 * legacy bridge ever loaded. On a path that had not touched the bridge the
 * script was simply absent, the absence read as "this deployment names no
 * mint", and the gate answered `unchecked` for every coupon. Nothing here reads
 * that global any more: the config is fetched through `lib/config.ts`, the same
 * module the rest of the React app uses, at a moment the app controls.
 *
 * ## `unknown` is not `none`
 *
 * Until the config has been read, the trusted set is UNKNOWN, and that is a
 * different answer from "the gateway named no mint". A failed or slow fetch
 * leaves it unknown, never empty. Callers refuse or defer on `not-ready`; only a
 * gateway that answered and genuinely named nothing produces `unchecked`, and
 * only the crediting paths accept that. See {@link MintVerdict}.
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
 * Exported for the other gates that need to say "same mint" (#131).
 */
export function normaliseMintUrl(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url.trim())
  } catch {
    return ''
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return ''
  // `URL` already lower-cases the scheme and host and drops a default port.
  const path = parsed.pathname.replace(/\/+$/, '')
  return `${parsed.protocol}//${parsed.host}${path}`
}

/** What `/api/v1/config` said, or `undefined` while it has not answered. */
let gatewayMint: string | undefined
let loading: Promise<void> | undefined

/**
 * Learn the gateway's mint. Awaited at start-up, before any coupon is received.
 *
 * Never rejects: a gateway that cannot be reached leaves the set UNKNOWN, and
 * the gates refuse on that, so there is nothing for a caller to handle. A second
 * call after a failure tries again; a second call after a success is free.
 */
export function loadTrustedMints(): Promise<void> {
  if (gatewayMint !== undefined) return Promise.resolve()
  loading ??= gatewayConfig()
    .then(({ mintUrl }) => {
      gatewayMint = mintUrl
    })
    .catch((error: unknown) => {
      console.warn('[trustedMint] gateway config unavailable, the trusted mint is still unknown:', error)
    })
    .finally(() => {
      loading = undefined
    })
  return loading
}

/** Forget what the gateway said. For tests, and nothing else. */
export function resetTrustedMints(): void {
  gatewayMint = undefined
  loading = undefined
}

/**
 * Whether the gate can answer yet: the gateway's config has arrived, or the
 * build names a mint of its own and needs no gateway to be sure.
 */
export function trustedMintsKnown(): boolean {
  return gatewayMint !== undefined || buildMints().length > 0
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
 * `https://mint.staging.398ja.xyz`), and `/api/v1/config` serves that public URL
 * as `mint_url`. So the token's `m` and this list agree on the public URL, and an
 * internal address is never trusted unless a build names it explicitly, which a
 * browser could not reach anyway.
 */
export function trustedMintUrls(): string[] {
  const fromGateway = normaliseMintUrl(gatewayMint ?? '')
  const all = fromGateway ? [...buildMints(), fromGateway] : buildMints()
  return [...new Set(all)]
}

/** Why a token's backing was or was not accepted. */
export type MintVerdict =
  /**
   * The gateway HAS answered and names no mint, and the build names none either.
   * This deployment genuinely configures no mint, so this build makes no claim.
   * Accepted only where refusing would strand money already held; see
   * `checkTokenBacking` and `receiveTokenByOwnSwap`.
   */
  | 'unchecked'
  /**
   * The trusted set is not yet known: the gateway's config has not arrived (or
   * could not be fetched) and the build names no mint. NOT a pass: wait and ask
   * again rather than credit on this.
   */
  | 'not-ready'
  /** The proofs are at a mint this build trusts, in the unit it understands. */
  | 'trusted'
  /** The proofs are at some other mint. Their value is not ours to credit. */
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
  if (trusted.length === 0) return trustedMintsKnown() ? 'unchecked' : 'not-ready'

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
 * - `untrusted-mint`, `wrong-unit`, or a token it cannot read -> refuse, before any
 *   swap. Terminal: the token's bytes will not change.
 * - `not-ready` -> defer. The delivery is left unconsumed and offered again on a
 *   later poll, by which time the trusted list has loaded. Never a pass.
 * - `unchecked` -> accept. This is the CREDITING path's documented choice, kept
 *   deliberately: the gateway answered and named no mint, and refusing here would
 *   strand a coupon the customer already holds. It is no worse than before the
 *   gate existed. The own-swap path, which chooses where to SEND money, refuses
 *   it instead (`receiveTokenByOwnSwap`).
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
    case 'unchecked':
      return { outcome: 'accept' }
    case 'not-ready':
      return { outcome: 'defer', detail: 'the trusted mint list has not loaded yet' }
    case 'untrusted-mint':
      return { outcome: 'refuse', reason: verdict, detail: `proofs are at an untrusted mint: ${backing.mintUrl || '(none named)'}` }
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
