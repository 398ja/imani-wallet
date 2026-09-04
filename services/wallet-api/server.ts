/**
 * The wallet API — a service that answers a signed request.
 *
 * This is the tracer bullet for the REST API epic (#3): one narrow path that
 * goes all the way through, so the shape of every later endpoint is settled
 * before there are many of them to change.
 *
 * ## What it is for
 *
 * The wallet holds bearer coupons in the browser. Some callers cannot: a
 * merchant's till, a back-office script, another service. They hold a key, and
 * this is where they present it.
 *
 * ## Why Node, again
 *
 * The same reason as `services/audit-api` and no other: the security boundary is
 * NIP-98 verification, and the wallet's signer is TypeScript. A Java port would
 * be a second implementation of the thing that must not drift, and the drift
 * would take the form of accepting a request the wallet did not sign.
 *
 * ## Authenticated, unlike the audit API
 *
 * The audit API is deliberately open, because everything it serves is already
 * public on the relay. Nothing here is. Every route below the health endpoint
 * requires a signature, and the identity of a caller IS the pubkey that signed
 * — there is no session, no cookie, and no token to steal, because a stolen
 * bearer token is exactly the failure a wallet full of bearer coupons cannot
 * afford twice.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

import { valueHolding, planSpend, checkRecipient, needsRecipientLookup } from '@imani/wallet-core'
import { merchantStats, outstandingLiability, expiringSoon } from '@imani/reports'

import { verifyNip98, type AuthFailure } from './nip98.js'
import { parseHolding, parsePlanRequest } from './holding.js'
import { parseReportRequest } from './reports.js'
import { parseCreateRequest, buildRequest, parseReconcileRequest, reconcile } from './requests.js'
import {
  parseVerifyInput,
  verifyCoupon,
  parseCheckInput,
  checkRedemption,
  receiveUrl,
  receiveBody,
} from './redeem.js'
import { parsePrepareRequest, requestSplit, buildRumor, splitUrl, splitBody } from './prepare.js'
import { createGuards, type StoredResponse } from './guards.js'
import { createStallLookup } from './stallLookup.js'

const PORT = Number(process.env.PORT ?? 8788)

/** Counters, in the same shape the audit API exposes. */
export const metrics = {
  requests: 0,
  errors: 0,
  requestSeconds: 0,
  /** Refusals by reason, so a caller failing in a loop is visible as a shape. */
  refusals: {} as Record<AuthFailure, number>,
  /** Malformed requests, which are a caller-integration signal, not an outage. */
  validationErrors: 0,
  /**
   * Sends refused because the recipient could not receive these coupons,
   * counted by reason and SEPARATELY from other failures.
   *
   * An operator watching this can tell a caller repeatedly aiming at the wrong
   * stall (a bug in their script) from a relay outage (a bug in ours), which
   * are the same 200-with-a-refusal on the wire.
   */
  recipientRefusals: {} as Record<string, number>,
  /**
   * Parts prepared, and failures by reason.
   *
   * Separate from `errors` because a prepare that fails is the one failure
   * where a caller might have half-moved money, so an operator needs to see it
   * without reading logs. `gateway-unreachable` climbing is an outage;
   * `gateway-swap_rejected` climbing is callers spending coupons that are
   * already spent, which is a wallet bug somewhere else entirely.
   */
  prepared: 0,
  prepareFailures: {} as Record<string, number>,
}

/**
 * Replay, idempotency and throttling state.
 *
 * Module-level, so it is per PROCESS. That is a real constraint and worth being
 * honest about: run two replicas behind a load balancer and each holds its own
 * view, so a replay could be accepted once per replica. The service is
 * otherwise stateless by design (ADR 0001), and a shared store would be the
 * database this architecture deliberately does not have.
 *
 * Staging is single-replica, which is what makes this adequate today. Scaling
 * out needs a shared store and a decision record, not a bigger cap.
 */
export const guards = createGuards()

/**
 * Recipient lookups. Module-level for the same reason as the guards: this
 * service holds no database, and the cache is per process.
 */
let stalls = createStallLookup()

/**
 * Substitute the lookup, for tests only.
 *
 * The fail-closed branch is the most important behaviour in this file and it
 * only happens when the network is down. A guarantee that cannot be exercised
 * under failure is a claim, so this seam exists to make the outage testable —
 * over real HTTP, against the real handler, rather than by reasoning about it.
 */
export function setStallLookup(lookup: ReturnType<typeof createStallLookup>): void {
  stalls = lookup
}

export function resetStallLookup(): void {
  stalls = createStallLookup()
}

/**
 * How the gateway is called.
 *
 * A seam for the same reason the lookup has one, and a more important one: the
 * behaviours that matter most on this path only happen when the gateway FAILS.
 * "A gateway failure leaves the caller's holding unchanged and says so plainly"
 * is the ticket's requirement, and a guarantee that cannot be exercised under
 * failure is a claim rather than a property.
 *
 * Substituting the transport keeps every other layer real: the request still
 * arrives over a socket, is still verified, still passes the guards, and the
 * answer is still assembled by the handler that ships.
 */
let gatewayFetch: typeof fetch = fetch

export function setGatewayFetch(impl: typeof fetch): void {
  gatewayFetch = impl
}

export function resetGatewayFetch(): void {
  gatewayFetch = fetch
}

/** One header, lower-cased and de-duplicated, or undefined. */
function header(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name]
  // Node gives an ARRAY when a header appears twice. Taking the first would let
  // a caller send two Idempotency-Keys and have the service silently pick one.
  const value = Array.isArray(raw) ? raw[0] : raw
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  const payload = JSON.stringify(body, null, 2)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    // NOT CORS-open, unlike the audit API. That service serves public data on
    // purpose; this one serves a caller's own data, and a wildcard here would
    // let any page a caller visits spend their identity.
    'cache-control': 'no-store',
    // A signature is not a bearer token, but browsers cache and prefetch, and
    // neither should ever happen to an authenticated response.
    'x-content-type-options': 'nosniff',
  })
  res.end(payload)
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    // Bounded before parsing, and before hashing: the payload check hashes the
    // body, so an unbounded read would let an unauthenticated caller spend our
    // memory and CPU before ever proving who they are.
    if (size > 1_000_000) throw new Error('body too large')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * The status for a refusal.
 *
 * Every one of these is 401 — the caller is not authenticated — and the reason
 * is in the body rather than in the code, because HTTP has no status for "your
 * clock is wrong" and inventing one would only confuse a proxy.
 */
function refuse(res: ServerResponse, reason: AuthFailure, detail: string) {
  metrics.refusals[reason] = (metrics.refusals[reason] ?? 0) + 1
  // `WWW-Authenticate` so a caller discovers the scheme from a refusal rather
  // than from documentation they have not read yet.
  res.setHeader('www-authenticate', 'Nostr')
  json(res, 401, { error: reason, detail })
}

/**
 * May these coupons go to this recipient?
 *
 * Shared by the plan and by prepare, and shared deliberately rather than
 * copied. The plan's refusal is advice — nothing has moved — while prepare's
 * refusal is the last moment the money is still whole. Two implementations
 * would eventually differ, and the one that would drift open is the one that
 * actually spends.
 *
 * Returns the refusal, or `null` when the send may proceed.
 */
async function refuseRecipient(
  senderPubkey: string,
  recipientPubkey: string,
  stallId: string | undefined,
): Promise<{ reason: string; detail: string } | null> {
  /**
   * The lookup is skipped for a redemption or a self-send, which are decided
   * from the keys alone.
   *
   * Not an optimisation. Redemption is the overwhelmingly common case and the
   * one a market stall depends on, so it must keep working when the relay does
   * not — and that is exactly what makes refusing on `unknown` affordable
   * rather than an outage for the whole market.
   */
  let role: 'stall' | 'customer' | 'unknown' = 'unknown'
  if (needsRecipientLookup(senderPubkey, recipientPubkey, stallId)) {
    try {
      role = await stalls.role(recipientPubkey)
    } catch {
      // `unknown`, NOT a 500.
      //
      // The lookup already catches its own failures, so this should be
      // unreachable — but "should be" is doing load-bearing work in a sentence
      // about the money path. A thrown error escaping to the generic handler
      // answers 500 with "internal error", which tells a caller nothing about
      // whether their send was refused or half-done.
      //
      // Degrading to `unknown` keeps the fail-closed guarantee a property of
      // THIS function rather than of the lookup's internals: whatever goes
      // wrong upstream, the send is refused and the caller is told the check
      // could not be made and nothing has moved.
      role = 'unknown'
    }
  }

  const verdict = checkRecipient({
    senderPubkey,
    recipientPubkey,
    issuerPubkey: stallId,
    recipientRole: role,
  })

  if (verdict.allowed) return null

  metrics.recipientRefusals[verdict.reason] = (metrics.recipientRefusals[verdict.reason] ?? 0) + 1
  return { reason: verdict.reason, detail: verdict.detail }
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const path = url.pathname.replace(/\/$/, '') || '/'
  const method = (req.method ?? 'GET').toUpperCase()

  // Liveness, and unauthenticated on purpose: an orchestrator has no key, and a
  // health check that requires one is a health check that fails closed at 3am.
  //
  // It holds no upstream, so unlike the audit API there is nothing to report
  // degraded — this service answers from the request alone.
  if (path === '/health') {
    return json(res, 200, { status: 'ok' })
  }

  if (path === '/metrics') {
    return json(res, 200, { ...metrics, guards: guards.stats, stores: guards.sizes(Date.now()) })
  }

  const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(req)

  const auth = verifyNip98({
    header: req.headers.authorization,
    // Rebuilt from the request rather than trusted from the `u` tag, which
    // would make the check circular: comparing the caller's claim to itself.
    url: url.toString(),
    method,
    body,
  })

  if (!auth.ok) return refuse(res, auth.reason, auth.detail)

  /**
   * Replay, idempotency and throttling — after authentication, before any work.
   *
   * After, because every one of them is scoped to a caller and there is no
   * caller until a signature has verified. Keying a rate limit on an unverified
   * pubkey would let anyone throttle anyone by claiming their key.
   *
   * Before, because a guard that runs after the work has already let the work
   * happen. For a spend that is a second payment.
   *
   * Health and metrics sit above this deliberately: an orchestrator polling
   * liveness must never be throttled, and has no key to be throttled by.
   */
  const idempotencyKey = header(req, 'idempotency-key')

  /**
   * Answer, and remember the answer if the caller asked for idempotency.
   *
   * Central rather than a `remember` call beside every `json(...)`, because
   * that pattern only has to be forgotten ONCE — on the spend endpoint, by
   * whoever adds it — for a retry to become a second payment. Routing every
   * answer through one function makes forgetting impossible rather than
   * unlikely.
   *
   * Only 2xx is stored. A 400 tells a caller their request was malformed, and
   * replaying that for 24 hours would keep answering "malformed" after they had
   * fixed it. Errors are also the answers most worth retrying for real.
   */
  const answer = (status: number, payload: unknown): void => {
    if (idempotencyKey !== undefined && status >= 200 && status < 300) {
      guards.remember({
        pubkey: auth.pubkey,
        idempotencyKey,
        response: { status, body: payload } satisfies StoredResponse,
        now: Date.now(),
      })
    }
    json(res, status, payload)
  }

  const verdict = guards.check({
    eventId: auth.eventId,
    pubkey: auth.pubkey,
    idempotencyKey,
    now: Date.now(),
  })

  if (!verdict.allowed) {
    if (verdict.reason === 'idempotent-replay') {
      // The ORIGINAL answer, not a fresh one, and marked so a caller can tell
      // its retry from its first attempt — which is the difference between
      // "this ran twice" and "this ran once and I asked twice".
      res.setHeader('idempotency-replayed', 'true')
      return json(res, verdict.stored.status, verdict.stored.body)
    }

    if (verdict.reason === 'rate-limited') {
      // `Retry-After` in seconds, which is what every HTTP client already
      // understands. Repeated in the body because a caller reading JSON should
      // not have to reach for headers to back off correctly.
      res.setHeader('retry-after', String(verdict.retryAfterSeconds))
      return json(res, 429, {
        error: 'rate-limited',
        detail: verdict.detail,
        retryAfterSeconds: verdict.retryAfterSeconds,
      })
    }

    if (verdict.reason === 'at-capacity') {
      res.setHeader('retry-after', '5')
      return json(res, 503, { error: 'at-capacity', detail: verdict.detail })
    }

    // A replay is 409: the request is well-formed and correctly signed, and
    // conflicts with one already handled. NOT 401 — the signature is valid, and
    // telling a caller their signature failed would send them at their key.
    return json(res, 409, { error: 'replay', detail: verdict.detail })
  }

  /**
   * The tracer bullet: tell a caller who they are.
   *
   * Trivial on purpose. It exercises the entire path — header parsing,
   * signature verification, freshness, URL and method binding, the refusal
   * shape, metrics — and holds no state, so when it works the next endpoint is
   * only a handler.
   *
   * It is also the endpoint a caller hits FIRST when their signing is broken,
   * and being able to say "you are this pubkey" separates a bad key from a bad
   * request in one call.
   */
  if (path === '/v1/whoami' && method === 'GET') {
    return answer(200, { pubkey: auth.pubkey })
  }

  /**
   * What a holding is worth, grouped by stall and currency.
   *
   * POST rather than GET, and that is not REST pedantry: the holding is the
   * request. A GET would have to carry hundreds of coupons in a URL, where they
   * would land in access logs and proxy caches — coupons are BEARER
   * instruments, so a logged one is a spendable one.
   *
   * State-in, state-out (ADR 0001). The coupons arrive here, are valued, and
   * are gone when the response ends: no store, no cache, no log line carrying
   * them. That is what makes a breach of this service a denial of service
   * rather than a theft.
   */
  if (path === '/v1/holding/value' && method === 'POST') {
    let parsedBody: unknown
    try {
      parsedBody = JSON.parse(body ?? '')
    } catch {
      return json(res, 400, {
        error: 'invalid-json',
        field: 'body',
        detail: 'the request body is not valid JSON',
      })
    }

    const holding = parseHolding(parsedBody)
    if (!holding.ok) {
      metrics.validationErrors++
      return json(res, 400, {
        error: 'invalid-request',
        field: holding.error.field,
        detail: holding.error.detail,
      })
    }

    // The same function the app's money logic uses, from @imani/wallet-core.
    // A second implementation here is the one thing that could make the API and
    // the app disagree about what a customer holds.
    const value = valueHolding(holding.value as never)

    return answer(200, {
      groups: value.groups,
      unusable: value.unusable,
      couponCount: value.couponCount,
    })
  }

  /**
   * Read a JSON body, or the 400 to answer with.
   *
   * Shared by every endpoint added after the first three, which each repeated
   * this block. Counts a malformed body as a validation error so the metric
   * keeps meaning "callers are getting the shape wrong".
   */
  const readJson = (raw: string | undefined) => {
    try {
      return { ok: true as const, value: JSON.parse(raw ?? '') as unknown }
    } catch {
      metrics.validationErrors++
      return {
        ok: false as const,
        problem: { error: 'invalid-json', field: 'body', detail: 'the request body is not valid JSON' },
      }
    }
  }

  /**
   * Both report endpoints take the same body, so they parse it the same way.
   *
   * Counts a bad body as a validation error, like every other endpoint, so the
   * metric keeps meaning "callers are getting the shape wrong" rather than
   * silently excluding whichever endpoints were added last.
   */
  const readReport = (raw: string | undefined) => {
    let parsedBody: unknown
    try {
      parsedBody = JSON.parse(raw ?? '')
    } catch {
      metrics.validationErrors++
      return {
        ok: false as const,
        problem: { error: 'invalid-json', field: 'body', detail: 'the request body is not valid JSON' },
      }
    }
    const report = parseReportRequest(parsedBody, Date.now())
    if (!report.ok) {
      metrics.validationErrors++
      return {
        ok: false as const,
        problem: { error: 'invalid-request', field: report.error.field, detail: report.error.detail },
      }
    }
    return { ok: true as const, value: report.value }
  }

  /**
   * Is this coupon real, unexpired, and mine to honour?
   *
   * Nothing moves. A till asks this while the customer is still standing there,
   * so it must answer from the bytes alone — no mint, no network.
   *
   * Says nothing about whether the coupon has been SPENT: that is the mint's
   * answer, and asking here would turn a local check into a round trip at the
   * slowest possible moment. What this settles is that the coupon is genuine,
   * which is the part a caller cannot do for itself.
   */
  if (path === '/v1/redeem/verify' && method === 'POST') {
    const parsed = readJson(body)
    if (!parsed.ok) return json(res, 400, parsed.problem)

    const input = parseVerifyInput(parsed.value, auth.pubkey, Math.floor(Date.now() / 1000))
    if (!input.ok) {
      metrics.validationErrors++
      return json(res, 400, { error: 'invalid-request', field: input.error.field, detail: input.error.detail })
    }

    // 200 even when the coupon is refused: the question was answered, and the
    // answer is that this coupon must not be taken. A 4xx would mean the
    // REQUEST was wrong, which is a different thing a caller fixes differently.
    return answer(200, verifyCoupon(input.value))
  }

  /**
   * Would taking this amount breach what the issuer signed?
   *
   * The only check that sees ACROSS redemptions — the one that notices the same
   * coupon presented until it exceeds its face. The service holds no history,
   * so the caller sends what it has and gets a verdict.
   *
   * The BOUND is never caller-supplied: it is read from the verified voucher,
   * because a ceiling the presenter chose is not a ceiling. That is why this
   * verifies the token again rather than trusting a face value in the body.
   */
  if (path === '/v1/redeem/check' && method === 'POST') {
    const parsed = readJson(body)
    if (!parsed.ok) return json(res, 400, parsed.problem)

    const input = parseCheckInput(parsed.value, auth.pubkey, Math.floor(Date.now() / 1000))
    if (!input.ok) {
      metrics.validationErrors++
      return json(res, 400, { error: 'invalid-request', field: input.error.field, detail: input.error.detail })
    }

    return answer(200, checkRedemption(input.value))
  }

  /**
   * What to sign to accept a coupon.
   *
   * A courier, for the reason ADR 0001 gives: accepting means swapping at the
   * mint, and this service holds no credential to present there. If it did,
   * that credential would be a way to redeem any coupon anyone sent it.
   *
   * The body is serialised ONCE and returned as a string to be signed byte for
   * byte. Re-serialising it changes the payload hash, and the gateway then
   * refuses the request from a service the caller never addressed directly.
   */
  if (path === '/v1/redeem/prepare' && method === 'POST') {
    const parsed = readJson(body)
    if (!parsed.ok) return json(res, 400, parsed.problem)

    const input = parseVerifyInput(parsed.value, auth.pubkey, Math.floor(Date.now() / 1000))
    if (!input.ok) {
      metrics.validationErrors++
      return json(res, 400, { error: 'invalid-request', field: input.error.field, detail: input.error.detail })
    }

    // Verified first, so a caller is never handed instructions for accepting a
    // coupon that was never going to be honoured.
    const verdict = verifyCoupon(input.value)
    if (!verdict.ok) return answer(200, verdict)

    return answer(200, {
      ok: true,
      voucher: verdict.voucher,
      url: receiveUrl(),
      method: 'POST',
      body: receiveBody(input.value.token),
    })
  }

  /**
   * Ask a customer to pay.
   *
   * The `vreqA` string is built by `shared/nut18v.js` — the SAME encoder the
   * app loads — because the wire format has to match
   * `VoucherPaymentRequest.java` byte for byte. A request this service encoded
   * slightly differently would scan, look right, and be refused by the gateway.
   *
   * The recipient is always the signing key and cannot be overridden. Takings
   * are gift-wrapped to whoever the request names, so a request naming anything
   * else would send a customer's payment to a key its owner cannot decrypt:
   * money stranded rather than merely misrouted.
   */
  if (path === '/v1/requests/create' && method === 'POST') {
    let parsedBody: unknown
    try {
      parsedBody = JSON.parse(body ?? '')
    } catch {
      metrics.validationErrors++
      return json(res, 400, { error: 'invalid-json', field: 'body', detail: 'the request body is not valid JSON' })
    }

    const request = parseCreateRequest(parsedBody, auth.pubkey)
    if (!request.ok) {
      metrics.validationErrors++
      return json(res, 400, { error: 'invalid-request', field: request.error.field, detail: request.error.detail })
    }

    return answer(200, { request: buildRequest(request.value, Math.floor(Date.now() / 1000)) })
  }

  /**
   * What arrived, against what was asked for.
   *
   * One endpoint rather than separate match and reconcile calls: matching a
   * single arrival is the same computation as reconciling a day of them, and
   * two endpoints would be two chances to disagree about which request a
   * payment settled.
   *
   * Answers with the requests as they now stand, the settlements found, and
   * what is still outstanding — including how much of an outstanding request
   * has partially arrived, because "unpaid" and "half paid" are different
   * problems for a merchant.
   */
  if ((path === '/v1/requests/reconcile' || path === '/v1/requests/match') && method === 'POST') {
    let parsedBody: unknown
    try {
      parsedBody = JSON.parse(body ?? '')
    } catch {
      metrics.validationErrors++
      return json(res, 400, { error: 'invalid-json', field: 'body', detail: 'the request body is not valid JSON' })
    }

    const parsed = parseReconcileRequest(parsedBody, Date.now())
    if (!parsed.ok) {
      metrics.validationErrors++
      return json(res, 400, { error: 'invalid-request', field: parsed.error.field, detail: parsed.error.detail })
    }

    return answer(200, reconcile(parsed.value))
  }

  /**
   * A stall's own numbers, over rows the caller supplies.
   *
   * POST for the same reason `/v1/holding/value` is: the history IS the
   * request, and it carries voucher ids and amounts that have no business in an
   * access log or a proxy cache.
   *
   * Computed by `@imani/reports`, which is the same code the app's dashboard
   * calls. A second implementation here would be worse than useless — two
   * dashboards disagreeing about takings is indistinguishable from money going
   * missing.
   *
   * NOT proxied to the gateway's own dashboard endpoint. That one answers 200
   * with zeros: it is fed by sources which deliberately do not consult
   * customer-wallet, so a merchant who has issued three coupons is told they
   * have issued none.
   */
  if (path === '/v1/reports/dashboard' && method === 'POST') {
    const parsed = readReport(body)
    if (!parsed.ok) return json(res, 400, parsed.problem)

    const { transactions, pubkey, unit, decimals, from, now } = parsed.value
    return answer(200, {
      stats: merchantStats(transactions, { pubkey, unit, decimals, from, now }),
    })
  }

  /**
   * What is still owed, and what is about to expire.
   *
   * Separate from the dashboard because they answer different questions and a
   * caller usually wants one of them: outstanding liability is an accounting
   * figure, and expiring-soon is an operational one that drives a reminder.
   */
  if (path === '/v1/reports/records' && method === 'POST') {
    const parsed = readReport(body)
    if (!parsed.ok) return json(res, 400, parsed.problem)

    const { transactions, pubkey, unit, now } = parsed.value
    return answer(200, {
      // Minor units, like every other amount this service reports. Rendering
      // is the caller's decision, so `unit` and `decimals` travel with it.
      outstanding: outstandingLiability(transactions, { pubkey, unit, now }),
      unit,
      decimals: parsed.value.decimals,
      expiringSoon: expiringSoon(transactions, { now }),
    })
  }

  /**
   * Which coupons would be spent for an amount, or why none can be.
   *
   * Nothing moves. This is the question asked before the money is touched,
   * which is what lets an impossible spend fail while the holding is still
   * whole — and it is why the answer to a spend that cannot be made is an
   * OBSTACLE rather than an error.
   *
   * The obstacle distinguishes "you do not hold enough" from "you hold enough
   * but it cannot be split to this amount". Only the first is solved by waiting
   * for more coupons; a caller told merely "failed" retries forever.
   *
   * Every decision comes from @imani/wallet-core, so this is the same plan the
   * wallet app would make from the same holding. `planParity.test.ts` pins it.
   */
  if (path === '/v1/spend/plan' && method === 'POST') {
    let parsedBody: unknown
    try {
      parsedBody = JSON.parse(body ?? '')
    } catch {
      return answer(400, {
        error: 'invalid-json',
        field: 'body',
        detail: 'the request body is not valid JSON',
      })
    }

    const request = parsePlanRequest(parsedBody)
    if (!request.ok) {
      metrics.validationErrors++
      return answer(400, {
        error: 'invalid-request',
        field: request.error.field,
        detail: request.error.detail,
      })
    }

    /**
     * The recipient check runs BEFORE planning, and planning moves nothing
     * either — so a refusal here happens while the holding is still whole and
     * before anything could have moved. That ordering is the ticket's
     * requirement and it is cheap to honour, because both steps are reads.
     *
     * Only performed when a recipient was named. A caller asking "can I afford
     * this?" has no recipient yet, and requiring one would make the cheap
     * question depend on a network round trip.
     */
    if (request.value.recipientPubkey !== undefined) {
      const refusal = await refuseRecipient(
        auth.pubkey,
        request.value.recipientPubkey,
        request.value.stallId,
      )

      if (refusal) {
        // 200 with a refusal, like an obstacle: the question was answered, and
        // the answer is that this send must not happen. The `refusal` field is
        // separate from `obstacle` because they are different problems — one is
        // about the coupons, the other about where they were going.
        return answer(200, {
          parts: [],
          obstacle: null,
          refusal,
          available: 0,
          eligibleCount: 0,
        })
      }
    }

    const plan = planSpend({
      coupons: request.value.coupons as never,
      stallId: request.value.stallId,
      currency: request.value.currency,
      amount: request.value.amount,
    })

    // 200 even when there is an obstacle. The question "can this be spent?" was
    // answered successfully; the answer being "no" is not a failed request, and
    // a 4xx here would make a caller's error handling fire on a normal result.
    return answer(200, {
      parts: plan.parts,
      obstacle: plan.obstacle,
      refusal: null,
      available: plan.available,
      eligibleCount: plan.eligibleCount,
    })
  }

  /**
   * Prepare one part: replacement coupons, and an unsigned event to sign.
   *
   * The point of the whole API. Everything before this is a read; this is
   * where a script can spend.
   *
   * ## What it does, and what it deliberately cannot
   *
   * The gateway is asked to split the coupon — forwarding the CALLER's own
   * signature, never one this service produced, because this service holds no
   * credential of its own to produce. Back come two coupons: the part being
   * sent, and the change. The service wraps the sent part in an UNSIGNED NIP-17
   * rumor addressed to the recipient and returns both.
   *
   * The caller signs that rumor locally and publishes it. This service cannot:
   * sealing a rumor needs the customer's private key, which it has never had
   * (ADR 0001, ADR 0002). A total compromise here denies callers a wallet; it
   * does not take their money.
   *
   * ## One part at a time
   *
   * A plan's parts fail independently, so preparing one touches nothing else,
   * and the caller owns the retry loop — which is correct, because the caller
   * owns the coupons.
   *
   * ## The dangerous moment
   *
   * Between the gateway minting the replacements and the caller persisting
   * them, a lost response is lost coupons. So the answer carries everything
   * needed to recover in ONE write, and a retry with the same idempotency key
   * returns that same answer rather than splitting again — `answer` above
   * stores it, and the guard replays it before any work happens.
   */
  if (path === '/v1/spend/parts/prepare' && method === 'POST') {
    let parsedBody: unknown
    try {
      parsedBody = JSON.parse(body ?? '')
    } catch {
      return answer(400, {
        error: 'invalid-json',
        field: 'body',
        detail: 'the request body is not valid JSON',
      })
    }

    const request = parsePrepareRequest(parsedBody)
    if (!request.ok) {
      metrics.validationErrors++
      return answer(400, {
        error: 'invalid-request',
        field: request.error.field,
        detail: request.error.detail,
      })
    }

    /**
     * The recipient check runs BEFORE the split, which is the whole reason it
     * is worth running at all here. Once the gateway has split, the sent half
     * exists and is addressed to somebody; refusing afterwards would leave the
     * caller holding a coupon they cannot deliver and did not ask for.
     */
    const refusal = await refuseRecipient(
      auth.pubkey,
      request.value.recipientPubkey,
      request.value.stallId,
    )

    if (refusal) {
      // 200 with a refusal and no coupons, matching the plan's shape. Nothing
      // was split, which is what `holdingUnchanged` says out loud: a caller
      // reading only this field knows not to reconcile.
      return answer(200, {
        prepared: null,
        refusal,
        holdingUnchanged: true,
      })
    }

    const outcome = await requestSplit(request.value, gatewayFetch)

    if (!outcome.ok) {
      metrics.prepareFailures[outcome.code] = (metrics.prepareFailures[outcome.code] ?? 0) + 1

      // NOT stored against the idempotency key — `answer` only remembers 2xx —
      // so a caller retrying a failed prepare with the same key really does
      // retry, rather than being handed the failure forever.
      return json(res, outcome.status, {
        error: outcome.code,
        detail: outcome.detail,
        // The load-bearing field. Every failure path above reaches the gateway
        // either not at all or without a split, so the caller's coupon is still
        // theirs and still whole. A caller that cannot tell "refused" from
        // "half-done" must reconcile after every error.
        holdingUnchanged: true,
      })
    }

    const split = outcome.split

    metrics.prepared++

    return answer(200, {
      prepared: {
        /**
         * The coupons that REPLACE the one being spent. Both of them, in one
         * answer, because this is the write a caller must commit atomically:
         * the source coupon is gone at the mint the moment the gateway
         * answered, and these two are what exists instead.
         *
         * `change` is null for a full send — the whole coupon went — rather
         * than a zero-valued coupon, which would be a coupon that cannot be
         * spent and would sit in a holding forever.
         */
        replaces: request.value.couponId ?? null,
        sent: {
          token: split.send_token,
          faceValue: split.send_face_value,
          faceUnit: split.face_unit ?? request.value.currency ?? null,
          faceDecimals: split.face_decimals ?? request.value.decimals ?? null,
          tokenAmount: split.send_token_amount ?? null,
          couponId: split.sent_voucher_id ?? null,
          stallId: split.issuer_id ?? request.value.stallId ?? null,
        },
        change:
          split.keep_token === undefined || split.keep_token === null || split.keep_token === ''
            ? null
            : {
                token: split.keep_token,
                faceValue: split.keep_face_value,
                faceUnit: split.face_unit ?? request.value.currency ?? null,
                faceDecimals: split.face_decimals ?? request.value.decimals ?? null,
                tokenAmount: split.keep_token_amount ?? null,
                stallId: split.issuer_id ?? request.value.stallId ?? null,
              },
        /**
         * The unsigned event. No `id`, no `pubkey`, no `sig` — the caller
         * supplies all three by sealing and wrapping it with their own key.
         *
         * Named `unsignedEvent` rather than `event` because the distinction is
         * the entire security property, and a field called `event` is one a
         * caller publishes directly and then wonders why nothing arrives.
         */
        unsignedEvent: buildRumor(request.value, split, auth.pubkey),
        recipientPubkey: request.value.recipientPubkey,
      },
      refusal: null,
      /**
       * FALSE, and this is the one place it is. The gateway has split; the
       * source coupon no longer exists and the two above are what replaced it.
       * Persist before doing anything else.
       */
      holdingUnchanged: false,
    })
  }

  /**
   * What to sign for the gateway, for a part you are about to prepare.
   *
   * Prepare needs a SECOND signature: one for this service, and one the service
   * forwards to the gateway, because it holds no credential of its own. That is
   * the single hardest thing about integrating, and the failure mode is a
   * `payload-mismatch` from a service the caller never addressed directly.
   *
   * So the URL and the exact body bytes are answered here rather than
   * documented and re-derived. A caller hashes the `body` string verbatim —
   * re-serialising it changes the hash and the gateway refuses the request.
   *
   * POST because the answer depends on the token and amount, and a token in a
   * URL is a bearer coupon in an access log.
   */
  if (path === '/v1/spend/parts/gateway-request' && method === 'POST') {
    let parsedBody: unknown
    try {
      parsedBody = JSON.parse(body ?? '')
    } catch {
      return answer(400, {
        error: 'invalid-json',
        field: 'body',
        detail: 'the request body is not valid JSON',
      })
    }

    const fields = (parsedBody ?? {}) as Record<string, unknown>
    if (typeof fields.token !== 'string' || fields.token.length === 0) {
      metrics.validationErrors++
      return answer(400, { error: 'invalid-request', field: 'token', detail: 'is required' })
    }
    if (typeof fields.amount !== 'number' || !Number.isInteger(fields.amount) || fields.amount <= 0) {
      metrics.validationErrors++
      return answer(400, {
        error: 'invalid-request',
        field: 'amount',
        detail: 'expected a positive whole number of minor units',
      })
    }

    return answer(200, {
      url: splitUrl(),
      method: 'POST',
      // The exact bytes. Sign THIS string; do not rebuild it.
      body: splitBody({ token: fields.token, amount: fields.amount }),
    })
  }

  // A 404 only AFTER authentication, so an unauthenticated caller cannot map
  // which routes exist by watching 404 and 401 differ.
  json(res, 404, { error: 'not found' })
}

export const server = createServer((req, res) => {
  const started = Date.now()
  void route(req, res)
    .catch((error) => {
      console.error('[wallet-api] request failed', error)
      metrics.errors++
      // The message is NOT echoed. This service sees signed bodies, and an
      // error string is the classic way one leaks back out.
      if (!res.headersSent) json(res, 500, { error: 'internal error' })
    })
    .finally(() => {
      metrics.requests++
      metrics.requestSeconds += (Date.now() - started) / 1000
    })
})

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  server.listen(PORT, () => {
    console.log(`[wallet-api] listening on ${PORT}`)
  })
}
