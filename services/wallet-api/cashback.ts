/**
 * Cashback: generating a code, looking one up, and claiming it.
 *
 * API ticket 08. Couriers, like issuance — the service returns bytes to sign
 * and never calls the portal itself.
 *
 * ## The correction this ticket rests on
 *
 * The ticket originally recorded cashback as blocked, on the grounds that it
 * demands an API key that ADR 0001 forbids this service from holding. That came
 * from probing `/api/v1/cashback/generate` on **gateway-core**, which does
 * answer `401 API key required` — and is not the endpoint the app uses.
 *
 * The real one is `/api/v1/portal/cashback/generate` on the **portal**, which
 * already sits under `PortalSecurityConfiguration`'s NIP-98 protected prefix.
 * Confirmed against a freshly built portal: a signed request reaches field
 * validation (400 naming `amountMinor`, `unit`, `idempotencyKey`), which it
 * could not do behind an API-key filter.
 *
 * ## Two reads that stay public, deliberately
 *
 * `/public/{claimRef}` and `/by-code/{code}` are exempt from NIP-98 in the
 * portal's own configuration, and that is right rather than an oversight: a
 * customer redeeming a code holds no key of ours. So the lookup endpoint here
 * returns a plain URL to fetch, with no signature to make.
 */

type Parsed<T> = { ok: true; value: T } | { ok: false; error: { field: string; detail: string } }

const fail = (field: string, detail: string): Parsed<never> => ({ ok: false, error: { field, detail } })

function describe(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'an array'
  return typeof v
}

/**
 * The portal, which is neither gateway-core nor customer-wallet.
 *
 * A third host, and it has to be: cashback lives here and nowhere else. The
 * 404 that made this ticket look blocked came from asking customer-wallet.
 */
const PORTAL_URL = process.env.WALLET_API_PORTAL_URL ?? 'http://gateway-portal:8084'

export const GENERATE_PATH = '/api/v1/portal/cashback/generate'
export const BY_CODE_PATH = '/api/v1/portal/cashback/by-code'
export const PUBLIC_PATH = '/api/v1/portal/cashback/public'

const portal = (path: string) => `${PORTAL_URL.replace(/\/$/, '')}${path}`

export const generateUrl = () => portal(GENERATE_PATH)
export const byCodeUrl = (code: string) => `${portal(BY_CODE_PATH)}/${encodeURIComponent(code)}`
export const publicUrl = (claimRef: string) => `${portal(PUBLIC_PATH)}/${encodeURIComponent(claimRef)}`

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface GenerateInput {
  amountMinor: number
  unit: string
  memo?: string
  idempotencyKey: string
  expiryDays?: number
}

export function parseGenerateRequest(body: unknown): Parsed<GenerateInput> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return fail('body', `expected a JSON object, got ${describe(body)}`)
  }
  const b = body as Record<string, unknown>

  const amountMinor = Number(b.amountMinor)
  if (!Number.isFinite(amountMinor) || amountMinor <= 0) {
    return fail('amountMinor', 'expected a number greater than zero, in minor units')
  }
  if (!Number.isInteger(amountMinor)) {
    return fail('amountMinor', 'expected a whole number of minor units')
  }

  const unit = typeof b.unit === 'string' ? b.unit.trim() : ''
  if (!unit) return fail('unit', 'required')
  if (unit.length > 8) return fail('unit', 'expected at most 8 characters')

  const memo = typeof b.memo === 'string' ? b.memo.trim() : ''
  if (memo.length > 280) return fail('memo', 'expected at most 280 characters')

  /**
   * A UUID, and required.
   *
   * The portal deserialises this into a `java.util.UUID` and answers a 500 on
   * anything else — a stack trace about string length, from a host the caller
   * never addressed. Refused here, where the message can say what a valid one
   * looks like.
   *
   * Not generated for the caller either. An idempotency key the service
   * invented would be a different key on every retry, which is the opposite of
   * what it is for: the caller has to be able to repeat a request that may
   * already have succeeded.
   */
  const idempotencyKey = typeof b.idempotencyKey === 'string' ? b.idempotencyKey : ''
  if (!idempotencyKey) {
    return fail(
      'idempotencyKey',
      'required — a UUID you choose and can repeat, so a retry cannot generate a second cashback',
    )
  }
  if (!UUID.test(idempotencyKey)) {
    return fail('idempotencyKey', 'expected a UUID, in the standard 36-character form')
  }

  const expiryDays = b.expiryDays === undefined ? undefined : Number(b.expiryDays)
  if (expiryDays !== undefined && (!Number.isInteger(expiryDays) || expiryDays <= 0)) {
    return fail('expiryDays', 'expected a whole number of days greater than zero')
  }

  return {
    ok: true,
    value: { amountMinor, unit, memo: memo || undefined, idempotencyKey, expiryDays },
  }
}

/**
 * The body to sign, serialised once.
 *
 * Field names are the portal's, and `memo`/`expiryDays` are omitted rather
 * than sent as null when absent — `@Size` on a null is fine, but an explicit
 * null in a signed body is one more thing that has to match byte for byte on
 * a retry.
 */
export function generateBody(input: GenerateInput): string {
  const body: Record<string, unknown> = {
    amountMinor: input.amountMinor,
    unit: input.unit,
    idempotencyKey: input.idempotencyKey,
  }
  if (input.memo !== undefined) body.memo = input.memo
  if (input.expiryDays !== undefined) body.expiryDays = input.expiryDays
  return JSON.stringify(body)
}

/**
 * Codes a customer might type.
 *
 * Deliberately permissive on case and separators, because this is read off a
 * receipt by a person: the portal's own by-code lookup canonicalises, and
 * refusing a lowercase code here would reject something that works.
 */
const CODE = /^[A-Za-z0-9][A-Za-z0-9-]{2,63}$/

export function parseLookupRequest(body: unknown): Parsed<{ code: string }> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return fail('body', `expected a JSON object, got ${describe(body)}`)
  }
  const b = body as Record<string, unknown>

  const code = typeof b.code === 'string' ? b.code.trim() : ''
  if (!code) return fail('code', 'required — the code printed on the receipt')
  if (!CODE.test(code)) {
    return fail('code', 'expected 3-64 characters: letters, digits or hyphens')
  }

  return { ok: true, value: { code } }
}

/**
 * Claiming is NOT an endpoint here, and that is a finding rather than a gap.
 *
 * The ticket asked for `/v1/cashback/claim`. There is no such operation to
 * courier. Looking a code up returns a `claimUrl` of the form
 * `https://<host>/c/<ref>#k=<43-char base64url>` — and the key is in the URL
 * FRAGMENT, which a browser never sends to a server. The customer's wallet
 * fetches the ciphertext, decrypts it with that key, and commits the token.
 *
 * So a claim endpoint would have to either receive the decryption key (making
 * this service able to claim anyone's cashback, which is the custody ADR 0001
 * refuses) or do nothing useful. `parseLookupRequest` returns the URL and the
 * caller does the rest with its own key, exactly as the wallet does.
 *
 * `publicUrl` is exported for the metadata read the wallet performs alongside
 * the claim — a public endpoint, needing no signature, so a caller can show
 * what a code is worth before spending it.
 */
