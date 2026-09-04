/**
 * Issuing a coupon, and delivering it.
 *
 * API tickets 03 and 04. Two phases with a real seam between them: a coupon can
 * be issued and undelivered, and that state is recoverable only if the caller
 * is told about it. The app already handles this — its error names the voucher
 * so it can be found by hand — and an API that hid delivery inside issuance
 * would turn a recoverable state into a silent loss of value.
 *
 * ## The path matters, and it is not the one the app uses
 *
 * Issuance couriers through `/api/v1/wallet/vouchers` on customer-wallet, NOT
 * `/api/v1/portal/vouchers`. Measured: an unregistered keypair signing NIP-98
 * for itself gets **201** on the wallet path and **500** on the portal path.
 * The portal is authorised by a session cookie validated against account-app,
 * with a shared secret the browser never sees, so no headless caller can
 * satisfy it. An implementer following `src/lib/issue.ts` would walk straight
 * into that, which is why it is named here and in the README.
 */

type Parsed<T> = { ok: true; value: T } | { ok: false; error: { field: string; detail: string } }

const fail = (field: string, detail: string): Parsed<never> => ({ ok: false, error: { field, detail } })

function describe(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'an array'
  return typeof v
}

const HEX64 = /^[0-9a-f]{64}$/i

/**
 * Where issuance happens: customer-wallet, the same host redemption uses.
 *
 * Shares `WALLET_API_CUSTOMER_URL` with the redeem courier deliberately — they
 * are the same service, and two variables would be two things to get wrong in
 * a deployment.
 */
const CUSTOMER_URL = process.env.WALLET_API_CUSTOMER_URL ?? 'http://gateway-customer:8082'

/** Exported so a test cannot drift from what callers are told to sign. */
export const ISSUE_PATH = '/api/v1/wallet/vouchers'
export const DELIVER_PATH = '/api/v1/dm/tokens/send'

export function issueUrl(): string {
  return `${CUSTOMER_URL.replace(/\/$/, '')}${ISSUE_PATH}`
}

export function deliverUrl(): string {
  return `${CUSTOMER_URL.replace(/\/$/, '')}${DELIVER_PATH}`
}

/**
 * The relay the GATEWAY can reach, which is not the one a browser can.
 *
 * `src/lib/relay.ts` reads this from `import.meta.env`, which is a Vite global
 * no Node service has, so it is an ordinary environment variable here. The
 * distinction it draws still applies: the gateway publishes from inside the
 * compose network, where `localhost` is its own container.
 */
export function relayUrls(): string[] {
  return [process.env.WALLET_API_INTERNAL_RELAY_URL ?? 'ws://nostr-relay:7777']
}

export interface IssuePlan {
  faceValue: number
  faceUnit: string
  faceDecimals: number
  issuerId: string
  memo?: string
  expiresInDays: number
}

/** A month, matching what the Sell screen offers by default. */
const DEFAULT_EXPIRY_DAYS = 30

export function parseIssueRequest(body: unknown, callerPubkey: string): Parsed<IssuePlan> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return fail('body', `expected a JSON object, got ${describe(body)}`)
  }
  const b = body as Record<string, unknown>

  const faceValue = Number(b.faceValue ?? b.face_value)
  if (!Number.isFinite(faceValue) || faceValue <= 0) {
    return fail('faceValue', 'expected a number greater than zero, in minor units')
  }
  if (!Number.isInteger(faceValue)) {
    // A fraction means cents were wanted and euros were sent. Rounding would
    // issue a coupon for the wrong money.
    return fail('faceValue', 'expected a whole number of minor units')
  }

  const faceUnit = typeof (b.faceUnit ?? b.face_unit) === 'string' ? String(b.faceUnit ?? b.face_unit) : ''
  if (!faceUnit) return fail('faceUnit', 'required')

  const rawDecimals = b.faceDecimals ?? b.face_decimals ?? 0
  const faceDecimals = Number(rawDecimals)
  if (!Number.isInteger(faceDecimals) || faceDecimals < 0 || faceDecimals > 8) {
    return fail('faceDecimals', 'expected a whole number between 0 and 8')
  }

  /**
   * The issuer is the SIGNING key, and cannot be overridden.
   *
   * A coupon names the stall that honours it. Letting a caller stamp someone
   * else's key would mint a claim against a stall that never agreed to it —
   * and the customer holding it would find out at the counter.
   *
   * Refused rather than ignored, for the same reason as in payment requests:
   * an integrator should learn this at the first call.
   */
  for (const forbidden of ['issuerId', 'issuer_id', 'stallPubkey']) {
    if (b[forbidden] !== undefined && String(b[forbidden]).toLowerCase() !== callerPubkey.toLowerCase()) {
      return fail(
        forbidden,
        'a coupon always names the signing key as issuer — a coupon claiming another stall could not be honoured',
      )
    }
  }

  if (!HEX64.test(callerPubkey)) {
    return fail('authorization', 'the signing key is not a 64-character hex pubkey')
  }

  const expiresInDays = Number(b.expiresInDays ?? b.expires_in_days ?? DEFAULT_EXPIRY_DAYS)
  if (!Number.isInteger(expiresInDays) || expiresInDays <= 0) {
    return fail('expiresInDays', 'expected a whole number of days greater than zero')
  }

  const memo = typeof b.memo === 'string' ? b.memo.trim() : ''

  return {
    ok: true,
    value: {
      faceValue,
      faceUnit,
      faceDecimals,
      issuerId: callerPubkey,
      memo: memo || undefined,
      expiresInDays,
    },
  }
}

/**
 * The exact body to sign, serialised ONCE.
 *
 * Snake_case because that is what the gateway reads. NIP-98 commits to a
 * sha256 of these bytes, so a caller that rebuilds this object with a different
 * key order gets a different hash and a refusal from a host it never addressed
 * directly.
 */
export function issueBody(plan: IssuePlan): string {
  return JSON.stringify({
    face_value: plan.faceValue,
    face_unit: plan.faceUnit,
    face_decimals: plan.faceDecimals,
    backing_strategy: 'PROPORTIONAL',
    issuer_id: plan.issuerId,
    memo: plan.memo ?? '',
    expires_in_days: plan.expiresInDays,
  })
}

export interface DeliverInput {
  recipientPubkey: string
  token: string
  voucherId: string
  faceValue: number
  faceUnit: string
  faceDecimals: number
  senderPubkey: string
  memo?: string
  expiresAt?: number
}

export function parseDeliverRequest(body: unknown, callerPubkey: string): Parsed<DeliverInput> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return fail('body', `expected a JSON object, got ${describe(body)}`)
  }
  const b = body as Record<string, unknown>

  const recipientPubkey = typeof b.recipientPubkey === 'string' ? b.recipientPubkey : ''
  if (!HEX64.test(recipientPubkey)) {
    return fail('recipientPubkey', 'expected 64 hex characters — who is being handed the coupon')
  }

  const token = typeof b.token === 'string' ? b.token.trim() : ''
  if (!token) return fail('token', 'required — the coupon to deliver')

  const voucherId = typeof b.voucherId === 'string' ? b.voucherId : ''
  if (!voucherId) {
    // Required rather than optional: it is how a caller finds a coupon that was
    // issued and not delivered, which is the whole reason these are two calls.
    return fail('voucherId', 'required — it is how an undelivered coupon is found again')
  }

  const faceValue = Number(b.faceValue)
  if (!Number.isFinite(faceValue)) return fail('faceValue', 'expected a finite number')

  const faceUnit = typeof b.faceUnit === 'string' ? b.faceUnit : ''
  if (!faceUnit) return fail('faceUnit', 'required')

  const faceDecimals = Number(b.faceDecimals ?? 0)
  if (!Number.isInteger(faceDecimals)) return fail('faceDecimals', 'expected a whole number')

  /**
   * The sender is the STALL, whichever device is calling.
   *
   * A customer must hold a coupon from a stall they can look up, not from a
   * till that may not exist next week — the same rule terminals ticket 02
   * settled for the app. Over HTTP the equivalent is refusing to read it from
   * the body.
   */
  for (const forbidden of ['senderPubkey', 'sender_pubkey', 'issuerId', 'issuer_id']) {
    if (b[forbidden] !== undefined && String(b[forbidden]).toLowerCase() !== callerPubkey.toLowerCase()) {
      return fail(forbidden, 'a delivered coupon always names the signing key as its stall')
    }
  }

  const expiresAt = b.expiresAt === undefined ? undefined : Number(b.expiresAt)
  if (expiresAt !== undefined && !Number.isFinite(expiresAt)) {
    return fail('expiresAt', 'expected epoch SECONDS')
  }

  return {
    ok: true,
    value: {
      recipientPubkey,
      token,
      voucherId,
      faceValue,
      faceUnit,
      faceDecimals,
      senderPubkey: callerPubkey,
      memo: typeof b.memo === 'string' ? b.memo : undefined,
      expiresAt,
    },
  }
}

/**
 * The delivery body, serialised once.
 *
 * `expires_at` is epoch SECONDS — the gateway forwards whatever the sender
 * supplies, so omitting it leaves the received coupon with a blank expiry, and
 * sending milliseconds would date it fifty thousand years out.
 *
 * `issuer_id` and `sender_pubkey` are both the stall. A terminal's own key
 * never appears on a coupon.
 */
export function deliverBody(input: DeliverInput, relayUrls: string[]): string {
  return JSON.stringify({
    recipient_pubkey: input.recipientPubkey,
    token: input.token,
    memo: input.memo ?? '',
    voucher_id: input.voucherId,
    face_value: input.faceValue,
    face_unit: input.faceUnit,
    face_decimals: input.faceDecimals,
    issuer_id: input.senderPubkey,
    sender_pubkey: input.senderPubkey,
    expires_at: input.expiresAt,
    relay_urls: relayUrls,
  })
}
