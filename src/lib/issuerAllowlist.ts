import type { ParsedVoucherToken } from './voucherToken'

/**
 * Which signing keys this build will believe a coupon from.
 *
 * ## The hole this closes
 *
 * `verifyVoucher` checks a voucher's signature against `issuerPublicKey`, and
 * that field is carried INSIDE the voucher being checked. Whoever signs it also
 * chooses the key it is verified against, so `signatureValid: true` means "these
 * bytes are internally consistent" and never "somebody I trust issued this". A
 * wholly self-issued voucher at any face value verifies perfectly. Recorded as
 * Finding 2 of `docs/research/audit-double-spend-inflation-review.md` and pinned
 * by `auditSoundnessLimits.test.ts`.
 *
 * What stands behind it in production is the MINT: it signs proofs only for
 * keysets it holds, so a self-issued voucher fails at the swap. **Offline there
 * is no such backstop**, which contradicts `voucherToken.ts`'s own promise that
 * "a merchant at a stall with no signal must still be able to tell their own
 * coupon from someone else's". This module is that check.
 *
 * ## Why an allowlist and not one pinned key
 *
 * The review recommended mirroring `VITE_LICENCE_ISSUER_PUBKEY`: one key, in the
 * bundle. **Measurement refused that shape.** Parsing the eight real captured
 * tokens in `src/lib/__tests__/fixtures/` shows FOUR distinct
 * `issuerPublicKey` values, varying with the mint rather than the stall:
 *
 *   6a02bb64…  control-unlocked, witness-positive, witness-test   (127.0.0.1.mint)
 *   4b22d0ec…  live-licence, live-terminal-till                   (127.mint.local)
 *   0d042df7…  live-terminal-credential                           (127.0.0.1.mint)
 *   27aa1ecd…  magento-demo-credential, revocation-probe          (127.0.0.1.mint)
 *
 * One stall (`b1787b2b…`) has coupons signed by all four. So the key is the
 * MINT's signing key for a keyset, not a stall identity and not a single
 * constant — `deploy/migrate-keys-to-hashi.sh` stores them per mint and per
 * keyset, and keysets rotate. A single pinned value would refuse most genuine
 * coupons, which is the shape of the error errata item 1 already records.
 *
 * An allowlist is what ADR 0006 already specifies for the gateway's own path:
 * *"(mint, issuer) allowlisted — no, local config"*. This brings the same
 * control to the wallet.
 *
 * ## Unset means ALLOW, and that is the opposite of the licence rule
 *
 * `licenceIssuerPubkey()` returns empty and nothing verifies, because a missing
 * subscription key should turn a paid feature OFF. Here the equivalent choice
 * would turn MONEY off: every coupon on every deployment that has not set the
 * variable would be refused, including all of them today.
 *
 * So an unset allowlist disables the check rather than failing closed. That is
 * deliberate and it is a real limitation, stated plainly rather than hidden: a
 * deployment that has not configured this is exactly as exposed as it was
 * before this module existed, and no worse. The safe direction for a *gate on
 * money* is the one that cannot strand it.
 */

/**
 * The configured keys, lowercased, or an empty array when unset.
 *
 * Read through a FUNCTION rather than a module constant, for the reason
 * `licenceIssuerPubkey` gives: a constant is fixed at import, which makes the
 * one security-critical input here the one input a test cannot vary, and an
 * untestable gate is how a misconfigured deployment ships open.
 *
 * Comma-separated, because a deployment legitimately spans several keysets at
 * once during a rotation and an either/or would force a flag day.
 */
export function allowedIssuerKeys(): string[] {
  const raw = (import.meta.env.VITE_VOUCHER_ISSUER_PUBKEYS as string | undefined) ?? ''
  return raw
    .split(',')
    .map((k) => k.trim().toLowerCase())
    .filter((k) => k.length > 0)
}

/** Why a coupon's issuer was not accepted. */
export type IssuerVerdict =
  /** No allowlist configured, so this build makes no claim either way. */
  | 'unchecked'
  /** The signing key is one this build was told to trust. */
  | 'allowed'
  /** A signing key this build does not know. Offline, this is the only signal. */
  | 'unknown-issuer'

/**
 * Is this coupon signed by a key this build trusts?
 *
 * Takes the PARSED voucher rather than a token, so the caller pays for the
 * decode once and this stays free of I/O and of any opinion about where the
 * bytes came from.
 *
 * Says nothing about the signature itself — `verifyVoucher` answers that, and
 * both must hold. The two are deliberately separate: one asks whether the bytes
 * were altered, the other whether their author is anybody we recognise.
 */
export function checkIssuer(parsed: ParsedVoucherToken): IssuerVerdict {
  const allowed = allowedIssuerKeys()
  if (allowed.length === 0) return 'unchecked'

  const key = parsed.voucher.issuerPublicKey?.toLowerCase() ?? ''
  return allowed.includes(key) ? 'allowed' : 'unknown-issuer'
}
