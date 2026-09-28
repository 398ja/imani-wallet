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
 * See `docs/explanation/the-wallet-swaps-its-own-receives.md`.
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
 * The mint the gateway told this wallet to use, or empty.
 *
 * Read off `globalThis` rather than imported. `shared/gateway-config.js` is a
 * classic script that assigns `globalThis.GatewayConfig` and fires a fetch on
 * load, so importing it here would make a pure comparison function perform I/O
 * as a side effect of being imported, and would do it in every test that touches
 * this file.
 *
 * Absent in tests and before `/api/v1/config` resolves, which is why every
 * caller treats an empty result as "nothing configured" rather than an error.
 */
function gatewayMintUrl(): string {
  const config = (globalThis as { GatewayConfig?: { mintUrl?: string } }).GatewayConfig
  return config?.mintUrl ?? ''
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
  const fromGateway = [gatewayMintUrl()]
  const all = [...fromEnv, ...fromGateway].map(normaliseMintUrl).filter((u) => u.length > 0)
  return [...new Set(all)]
}

/** Why a coupon's backing was not accepted. */
export type MintVerdict =
  /** Nothing names a trusted mint, so this build makes no claim about the mint. */
  | 'unchecked'
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
  if (trusted.length === 0) return 'unchecked'

  // A token with no mint URL normalises to the empty string, which cannot be on
  // the list because `trustedMintUrls` filters empties out when building it. So
  // "declines to say where its value is" already lands on `untrusted-mint` here,
  // and an explicit guard for it would be unreachable. Pinned by the
  // no-mint-URL test, which fails if that filter is ever dropped.
  return trusted.includes(normaliseMintUrl(parsed.mintUrl)) ? 'trusted' : 'untrusted-mint'
}
