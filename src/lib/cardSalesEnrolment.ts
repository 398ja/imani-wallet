/**
 * Turning on card sales for a stall, from the stall owner's phone (imani-wallet#298).
 *
 * A stall that connects Stripe can take card payments, but the purchase issuer can only mint its
 * vouchers once the stall has ENROLLED it: an issue-and-redeem terminal credential locked to a key
 * the issuer holds, confirmed at the gateway, and a kind-30078 `coupon:issue` delegation naming
 * that key. Until now only an operator script could do that, so paid purchases sat OWED.
 *
 * ## The stall's key never leaves this phone
 *
 * Owner requirement, 2026-10-18, and the shape of every step below:
 *
 * - every request to the purchase issuer is NIP-98 signed HERE (`signedFetch`);
 * - the credential is minted HERE, with the stall's own NIP-98 and the owner attestation signed
 *   here (`attestEnrolment`), exactly as Add terminal mints a till's;
 * - the delegation is signed HERE (`issuerDelegationTemplate` + the session signer).
 *
 * What leaves is signed artefacts and public data: the credential id and the signed delegation
 * event. Nothing here reads `privkeyHex()`, and `cardSalesEnrolment.test.ts` scans every request
 * body for key material.
 *
 * ## And the issuer's key never comes here
 *
 * The credential is locked to a key the purchase issuer generates and keeps (`begin` returns only
 * its public half), the same shape the operator script used. So nothing on this phone, or on the
 * wire, could sign as the issuer either.
 */
import {
  attestEnrolment,
  CREDENTIAL_LIFETIME_DAYS,
  mintTerminalCredential,
  ownerTransport,
  type MintTransport,
} from './terminalMint'
import { MAX_VALIDITY_DAYS } from '@imani/merchant-record'
import { issuerDelegationTemplate } from './issuerDelegation'
import { grantFor, TERMINAL_ROLES } from './terminalRole'
import { signedFetch, type RequestSigner } from './nip98'
import type { StallSigner } from './ownerAttestation'
import type { PreparedCredential } from './terminalIssue'

/** The purchase issuer's enrolment API, same-origin through the edge (and Vite's proxy in dev). */
export const CARD_SALES_PREFIX = '/api/v1/card-sales'
export const BEGIN_PATH = `${CARD_SALES_PREFIX}/enrolment/begin`
export const ENROL_PATH = `${CARD_SALES_PREFIX}/enrolment`
export const readyPath = (stallPubkey: string) => `${CARD_SALES_PREFIX}/ready/${encodeURIComponent(stallPubkey)}`

/**
 * The delegation's life (review of #302).
 *
 * The issuer refuses to mint, and `/ready` answers false, unless the delegation outlives a coupon
 * minted NOW for the stall's own term by `DELEGATION_SKEW_MARGIN_MS` (7 days). The operator
 * script's 380 days once kept a stall on sale for only EIGHT days after it enrolled, so the
 * delegation must cover the whole time the stall wants to sell plus the longest coupon minted at
 * its end: the credential sells for a year (`CREDENTIAL_LIFETIME_DAYS`), and since #312 a coupon's
 * life is the stall's term, which may be up to `MAX_VALIDITY_DAYS` (730). So 365 + 730 + 7.
 * Card sales then stay on for the credential's life whatever finite term the stall picks, and both
 * are renewed together by Set up card sales again. (A never-expiring term cannot be backed by any
 * finite delegation: `/ready` says so instead, `validity_never_expires`.)
 */
export const DELEGATION_LIFETIME_DAYS = CREDENTIAL_LIFETIME_DAYS + MAX_VALIDITY_DAYS + 7

/** The till name the credential carries, shown on the owner's own records. */
export const CARD_SALES_TERMINAL_NAME = 'Card sales'

/** What the issuer says about this stall. Mirrors `EnrolmentStatus` in purchase-issuer. */
export interface CardSalesStatus {
  enrolled: boolean
  confirmation: 'confirmed' | 'expired' | 'unconfirmed' | 'unknown' | null
  delegationExpiresAt: number | null
  delegationValid: boolean
  ready: boolean
  reason?: string
  /** Set for the reasons the stall fixes in its shop settings (#312). */
  reasonCode?: 'validity_never_expires' | 'validity_outlives_delegation' | 'validity_unknown'
}

export type CardSalesResult =
  | { kind: 'ok'; status: CardSalesStatus }
  | { kind: 'error'; reason: string }

/** Just the stall-side signing this needs. The session signer satisfies it. */
export type StallKey = StallSigner & RequestSigner

export interface EnrolDeps {
  signer: StallKey
  /** Requests to the purchase issuer, NIP-98 signed by `signer`. */
  call?: (path: string, method: string, body?: unknown) => Promise<Response>
  /** The credential mint at the gateway, also signed by the stall. */
  mint?: MintTransport
  /** Spends a credential that came back wrong. Optional: absent, a wrong one is reported, kept. */
  spendAtOnce?: (token: string) => Promise<boolean>
  now?: () => number
}

async function reason(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown }
    if (typeof body.error === 'string' && body.error !== '') return body.error
  } catch {
    // Not JSON.
  }
  return `${fallback} (${response.status})`
}

/** The stall's own status, from the issuer. Unknown on any failure, which the UI shows as such. */
export async function fetchCardSalesStatus(signer: RequestSigner): Promise<CardSalesResult> {
  try {
    const response = await signedFetch(ENROL_PATH, 'GET', undefined, signer)
    if (!response.ok) return { kind: 'error', reason: await reason(response, 'Could not check card sales') }
    return { kind: 'ok', status: (await response.json()) as CardSalesStatus }
  } catch {
    return { kind: 'error', reason: 'Could not reach the card-sales service. Check your connection.' }
  }
}

/**
 * Turn card sales on: begin, mint, delegate, enrol. Safe to run again: a second run replaces the
 * stall's one record with a fresh credential (the issuer's `vault.put`).
 */
export async function turnOnCardSales(deps: EnrolDeps): Promise<CardSalesResult> {
  const { signer } = deps
  const now = deps.now ?? (() => Date.now())
  const call = deps.call ?? ((path: string, method: string, body?: unknown) => signedFetch(path, method, body, signer))
  const stall = signer.pubkey.toLowerCase()

  // 1. A lock key, made by the issuer. Only its public half and its terminal proof come back.
  let begun: { lockPubkey?: unknown; enrolmentProof?: unknown }
  try {
    const response = await call(BEGIN_PATH, 'POST', {})
    if (!response.ok) return { kind: 'error', reason: await reason(response, 'Could not start card sales') }
    begun = (await response.json()) as typeof begun
  } catch {
    return { kind: 'error', reason: 'Could not reach the card-sales service. Nothing was set up.' }
  }
  const lock = typeof begun.lockPubkey === 'string' ? begun.lockPubkey.toLowerCase() : ''
  if (!/^[0-9a-f]{64}$/.test(lock) || typeof begun.enrolmentProof !== 'string') {
    return { kind: 'error', reason: 'The card-sales service answered something unexpected. Nothing was set up.' }
  }

  // 2. The credential, minted by THIS stall's key, locked to the issuer's, checked from its bytes.
  const prepared: PreparedCredential = {
    name: CARD_SALES_TERMINAL_NAME,
    stallPubkey: stall,
    role: TERMINAL_ROLES.ISSUE_AND_REDEEM,
    lockedTo: lock,
    permissions: grantFor(TERMINAL_ROLES.ISSUE_AND_REDEEM, stall),
    enrolmentProof: begun.enrolmentProof,
  }
  let credentialId: string
  try {
    const credential = { ...prepared, attestation: attestEnrolment(prepared, signer, now()) }
    const transport = deps.mint ?? ownerTransport
    const spend = deps.spendAtOnce ?? (async () => false)
    const minted = await mintTerminalCredential(credential, spend, transport, {
      idempotencyKey: crypto.randomUUID(),
    })
    credentialId = minted.voucherId
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The credential could not be made.'
    return { kind: 'error', reason: message.replace('Could not set up the terminal', 'Could not turn on card sales') }
  }

  // 3. The delegation: this stall says the issuer's key may issue for it, until then.
  const delegation = await signer.signEvent(
    issuerDelegationTemplate({
      delegatePubkey: lock,
      expiresAt: Math.floor(now() / 1000) + DELEGATION_LIFETIME_DAYS * 86_400,
    }),
  )

  // 4. Hand over the signed artefacts. The issuer confirms the credential before it seals it.
  try {
    const response = await call(ENROL_PATH, 'POST', { credentialId, delegation })
    if (!response.ok) return { kind: 'error', reason: await reason(response, 'Could not turn on card sales') }
    return { kind: 'ok', status: (await response.json()) as CardSalesStatus }
  } catch {
    return { kind: 'error', reason: 'Could not reach the card-sales service. Try again.' }
  }
}

/**
 * May a shopper be sent to pay this stall by card? Public, unauthenticated.
 *
 * FAILS SAFE: anything but an explicit `{ ready: true }` (a 404, a timeout, an older issuer, no
 * network) is "no". Taking money that nothing can issue is the failure this exists to prevent.
 */
export async function cardSalesReady(
  stallPubkey: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 5000,
): Promise<boolean> {
  return (await cardSalesReadiness(stallPubkey, fetchImpl, timeoutMs)) === 'ready'
}

/**
 * The same question, keeping the one reason a shopper can be told (#312): the stall's vouchers
 * never expire, and card sales need an expiry. Everything else that is not `ready` is plain
 * `not-ready`, failing safe exactly as `cardSalesReady` does.
 */
export async function cardSalesReadiness(
  stallPubkey: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 5000,
): Promise<'ready' | 'not-ready' | 'no-expiry'> {
  try {
    const response = await fetchImpl(readyPath(stallPubkey), { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) return 'not-ready'
    const body = (await response.json()) as { ready?: unknown; reason?: unknown }
    if (body.ready === true) return 'ready'
    return body.reason === 'validity_never_expires' ? 'no-expiry' : 'not-ready'
  } catch {
    return 'not-ready'
  }
}
