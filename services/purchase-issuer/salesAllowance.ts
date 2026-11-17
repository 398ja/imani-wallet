/**
 * A stall's Free plan sales allowance, asked of the gateway BEFORE a buyer pays (gc#317 follow-up).
 *
 * gateway-customer refuses a sale past a free stall's lifetime allowance at the mint (422
 * `SALES_LIMIT_REACHED`). For a card sale that refusal comes after the card was charged: the paid
 * purchase is parked for a refund (`discharge.ts`, `attention`). So `/ready` asks first, with the
 * same answer the wallet's Sell screen reads (`GET /api/v1/wallet/vouchers/sales-allowance`), and
 * Buy and payment-adapter's checkout refuse a stall that could not issue the coupon.
 *
 * ## Asked as the stall
 *
 * The endpoint only ever answers for the caller's own stall. This service holds no stall key, only
 * each stall's terminal credential and its lock key, so it asks exactly as issuance does: NIP-98
 * signed with the lock key, the credential in `X-Imani-Terminal-Credential`. The gateway resolves
 * the stall from the credential.
 *
 * ## Advice, cached briefly
 *
 * The mint re-checks and is what enforces. A position is cached for `ALLOWANCE_CACHE_MS` so a busy
 * Buy page is not one gateway call per view, and short enough that a stall which upgrades (or
 * sells its last pound over the counter) is seen within seconds. Only answers are cached; an
 * unknown is asked again next time.
 */

import { authorization, CREDENTIAL_HEADER, ISSUE_PATH, type StallCredential } from './issuer'

export const SALES_ALLOWANCE_PATH = `${ISSUE_PATH}/sales-allowance`

/** How long one stall's position in one unit is remembered. */
export const ALLOWANCE_CACHE_MS = 10_000

/** How long one read may take. Readiness is on the Buy tap's path. */
export const ALLOWANCE_TIMEOUT_MS = 3_000

export type SalesPosition =
  /** A paid plan, or the allowance is switched off: nothing to refuse. */
  | { kind: 'unlimited' }
  /** A free stall. `remainingMinor` is in the unit's minor units, never negative. */
  | { kind: 'limited'; unit: string; remainingMinor: number }
  /** The gateway could not be asked, refused the credential, or answered nonsense. */
  | { kind: 'unknown'; reason: string }

export type AllowanceReader = (credential: StallCredential, unit: string) => Promise<SalesPosition>

/** A three-letter currency code, upper-cased, or null. */
export function normaliseUnit(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const unit = raw.trim().toUpperCase()
  return /^[A-Z]{3}$/.test(unit) ? unit : null
}

/** Ask the gateway once, with no cache. Never throws. */
export async function readSalesAllowance(
  gatewayUrl: string,
  credential: StallCredential,
  unit: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = ALLOWANCE_TIMEOUT_MS,
): Promise<SalesPosition> {
  const url = `${gatewayUrl.replace(/\/$/, '')}${SALES_ALLOWANCE_PATH}?unit=${encodeURIComponent(unit)}`
  try {
    const response = await fetchImpl(url, {
      headers: {
        // Signed over the URL actually requested, query included, and the empty body of a GET.
        Authorization: authorization('GET', url, '', credential.lockKeyHex),
        [CREDENTIAL_HEADER]: credential.credentialId,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (response.status !== 200) return { kind: 'unknown', reason: `sales allowance answered ${response.status}` }
    const body = (await response.json()) as Record<string, unknown> | null
    if (body === null || typeof body !== 'object') return { kind: 'unknown', reason: 'sales allowance was not an object' }
    if (body.limited === false) return { kind: 'unlimited' }
    const remaining = body.remaining_minor
    if (body.limited !== true || typeof remaining !== 'number' || !Number.isSafeInteger(remaining)) {
      return { kind: 'unknown', reason: 'sales allowance had no usable position' }
    }
    // `reached` is the gateway's own verdict; a remaining of 0 says the same.
    const remainingMinor = body.reached === true ? 0 : Math.max(0, remaining)
    return { kind: 'limited', unit: normaliseUnit(body.unit) ?? unit, remainingMinor }
  } catch (error) {
    return { kind: 'unknown', reason: `sales allowance unreachable: ${error instanceof Error ? error.name : 'error'}` }
  }
}

/** A reader with a short per-stall, per-unit cache of real answers. */
export function cachedAllowanceReader(
  read: AllowanceReader,
  now: () => number = () => Date.now(),
  ttlMs = ALLOWANCE_CACHE_MS,
): AllowanceReader {
  const cache = new Map<string, { at: number; value: SalesPosition }>()
  return async (credential, unit) => {
    // Keyed by credential too: a stall that re-enrols is asked afresh with its new credential.
    const key = `${credential.stallPubkey.toLowerCase()}|${credential.credentialId}|${unit}`
    const hit = cache.get(key)
    if (hit && now() - hit.at < ttlMs) return hit.value
    const value = await read(credential, unit)
    if (value.kind !== 'unknown') {
      // Bounded: a public endpoint must not grow this without limit. Oldest out first.
      if (cache.size >= 10_000) cache.delete(cache.keys().next().value as string)
      cache.set(key, { at: now(), value })
    } else {
      cache.delete(key)
    }
    return value
  }
}

/**
 * What a position means for one sale. `amountMinor` null asks only "can this stall sell at all?",
 * which is what Buy asks before an amount is typed.
 */
export type AllowanceVerdict = 'ok' | 'reached' | 'exceeded' | 'unknown'

export function allowanceVerdict(position: SalesPosition, amountMinor: number | null): AllowanceVerdict {
  if (position.kind === 'unlimited') return 'ok'
  if (position.kind === 'unknown') return 'unknown'
  if (position.remainingMinor <= 0) return 'reached'
  if (amountMinor !== null && amountMinor > position.remainingMinor) return 'exceeded'
  return 'ok'
}
