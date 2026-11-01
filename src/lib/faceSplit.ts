/**
 * Splitting one coupon's face value across the proofs it is filed as (imani-wallet#384).
 *
 * The wallet keeps one voucher row per proof when a gift comes back (a Cashlink take-back, a relay
 * refund, a NUT-09 restore), so each row needs a whole number of face minor units. Rounding each
 * proof's share on its own loses (or invents) cents: 277 sats at ratio 0.07220 is exactly 20.0 c,
 * but 256/16/4/1 sats round to 18 + 1 + 0 + 0 = 19 c. The largest-remainder method gives each share
 * its floor, then hands the cents still owed to the largest remainders, so the shares always sum to
 * the rounded total.
 */
import { exactFaceValue, parseVoucherToken, tokenProofs } from './voucherToken'
import { encodePlainTokenV4 } from './plainToken'

/**
 * Whole shares of `exact` values that sum to `Math.round(sum(exact))`. Ties go to the earlier
 * index, so the result depends only on the inputs and their order (a retry files the same shares).
 */
export function apportion(exact: readonly number[]): number[] {
  const total = Math.round(exact.reduce((s, v) => s + v, 0) + 1e-9)
  const floors = exact.map((v) => Math.floor(v + 1e-9))
  let owed = total - floors.reduce((s, v) => s + v, 0)
  const order = exact.map((v, i) => ({ i, rem: v - floors[i] })).sort((a, b) => b.rem - a.rem || a.i - b.i)
  for (const { i } of order) {
    if (owed <= 0) break
    floors[i] += 1
    owed -= 1
  }
  return floors
}

/**
 * Each proof's whole face share in a gift token, keyed by proof secret. Undefined when the token is
 * not a readable voucher (the caller then falls back to the per-proof rounding it used before).
 */
export function faceSharesOf(token: string): Map<string, number> | undefined {
  try {
    const mintUrl = mintOfToken(token)
    const proofs = tokenProofs(token)
    const exact = proofs.map((p) => exactFaceValue(parseVoucherToken(encodePlainTokenV4(mintUrl, 'sat', [{ amount: p.amount, id: p.id, secret: p.secret, C: p.C }]))))
    const shares = apportion(exact)
    return new Map(proofs.map((p, n) => [p.secret, shares[n]]))
  } catch {
    return undefined
  }
}

/** The face share of one proof of a gift token, or undefined (see `faceSharesOf`). */
export function faceShareOf(token: string, secret: string): number | undefined {
  return faceSharesOf(token)?.get(secret)
}

function mintOfToken(token: string): string {
  return parseVoucherToken(token).mintUrl
}
