import { formatFace, currencyDecimals } from './format'
import { signedFetch } from './nip98'
import { shopHost } from './shopEnrol'

/**
 * What an online shop could redirect if its key `S` were stolen (#402 R5): the codes currently
 * locked to `S` and not yet redeemed, cancelled or expired. Shown on the stall's Terminals page,
 * "3 codes, €45 outstanding at shop.example".
 *
 * The figure lives only in the code store: the stall never sees a customer's deposit. So it comes
 * from a stall-authenticated summary call (contract §3, `GET /v1/checkout-codes/exposure`), and
 * when the store is not configured, unreachable or does not have that route yet, this returns null
 * and the row shows no figure. Never a guessed zero: "nothing outstanding" is a claim.
 */

export interface ShopExposure {
  /** Codes in `reserved`, `held` or `cancelling`. */
  codes: number
  /** Their total, in minor units of `unit`. */
  amount: number
  unit: string
}

export type ExposureFetch = (stallPubkey: string, shopKey: string) => Promise<ShopExposure | null>

/** The code store's base url, if this build knows one. */
function storeBase(): string {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env
  return (env?.VITE_CHECKOUT_CODES_URL ?? '').trim().replace(/\/+$/, '')
}

/** Read the summary body, fail-closed. */
export function parseExposure(raw: unknown): ShopExposure | null {
  const r = raw as Record<string, unknown> | null
  if (!r || typeof r !== 'object') return null
  const { codes, amount, unit } = r
  if (!Number.isSafeInteger(codes) || (codes as number) < 0) return null
  if (!Number.isSafeInteger(amount) || (amount as number) < 0) return null
  if (typeof unit !== 'string' || !/^[a-z]{3,8}$/i.test(unit)) return null
  return { codes: codes as number, amount: amount as number, unit: unit.toUpperCase() }
}

/** NIP-98 as the stall. Null for anything but a well-formed 200. */
export const fetchShopExposure: ExposureFetch = async (_stallPubkey, shopKey) => {
  const base = storeBase()
  if (!base) return null
  try {
    const r = await signedFetch(`${base}/v1/checkout-codes/exposure?shop_key=${encodeURIComponent(shopKey)}`, 'GET')
    if (!r.ok) return null
    return parseExposure(await r.json())
  } catch {
    return null
  }
}

/** "3 codes, €45.00": the figure alone, for a value cell. */
export function exposureSummary(exposure: ShopExposure): string {
  const n = exposure.codes === 1 ? '1 code' : `${exposure.codes} codes`
  const value = formatFace(exposure.amount, { unit: exposure.unit, decimals: currencyDecimals(exposure.unit) })
  return `${n}, ${value}`
}

/** "3 codes, €45.00 outstanding at shop.example". */
export function exposureLine(exposure: ShopExposure, url: string): string {
  return `${exposureSummary(exposure)} outstanding at ${shopHost(url)}`
}
