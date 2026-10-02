import type { ParsedVoucherToken } from './voucherToken'

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
 * Until this module the wallet read the token's mint URL and unit and then
 * checked neither. That was already a bug. It becomes a sharper one now the
 * wallet swaps its own receives, because the mint URL stops being a field we
 * record and becomes the address we send money to.
 *
 * See `imani-docs/wallet/explanation/the-wallet-swaps-its-own-receives.md`.
 *
 * ## `voucher.unit` is deliberately not what this checks
 *
 * This reads like an off-by-one field, so it is worth stating. Measured on the
 * captured fixtures, EVERY token's `u` is `sat`, while `voucher.unit` ranges
 * over currencies: `live-licence.token` is a GBP coupon. The two are different
 * facts. `u` is what the proofs are denominated in; `voucher.unit` is what the
 * face value is denominated in.
 *
 * So a rule over `voucher.unit` would refuse every foreign-currency coupon we
 * issue. `trustedMint.test.ts` pins the distinction against the real tokens.
 */

/**
 * The unit the proofs must be denominated in.
 *
 * Not configurable, unlike the mint list. A wallet that credits proofs in some
 * other unit has no way to convert them, so allowing it to be relaxed would only
 * ever be a way to get the check wrong.
 */
export const TOKEN_UNIT = 'sat'

/** A mint URL with the incidental differences removed, for comparison. */
function normaliseMintUrl(url: string): string {
  return url.trim().toLowerCase().replace(/\/+$/, '')
}

/**
 * The gateway's config, when it has actually arrived.
 *
 * Read off `globalThis` rather than imported. `shared/gateway-config.js` is a
 * classic script that assigns `globalThis.GatewayConfig` and fires a fetch on
 * load, so importing it here would make a pure comparison function perform I/O
 * as a side effect of being imported, and would do it in every test that touches
 * this file.
 */
interface GatewayConfigShape {
  mintUrl?: string
  /** Fires once, after `/api/v1/config` resolves. Our readiness signal. */
  whenReady?(callback: () => void): void
}

function gatewayConfig(): GatewayConfigShape | undefined {
  return (globalThis as { GatewayConfig?: GatewayConfigShape }).GatewayConfig
}

/**
 * Whether the gateway's configuration has arrived yet.
 *
 * **This is a security distinction, not a convenience.** `/api/v1/config` is
 * fetched asynchronously and `shared/gateway-config.js` is itself loaded lazily by
 * the legacy bridge, so `GatewayConfig` is `undefined` for a while after start and
 * its `mintUrl` is empty until the fetch resolves.
 *
 * Without this distinction an empty mint list reads as "this deployment configures
 * no mint", which returns `unchecked` and waves every coupon through. That turns
 * the gate off for anyone who can merely DELAY one request: a slow network, a 500
 * the wallet does not retry, a service-worker race. Far cheaper than compromising
 * the config it is meant to protect.
 *
 * So "not loaded yet" is reported separately, and callers treat it as a reason to
 * wait rather than a reason to proceed.
 *
 * Readiness is taken from `whenReady`, which the config module invokes ONCE the
 * fetch has resolved, rather than from a non-empty `mintUrl`. A deployment may
 * legitimately report no mint, and inferring readiness from the value could not
 * tell that apart from a fetch still in flight.
 *
 * **Absent is not the same as pending.** `shared/gateway-config.js` is loaded
 * lazily by the legacy bridge, so on a path that never touches it `GatewayConfig`
 * is undefined for ever rather than briefly. Treating that as "wait" would refuse
 * every coupon permanently, so it reads as "this wallet has no gateway config to
 * wait for" and only a PRESENT-but-unresolved config defers. See `checkMintAndUnit`.
 */
export function gatewayConfigLoaded(): boolean {
  const config = gatewayConfig()
  // Nothing to wait for: the script was never loaded on this path.
  if (!config) return true
  // Present but not the module we know how to ask. Nothing to wait for either.
  if (typeof config.whenReady !== 'function') return true

  // `whenReady` runs its callback SYNCHRONOUSLY when the config has already
  // resolved, and defers it otherwise. So observing a synchronous call is exactly
  // the question being asked, and it costs no state of our own.
  let ready = false
  config.whenReady(() => {
    ready = true
  })
  return ready
}

/**
 * The mints this build will credit from, normalised, or an empty array when
 * nothing names one.
 *
 * Read through a FUNCTION rather than a module constant, for the reason
 * `allowedIssuerKeys` gives: a constant is fixed at import, which makes the one
 * security-critical input the one input a test cannot vary.
 *
 * A LIST, not a single value, for the reason that shaped `issuerAllowlist`: a
 * mint migration spans two mints at once, and an either/or would force a flag
 * day.
 *
 * The gateway's configured mint is included as a fallback. Without it this check
 * would be unset on every existing wallet the moment it ships, and an unset
 * check is not a check. With it, a wallet that has been told which mint to use
 * by its own gateway is protected without anybody configuring anything.
 */
export function trustedMintUrls(): string[] {
  const configured = (import.meta.env.VITE_TRUSTED_MINT_URLS as string | undefined) ?? ''
  const fromEnv = configured.split(',')
  // The gateway tells the wallet which mint to use. It is the same fact, from a
  // source the wallet already trusts for it.
  const fromGateway = [gatewayConfig()?.mintUrl ?? '']
  const all = [...fromEnv, ...fromGateway].map(normaliseMintUrl).filter((u) => u.length > 0)
  return [...new Set(all)]
}

/** Why a coupon's backing was not accepted. */
export type MintVerdict =
  /**
   * Nothing names a trusted mint AND the gateway's config has arrived, so this
   * deployment genuinely configures none. This build makes no claim about the mint.
   */
  | 'unchecked'
  /**
   * The gateway's config has not arrived, so the trusted set is not yet knowable.
   * NOT a pass: a caller must wait and ask again rather than credit on this.
   */
  | 'not-ready'
  /** The proofs are at a mint this build trusts, in the unit it understands. */
  | 'trusted'
  /** The proofs are at some other mint. Their value is not ours to credit. */
  | 'untrusted-mint'
  /** The proofs are not denominated in sat, so their amounts mean nothing here. */
  | 'wrong-unit'

/**
 * Are this token's proofs at a mint we trust, in a unit we understand?
 *
 * Takes the PARSED token, so the caller pays for the decode once, and this stays
 * free of I/O. Says nothing about the signature: `verifyVoucher` answers that,
 * and both must hold.
 *
 * The unit is checked FIRST, and checked even when no mint is configured. It
 * needs no configuration to be meaningful, so there is no reason for it to lapse
 * along with the mint list.
 */
export function checkMintAndUnit(parsed: ParsedVoucherToken): MintVerdict {
  if (parsed.unit.trim().toLowerCase() !== TOKEN_UNIT) return 'wrong-unit'

  const trusted = trustedMintUrls()
  if (trusted.length === 0) {
    // An explicitly configured list needs no gateway, so an empty one here means
    // neither source has named a mint. Which of the two silences it is decides
    // whether this is a deployment choice or a race.
    return gatewayConfigLoaded() ? 'unchecked' : 'not-ready'
  }

  // A token with no mint URL normalises to the empty string, which cannot be on
  // the list because `trustedMintUrls` filters empties out when building it. So
  // "declines to say where its value is" already lands on `untrusted-mint` here,
  // and an explicit guard for it would be unreachable. Pinned by the
  // no-mint-URL test, which fails if that filter is ever dropped.
  return trusted.includes(normaliseMintUrl(parsed.mintUrl)) ? 'trusted' : 'untrusted-mint'
}
