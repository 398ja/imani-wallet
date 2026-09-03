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

import { valueHolding, planSpend } from '@imani/wallet-core'

import { verifyNip98, type AuthFailure } from './nip98.js'
import { parseHolding, parsePlanRequest } from './holding.js'
import { createGuards, type StoredResponse } from './guards.js'

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
      available: plan.available,
      eligibleCount: plan.eligibleCount,
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
