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
import { cashbackValidation } from './cashbackValidation'
import { claimRefFromUrl, isClaimKey } from './claimLink'
import { legacyApi, withCorrelation } from './legacyBridge'
import { signedFetch } from './nip98'
import { checkTokenBacking, loadTrustedMints, trustedMintUrls } from './trustedMint'
import { getSigner } from './nap'
import { ForeignVoucherRefusedError, isServerForeignRefusal, refuseForeignIssuer, refuseForeignVouchers, sessionAccount } from './merchantVouchers'
import { notifyWalletChanged, recordCashbackStatus } from './wallet'

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

/**
 * The characters that vary. `CB` and the dashes carry no information.
 *
 * Two shapes, mirroring the portal's `CashbackByCodeController.canonicaliseOrNull`.
 * Codes issued since gateway-portal 0.4.0 (GP-02) are ten random characters,
 * `CB-XXXXX-XXXXX`. Codes printed before it are six, `CB-XXXX-YY`, and still redeem.
 */
const CURRENT_VARIABLE_RE = /^[A-Z0-9]{10}$/
const LEGACY_VARIABLE_RE = /^[A-Z0-9]{6}$/
/** What the gateway matches on, and the only shapes `by-code` accepts. */
const CANONICAL_RE = /^CB-(?:[A-Z0-9]{5}-[A-Z0-9]{5}|[A-Z0-9]{4}-[A-Z0-9]{2})$/
const CB_PREFIX = 'CB'
/** base64url, 43 unpadded characters — exactly 32 bytes of AES-256 key. */
const KEY_RE = /^k=([A-Za-z0-9_-]{43})$/
const CLAIM_PATH_RE = /^\/c\/([A-Za-z0-9_-]{8,64})$/

/**
 * The same two shapes, unwrapped, for a claim that arrives as parts rather than
 * as a URL. Declared beside their wrapped forms so the two paths cannot drift
 * into accepting different things.
 */
const CLAIM_REF_RE = /^[A-Za-z0-9_-]{8,64}$/
const CLAIM_KEY_RE = /^[A-Za-z0-9_-]{43}$/

const BY_CODE_PATH = '/api/v1/portal/cashback/by-code/'
const PUBLIC_META_PATH = '/api/v1/portal/cashback/public/'

/** Long enough for a market-stall connection, short enough to not feel hung. */
const READ_TIMEOUT_MS = 15_000

// ─── The code itself ────────────────────────────────────────────────────────

/**
 * Whatever the customer typed, reduced to the characters that matter.
 *
 * Deliberately forgiving, because this is entered by hand from a paper receipt
 * by someone who just installed the app: case, spaces, missing dashes and a
 * missing `CB` prefix are all accepted. Returns null when what is left is not
 * ten or six alphanumerics. There is no partial credit.
 */
export function normaliseTypedClaimCode(raw: string): string | null {
  if (typeof raw !== 'string') return null

  const alphanum = raw.toUpperCase().match(/[A-Z0-9]/g)?.join('') ?? ''
  // `CB` is a constant prefix, so an entry two characters longer than a code
  // means the customer typed it back. Stripping it only then is what lets both
  // `CB-A1B2-C3` and `A1B2C3` resolve to the same code, while a bare code that
  // happens to start with C and B keeps them.
  const candidate = typedWithPrefix(alphanum) ? alphanum.slice(CB_PREFIX.length) : alphanum

  return isVariablePart(candidate) ? candidate : null
}

function typedWithPrefix(alphanum: string): boolean {
  return alphanum.startsWith(CB_PREFIX) && isVariablePart(alphanum.slice(CB_PREFIX.length))
}

function isVariablePart(candidate: string): boolean {
  return CURRENT_VARIABLE_RE.test(candidate) || LEGACY_VARIABLE_RE.test(candidate)
}

/** The variable characters, punctuated the way the gateway stores them. */
export function toCanonicalClaimCode(variable: string): string {
  if (CURRENT_VARIABLE_RE.test(variable)) {
    return `CB-${variable.slice(0, 5)}-${variable.slice(5)}`
  }
  if (LEGACY_VARIABLE_RE.test(variable)) {
    return `CB-${variable.slice(0, 4)}-${variable.slice(4)}`
  }
  throw new Error('toCanonicalClaimCode: expected exactly 10 or 6 characters of [A-Z0-9]')
}

/** Typed input straight to `CB-XXXXX-XXXXX` or `CB-XXXX-YY`, or null if it was never a code. */
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
  /**
   * The voucher the portal minted for this code, when it says. Older portals
   * do not return it, and a row without it simply stays off the Vouchers list.
   */
  voucherId?: string
  /**
   * The claim reference and its one-time key, for the link and QR (claim links phase 2, spec
   * 4.1). Held in this screen's memory only: never written to the row, a log or storage. A later
   * visit rebuilds the link from the code through `by-code` (`resolveClaimLinkByCode`). Absent
   * when the portal did not return a well-formed pair, and the screen then offers the code alone.
   */
  claim?: { ref: string; key: string }
}

interface GenerateResponse {
  cashbackId?: unknown
  claimCode?: unknown
  amountMinor?: unknown
  unit?: unknown
  expiresAt?: unknown
  voucherId?: unknown
  claimUrl?: unknown
  claimKey?: unknown
}

/**
 * What a merchant sees when the portal refuses the stall's warrant.
 *
 * Its own words because the fix is different from any other failure: retrying
 * will not help, and the usual cause is a device whose key is not the stall's.
 */
export const WARRANT_REFUSED_MESSAGE =
  'The gateway did not accept this device\u2019s authorisation for the cashback. ' +
  'No code was created. Sign in on the stall\u2019s own device and try again.'

/**
 * What a merchant sees when the portal already holds this issue under the
 * same key with a different body. The usual cause is a re-signed warrant on a
 * retry. Nothing new was minted.
 */
export const IDEMPOTENCY_CONFLICT_MESSAGE =
  'This cashback was already being created with different details, so no second code was made. ' +
  'Check your history before creating it again.'

/**
 * The portal's `ErrorEnvelope.code` values this screen speaks for itself.
 * Matched on the code, not the message text, so a different 400 that happens
 * to mention a warrant keeps its own words.
 */
const ENVELOPE_MESSAGES: Record<string, string> = {
  INVALID_WARRANT: WARRANT_REFUSED_MESSAGE,
  IDEMPOTENCY_CONFLICT: IDEMPOTENCY_CONFLICT_MESSAGE,
}

const HTTP_CONFLICT = 409
const HTTP_CLIENT_ERROR_MIN = 400
const HTTP_SERVER_ERROR_MIN = 500

/**
 * The portal answered generate with an error. Carries the status so a caller
 * can tell a refusal of THIS request from an answer that may hide a success.
 */
export class CashbackGenerateError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | undefined,
  ) {
    super(message)
    this.name = 'CashbackGenerateError'
  }

  /**
   * A 4xx with an error envelope: the portal looked at this request and turned
   * it down, so nothing was minted under its key. A 409 is NOT one, because it
   * says the key is already taken, and a 5xx or a dropped connection may hide a
   * request that landed. Those are retried with the same key and warrant.
   */
  get definiteRefusal(): boolean {
    return (
      this.code !== undefined &&
      this.status >= HTTP_CLIENT_ERROR_MIN &&
      this.status < HTTP_SERVER_ERROR_MIN &&
      this.status !== HTTP_CONFLICT
    )
  }
}

/**
 * Mint a cashback voucher and get back the code to read out.
 *
 * Authenticated exactly like voucher issuance (`lib/issue.ts`): the session
 * cookie goes up, the edge validates it against account-app and injects the
 * pubkey the portal trusts. The issuer is never a body field — the endpoint is
 * `@PreAuthorize(MERCHANT_ONLY)` and stamps whoever the edge authenticated.
 *
 * `idempotencyKey` comes from the caller, with the warrant, so a retry of the
 * same issue can resend both unchanged (#144). The portal compares the
 * warrant's hash under a key, so a re-signed warrant gets a 409. A double-tap must not
 * mint two vouchers, and a network error whose request actually landed would
 * otherwise be indistinguishable from one that did not.
 *
 * The response also carries a one-time `claimKey`, the AES key in the claim
 * link's fragment. It is kept on `IssuedCashback.claim`, in memory, so the
 * success screen can show the link and QR (claim links phase 2). It is never
 * stored: `by-code` rebuilds the same link from the code later.
 */
export async function generateCashback(params: {
  amountMinor: number
  unit: string
  memo?: string
  expiryDays: number
  /**
   * The coupon's own life in days, separate from the claim window above.
   * Always sent, 0 included: 0 is never-expires, and an absent field is what
   * the portal reads as an older wallet (398ja/imani-gateway-portal#58).
   */
  voucherValidityDays: number
  /**
   * The stall's warrant for this sale, signed BEFORE this call. It goes into
   * the voucher's signed secret, so it cannot be added once the code exists.
   */
  issuanceWarrant?: string
  /** One per issue, reused on every retry of it. */
  idempotencyKey: string
}): Promise<IssuedCashback> {
  const response = await signedFetch('/api/v1/portal/cashback/generate', 'POST', {
    amountMinor: params.amountMinor,
    unit: params.unit,
    memo: params.memo,
    idempotencyKey: params.idempotencyKey,
    expiryDays: params.expiryDays,
    voucherValidityDays: params.voucherValidityDays,
    // Omitted when undefined, as on Sell: absent means "no warrant", which is a
    // different claim from a signed `none`.
    ...(params.issuanceWarrant === undefined ? {} : { issuanceWarrant: params.issuanceWarrant }),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    const code = envelopeCode(text)
    const message =
      ENVELOPE_MESSAGES[code ?? ''] ??
      failureDetailFrom(text, response.status, 'Could not create the cashback code')
    throw new CashbackGenerateError(message, response.status, code)
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
    ...(typeof body.voucherId === 'string' && body.voucherId ? { voucherId: body.voucherId } : {}),
    ...claimOf(body),
  }
}

/** The claim ref and key from a generate answer, only when both are well formed. */
function claimOf(body: GenerateResponse): { claim?: { ref: string; key: string } } {
  const ref = claimRefFromUrl(typeof body.claimUrl === 'string' ? body.claimUrl : null)
  return ref && isClaimKey(body.claimKey) ? { claim: { ref, key: body.claimKey } } : {}
}

/** What a merchant's Cancel came to. */
export type RevokeOutcome =
  | { kind: 'revoked' }
  /** The customer claimed it first, or it already closed another way: nothing to cancel. */
  | { kind: 'not_revocable' }
  /** The gateway could not be reached, or failed. The cashback may still be live. */
  | { kind: 'failed' }

/**
 * Cancel a cashback (spec 4.1, Q4): the portal's revoke, which closes the claim and burns the
 * voucher. Nothing is refunded to the merchant. Scoped to the authenticated merchant by the
 * portal, like the status read.
 */
export async function revokeCashback(cashbackId: string): Promise<RevokeOutcome> {
  const path = `/api/v1/portal/cashback/${encodeURIComponent(cashbackId)}/revoke`
  let response: Response
  try {
    response = await signedFetch(path, 'POST', {})
  } catch {
    return { kind: 'failed' }
  }
  if (response.ok) return { kind: 'revoked' }
  if (response.status === HTTP_CONFLICT) return { kind: 'not_revocable' }
  return { kind: 'failed' }
}

/**
 * Where a cashback got to, as the gateway sees it.
 *
 * `Unclaimed` is the only non-terminal one: the code is out there and nobody
 * has typed it in yet. The other four are final and never change again, which
 * is what makes a cached copy of one safe to trust forever.
 */
export type CashbackStatus =
  | 'Unclaimed'
  | 'Claimed'
  | 'Expired'
  | 'Revoked'
  | 'ManualAttention'

const TERMINAL_STATUSES: readonly string[] = ['Claimed', 'Expired', 'Revoked', 'ManualAttention']

/** Whether this status can still change, and so whether it is worth re-asking. */
export function isTerminalCashbackStatus(status: string | undefined): boolean {
  return status !== undefined && TERMINAL_STATUSES.includes(status)
}

export interface CashbackStatusReading {
  status: CashbackStatus
  /** Epoch milliseconds, or undefined while it is still unclaimed. */
  claimedAt?: number
}

/**
 * Ask the gateway whether the customer ever redeemed this code.
 *
 * The merchant-side counterpart to `redeemCashbackCode`, and the only source of
 * truth for it: the code lives on a paper receipt, the customer may redeem it
 * on a phone that did not exist when it was issued, and nothing about that ever
 * reaches this device. `GET /{id}/status` is scoped to the authenticated
 * merchant by `PortalCashbackController`, so a merchant can only ever read
 * their own.
 *
 * Returns null rather than throwing on anything that went wrong — offline, 404,
 * a gateway having a bad day. A status screen that cannot reach the gateway
 * must say "could not check", never invent an answer, and a merchant at a stall
 * can act on neither the HTTP code nor the stack trace.
 */
export async function fetchCashbackStatus(
  cashbackId: string,
): Promise<CashbackStatusReading | null> {
  const path = `/api/v1/portal/cashback/${encodeURIComponent(cashbackId)}/status`
  let response: Response
  try {
    response = await signedFetch(path, 'GET')
  } catch {
    return null
  }
  if (!response.ok) return null

  const body = (await response.json().catch(() => null)) as {
    status?: unknown
    claimedAt?: unknown
  } | null
  const status = typeof body?.status === 'string' ? body.status : null
  if (!status) return null

  const claimedAt = typeof body?.claimedAt === 'string' ? Date.parse(body.claimedAt) : NaN
  return {
    status: status as CashbackStatus,
    claimedAt: Number.isNaN(claimedAt) ? undefined : claimedAt,
  }
}

/**
 * The status of one issued cashback, for a screen that has just been opened.
 *
 * Reads once per mount rather than on a timer. possa-merchant polls every 30 s
 * because its voucher list is a live dashboard; this is a receipt someone
 * navigated to on purpose, and the answer they want is "as of when I opened
 * this". A merchant who wants a fresher one navigates back in.
 *
 * A terminal cached status short-circuits the fetch entirely — `Claimed` never
 * becomes anything else, so re-asking would spend a round trip to be told what
 * the row already says.
 *
 * `checking` is distinct from a null reading: one means the answer is on its
 * way, the other that it could not be had. Collapsing them would leave an
 * offline screen spinning forever.
 */
export function useCashbackStatus(input: {
  /**
   * The row to stamp the answer onto, passed in rather than rebuilt from the
   * cashback id. `buildCashbackTransaction` owns the `cashback:<id>` key, and a
   * second copy of that convention here would fail the only way this write can:
   * `updateTransaction` returns null for an id that matches nothing and
   * `recordCashbackStatus` swallows it, so the cache would just quietly stop
   * working with nothing on screen or in the console to say so.
   */
  rowId?: string
  cashbackId?: string
  cachedStatus?: string
  cachedClaimedAt?: number
}): { reading: CashbackStatusReading | null; checking: boolean } {
  const { rowId, cashbackId, cachedStatus, cachedClaimedAt } = input
  const settled = isTerminalCashbackStatus(cachedStatus)
  const cached: CashbackStatusReading | null = cachedStatus
    ? { status: cachedStatus as CashbackStatus, claimedAt: cachedClaimedAt }
    : null

  // The id is carried alongside the answer so a screen navigated from one
  // cashback to another does not show the first one's status while the second
  // is still in flight.
  const [fetched, setFetched] = useState<{
    id: string
    reading: CashbackStatusReading | null
  } | null>(null)

  useEffect(() => {
    if (!cashbackId || settled) return
    let live = true
    void fetchCashbackStatus(cashbackId).then((fresh) => {
      if (!live) return
      setFetched({ id: cashbackId, reading: fresh })
      // Only terminal states are written back. An `Unclaimed` reading is stale
      // the moment it lands, and persisting it would let a row claim it had
      // been checked when the check tells you nothing durable.
      if (rowId && fresh && isTerminalCashbackStatus(fresh.status)) {
        void recordCashbackStatus(rowId, fresh)
      }
    })
    return () => {
      live = false
    }
  }, [rowId, cashbackId, settled])

  const answer = fetched && fetched.id === cashbackId ? fetched : null
  return {
    // A failed check falls back to the cache rather than blanking the screen:
    // what was true last time is more use than nothing at all.
    reading: answer?.reading ?? cached,
    checking: !!cashbackId && !settled && answer === null,
  }
}

/** The server's `message`/`detail` if it sent one, else the bare status. */
function failureDetailFrom(text: string, status: number, fallback: string): string {
  try {
    const body = JSON.parse(text) as { message?: string; detail?: string; error?: string }
    const message = body.message ?? body.detail ?? body.error
    if (message) return `${fallback}: ${message}`
  } catch {
    // Not JSON — fall through to the raw text, truncated.
  }
  return `${fallback} (${status}): ${text.slice(0, 200)}`
}

/** The portal's `ErrorEnvelope.code`, or undefined if the body is not one. */
function envelopeCode(text: string): string | undefined {
  try {
    const code = (JSON.parse(text) as { code?: unknown }).code
    return typeof code === 'string' ? code : undefined
  } catch {
    return undefined
  }
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
  /**
   * Claimed and kept, but NOT swapped: the trusted-mint gate is holding it
   * (#133 review, MEDIUM-1). Its mint is not one this wallet lists, or no mint is
   * known yet. The token stays stashed on this device and is banked by a later
   * visit once the mint is confirmed. Nothing was lost.
   */
  | { kind: 'held'; reason: 'untrusted-mint' | 'no-trusted-mint' | 'not-ready' }
  /**
   * Claimed, and the token can never be credited (a foreign unit, or unreadable).
   * Kept on the device all the same, never swapped and never silently dropped.
   */
  | { kind: 'refused'; reason: string }
  /**
   * A merchant account and another stall's cashback (owner rule 2026-10-13). Refused before the
   * destructive claim whenever the portal metadata names the issuer, so nothing is spent and the
   * voucher still waits for a customer account. `unknown`: the account's role could not be checked.
   */
  | { kind: 'merchant_refused'; reason: 'merchant' | 'unknown' }

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
): Promise<{ amountMinor: number | null; unit: string | null; memo: string | null; issuerPubkey: string | null }> {
  const empty = { amountMinor: null, unit: null, memo: null, issuerPubkey: null }
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
      issuerPubkey?: unknown
    }
    return {
      amountMinor: typeof body.amountMinor === 'number' ? body.amountMinor : null,
      unit: typeof body.unit === 'string' ? body.unit : null,
      memo: typeof body.memo === 'string' ? body.memo : null,
      issuerPubkey: typeof body.issuerPubkey === 'string' && body.issuerPubkey !== '' ? body.issuerPubkey.toLowerCase() : null,
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
 * A LIST, not one slot (#133 review, MEDIUM-1). It used to be a single slot on
 * the grounds that a claim is committed seconds after it is stashed. Since the
 * commit is gated on the token's mint, a stashed token can now wait for days
 * until the mint is confirmed, and a second claim in that time would have
 * overwritten, and so lost, the first. The legacy single-token value is still
 * read, so a token stashed by an older build is not stranded.
 */
const PENDING_KEY = 'imani:cashback:pending'

function readStash(): string[] {
  let raw: string | null
  try {
    raw = localStorage.getItem(PENDING_KEY)
  } catch {
    return []
  }
  if (!raw) return []
  // An older build stored the bare token string.
  if (raw.startsWith('cashu')) return [raw]
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string' && t.length > 0) : []
  } catch {
    return []
  }
}

function writeStash(tokens: readonly string[]): void {
  try {
    if (tokens.length === 0) localStorage.removeItem(PENDING_KEY)
    else localStorage.setItem(PENDING_KEY, JSON.stringify(tokens))
  } catch {
    // A full or disabled store must not abort a redemption that is otherwise
    // fine — it only means a crash in the next few seconds would cost the
    // coupon, which is exactly where we were without the stash.
  }
}

function stashToken(token: string): void {
  const tokens = readStash()
  if (!tokens.includes(token)) writeStash([...tokens, token])
}

function clearStashedToken(token: string): void {
  writeStash(readStash().filter((t) => t !== token))
}

/** How many claimed cashback tokens are on this device waiting to be banked. */
export function pendingCashbackCount(): number {
  return readStash().length
}

/**
 * Bank every token that was claimed but never swapped.
 *
 * Safe to call on every visit to the redeem screen: `TokenRedemption.redeem`
 * dedupes by fingerprint, so replaying one that actually landed is a no-op.
 * A token the trusted-mint gate still holds is kept, not swapped (#133 review).
 * Returns true when something was recovered, so the screen can say so.
 */
export async function replayPendingCashback(): Promise<boolean> {
  const tokens = readStash()
  if (tokens.length === 0) return false
  // Learn the trusted mints first: until they are known the gate defers, and a
  // token is kept rather than swapped.
  await loadTrustedMints()

  let recovered = false
  for (const token of tokens) {
    try {
      const outcome = await commitToken(token)
      if (outcome.kind === 'banked') {
        clearStashedToken(token)
        recovered = true
      }
      // Held or refused: kept. Nothing is ever dropped from the stash except by
      // banking it, because the claim that produced it cannot be repeated.
    } catch {
      // Keep it. The next visit tries again — this is the whole point of the
      // stash, and dropping it here would be the loss it exists to prevent.
    }
  }
  return recovered
}

/** What `commitToken` did with a token. */
type CommitOutcome =
  | { kind: 'banked' }
  | { kind: 'held'; reason: 'untrusted-mint' | 'no-trusted-mint' | 'not-ready' }
  | { kind: 'refused'; reason: string }
  /** Owner rule 2026-10-13: a merchant account and another stall's voucher. Kept in the stash, never swapped. */
  | { kind: 'merchant_refused'; reason: 'merchant' | 'unknown' }

/** This session's account key, or undefined before unlock (a test, or a page with no session). */
function signerPubkey(): string | undefined {
  return sessionAccount(getSigner)
}

/**
 * Swap the token at the mint and write it into the wallet.
 *
 * Delegates to the same coordinator every other receive path uses, and
 * `'cashback'` is a source it already knows: it skips the inspect-before-save
 * precondition that `scan`/`manual` require, because a cashback token was
 * minted by the gateway rather than pasted in by a person. Skipping the gate
 * is not skipping the check: the coupon's issuer and signature are verified
 * here and recorded on the row like any other receive (#156).
 *
 * And the BACKING is checked before anything is swapped (#133 review,
 * MEDIUM-1): this path used to swap and credit whatever mint the token named.
 * The token is the portal's, which stamps customer-wallet's PUBLIC mint URL
 * into `m` (`gateway.wallet.public-mint-url`, verified on staging), so a genuine
 * cashback token is at a mint the gate trusts. One that is not is HELD: never
 * swapped, kept in the stash, and banked by a later visit once its mint is
 * confirmed. The claim was destructive, so the one thing this must never do is
 * drop the token.
 */
async function commitToken(token: string): Promise<CommitOutcome> {
  const backing = checkTokenBacking(token)
  switch (backing.outcome) {
    case 'accept':
      break
    case 'hold':
      console.warn('[cashback] holding a claimed token, not swapping it:', backing.detail)
      return { kind: 'held', reason: backing.reason }
    case 'defer':
      return { kind: 'held', reason: 'not-ready' }
    case 'refuse':
      console.error('[cashback] a claimed token can never be credited here, kept on the device:', backing.detail)
      return { kind: 'refused', reason: backing.reason }
  }

  // Owner rule 2026-10-13, after the claim: the token itself names the stall. The portal's
  // metadata was asked before the claim; this catches a token whose issuer it did not name. Kept in
  // the stash (never swapped, never dropped), so a customer account can still take it.
  const account = signerPubkey()
  if (account) {
    try {
      await refuseForeignVouchers([token], account)
    } catch (e) {
      if (e instanceof ForeignVoucherRefusedError) return { kind: 'merchant_refused', reason: e.reason }
      throw e
    }
  }

  await legacyApi()
  const redemption = window.TokenRedemption
  if (!redemption) throw new Error('TokenRedemption unavailable')

  // Registered with the bridge and named on the row it writes (#145), so a
  // DM redeem in flight at the same moment can never stamp its claim here.
  // Nothing to stamp: a cashback is not a stall's own coupon coming home.
  // The same issuer + signature check every other receive records (#156).
  // Recorded and never refused: the claim above was destructive, so refusing
  // here would lose value. A failed check reads as failed on the row.
  const validation = cashbackValidation(token)
  try {
    await withCorrelation(validation ? { validation: { ...validation } } : {}, (correlationId) =>
      redemption.redeem(token, { source: 'cashback', metadata: { correlation_id: correlationId } }),
    )
  } catch (e) {
    // The server refused it under the same rule (403 FOREIGN_VOUCHER_FOR_MERCHANT): nothing swapped.
    if (isServerForeignRefusal(e)) return { kind: 'merchant_refused', reason: 'merchant' }
    throw e
  }

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
  return { kind: 'banked' }
}

/**
 * The wallet-origin claim link for a code, rebuilt through `by-code` (spec 4.1, Show QR again).
 *
 * Non-destructive: `by-code` only looks the claim up. The ref and key come back in the claim-host
 * URL, are checked against the trusted hosts exactly as a redeem checks them, and are returned as
 * parts for `formatCashbackLink`. The key is never stored.
 */
export async function resolveClaimLinkByCode(
  code: string,
): Promise<{ kind: 'ok'; ref: string; key: string } | RedeemFailure> {
  const canonical = canonicaliseTypedClaimCode(code)
  if (!canonical) return { kind: 'not_found' }

  const config = await gatewayConfig().catch(() => null)
  if (!config) return { kind: 'unreachable', reason: 'network' }
  if (!cashbackEnabled(config)) return { kind: 'disabled' }

  const resolved = await resolveClaimUrl(canonical)
  if ('kind' in resolved) return resolved

  const parsed = parseClaimUrl(resolved.claimUrl, config.cashbackOrigins)
  if (!parsed) return { kind: 'invalid', reason: 'untrusted_claim_url' }
  return { kind: 'ok', ref: parsed.claimRef, key: parsed.claimKey }
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

  return redeemParsedClaim(parsed)
}

/**
 * What the confirm prompt shows BEFORE anything is spent (claim links phase 1, spec 4.3).
 *
 * Read from the portal's public metadata, which is non-destructive: the ciphertext endpoint is
 * never touched here, so a claim link can be opened, prefetched or re-rendered any number of
 * times and the voucher stays where it is. The ref is checked against the claim pattern first; the
 * key is not needed and not taken.
 *
 * `mintTrusted` is whether this wallet trusts any mint at all. The voucher's own mint is inside
 * the ciphertext and cannot be read without spending the claim, so the redeem checks it after the
 * tap (`commitToken` holds a token at a mint it does not trust). A wallet that trusts NO mint would
 * hold every claim, so the prompt refuses to start one.
 */
export type ClaimSummary =
  | {
      kind: 'ok'
      /** The portal's record status: Unclaimed, Claimed, Expired, Revoked or ManualAttention. */
      status: string
      amountMinor: number | null
      unit: string | null
      decimals: number | null
      memo: string | null
      expiresAt: string | null
      claimedAt: string | null
      revokedAt: string | null
      /** The stall that funded the cashback, hex. */
      issuerPubkey: string | null
      mintTrusted: boolean
    }
  | { kind: 'not_found' }
  | { kind: 'unreachable' }
  | { kind: 'disabled' }

export async function fetchClaimSummary(ref: string): Promise<ClaimSummary> {
  if (!CLAIM_REF_RE.test(ref)) return { kind: 'not_found' }

  const config = await gatewayConfig().catch(() => null)
  if (!config) return { kind: 'unreachable' }
  if (!cashbackEnabled(config)) return { kind: 'disabled' }

  let response: Response
  try {
    response = await fetchWithTimeout(PUBLIC_META_PATH + encodeURIComponent(ref), {
      method: 'GET',
      headers: { Accept: 'application/json' },
    })
  } catch {
    return { kind: 'unreachable' }
  }
  if (response.status === 404) return { kind: 'not_found' }
  if (response.status !== 200) return { kind: 'unreachable' }

  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body.status !== 'string') return { kind: 'unreachable' }

  await loadTrustedMints()
  const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null)
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  return {
    kind: 'ok',
    status: body.status,
    amountMinor: num(body.amountMinor),
    unit: str(body.unit),
    decimals: num(body.decimals),
    memo: str(body.memo),
    expiresAt: str(body.expiresAt),
    claimedAt: str(body.claimedAt),
    revokedAt: str(body.revokedAt),
    issuerPubkey: str(body.issuerPubkey)?.toLowerCase() ?? null,
    mintTrusted: trustedMintUrls().length > 0,
  }
}

/**
 * Redeem a claim that arrived as a LINK rather than as a typed code.
 *
 * The hosted claim page hands over `ref` and the key from its fragment, and the
 * wallet performs the redeem itself. That split is deliberate and it is the fix
 * for a real bug: the page used to fetch the ciphertext on load, which spent the
 * claim into a browser tab that could not keep it, so anyone without a wallet
 * installed lost the voucher by looking at it.
 *
 * The URL is rebuilt here from the trusted-origin list rather than taken from
 * the caller, so a link cannot name its own host. `ref` and `key` are still
 * checked against the same patterns `parseClaimUrl` enforces.
 */
export async function redeemClaimRef(ref: string, key: string): Promise<RedeemResult> {
  if (!CLAIM_REF_RE.test(ref)) return { kind: 'not_found' }
  if (!CLAIM_KEY_RE.test(key)) return { kind: 'invalid', reason: 'untrusted_claim_url' }

  const config = await gatewayConfig().catch(() => null)
  if (!config) return { kind: 'unreachable', reason: 'network' }
  if (!cashbackEnabled(config)) return { kind: 'disabled' }

  // The origin comes from config, never from the link. A claim link can only
  // ever point at a host this deployment already trusts.
  const origin = config.cashbackOrigins[0]
  if (!origin) return { kind: 'invalid', reason: 'untrusted_claim_url' }

  return redeemParsedClaim({
    claimRef: ref,
    claimKey: key,
    ciphertextUrl: `https://${origin}/c/${ref}/ciphertext`,
  })
}

/**
 * The half of redemption that is the same however the claim arrived.
 *
 * Ordered so everything fallible and reversible happens before the one step
 * that is neither: the metadata read precedes the destructive claim, so a
 * success screen can name a real amount even if the commit must be replayed.
 */
async function redeemParsedClaim(parsed: ParsedClaimUrl): Promise<RedeemResult> {
  const metadata = await fetchPublicMetadata(parsed.claimRef)

  // Owner rule 2026-10-13: a merchant account takes only its own stall's vouchers. Asked BEFORE
  // the destructive claim, from the portal's issuer, so a merchant never spends a customer's claim.
  const account = signerPubkey()
  if (account) {
    try {
      await refuseForeignIssuer(metadata.issuerPubkey, account)
    } catch (e) {
      if (e instanceof ForeignVoucherRefusedError) return { kind: 'merchant_refused', reason: e.reason }
      throw e
    }
  }

  const claimed = await claimCiphertext(parsed)
  if ('kind' in claimed) return claimed

  // From here the claim is spent. Persist before swapping so a crash is
  // recoverable, and only forget it once the mint has actually taken it.
  stashToken(claimed.token)
  // The trusted mints, before the gate is asked: until they are known it can
  // only defer, and a token is then kept rather than swapped.
  await loadTrustedMints()
  let outcome: CommitOutcome
  try {
    outcome = await commitToken(claimed.token)
  } catch (e) {
    return {
      kind: 'unreachable',
      reason: e instanceof Error && e.name === 'AbortError' ? 'timeout' : 'commit_failed',
    }
  }
  if (outcome.kind === 'held') return { kind: 'held', reason: outcome.reason }
  if (outcome.kind === 'refused') return { kind: 'refused', reason: outcome.reason }
  if (outcome.kind === 'merchant_refused') return { kind: 'merchant_refused', reason: outcome.reason }
  clearStashedToken(claimed.token)

  return { kind: 'ok', amountMinor: metadata.amountMinor, unit: metadata.unit, memo: metadata.memo }
}
