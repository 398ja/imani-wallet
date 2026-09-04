/**
 * Noticing money arriving, and bringing a stall into existence.
 *
 * API tickets 06 and 10. Both are couriers, and both were listed as needing
 * their service located first. They did — and the locating is the interesting
 * part, because in each case the endpoint the app appears to use is not the one
 * that answers.
 *
 * ## Where these actually live
 *
 * The inbox is on **gateway-core**, not customer-wallet. A signed POST to
 * `/api/v1/incoming-notifications/drain` returns 404 on 28082 and **200** on
 * 28081. The 404 is what made the coverage assessment call this unlocated.
 *
 * Claiming a handle is `POST /api/v1/nip05`, also on gateway-core. It is NOT
 * `/api/v1/register`, which is bottin's, wants HTTP Basic, and is not something
 * a service holding no credentials could ever call.
 *
 * ## Why receiving matters more than its size suggests
 *
 * Spending without receiving is half a wallet. Until this, a program could pay
 * a supplier and never notice being paid — which makes the "bookkeeping tool"
 * in the API's own opening line only half possible.
 *
 * ## What stays with the caller
 *
 * Unwrapping the NIP-17 gift wrap needs the customer's private key, so
 * decryption is theirs and always will be. This service says where to ask and
 * what to sign; it never sees a plaintext coupon.
 */

type Parsed<T> = { ok: true; value: T } | { ok: false; error: { field: string; detail: string } }

const fail = (field: string, detail: string): Parsed<never> => ({ ok: false, error: { field, detail } })

function describe(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'an array'
  return typeof v
}

/**
 * Gateway-core, which serves both of these.
 *
 * The same host the split courier already uses, read from the same variable —
 * a second one would be a second thing to get wrong in a deployment.
 */
const GATEWAY_URL = process.env.WALLET_API_GATEWAY_URL ?? 'http://gateway-core:8081'

export const DRAIN_PATH = '/api/v1/incoming-notifications/drain'
export const ACK_PATH = '/api/v1/incoming-notifications/ack'
export const CLAIM_HANDLE_PATH = '/api/v1/nip05'

const gateway = (path: string) => `${GATEWAY_URL.replace(/\/$/, '')}${path}`

export const drainUrl = () => gateway(DRAIN_PATH)
export const ackUrl = () => gateway(ACK_PATH)
export const claimHandleUrl = () => gateway(CLAIM_HANDLE_PATH)

/** The app drains fifty at a time; the same ceiling applies here. */
const MAX_DRAIN = 50

export function parseDrainRequest(body: unknown): Parsed<{ limit: number }> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return fail('body', `expected a JSON object, got ${describe(body)}`)
  }
  const b = body as Record<string, unknown>

  const limit = Number(b.limit ?? MAX_DRAIN)
  if (!Number.isInteger(limit) || limit <= 0) {
    return fail('limit', 'expected a whole number greater than zero')
  }
  if (limit > MAX_DRAIN) {
    // Capped rather than silently reduced: a caller asking for a thousand and
    // receiving fifty would conclude it had drained the inbox.
    return fail('limit', `expected at most ${MAX_DRAIN}`)
  }

  return { ok: true, value: { limit } }
}

export function drainBody(limit: number): string {
  return JSON.stringify({ limit })
}

export function parseAckRequest(body: unknown): Parsed<{ ids: string[] }> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return fail('body', `expected a JSON object, got ${describe(body)}`)
  }
  const b = body as Record<string, unknown>

  const raw = b.ids
  if (!Array.isArray(raw)) {
    return fail('ids', `expected an array of envelope ids, got ${describe(raw)}`)
  }
  if (raw.length === 0) {
    // Acknowledging nothing is almost certainly a caller bug — a loop that
    // built an empty list and would now drain the same envelopes forever.
    return fail('ids', 'expected at least one envelope id')
  }

  const ids: string[] = []
  for (let i = 0; i < raw.length; i++) {
    const id = raw[i]
    if (typeof id !== 'string' || id.length === 0) {
      return fail(`ids[${i}]`, 'expected a non-empty string')
    }
    ids.push(id)
  }

  return { ok: true, value: { ids } }
}

export function ackBody(ids: string[]): string {
  return JSON.stringify({ ids })
}

export interface ClaimHandleInput {
  username: string
  pubkey: string
  relays: string[]
}

/**
 * Handles a stall can ask for.
 *
 * Deliberately narrow. This becomes half of a NIP-05 address, so anything that
 * cannot appear left of an `@` is refused here rather than by the gateway,
 * where the error is about a domain the caller never mentioned.
 */
const HANDLE = /^[a-z0-9][a-z0-9_-]{2,31}$/

export function parseClaimHandleRequest(
  body: unknown,
  callerPubkey: string,
  defaultRelays: string[],
): Parsed<ClaimHandleInput> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return fail('body', `expected a JSON object, got ${describe(body)}`)
  }
  const b = body as Record<string, unknown>

  const username = typeof b.username === 'string' ? b.username.trim().toLowerCase() : ''
  if (!username) return fail('username', 'required — the handle to claim')
  if (!HANDLE.test(username)) {
    return fail(
      'username',
      'expected 3-32 characters: lowercase letters, digits, underscore or hyphen, starting with a letter or digit',
    )
  }

  /**
   * The handle is claimed FOR the signing key.
   *
   * A caller naming another pubkey would be claiming a handle on someone
   * else's behalf — or, worse, pointing an existing name at a key they hold.
   * The signature is the only evidence of who is asking, so it is the only
   * thing that decides.
   */
  if (b.pubkey !== undefined && String(b.pubkey).toLowerCase() !== callerPubkey.toLowerCase()) {
    return fail(
      'pubkey',
      'a handle is always claimed for the SIGNING key — claiming one for another key would be claiming a name on their behalf',
    )
  }

  const relays = Array.isArray(b.relays)
    ? b.relays.filter((r): r is string => typeof r === 'string' && r.length > 0)
    : defaultRelays

  if (relays.length === 0) {
    return fail('relays', 'expected at least one relay where this stall can be reached')
  }

  return { ok: true, value: { username, pubkey: callerPubkey, relays } }
}

export function claimHandleBody(input: ClaimHandleInput): string {
  return JSON.stringify({
    username: input.username,
    pubkey: input.pubkey,
    relays: input.relays,
  })
}
