/**
 * Cashback: a coupon handed to someone who does not have the app yet.
 *
 * The merchant mints one at the counter and reads out a short code. Days later
 * the customer installs the wallet, types the code, and the coupon lands. That
 * gap is the whole point — every other way into this wallet needs the customer
 * present, with a wallet, showing a QR.
 *
 * Both ends already exist on the gateway, so this file is a client and nothing
 * more:
 *
 *   issue   POST /api/v1/portal/cashback/generate   (merchant, edge-authenticated)
 *   look up GET  /api/v1/portal/cashback/by-code/{code}   (public, unauthenticated)
 *   claim   GET  https://{host}/c/{ref}/ciphertext   (public, DESTRUCTIVE)
 *
 * The code is an index, not a secret — it only resolves to the claim URL, and
 * the claim URL carries the AES key that actually opens the token. That makes
 * the six variable characters (~24 bits) worth guessing, which is why the
 * gateway rate-limits `by-code` per-IP AND per-code and collapses throttling
 * into a 404 so a prober cannot tell "wrong" from "too fast".
 *
 * ponytail: ported by hand rather than vendoring imani-apps' `cashback-redeem`.
 * That package exports only the four normaliser functions; everything that
 * matters still lives in a 919-line non-module browser script that reaches for
 * globals (`GatewayConfig`, `CashbackUrl`) this app does not define.
 */

import { useEffect, useState } from 'react'

import { gatewayConfig, cashbackEnabled } from './config'
import { legacyApi } from './legacyBridge'
import { signedFetch } from './nip98'
import { notifyWalletChanged } from './wallet'

/**
 * Whether to offer cashback at all on this deployment.
 *
 * False until the config says otherwise, including while it is still loading —
 * an entry point that appears a moment late is unremarkable, while one that
 * appears and then vanishes under the thumb is not.
 *
 * Both the merchant's link and the customer's key off this same answer: a
 * deployment that cannot validate a claim URL cannot honour a code either, so
 * issuing one there would only mint something unredeemable.
 */
export function useCashbackAvailable(): boolean {
  const [available, setAvailable] = useState(false)

  useEffect(() => {
    let live = true
    void gatewayConfig().then(
      (config) => {
        if (live) setAvailable(cashbackEnabled(config))
      },
      () => {
        // Leave it hidden. This is the same fail-closed default the gateway
        // ships, and the config fetch is cached, so a transient failure here
        // costs one hidden link until the next screen retries it.
      },
    )
    return () => {
      live = false
    }
  }, [])

  return available
}

/** The six characters that vary. `CB` and the dashes carry no information. */
const VARIABLE_RE = /^[A-Z0-9]{6}$/
/** What the gateway matches on, and the only shape `by-code` accepts. */
const CANONICAL_RE = /^CB-[A-Z0-9]{4}-[A-Z0-9]{2}$/
/** base64url, 43 unpadded characters — exactly 32 bytes of AES-256 key. */
const KEY_RE = /^k=([A-Za-z0-9_-]{43})$/
const CLAIM_PATH_RE = /^\/c\/([A-Za-z0-9_-]{8,64})$/

const BY_CODE_PATH = '/api/v1/portal/cashback/by-code/'
const PUBLIC_META_PATH = '/api/v1/portal/cashback/public/'

/** Long enough for a market-stall connection, short enough to not feel hung. */
const READ_TIMEOUT_MS = 15_000

// ─── The code itself ────────────────────────────────────────────────────────

/**
 * Whatever the customer typed, reduced to the six characters that matter.
 *
 * Deliberately forgiving, because this is entered by hand from a paper receipt
 * by someone who just installed the app: case, spaces, missing dashes and a
 * missing `CB` prefix are all accepted. Returns null when what is left is not
 * six alphanumerics — there is no partial credit.
 */
export function normaliseTypedClaimCode(raw: string): string | null {
  if (typeof raw !== 'string') return null

  const alphanum = raw.toUpperCase().match(/[A-Z0-9]/g)?.join('') ?? ''
  // `CB` is a constant prefix, so a full 8-character entry means the customer
  // typed it back. Stripping it is what lets both `CB-A1B2-C3` and `A1B2C3`
  // resolve to the same code.
  const candidate = alphanum.length === 8 && alphanum.startsWith('CB') ? alphanum.slice(2) : alphanum

  return VARIABLE_RE.test(candidate) ? candidate : null
}

/** The six variable characters, punctuated the way the gateway stores them. */
export function toCanonicalClaimCode(variable6: string): string {
  if (!VARIABLE_RE.test(variable6)) {
    throw new Error('toCanonicalClaimCode: expected exactly 6 characters of [A-Z0-9]')
  }
  return `CB-${variable6.slice(0, 4)}-${variable6.slice(4)}`
}

/** Typed input straight to `CB-XXXX-YY`, or null if it was never a code. */
export function canonicaliseTypedClaimCode(raw: string): string | null {
  const variable = normaliseTypedClaimCode(raw)
  return variable === null ? null : toCanonicalClaimCode(variable)
}

// ─── Issuing (merchant) ─────────────────────────────────────────────────────

/** What the merchant needs on screen after minting one. */
export interface IssuedCashback {
  cashbackId: string
  claimCode: string
  amountMinor: number
  unit: string
  expiresAt: string
}

interface GenerateResponse {
  cashbackId?: unknown
  claimCode?: unknown
  amountMinor?: unknown
  unit?: unknown
  expiresAt?: unknown
}

/**
 * Mint a cashback voucher and get back the code to read out.
 *
 * Authenticated exactly like voucher issuance (`lib/issue.ts`): the session
 * cookie goes up, the edge validates it against account-app and injects the
 * pubkey the portal trusts. The issuer is never a body field — the endpoint is
 * `@PreAuthorize(MERCHANT_ONLY)` and stamps whoever the edge authenticated.
 *
 * `idempotencyKey` is generated here and not retried on: a double-tap must not
 * mint two vouchers, and a network error whose request actually landed would
 * otherwise be indistinguishable from one that did not.
 *
 * The response also carries a one-time `claimKey`. This app deliberately drops
 * it. It is the AES key for the QR flow, and reading it here would mean holding
 * key material for a path we do not offer — `by-code` hands the key back to the
 * customer from the server when they redeem.
 */
export async function generateCashback(params: {
  amountMinor: number
  unit: string
  memo?: string
  expiryDays: number
}): Promise<IssuedCashback> {
  const response = await signedFetch('/api/v1/portal/cashback/generate', 'POST', {
    amountMinor: params.amountMinor,
    unit: params.unit,
    memo: params.memo,
    idempotencyKey: crypto.randomUUID(),
    expiryDays: params.expiryDays,
  })

  if (!response.ok) {
    throw new Error(await failureDetail(response, 'Could not create the cashback code'))
  }

  const body = (await response.json()) as GenerateResponse
  const claimCode = typeof body.claimCode === 'string' ? body.claimCode : null
  if (!claimCode) throw new Error('The gateway issued no cashback code.')

  return {
    cashbackId: String(body.cashbackId ?? ''),
    claimCode,
    amountMinor: Number(body.amountMinor ?? params.amountMinor),
    unit: typeof body.unit === 'string' ? body.unit : params.unit,
    expiresAt: typeof body.expiresAt === 'string' ? body.expiresAt : '',
  }
}

/** The server's `message`/`detail` if it sent one, else the bare status. */
async function failureDetail(response: Response, fallback: string): Promise<string> {
  const text = await response.text().catch(() => '')
  try {
    const body = JSON.parse(text) as { message?: string; detail?: string; error?: string }
    const message = body.message ?? body.detail ?? body.error
    if (message) return `${fallback}: ${message}`
  } catch {
    // Not JSON — fall through to the raw text, truncated.
  }
  return `${fallback} (${response.status}): ${text.slice(0, 200)}`
}

// ─── Redeeming (customer) ───────────────────────────────────────────────────

/** Why a redemption could not happen, in terms the screen can speak. */
export type RedeemFailure =
  /** The deployment never set `cashback_origins`, so nothing can be validated. */
  | { kind: 'disabled' }
  /** No such code — or the same 404 the gateway returns when throttling. */
  | { kind: 'not_found' }
  /** Spent, past its date, or pulled back by the merchant. */
  | { kind: 'terminal'; code: 'claimed' | 'expired' | 'revoked' }
  /** Rate-limited, and told so. */
  | { kind: 'throttled'; retryAfterSeconds: number | null }
  /** Offline, timed out, or the gateway is unwell. */
  | { kind: 'unreachable'; reason: string }
  /** Reached everything, but what came back could not be trusted or opened. */
  | { kind: 'invalid'; reason: string }

export type RedeemResult =
  | { kind: 'ok'; amountMinor: number | null; unit: string | null; memo: string | null }
  | RedeemFailure

interface ParsedClaimUrl {
  claimRef: string
  claimKey: string
  ciphertextUrl: string
}

/**
 * A claim URL, checked against the hosts this deployment trusts.
 *
 * Fail-closed at every step, and null for all of them: the customer cannot act
 * on the difference between "wrong host" and "no key", and enumerating the
 * reasons back to a caller invites one of them being handled leniently.
 *
 * The key lives in the URL *fragment*, which is why it never reaches the
 * holding store — the browser does not send a fragment.
 */
function parseClaimUrl(raw: string, trustedOrigins: string[]): ParsedClaimUrl | null {
  if (!raw || trustedOrigins.length === 0) return null

  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }

  // https only. The key is in the fragment so it is not on the wire, but the
  // ciphertext and the claim itself are, and plaintext would leak both.
  if (url.protocol !== 'https:') return null
  if (!trustedOrigins.includes(url.host.toLowerCase())) return null

  const path = CLAIM_PATH_RE.exec(url.pathname)
  if (!path) return null

  const key = KEY_RE.exec(url.hash.replace(/^#/, ''))
  if (!key) return null

  return {
    claimRef: path[1],
    claimKey: key[1],
    ciphertextUrl: `${url.origin}/c/${path[1]}/ciphertext`,
  }
}

/** `fetch` that gives up rather than hanging a screen forever. */
async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), READ_TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/** Turn a thrown fetch into the two reasons a screen can distinguish. */
function unreachable(error: unknown): RedeemFailure {
  const name = error instanceof Error ? error.name : ''
  return { kind: 'unreachable', reason: name === 'AbortError' ? 'timeout' : 'network' }
}

/**
 * Code → claim URL, via the public lookup.
 *
 * Non-destructive: the same code resolves twice. Nothing is spent until
 * `claimCiphertext` runs.
 */
async function resolveClaimUrl(canonical: string): Promise<{ claimUrl: string } | RedeemFailure> {
  let response: Response
  try {
    response = await fetchWithTimeout(BY_CODE_PATH + encodeURIComponent(canonical), {
      method: 'GET',
      headers: { Accept: 'application/json' },
    })
  } catch (e) {
    return unreachable(e)
  }

  if (response.status === 200) {
    const body = (await response.json().catch(() => null)) as { claimUrl?: unknown } | null
    const claimUrl = typeof body?.claimUrl === 'string' ? body.claimUrl : null
    return claimUrl ? { claimUrl } : { kind: 'invalid', reason: 'no_claim_url' }
  }

  // 410 is the one status that says *why*, and the three reasons need three
  // different things from the customer.
  if (response.status === 410) {
    const body = (await response.json().catch(() => null)) as { code?: unknown } | null
    const code = body?.code
    return code === 'expired' || code === 'revoked' || code === 'claimed'
      ? { kind: 'terminal', code }
      : { kind: 'terminal', code: 'claimed' }
  }

  // Not-found and silently-throttled are the same answer on purpose (FR-010),
  // so this app cannot tell them apart either. The copy has to cover both.
  if (response.status === 404) return { kind: 'not_found' }

  if (response.status === 429) {
    const body = (await response.json().catch(() => null)) as {
      retryAfterSeconds?: unknown
    } | null
    const wait = typeof body?.retryAfterSeconds === 'number' ? body.retryAfterSeconds : null
    return { kind: 'throttled', retryAfterSeconds: wait }
  }

  return { kind: 'unreachable', reason: `http_${response.status}` }
}

/**
 * The destructive call: take the ciphertext and decrypt it.
 *
 * Single-use. The holding store flips pending → claimed the moment it answers
 * 200, so from here the token exists only in this browser and losing it loses
 * the money. That is what `stashToken` below is for.
 */
async function claimCiphertext(parsed: ParsedClaimUrl): Promise<{ token: string } | RedeemFailure> {
  const keyBytes = base64UrlToBytes(parsed.claimKey)
  if (!keyBytes || keyBytes.length !== 32) return { kind: 'invalid', reason: 'bad_key' }

  let response: Response
  try {
    response = await fetchWithTimeout(parsed.ciphertextUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    })
  } catch (e) {
    return unreachable(e)
  }

  if (response.status === 410) {
    const body = (await response.json().catch(() => null)) as { code?: unknown } | null
    const code = body?.code
    return code === 'expired' || code === 'revoked' || code === 'claimed'
      ? { kind: 'terminal', code }
      : { kind: 'terminal', code: 'claimed' }
  }
  if (response.status !== 200) return { kind: 'unreachable', reason: `http_${response.status}` }

  const body = (await response.json().catch(() => null)) as {
    ciphertext?: unknown
    iv?: unknown
  } | null
  if (typeof body?.ciphertext !== 'string' || typeof body.iv !== 'string') {
    return { kind: 'invalid', reason: 'malformed_response' }
  }

  const ciphertext = base64UrlToBytes(body.ciphertext)
  const iv = base64UrlToBytes(body.iv)
  if (!ciphertext || !iv) return { kind: 'invalid', reason: 'malformed_payload' }

  try {
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, [
      'decrypt',
    ])
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext)
    return { token: new TextDecoder().decode(plain) }
  } catch {
    // AES-GCM is authenticated, so this is a wrong key or a tampered payload —
    // never a merely corrupt one.
    return { kind: 'invalid', reason: 'decrypt_failure' }
  }
}

// `Uint8Array<ArrayBuffer>`, not the plain alias: `WebCrypto`'s `BufferSource`
// excludes views backed by a `SharedArrayBuffer`, and the default type parameter
// is the union of both.
function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> | null {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(
    value.length + ((4 - (value.length % 4)) % 4),
    '=',
  )
  try {
    const binary = atob(padded)
    return Uint8Array.from(binary, (c) => c.charCodeAt(0))
  } catch {
    return null
  }
}

/**
 * Authoritative face value, read before the destructive call.
 *
 * The Cashu token underneath is denominated in sats, so without this a "5 EUR"
 * cashback would be announced as "782 SAT". Best-effort by design: a failure
 * here must not cost the customer their coupon, so the success screen simply
 * says less.
 */
async function fetchPublicMetadata(
  claimRef: string,
): Promise<{ amountMinor: number | null; unit: string | null; memo: string | null }> {
  const empty = { amountMinor: null, unit: null, memo: null }
  try {
    const response = await fetchWithTimeout(PUBLIC_META_PATH + encodeURIComponent(claimRef), {
      method: 'GET',
      headers: { Accept: 'application/json' },
    })
    if (response.status !== 200) return empty

    const body = (await response.json()) as {
      amountMinor?: unknown
      unit?: unknown
      memo?: unknown
    }
    return {
      amountMinor: typeof body.amountMinor === 'number' ? body.amountMinor : null,
      unit: typeof body.unit === 'string' ? body.unit : null,
      memo: typeof body.memo === 'string' ? body.memo : null,
    }
  } catch {
    return empty
  }
}

// ─── Surviving a crash between the claim and the swap ───────────────────────

/**
 * Where a decrypted-but-not-yet-banked token waits.
 *
 * The window this closes is real and it loses money: `claimCiphertext` burns
 * the claim, and if the app dies before `TokenRedemption.redeem` has swapped
 * the token at the mint there is nothing left to retry — the holding store
 * will answer 410 for the rest of time. This lands on the phone of someone who
 * installed the app ten minutes ago, on whatever connection a market has.
 *
 * ponytail: one localStorage slot, not a queue. Redeeming is a foreground act
 * the customer is watching, so two claims cannot overlap, and the replay only
 * has to survive as far as the next time they open the screen. A queue is the
 * upgrade if cashback ever redeems in the background.
 */
const PENDING_KEY = 'imani:cashback:pending'

function stashToken(token: string): void {
  try {
    localStorage.setItem(PENDING_KEY, token)
  } catch {
    // A full or disabled store must not abort a redemption that is otherwise
    // fine — it only means a crash in the next few seconds would cost the
    // coupon, which is exactly where we were without the stash.
  }
}

function clearStashedToken(): void {
  try {
    localStorage.removeItem(PENDING_KEY)
  } catch {
    // Nothing to do; a stale entry only costs one no-op replay attempt.
  }
}

/**
 * Bank a token that was claimed but never swapped, if one is waiting.
 *
 * Safe to call on every visit to the redeem screen: `TokenRedemption.redeem`
 * dedupes by fingerprint, so replaying one that actually landed is a no-op.
 * Returns true when something was recovered, so the screen can say so.
 */
export async function replayPendingCashback(): Promise<boolean> {
  let token: string | null = null
  try {
    token = localStorage.getItem(PENDING_KEY)
  } catch {
    return false
  }
  if (!token) return false

  try {
    await commitToken(token)
    clearStashedToken()
    return true
  } catch {
    // Keep it. The next visit tries again — this is the whole point of the
    // stash, and dropping it here would be the loss it exists to prevent.
    return false
  }
}

/**
 * Swap the token at the mint and write it into the wallet.
 *
 * Delegates to the same coordinator every other receive path uses, and
 * `'cashback'` is a source it already knows: it skips the inspect-before-save
 * precondition that `scan`/`manual` require, because a cashback token was
 * minted by the gateway rather than pasted in by a person.
 */
async function commitToken(token: string): Promise<void> {
  await legacyApi()
  const redemption = window.TokenRedemption
  if (!redemption) throw new Error('TokenRedemption unavailable')

  await redemption.redeem(token, { source: 'cashback' })

  // Deliberately NOT attested (lib/attestation.ts). A code review flagged this
  // path as a gap in the ledger; it is a scope boundary rather than an
  // oversight. An attestation is a MERCHANT's claim about a coupon they
  // honoured. This is the opposite direction: a customer claiming cashback the
  // gateway minted for them. There is no merchant redeeming, no issuer
  // signature over a face value they credited, and so nothing anyone here is
  // entitled to attest to.
  //
  // If cashback ever needs to appear in the public ledger, the attestation has
  // to come from whoever actually honoured the value, not from the recipient.

  // The legacy layer writes straight to IndexedDB, and this tab does not hear
  // its own BroadcastChannel post.
  notifyWalletChanged()
}

/**
 * The whole customer flow: code in, coupon banked.
 *
 * Ordered so that everything fallible and reversible happens before the one
 * step that is neither. The public metadata read is deliberately in front of
 * the destructive claim, so the success screen can name a real amount even if
 * the commit has to be replayed later.
 */
export async function redeemCashbackCode(canonical: string): Promise<RedeemResult> {
  if (!CANONICAL_RE.test(canonical)) return { kind: 'not_found' }

  const config = await gatewayConfig().catch(() => null)
  if (!config) return { kind: 'unreachable', reason: 'network' }
  if (!cashbackEnabled(config)) return { kind: 'disabled' }

  const resolved = await resolveClaimUrl(canonical)
  if ('kind' in resolved) return resolved

  const parsed = parseClaimUrl(resolved.claimUrl, config.cashbackOrigins)
  // The gateway named a host this build does not trust, or sent a URL with no
  // key in it. Both mean the same thing here: do not fetch it.
  if (!parsed) return { kind: 'invalid', reason: 'untrusted_claim_url' }

  const metadata = await fetchPublicMetadata(parsed.claimRef)

  const claimed = await claimCiphertext(parsed)
  if ('kind' in claimed) return claimed

  // From here the claim is spent. Persist before swapping so a crash is
  // recoverable, and only forget it once the mint has actually taken it.
  stashToken(claimed.token)
  try {
    await commitToken(claimed.token)
  } catch (e) {
    return {
      kind: 'unreachable',
      reason: e instanceof Error && e.name === 'AbortError' ? 'timeout' : 'commit_failed',
    }
  }
  clearStashedToken()

  return { kind: 'ok', ...metadata }
}
