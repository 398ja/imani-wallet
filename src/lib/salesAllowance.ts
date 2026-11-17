/**
 * Has this stall used up its Free plan? Asked BEFORE a sale is started (review of gc#317).
 *
 * The gateway refuses a mint that would pass the allowance (422 SALES_LIMIT_REACHED), so nothing
 * can be over-issued whatever this says. This is the courtesy in front of it: a stall at its limit
 * is sent to the upgrade screen when it presses Sell, instead of scanning a customer and typing an
 * amount only to be refused.
 *
 * `GET /api/v1/wallet/vouchers/sales-allowance?unit=` answers for the CALLER's own stall: the
 * signing key, or the stall a till's credential names (signedFetch adds it).
 *
 * Fails OPEN on purpose. An answer that cannot be read lets the merchant into Sell, because the
 * gateway still refuses at the mint; locking a stall out of selling because ADVICE was unavailable
 * would be the worse outcome.
 */
import { signedFetch } from './nip98'

export type SalesAllowance =
  | { kind: 'unlimited' }
  | { kind: 'limited'; unit: string; usedMinor: number; allowanceMinor: number; remainingMinor: number; reached: boolean }
  | { kind: 'unknown' }

export const SALES_ALLOWANCE_PATH = '/api/v1/wallet/vouchers/sales-allowance'

/** The query string `?reason=` the subscription screen reads to explain why it was opened. */
export const SALES_LIMIT_REASON = 'sales-limit'

/** Where Sell sends an owner whose Free plan is used up. */
export const UPGRADE_PATH = `/settings/subscription?reason=${SALES_LIMIT_REASON}`

export async function salesAllowance(unit: string, fetchImpl: typeof signedFetch = signedFetch): Promise<SalesAllowance> {
  try {
    const response = await fetchImpl(`${SALES_ALLOWANCE_PATH}?unit=${encodeURIComponent(unit)}`, 'GET')
    if (!response.ok) return { kind: 'unknown' }
    const body = (await response.json()) as Record<string, unknown>
    if (body.limited === false) return { kind: 'unlimited' }
    const used = Number(body.used_minor)
    const allowance = Number(body.allowance_minor)
    const remaining = Number(body.remaining_minor)
    if (body.limited !== true || ![used, allowance, remaining].every(Number.isFinite)) return { kind: 'unknown' }
    return {
      kind: 'limited',
      unit: String(body.unit ?? unit),
      usedMinor: used,
      allowanceMinor: allowance,
      remainingMinor: remaining,
      reached: body.reached === true || remaining <= 0,
    }
  } catch {
    return { kind: 'unknown' }
  }
}
