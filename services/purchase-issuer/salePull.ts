/**
 * The pull on login (imani-wallet#275 item 3, card atomicity U9).
 *
 * A stall that was offline, restored, or on a device that never saw a sale record asks for its
 * missed card sales again. The wallet lists its own sales from payment-adapter
 * (`GET /api/v1/purchases?stall=`, NIP-98 as the stall), sees which `issued:<voucher>` rows it
 * lacks, and asks this service to re-send those records (`POST /api/v1/card-sales/sales/resend`,
 * NIP-98 as the stall).
 *
 * The voucher ids the wallet names are a FILTER, never the source. What is re-sent is rebuilt from
 * payment-adapter's own list, read here with the issuer's token: the amount, currency, `pi_` and
 * sale time are the ones the webhook recorded, so a stall cannot have a record forged for a sale
 * it never made, and the record's time is the payment's, not this service's (residual R1).
 *
 * Every record is re-signed with the deterministic warrant (`delegatedWarrant`), so for the same
 * purchase and delegation it is byte-identical to the one the coupon was minted under. The stall
 * files by `issued:<voucher>`, so re-sending is idempotent.
 */

import { getDecimals } from '@imani/money'

import { DELEGATION_SKEW_MARGIN_MS, checkDelegation, delegatedWarrant } from './delegatedWarrant'
import type { StallCredential } from './issuer'
import { resendSaleRecords, type CardSale } from './saleRecord'

/** The stall-purchases list, on payment-adapter. */
export const STALL_PURCHASES_PATH = '/api/v1/purchases'

/** At most this many records per resend call. The list itself is capped at 200. */
export const MAX_RESEND = 50

/** One card sale as payment-adapter's stall list answers it. */
export interface StallPurchase {
  voucherId: string
  ref: string
  amountMinor: number
  currency: string
  livemode: boolean
  /** Epoch ms the webhook recorded the payment. */
  paidAt: number
}

const VOUCHER_ID = /^[0-9A-Za-z-]{1,64}$/
const PI = /^pi_[A-Za-z0-9_]{1,250}$/
const CURRENCY = /^[a-z]{3}$/

/** One row of payment-adapter's answer, or null when any field is not what it must be. */
export function parseStallPurchase(raw: unknown): StallPurchase | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const voucherId = typeof r.voucher_id === 'string' ? r.voucher_id : ''
  const ref = typeof r.ref === 'string' ? r.ref : ''
  const currency = typeof r.currency === 'string' ? r.currency.toLowerCase() : ''
  const amount = r.amount_minor
  const paidAt = typeof r.paid_at === 'string' ? Date.parse(r.paid_at) : typeof r.paid_at === 'number' ? r.paid_at * 1000 : NaN
  if (!VOUCHER_ID.test(voucherId) || !PI.test(ref) || !CURRENCY.test(currency)) return null
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0) return null
  if (!Number.isFinite(paidAt) || paidAt <= 0) return null
  return { voucherId, ref, amountMinor: amount, currency, livemode: r.livemode === true, paidAt }
}

/**
 * The stall's card sales, from payment-adapter with the issuer's token. Null when they cannot be
 * read (never "none": an outage must not read as a stall with no sales).
 */
export async function fetchStallPurchases(
  purchasesUrl: string,
  token: string,
  stallPubkey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<StallPurchase[] | null> {
  try {
    const url = `${purchasesUrl.replace(/\/$/, '')}${STALL_PURCHASES_PATH}?stall=${encodeURIComponent(stallPubkey.toLowerCase())}`
    const response = await fetchImpl(url, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) return null
    const body = (await response.json()) as unknown
    if (!Array.isArray(body)) return null
    return body.map(parseStallPurchase).filter((p): p is StallPurchase => p !== null)
  } catch {
    return null
  }
}

/**
 * The sale record a purchase's coupon was minted with, rebuilt. Null when the credential holds no
 * usable delegation. No recipient (the list carries none) and no expiry (the mint's term is not on
 * the list): the stall's reader treats both as absent, never as wrong.
 */
export function rebuildSale(credential: StallCredential, purchase: StallPurchase): CardSale | null {
  // The stored delegation must still be a well-formed one for this lock key. Checked as for a
  // coupon that ended at the sale: the stall's reader judges it at the sale time, so a delegation
  // that has lapsed since is fine, and one renewed after the sale is refused there (see Not done).
  const delegation = checkDelegation(credential, purchase.paidAt - DELEGATION_SKEW_MARGIN_MS)
  if (!delegation.ok) return null
  const event = delegation.event
  const unit = purchase.currency.toUpperCase()
  const faceDecimals = getDecimals(unit)
  return {
    voucherId: purchase.voucherId,
    faceValue: purchase.amountMinor,
    faceUnit: unit,
    faceDecimals,
    memo: '',
    at: purchase.paidAt,
    issuanceWarrant: delegatedWarrant({
      paymentIntent: purchase.ref,
      issuerId: credential.stallPubkey.toLowerCase(),
      saleTotalMinor: purchase.amountMinor,
      faceDecimals,
      unit,
      reference: purchase.ref,
      lockKeyHex: credential.lockKeyHex,
      delegation: event,
    }),
  }
}

export interface ResendDeps {
  purchasesUrl: string
  purchasesToken: string
  gatewayUrl: string
  livemode: boolean
  credentialFor(stallPubkey: string): Promise<StallCredential | null>
  fetchImpl?: typeof fetch
}

export type ResendResult =
  | { kind: 'sent'; sent: number; failed: string[]; unknown: string[] }
  | { kind: 'not-enrolled' }
  | { kind: 'unavailable' }

/**
 * Re-send the records of `voucherIds` (all of the stall's, when empty) that payment-adapter lists
 * for this stall. Ids it does not list come back as `unknown` and are sent nothing.
 */
export async function resendStallSales(
  deps: ResendDeps,
  stallPubkey: string,
  voucherIds: readonly string[],
): Promise<ResendResult> {
  const credential = await deps.credentialFor(stallPubkey)
  if (credential === null) return { kind: 'not-enrolled' }
  const listed = await fetchStallPurchases(deps.purchasesUrl, deps.purchasesToken, stallPubkey, deps.fetchImpl)
  if (listed === null) return { kind: 'unavailable' }
  // Real value is never described from a test payment, nor the other way round.
  const own = listed.filter((p) => p.livemode === deps.livemode)
  const wanted = voucherIds.length > 0 ? new Set(voucherIds) : null
  const picked = wanted ? own.filter((p) => wanted.has(p.voucherId)) : own
  const unknown = wanted ? [...wanted].filter((id) => !own.some((p) => p.voucherId === id)) : []
  const sales = picked
    .slice(0, MAX_RESEND)
    .map((p) => rebuildSale(credential, p))
    .filter((s): s is CardSale => s !== null)
  const { sent, failed } = await resendSaleRecords(deps.gatewayUrl, credential, sales, deps.fetchImpl)
  return { kind: 'sent', sent, failed, unknown }
}
