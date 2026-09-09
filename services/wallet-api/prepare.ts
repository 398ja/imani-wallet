/**
 * Preparing one part of a spend.
 *
 * This is the only place in the service where money moves, and the shape of
 * everything here follows from one fact: **the service cannot sign**. Wrapping
 * a NIP-17 gift wrap needs the customer's private key, which this service has
 * never held (ADR 0001), so it cannot deliver a send. It splits the coupon and
 * hands the caller an unsigned event to sign and publish (ADR 0002).
 *
 * That is a feature, not a limitation. A total compromise of this service
 * denies callers a wallet; it does not take their money, because there is no
 * code path here capable of spending.
 *
 * ## Why the caller signs the gateway call too
 *
 * The split runs on the gateway, behind NIP-98. The service does not hold a
 * credential of its own to present there — if it did, that credential would be
 * a way to split any coupon anyone sent it, which is the custody this design
 * refuses. Instead the caller signs the gateway request itself and passes that
 * header through. The service is a courier for a signature it cannot forge.
 *
 * ## The dangerous moment
 *
 * Between the gateway minting the replacements and the caller persisting them,
 * a caller that loses the response has lost coupons. Two consequences, both
 * load-bearing:
 *
 *  - the response carries EVERYTHING needed to recover in a single write, so
 *    there is no second call to lose;
 *  - a retry with the same idempotency key returns the first answer rather than
 *    splitting again, which the server's central `answer` already guarantees.
 */

import type { Parsed, FieldError } from './holding.js'

/** The gateway that performs the split. */
const GATEWAY_URL = process.env.WALLET_API_GATEWAY_URL ?? 'http://gateway-core:8081'

/**
 * How long to wait for the gateway.
 *
 * A split can involve a mint swap, which is slower than a read, so this is
 * generous compared with the relay lookup. Bounded regardless: an unbounded
 * wait on the money path is a caller's request hanging for as long as a broken
 * gateway holds a socket open.
 */
const GATEWAY_TIMEOUT_MS = Number(process.env.WALLET_API_GATEWAY_TIMEOUT_MS ?? 30_000)

/** The gateway path the caller must have signed. Exported so tests cannot drift from it. */
export const SPLIT_PATH = '/api/v1/atomic/vouchers/split'

/** The full URL a caller signs when preparing a part. */
export function splitUrl(): string {
  return `${GATEWAY_URL.replace(/\/$/, '')}${SPLIT_PATH}`
}

/**
 * What a caller asks for when preparing one part.
 *
 * One part, never a whole plan. A plan's parts are independent by design, so
 * one failing must strand nothing else — and the caller owns the retry loop,
 * which is correct, because the caller owns the coupons.
 */
export interface PrepareBody {
  /** The coupon being spent, as the caller holds it. */
  token: string
  /** Face value to send, in minor units. The remainder comes back as change. */
  amount: number
  /** Who the send is addressed to. */
  recipientPubkey: string
  /** The stall that issued this coupon, carried into the event for the recipient. */
  stallId?: string
  currency?: string
  decimals?: number
  /** The coupon's own id, so a caller can tie the answer back to its holding. */
  couponId?: string
  memo?: string
  /** Unix SECONDS, forwarded so the recipient's wallet can show a lifetime. */
  expiresAt?: number
  /**
   * The caller's own NIP-98 credential for the GATEWAY call, not for this one.
   *
   * A separate signature over a separate URL, because that is what NIP-98
   * means: a signature binds one key to one exact request. Reusing the header
   * that authenticated THIS request would present a credential signed for the
   * wallet API's URL to the gateway, which correctly refuses it.
   */
  gatewayAuthorization: string
}

function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value)
  if (typeof value === 'string') return `a string (${JSON.stringify(value)})`
  return `a ${typeof value}`
}

const bad = (field: string, detail: string): { ok: false; error: FieldError } => ({
  ok: false,
  error: { field, detail },
})

export function parsePrepareRequest(body: unknown): Parsed<PrepareBody> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return bad('body', `expected a JSON object, got ${describe(body)}`)
  }
  const fields = body as Record<string, unknown>

  const token = fields.token
  if (typeof token !== 'string' || token.length === 0) {
    return bad('token', token === undefined ? 'is required' : `expected a non-empty string, got ${describe(token)}`)
  }

  const amount = fields.amount
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    return bad('amount', amount === undefined ? 'is required' : `expected a finite number, got ${describe(amount)}`)
  }
  // The same rule as the plan: minor units are whole. Flooring a fractional
  // amount here would send the wrong money, and this endpoint moves it.
  if (!Number.isInteger(amount)) {
    return bad(
      'amount',
      `expected a whole number of minor units, got ${amount}. Amounts are in cents, not euros.`,
    )
  }
  if (amount <= 0) return bad('amount', `expected a positive amount, got ${amount}`)

  const recipient = fields.recipientPubkey
  if (typeof recipient !== 'string' || recipient.length === 0) {
    return bad(
      'recipientPubkey',
      recipient === undefined ? 'is required' : `expected a non-empty string, got ${describe(recipient)}`,
    )
  }
  // Checked here rather than left to the relay for the same reason as the plan:
  // a malformed key is a send addressed to nobody, and the coupons inside it
  // are gone. This endpoint is where that becomes irreversible.
  if (!/^[0-9a-f]{64}$/i.test(recipient)) {
    return bad('recipientPubkey', 'expected a 64-character hex public key')
  }

  const auth = fields.gatewayAuthorization
  if (typeof auth !== 'string' || auth.trim().length === 0) {
    return bad(
      'gatewayAuthorization',
      auth === undefined
        ? `is required — sign ${SPLIT_PATH} with your own key; this service holds no credential of its own`
        : `expected a non-empty string, got ${describe(auth)}`,
    )
  }

  for (const field of ['stallId', 'currency', 'couponId', 'memo'] as const) {
    const value = fields[field]
    if (value !== undefined && value !== null && typeof value !== 'string') {
      return bad(field, `expected a string, got ${describe(value)}`)
    }
  }

  for (const field of ['decimals', 'expiresAt'] as const) {
    const value = fields[field]
    if (value !== undefined && value !== null && (typeof value !== 'number' || !Number.isFinite(value))) {
      return bad(field, `expected a finite number, got ${describe(value)}`)
    }
  }

  const str = (name: keyof PrepareBody) => {
    const v = fields[name as string]
    return typeof v === 'string' ? v : undefined
  }
  const num = (name: keyof PrepareBody) => {
    const v = fields[name as string]
    return typeof v === 'number' ? v : undefined
  }

  return {
    ok: true,
    value: {
      token,
      amount,
      recipientPubkey: recipient.toLowerCase(),
      stallId: str('stallId'),
      currency: str('currency'),
      decimals: num('decimals'),
      couponId: str('couponId'),
      memo: str('memo'),
      expiresAt: num('expiresAt'),
      gatewayAuthorization: auth,
    },
  }
}

/** The gateway's split answer, in the fields this service reads. */
export interface SplitResult {
  send_token: string
  keep_token?: string | null
  send_face_value: number
  keep_face_value: number
  send_token_amount?: number
  keep_token_amount?: number
  is_full_send?: boolean
  sent_voucher_id?: string | null
  issuer_id?: string | null
  face_unit?: string | null
  face_decimals?: number | null
  swap_performed?: boolean
}

export type SplitOutcome =
  | { ok: true; split: SplitResult }
  | { ok: false; status: number; code: string; detail: string }

/**
 * Ask the gateway to split, presenting the CALLER's signature.
 *
 * The exact body the caller signed must be sent byte for byte, so this
 * serialises once and posts that string. Re-serialising with a different key
 * order produces a different payload hash and the gateway refuses the request
 * — the same rule this service applies to its own callers.
 */
export async function requestSplit(
  request: PrepareBody,
  fetchImpl: typeof fetch = fetch,
): Promise<SplitOutcome> {
  const body = splitBody(request)

  let response: Response
  try {
    response = await fetchImpl(splitUrl(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // The caller's own credential, forwarded verbatim. This service has
        // none to substitute, which is the whole security argument.
        authorization: request.gatewayAuthorization,
      },
      body,
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
    })
  } catch (error) {
    // Unreachable, refused, or timed out. NOTHING was split, so the caller's
    // holding is untouched — and saying that plainly is what stops a caller
    // from treating an outage as a lost coupon and reconciling against a
    // gateway that never moved.
    return {
      ok: false,
      status: 502,
      code: 'gateway-unreachable',
      detail: `The gateway could not be reached (${error instanceof Error ? error.message : String(error)}). Nothing was split and your holding is unchanged.`,
    }
  }

  const text = await response.text()

  if (!response.ok) {
    let detail = text.slice(0, 500)
    let code = 'gateway-refused'
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>
      if (typeof parsed.error_message === 'string') detail = parsed.error_message
      if (typeof parsed.error_code === 'string') code = `gateway-${parsed.error_code.toLowerCase()}`
    } catch {
      // Not JSON. The raw text, truncated, is more use than "gateway error".
    }
    // 401 and 403 are passed through as 401: the caller's own signature was
    // refused, and this service has no way to fix that by trying harder.
    const status = response.status === 401 || response.status === 403 ? 401 : 502
    return {
      ok: false,
      status,
      code,
      detail: `${detail} Nothing was split and your holding is unchanged.`,
    }
  }

  let split: SplitResult
  try {
    split = JSON.parse(text) as SplitResult
  } catch {
    return {
      ok: false,
      status: 502,
      code: 'gateway-unreadable',
      detail: 'The gateway answered with something that is not JSON. Your holding may have changed; re-read it before retrying.',
    }
  }

  // A split that answers 200 without a send token has moved the coupon and
  // told us nothing about where it went. Refusing to build an event around
  // `undefined` is the difference between a caller seeing an error and a
  // caller publishing a send containing no money.
  if (typeof split.send_token !== 'string' || split.send_token.length === 0) {
    return {
      ok: false,
      status: 502,
      code: 'gateway-incomplete',
      detail: 'The gateway reported success but returned no send token. Re-read your holding before retrying: the coupon may already have been split.',
    }
  }

  return { ok: true, split }
}

/**
 * The exact JSON the caller must sign for the gateway.
 *
 * Exported and used by BOTH sides — the caller hashes this to sign, the service
 * posts this to the gateway. One function, so the two cannot drift; two would
 * differ by a key order one day and every prepare would fail as
 * `payload-mismatch` with nothing visibly wrong.
 *
 * **The memo is deliberately absent**, though the gateway's split accepts one.
 * The memo belongs to the message, not to the division of a coupon, and it is
 * carried in the rumor where the recipient actually reads it. Including it here
 * would put a field in the signed body that the caller supplies at prepare
 * time, so a caller that signed without a memo and then sent one would be
 * refused for a payload mismatch — which is exactly the failure this endpoint
 * exists to make impossible. Found by running it, not by reasoning about it.
 *
 * The signed body therefore depends only on the token and the amount, both of
 * which the caller must have decided before it can sign at all.
 */
export function splitBody(request: { token: string; amount: number }): string {
  return JSON.stringify({
    token: request.token,
    send_face_value: request.amount,
  })
}

/**
 * An UNSIGNED NIP-17 rumor, addressed to the recipient and carrying the part.
 *
 * A rumor is an event with no `id`, no `pubkey` and no `sig` — the inner layer
 * of a gift wrap. It is the most this service can build, and deliberately so:
 *
 *  - the SEAL (kind 13) is encrypted to a conversation key derived from the
 *    sender's private key, so producing one is signing;
 *  - the WRAP (kind 1059) is signed by a throwaway key, and a service that
 *    generated it would be generating keys on the money path.
 *
 * The caller passes this to `nip17.wrapEvent`, or seals and wraps it by hand.
 * Either way the customer's key is used only on the customer's machine.
 *
 * `created_at` is deliberately absent along with the rest: a timestamp minted
 * here would be the service's clock, and NIP-59 wants the SENDER's — randomised
 * against timing analysis, which is a decision belonging to whoever publishes.
 */
export interface UnsignedRumor {
  kind: 14
  content: string
  tags: string[][]
}

export function buildRumor(request: PrepareBody, split: SplitResult, senderPubkey: string): UnsignedRumor {
  /**
   * The payload shape is the gateway's own `TokenTransferMessage`, snake_case,
   * because that is what a receiving wallet parses. Matching the SENDER-side
   * camelCase type instead yields a DM that unwraps to a coupon with no issuer,
   * no face value and no currency — a message that arrives and is worth nothing.
   */
  const payload: Record<string, unknown> = {
    type: 'cashu_token_transfer',
    version: '1.0',
    token: split.send_token,
    amount_hint: split.send_token_amount ?? undefined,
    face_value: split.send_face_value,
    face_unit: split.face_unit ?? request.currency,
    face_decimals: split.face_decimals ?? request.decimals,
    issuer_id: split.issuer_id ?? request.stallId,
    voucher_id: split.sent_voucher_id ?? request.couponId,
    // The sender's own key, as this service verified it. Not taken from the
    // request body: a caller could then address a send as somebody else, and
    // the recipient's wallet shows this as who paid.
    sender_pubkey: senderPubkey,
    memo: request.memo ?? null,
    expires_at: request.expiresAt ?? null,
  }

  // Undefined fields are dropped rather than serialised as null. The receiving
  // wallet distinguishes "absent" from "explicitly nothing" for expiry, and a
  // null face_unit would group the arrival under a currency called "null".
  for (const key of Object.keys(payload)) {
    if (payload[key] === undefined) delete payload[key]
  }

  return {
    kind: 14,
    content: JSON.stringify(payload),
    // The `p` tag is what addresses the rumor. A wrap without it reaches the
    // relay and nobody: the recipient's subscription filters on this tag.
    tags: [['p', request.recipientPubkey]],
  }
}
