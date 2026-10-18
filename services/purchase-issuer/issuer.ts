/**
 * Issuing a coupon for a purchase, as the stall, with nobody in the loop.
 *
 * A customer pays a stall by card. Stripe confirms it, an Obligation is
 * recorded, and this mints the coupon and hands it over. The stall is asleep.
 *
 * ## Why this is a separate service from `wallet-api`
 *
 * `wallet-api` holds no key and signs nothing: ADR 0001 and 0002 are the reason
 * a public spending endpoint is defensible at all. This service is the opposite
 * shape — it holds one issuing credential per stall and signs with them — so it
 * must be visibly a different thing rather than an endpoint on that one. Two
 * services, two postures, no ambiguity about which property applies where.
 *
 * It is a **caller** in the precise sense the glossary gives that word: a
 * program holding the key and doing its own signing, using the plan-then-sign
 * seam ADR 0002 describes as where a caller inserts its own policy.
 *
 * ## What it does NOT do
 *
 * **It does not gift-wrap.** That was my assumption and it was wrong. Only
 * `gateway-customer` builds NIP-17 wraps; this POSTs to `/api/v1/dm/tokens/send`
 * and the gateway wraps. So there is no NIP-44 or NIP-17 code here at all, and
 * the service is much smaller than "an autonomous Nostr issuer" suggests.
 *
 * **It does not decide what is owed.** `payment-adapter` records that a purchase
 * was paid; this reads those records and discharges them. Recording and
 * discharging are deliberately different jobs in different services, because the
 * first must be transactional with a webhook and the second must be able to take
 * its time and retry.
 *
 * ## The behaviour worth copying from `imani-woo`
 *
 * `AutonomousIssuance` has run this against a real shop, and three things it
 * learned are carried here rather than rediscovered:
 *
 * - **Minting is asynchronous.** A voucher id comes back in ~250ms and the token
 *   about 1.5s later. Waiting briefly is worth it; waiting forever is not.
 * - **No credential is silence, not an error.** A stall that never enrolled is
 *   the ordinary case, and warning on every sale trains people to ignore logs.
 * - **A failure leaves the debt standing, with a reason.** Never a silent drop,
 *   and never a discharge on anything short of confirmation.
 */

import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils'
import { sha256 } from '@noble/hashes/sha256'

/** The header the gateway reads a terminal credential from. */
export const CREDENTIAL_HEADER = 'X-Imani-Terminal-Credential'

/**
 * The header the gateway's voucher-create replay store is keyed on,
 * namespaced there by caller.
 */
export const IDEMPOTENCY_HEADER = 'Idempotency-Key'

/**
 * Where issuance happens: customer-wallet, NOT the portal.
 *
 * `wallet-api`'s `issue.ts` names this trap and it is worth repeating where
 * somebody might follow the app instead: an unregistered keypair signing NIP-98
 * for itself gets 201 on `/api/v1/wallet/vouchers` and 500 on
 * `/api/v1/portal/vouchers`, because the portal wants a session cookie no
 * headless caller can produce.
 */
export const ISSUE_PATH = '/api/v1/wallet/vouchers'
export const DELIVER_PATH = '/api/v1/dm/tokens/send'

/**
 * How long a mint request may take. Well inside the purchase claim's lease
 * (payment-adapter `purchase.claim.lease-seconds`, 600 s by default), so a
 * slow mint is abandoned long before another worker could take the row.
 */
export const ISSUE_TIMEOUT_MS = 30_000

/**
 * How long a coupon bought by card stays spendable.
 *
 * A year, matching the gateway's default for merchant issuance and `imani-woo`.
 * Long enough that a gift bought at Christmas is still good the next one.
 */
export const DEFAULT_EXPIRES_IN_DAYS = 365

/** One stall's authority to be issued for, held on its behalf. */
export interface StallCredential {
  /** The stall this issues as. */
  stallPubkey: string
  /** The credential's voucher id. Travels in a header; not a secret. */
  credentialId: string
  /**
   * The private key the credential is LOCKED to, hex.
   *
   * This is the secret. The credential id proves nothing on its own: the
   * gateway checks a NIP-98 signature from the key the credential names.
   */
  lockKeyHex: string
  /**
   * The stall's signed delegation of `coupon:issue` to `lockKeyHex`'s public
   * key, as kind-30078 event JSON (imani-wallet#152). Without it this service
   * cannot sign a warrant the till accepts, so it mints nothing.
   * See `delegatedWarrant.ts`.
   */
  delegation?: string
  /**
   * Set, in memory only, when the gateway will never accept this credential and the stall must
   * re-enrol it (imani-wallet#296: confirm answered 410 EXPIRED). A sale fails fast with this as
   * its reason instead of minting into a 403 that reads as "burnt or replaced". Never sealed.
   */
  unusable?: string
}

export interface IssuePlan {
  faceValue: number
  faceUnit: string
  faceDecimals: number
  memo: string
  expiresInDays: number
  /**
   * Sent as `Idempotency-Key` (imani-wallet#96). The same purchase always
   * mints under the same key, so a retry after a crash between the mint and
   * the discharge gets the ORIGINAL coupon back from a gateway that honours
   * it, rather than a second coupon for one payment.
   */
  idempotencyKey?: string
  /**
   * The issuance warrant JSON, carried verbatim into the coupon's signed
   * bytes. See `delegatedWarrant.ts`.
   */
  issuanceWarrant?: string
}

/**
 * The key a purchase mints under: the PAYMENT INTENT, not the webhook event (imani-wallet#274,
 * card audit U8). Two events for one payment, or a reconciler re-drive, are one payment and must
 * mint under one key. gc#232 replays the recorded voucher for the warrant nonce (also from the
 * pi_) after the 24 h idempotency window, so this key is no longer the only guard.
 */
export function purchaseIdempotencyKey(paymentIntent: string): string {
  return `purchase:pi:${paymentIntent}`
}

export interface IssuedCoupon {
  voucherId: string
  issuerId: string
  /** Empty while the mint is still working. See `waitForToken`. */
  token: string
}

/** Why an issuance did not happen, in terms an operator can act on. */
export class IssuanceFailed extends Error {
  /** True when retrying could plausibly succeed. */
  readonly retryable: boolean
  /**
   * True when the gateway may have minted despite the failure: the request
   * could not be confirmed either way (unreachable, timeout, 5xx, a 2xx with
   * an unreadable body). False for a definite refusal (4xx).
   */
  readonly ambiguous: boolean
  /**
   * gc answered 409 UNRECORDED (gc#230/#232): this warrant nonce was spent by a run that never
   * recorded its voucher. Whether a coupon exists is unknown, so this is NEVER retried: the row
   * is parked `gateway_unrecorded` for a person (imani-wallet#274).
   */
  readonly unrecorded: boolean

  constructor(message: string, retryable: boolean, ambiguous = retryable, unrecorded = false) {
    super(message)
    this.name = 'IssuanceFailed'
    this.retryable = retryable
    this.ambiguous = ambiguous
    this.unrecorded = unrecorded
  }
}

/**
 * A NIP-98 Authorization header for one request.
 *
 * Signed with the credential's lock key, which is what the gateway checks
 * before deriving the issuer from the credential id.
 */
export function authorization(
  method: string,
  url: string,
  body: string,
  lockKeyHex: string,
): string {
  const event = finalizeEvent(
    {
      kind: 27235,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['u', url],
        ['method', method.toUpperCase()],
        ['payload', bytesToHex(sha256(new TextEncoder().encode(body)))],
        // A random nonce so two requests signed in the same second are two events (#296). Without
        // it a retry inside one second re-sent the identical event, and the gateway refused it as
        // an event-id replay (401). NIP-98 allows extra tags; the filter ignores this one.
        ['nonce', bytesToHex(randomBytes(16))],
      ],
      content: '',
    },
    hexToBytes(lockKeyHex),
  )
  return `Nostr ${btoa(JSON.stringify(event))}`
}

/**
 * The issuance request body.
 *
 * **No `issuer_id`.** The gateway derives it from the credential, so a value
 * here could only agree or be refused — stating something we are not the
 * authority on.
 */
export function issueBody(plan: IssuePlan): string {
  return JSON.stringify({
    face_value: plan.faceValue,
    face_unit: plan.faceUnit,
    face_decimals: plan.faceDecimals,
    /**
     * PROPORTIONAL, not MINIMAL, and the difference is whether the coupon can
     * be spent at all.
     *
     * Backing decides granularity. Measured on a live gateway for one £25
     * coupon: MINIMAL gives token_amount=10, ratio=250, so £2.50 steps;
     * PROPORTIONAL gives 2500, ratio=1, so £0.01 steps. A split floors to the
     * ratio, so a MINIMAL £25 coupon paying a £10.75 basket splits to £10.00,
     * the gateway refuses the mismatch, and the send lands in SPLIT_ERROR — a
     * state the wallet cannot reclaim from.
     *
     * `imani-woo` shipped MINIMAL, a customer paying £10.75 found it, and this
     * comment exists so the next implementation does not find it again.
     */
    backing_strategy: 'PROPORTIONAL',
    memo: plan.memo,
    expires_in_days: plan.expiresInDays,
    ...(plan.issuanceWarrant ? { issuance_warrant: plan.issuanceWarrant } : {}),
  })
}

/** Mint one coupon as the stall. */
export async function issueAsStall(
  baseUrl: string,
  credential: StallCredential,
  plan: IssuePlan,
  fetchImpl: typeof fetch = fetch,
): Promise<IssuedCoupon> {
  const url = `${baseUrl.replace(/\/$/, '')}${ISSUE_PATH}`
  const body = issueBody(plan)

  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authorization('POST', url, body, credential.lockKeyHex),
        [CREDENTIAL_HEADER]: credential.credentialId,
        ...(plan.idempotencyKey ? { [IDEMPOTENCY_HEADER]: plan.idempotencyKey } : {}),
      },
      body,
      // Bounded (imani-wallet#96 review). A hung gateway otherwise holds the
      // worker, and the purchase's claim, indefinitely. A timeout is an
      // AMBIGUOUS failure: the claim is left to lapse, and the retry after it
      // goes out under the same idempotency key.
      signal: AbortSignal.timeout(ISSUE_TIMEOUT_MS),
    })
  } catch (error) {
    // Unreachable is retryable: the money is already taken, so the debt stands
    // and a later attempt is the right answer.
    throw new IssuanceFailed(
      error instanceof Error ? error.message : 'could not reach the gateway',
      true,
    )
  }

  const raw = await response.text()

  if (isUnrecorded(response.status, raw)) {
    throw new IssuanceFailed(explain(response.status, raw), false, true, true)
  }

  if (response.status !== 200 && response.status !== 201) {
    // A 4xx (429 included) is a refusal: nothing was minted. A 5xx may have
    // minted before failing.
    throw new IssuanceFailed(
      explain(response.status, raw),
      isRetryableStatus(response.status),
      response.status >= 500,
    )
  }

  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch {
    throw new IssuanceFailed('the gateway returned something that was not JSON', true)
  }

  if (decoded === null || typeof decoded !== 'object') {
    throw new IssuanceFailed('the gateway returned no voucher', true)
  }

  const record = decoded as Record<string, unknown>
  const voucherId = typeof record.voucher_id === 'string' ? record.voucher_id : ''
  if (voucherId === '') {
    throw new IssuanceFailed('the gateway accepted the request but returned no voucher', true)
  }

  return {
    voucherId,
    issuerId: typeof record.issuer_id === 'string' ? record.issuer_id : '',
    token: typeof record.token === 'string' ? record.token : '',
  }
}

/**
 * Turn a refusal into something an operator can act on.
 *
 * A 403 here almost always means the credential was burnt or re-issued, which
 * is a stall's deliberate act rather than a fault, and it must not be retried
 * forever against a door that is now closed.
 */
function explain(status: number, raw: string): string {
  if (status === 401) {
    return 'the gateway did not accept this credential’s signature'
  }
  if (status === 403) {
    // Also what an UNCONFIRMED credential gets (gc `issuer_not_permitted`), e.g. one that expired
    // before it was confirmed (#296). Confirming at enrolment and startup makes that rare, and an
    // expired one is caught before the mint with its own reason (`confirmation.ts`).
    return (
      'the stall no longer authorises this issuer (credential burnt, replaced, or never ' +
      'confirmed; check imani_purchase_issuer_credentials and re-enrol if expired)'
    )
  }
  const detail = raw.trim().slice(0, 200)
  return detail === ''
    ? `the gateway refused with status ${status}`
    : `the gateway refused with status ${status}: ${detail}`
}

/**
 * gc refused this payment's mint in a way every later retry gets too, and an earlier attempt may
 * have minted (review of #279). Parked `gateway_unrecorded`, never retried:
 *  - 409 `UNRECORDED`: the warrant nonce's first use never recorded its voucher (gc#232). The
 *    same test also matches the idempotency store's `IDEMPOTENCY_PREVIOUS_ATTEMPT_UNRECORDED`.
 *  - 409 `WARRANT_ALREADY_USED`: the pi_ nonce was spent by a request with DIFFERENT bytes. A
 *    retry's body changes when the stall renews its delegation between attempts (the delegation
 *    rides inside the warrant). Before this it was retryable, so the row looped forever.
 *  - 422 `IDEMPOTENCY_KEY_REUSED`: the same case inside gc's 24 h key window.
 */
function isUnrecorded(status: number, raw: string): boolean {
  if (status === 409) return /UNRECORDED|WARRANT_ALREADY_USED/.test(raw)
  if (status === 422) return /IDEMPOTENCY_KEY_REUSED/.test(raw)
  return false
}

/** A burnt credential will never succeed; a 500 might. */
function isRetryableStatus(status: number): boolean {
  return status !== 401 && status !== 403 && status !== 400
}

export { getPublicKey }
