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

import { verifyNip98, type AuthFailure } from './nip98.js'

const PORT = Number(process.env.PORT ?? 8788)

/** Counters, in the same shape the audit API exposes. */
export const metrics = {
  requests: 0,
  errors: 0,
  requestSeconds: 0,
  /** Refusals by reason, so a caller failing in a loop is visible as a shape. */
  refusals: {} as Record<AuthFailure, number>,
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
    return json(res, 200, metrics)
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
    return json(res, 200, { pubkey: auth.pubkey })
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
