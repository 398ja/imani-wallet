/**
 * The hosted audit API — the trust product, served over HTTP.
 *
 * `src/lib/audit.ts` is the logic; this is only transport plus a cache. That
 * split is deliberate and load-bearing: the API must not be able to answer
 * differently from a merchant auditing themselves in the wallet, and the only
 * way to guarantee that is to run the same code rather than a second
 * implementation that agrees today.
 *
 * ## Why this is Node and not a Spring service
 *
 * Every other backend here is Java, so this is the odd one out and it is a
 * considered choice. The reader is 300 lines of signature checking and payload
 * validation whose correctness IS the product; a Java port would be a second
 * implementation of the security boundary, free to drift, and the drift would
 * take the form of an auditor being told a forged record is genuine. Reusing the
 * TypeScript reader makes that class of bug impossible.
 *
 * ## Read-only, unauthenticated, and holding nothing
 *
 * There is no database. The relay is the source of truth and this is a cache in
 * front of it. Nothing here can write an attestation, so a total compromise of
 * this service leaks what is already public and forges nothing — every answer it
 * gives is re-derivable by anyone with the relay URL and the reader.
 *
 * Unauthenticated because the design says the stream is broadly readable and the
 * payload, not the transport, is what protects the merchant. Putting auth here
 * would imply a confidentiality this data does not have.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

// BOTH from `nostr-tools/pool`, and that is not a style choice.
//
// `nostr-tools` and `nostr-tools/pool` are separate module instances, each with
// its own module-level `_WebSocket` that `useWebSocketImplementation` assigns.
// Importing `SimplePool` from the root and the setter from the subpath sets the
// transport on one instance while the pool reads the OTHER — measured: the
// connection opens, EOSE arrives, and every query returns 0 of 30 events.
import { SimplePool, useWebSocketImplementation } from 'nostr-tools/pool'
import WebSocketImpl from 'ws'

import { ATTESTATION_KIND } from '../../src/lib/attestationKind'
import {
  ABSENCE_SLA_MS,
  checkCoupon,
  findDuplicates,
  readAttestations,
  summarise,
  tallyDefects,
  verifyDisclosedTotal,
  type AuditedAttestation,
  type RejectedAttestation,
} from '../../src/lib/audit'
import { metrics, renderMetrics } from './metrics'

/**
 * nostr-tools talks to relays through a GLOBAL `WebSocket`, which the browser
 * provides and Node 20 does not.
 *
 * Without this the service starts cleanly, connects to nothing, and answers
 * every query with ZERO EVENTS — no error, no warning, no failed health check.
 * Measured in the built image: `typeof WebSocket === 'undefined'` and
 * `querySync` resolves `[]` against a relay holding 28 attestations.
 *
 * That is the worst possible failure for this particular service. An empty
 * stream does not read as "broken", it reads as "no redemptions", so every
 * coupon check would answer `missing` and the audit API would accuse every
 * merchant on the deployment of not publishing. The dashboard would show a flat
 * zero and look like a quiet day.
 *
 * `audit_api_relay_up` cannot catch it either: the query SUCCEEDS, it just
 * returns nothing. Hence a hard dependency here rather than a health probe.
 */
useWebSocketImplementation(WebSocketImpl)

const PORT = Number(process.env.AUDIT_API_PORT ?? 8090)
const RELAY_URL = process.env.AUDIT_RELAY_URL ?? 'ws://nostr-relay:7777'
/**
 * How long a fetched stream is reused.
 *
 * The relay is the source of truth and it is not ours to hammer: a dashboard
 * scraping every 15s and a handful of auditors must not become a query per
 * request. 30s is well inside the one-hour SLA, so a cached answer can never be
 * the reason a coupon looks missing.
 */
const CACHE_MS = Number(process.env.AUDIT_CACHE_MS ?? 30_000)
/** Bounded so a growing stream cannot turn one request into an unbounded fetch. */
const FETCH_LIMIT = Number(process.env.AUDIT_FETCH_LIMIT ?? 5000)
/**
 * Most redemptions one disclosure may cover.
 *
 * The only caller-controlled unbounded input on this service, and it drives
 * elliptic-curve work: 1,000 entries measured at ~82ms of blocked event loop,
 * 5,000 at ~400ms. 500 keeps a single request comfortably sub-50ms while being
 * far more than a stall discloses for a trading day.
 */
const DISCLOSURE_LIMIT = Number(process.env.AUDIT_DISCLOSURE_LIMIT ?? 500)
/** Tolerance for a caller whose clock runs slightly ahead of this server's. */
const CLOCK_SKEW_MS = 5 * 60 * 1000
/**
 * How far back a `redeemedAt` may reach before this service refuses to judge it.
 *
 * 30 days. Beyond that a `missing` verdict says more about how long the ledger
 * has existed than about the merchant, and an unbounded window lets anyone
 * backdate a claim to manufacture an accusation.
 */
const MAX_REDEEMED_AGE_MS = 30 * 24 * 60 * 60 * 1000

interface Snapshot {
  accepted: AuditedAttestation[]
  rejected: RejectedAttestation[]
  fetchedAt: number
  /**
   * The relay returned a full page, so events beyond the limit are not here.
   *
   * Load-bearing rather than diagnostic: a truncated stream drops the OLDEST
   * attestations, so a coupon whose record fell off the end answers `missing`
   * past the SLA. That is the false accusation this whole service is built to
   * avoid, arriving by the back door. Surfaced as a metric and refused as a
   * verdict below.
   */
  truncated: boolean
}

let cached: Snapshot | undefined
let inFlight: Promise<Snapshot> | undefined

/**
 * Fetch and audit the whole stream, at most once per `CACHE_MS`.
 *
 * `inFlight` collapses concurrent misses into ONE relay query. Without it, a
 * dashboard refresh and two auditors arriving together on a cold cache open
 * three websockets and do the same signature verification three times — and the
 * cost is paid on the relay, which is shared infrastructure.
 */
async function snapshot(): Promise<Snapshot> {
  if (cached && Date.now() - cached.fetchedAt < CACHE_MS) {
    metrics.cacheHits++
    return cached
  }
  if (inFlight) return inFlight

  metrics.cacheMisses++
  inFlight = (async () => {
    const pool = new SimplePool()
    const started = Date.now()
    try {
      const events = await pool.querySync([RELAY_URL], {
        kinds: [ATTESTATION_KIND],
        limit: FETCH_LIMIT,
      })
      const { accepted, rejected } = readAttestations(events)
      const truncated = events.length >= FETCH_LIMIT
      if (truncated) {
        console.warn(
          `[audit-api] relay returned ${events.length} events at the limit of ${FETCH_LIMIT}; ` +
            'older attestations are not in this snapshot and `missing` verdicts are suppressed',
        )
      }
      metrics.relayQueries++
      metrics.relayQuerySeconds += (Date.now() - started) / 1000
      metrics.lastFetchOk = 1
      cached = { accepted, rejected, fetchedAt: Date.now(), truncated }
      return cached
    } catch (error) {
      metrics.relayErrors++
      metrics.lastFetchOk = 0
      // Serve stale rather than fail. An audit answer from 90 seconds ago is
      // enormously more useful than a 502, and the alternative — reporting
      // "missing" because the relay was briefly unreachable — is the
      // false-accusation failure this whole feature is built to avoid.
      if (cached) {
        console.error('[audit-api] relay query failed, serving stale snapshot', error)
        return cached
      }
      throw error
    } finally {
      pool.close([RELAY_URL])
      inFlight = undefined
    }
  })()

  return inFlight
}

/**
 * Read and parse a JSON request body, bounded.
 *
 * The cap is not ceremony: this endpoint is unauthenticated and public, so an
 * unbounded read is a trivial way to exhaust the process's memory. 1 MB is far
 * more than any honest disclosure — a thousand nullifiers is ~66 KB.
 */
async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > 1_000_000) throw new Error('body too large')
    chunks.push(chunk as Buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  const payload = JSON.stringify(body, null, 2)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    // Public data, and CORS-open on purpose: the point of an audit service is
    // that anybody can check, including from a page this project did not write.
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
  })
  res.end(payload)
}

/** A 64-char hex string. Rejected early so a bad id never reaches a filter. */
const HEX64 = /^[0-9a-f]{64}$/i

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const path = url.pathname.replace(/\/$/, '') || '/'

  // Liveness. Deliberately does NOT touch the relay: a health check that fails
  // when its upstream is briefly down gets the container restarted mid-incident,
  // which helps nobody. Relay reachability is reported as a metric instead.
  //
  // It DOES report whether the stream is actually readable, because the failure
  // that hides here is silent and catastrophic: no transport means every query
  // returns zero events, which reads as "no redemptions" rather than as an
  // outage, and the API starts reporting honest merchants as `missing`.
  //
  // An earlier version tested `Boolean(WebSocketImpl)`, which is a STATIC
  // IMPORT and therefore always truthy — the 503 branch was unreachable and the
  // comment claiming it guarded anything was false. Review caught it.
  //
  // It reports rather than FAILS, and that is the deliberate half. A health
  // check that goes red on a transient upstream error gets the container
  // restarted mid-incident, losing the cache and helping nobody — the reason
  // this endpoint did not touch the relay in the first place. So a degraded
  // stream is visible in the body and in `audit_api_relay_up`, while the status
  // stays 200 for anything short of the service being unable to serve at all.
  if (path === '/health') {
    return json(res, 200, {
      status: cached && metrics.lastFetchOk === 0 ? 'degraded' : 'ok',
      // Absent until the first fetch, so a just-started service says nothing it
      // cannot support. Once it HAS read the relay, these are the numbers an
      // operator needs when the dashboard looks quiet.
      ...(cached ? { redemptions: cached.accepted.length, truncated: cached.truncated } : {}),
    })
  }

  if (path === '/metrics') {
    // Takes a SNAPSHOT rather than rendering whatever happens to be cached, and
    // that is the difference between a working dashboard and a blank one.
    //
    // Rendering `cached` meant the `audit_ledger_*` gauges did not exist until
    // somebody called an API endpoint — a scrape alone never fetched the stream.
    // On a real deployment nothing calls this API on a schedule, so Prometheus
    // would scrape `up`, collect the request counters, and the six panels that
    // actually describe the LEDGER would read "No data" indefinitely. Caught by
    // pointing real Prometheus at this service with the repo's own config and
    // running every dashboard query: 6 of 15 came back empty.
    //
    // Cheap, because `snapshot()` is the same 30s cache the API uses: a 15s
    // scrape interval mostly hits it, and two scrapes cannot stampede the relay
    // because `inFlight` collapses concurrent misses into one query.
    //
    // Failure here must still render. A relay outage should show up as
    // `audit_api_relay_up 0` beside the last known figures — which is precisely
    // what an operator needs — not as a failed scrape that also loses the
    // counters telling them the service is alive.
    const snap = await snapshot().catch(() => cached)
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' })
    return void res.end(renderMetrics(snap))
  }

  if (path === '/api/v1/audit/summary') {
    const { accepted, rejected, fetchedAt } = await snapshot()
    const duplicates = findDuplicates(accepted)
    const ledgers = [...new Set(accepted.map((a) => a.ledgerPubkey))]
    return json(res, 200, {
      redemptions: accepted.length,
      // Named `refused`, not `invalid`: an event this reader will not read is
      // not necessarily malformed — a future batched format is refused by a
      // reader that predates it, which is correct behaviour on both sides.
      refused: rejected.length,
      refusedReasons: tallyDefects(rejected),
      merchants: ledgers.length,
      units: [...new Set(accepted.map((a) => a.unit))].sort(),
      conflicts: duplicates.filter((d) => !d.benign).length,
      republished: duplicates.filter((d) => d.benign).length,
      fetchedAt,
    })
  }

  if (path === '/api/v1/audit/ledgers') {
    const { accepted } = await snapshot()
    const ledgers = [...new Set(accepted.map((a) => a.ledgerPubkey))]
    return json(res, 200, { ledgers: ledgers.map((k) => summarise(accepted, k)) })
  }

  const ledgerMatch = path.match(/^\/api\/v1\/audit\/ledger\/([^/]+)$/)
  if (ledgerMatch) {
    const key = ledgerMatch[1]
    if (!HEX64.test(key)) return json(res, 400, { error: 'ledger id must be 64 hex characters' })
    const { accepted } = await snapshot()
    // Always 200, even for a key with no records. A stall that has redeemed
    // nothing and a stall that does not exist are indistinguishable on a
    // pseudonymous stream by construction, and a 404 would invent a distinction
    // the data cannot support.
    return json(res, 200, {
      ...summarise(accepted, key),
      attestations: accepted
        .filter((a) => a.ledgerPubkey === key)
        .sort((a, b) => b.at - a.at)
        .map(({ nullifier, commitment, unit, eventId, at }) => ({
          nullifier,
          commitment,
          unit,
          eventId,
          at,
        })),
    })
  }

  const couponMatch = path.match(/^\/api\/v1\/audit\/coupon\/([^/]+)$/)
  if (couponMatch) {
    const nullifier = couponMatch[1]
    if (!HEX64.test(nullifier)) {
      return json(res, 400, { error: 'nullifier must be 64 hex characters' })
    }
    // The SLA clock runs from when the redemption is believed to have happened.
    // Absent, `checkCoupon` cannot return `missing` at all — no timestamp, no
    // accusation. That is the safe direction and it is enforced in the reader,
    // not here, so every caller inherits it.
    //
    // But `redeemedAt` is supplied by whoever is asking, and a `missing` verdict
    // is quotable at a merchant. Unvalidated, `?redeemedAt=0` returned `missing`
    // instantly for any nullifier — the SLA gated the caller's honesty rather
    // than the passage of time, which is no gate at all on a public endpoint.
    // Caught in review; measured before fixing.
    //
    // Two bounds, both against the SERVER's clock:
    //   - not in the future, which is nonsense and would push `reportableAt`
    //     out rather than in, so it is refused rather than clamped;
    //   - not older than this window. A redemption from before the ledger
    //     existed cannot be judged by it, and someone backdating a claim to
    //     force `missing` is exactly the abuse this endpoint must not serve.
    const raw = url.searchParams.get('redeemedAt')
    const redeemedAt = raw === null ? undefined : Number(raw)
    if (redeemedAt !== undefined) {
      if (!Number.isFinite(redeemedAt)) {
        return json(res, 400, { error: 'redeemedAt must be epoch milliseconds' })
      }
      const now = Date.now()
      if (redeemedAt > now + CLOCK_SKEW_MS) {
        return json(res, 400, { error: 'redeemedAt is in the future' })
      }
      if (redeemedAt < now - MAX_REDEEMED_AGE_MS) {
        return json(res, 400, {
          error: `redeemedAt is further back than this service will judge (${MAX_REDEEMED_AGE_MS}ms)`,
        })
      }
    }

    const snap = await snapshot()
    const check = checkCoupon(nullifier, snap.accepted, redeemedAt)

    // A truncated snapshot cannot support an accusation. The relay hit its
    // limit, so the OLDEST attestations are absent, and the record for this
    // coupon may be among them — `missing` would then be a statement about our
    // page size rather than about the merchant. Downgrade to `pending`, which
    // is what "we cannot yet say" means everywhere else in this service.
    //
    // `honoured` and `conflicting` survive truncation untouched: those are
    // claims about records we HAVE, and finding fewer records cannot make a
    // record we found untrue.
    const verdict = snap.truncated && check.verdict === 'missing' ? 'pending' : check.verdict
    metrics.couponChecks[verdict] = (metrics.couponChecks[verdict] ?? 0) + 1
    return json(res, 200, {
      nullifier,
      ...check,
      verdict,
      slaMs: ABSENCE_SLA_MS,
      // Said out loud in the payload, not just in a doc nobody reading JSON will
      // open. `missing` is the verdict most likely to be quoted at a merchant,
      // and it must never be repeated as proof of dishonesty.
      note:
        verdict === 'missing'
          ? 'Past the publication window with no record. This is evidence of a gap, NOT proof of a dishonest merchant: a lost publish looks identical until the merchant runs a reconciliation sweep.'
          : snap.truncated && check.verdict === 'missing'
            ? 'No record found, but this service is reading a truncated view of the stream, so absence here means nothing. Retry once the snapshot is complete.'
            : undefined,
    })
  }

  if (path === '/api/v1/audit/duplicates') {
    const { accepted } = await snapshot()
    // Conflicts only. A benign republication is the reconciliation sweep working
    // as designed, and listing it beside real findings would train whoever reads
    // this to ignore the endpoint.
    return json(res, 200, {
      conflicts: findDuplicates(accepted)
        .filter((d) => !d.benign)
        .map((d) => ({
          nullifier: d.nullifier,
          claims: d.occurrences.map((o) => ({
            ledgerPubkey: o.ledgerPubkey,
            commitment: o.commitment,
            eventId: o.eventId,
            at: o.at,
          })),
        })),
    })
  }

  /**
   * Check a merchant's claimed total against what they published.
   *
   * The row of the capability table that reads "read one merchant's totals —
   * only on that merchant's disclosure". Until this existed the maths was
   * correct and UNREACHABLE: `verifyDisclosedTotal` was called by nothing but
   * its own tests, so no auditor could actually perform the check the design
   * document advertises. The whole point of the homomorphic commitments is this
   * endpoint.
   *
   * POST, not GET: a disclosure carries a list of nullifiers and a scalar, which
   * is both too long for a query string and not something to leave in access
   * logs and browser history.
   *
   * Needs NO key, which is what makes it an audit rather than a favour. The
   * merchant supplies `total` and `blindSum` (from `blindSumFor` in their
   * wallet); this re-derives nothing and simply checks the published
   * commitments sum to a commitment to that total.
   *
   * What a `true` here does and does not mean, stated in the response because
   * this is exactly the claim someone will overstate: the disclosed SET adds up
   * to the disclosed total. It does NOT bind the merchant to a period — they
   * choose which nullifiers to include, and omitting one reconciles perfectly at
   * a lower total. Set completeness has to come from elsewhere, e.g. a customer
   * presenting a nullifier absent from the disclosure.
   */
  if (path === '/api/v1/audit/verify-total' && req.method === 'POST') {
    const body = await readJson(req).catch(() => null)
    if (!body || typeof body !== 'object') {
      return json(res, 400, { error: 'expected a JSON body' })
    }
    const { nullifiers, total, blindSum } = body as {
      nullifiers?: unknown
      total?: unknown
      blindSum?: unknown
    }
    if (!Array.isArray(nullifiers) || nullifiers.length === 0) {
      return json(res, 400, { error: 'nullifiers must be a non-empty array' })
    }
    // Upper bound as well as lower, because this endpoint is public,
    // unauthenticated, and does elliptic-curve point addition per entry.
    // Measured: 5,000 commitments block the event loop for ~400ms, and the 1 MB
    // body cap alone would allow roughly 15,000 — so a handful of concurrent
    // requests is a denial of service on a single-threaded server. A disclosure
    // larger than this is a reporting job, not an interactive check.
    if (nullifiers.length > DISCLOSURE_LIMIT) {
      return json(res, 400, {
        error: `a disclosure may cover at most ${DISCLOSURE_LIMIT} redemptions`,
      })
    }
    if (typeof total !== 'number' || !Number.isFinite(total) || total < 0) {
      return json(res, 400, { error: 'total must be a non-negative number of minor units' })
    }
    if (typeof blindSum !== 'string' || !/^[0-9a-f]+$/i.test(blindSum)) {
      return json(res, 400, { error: 'blindSum must be a hex scalar' })
    }

    const { accepted } = await snapshot()
    const byNullifier = new Map(accepted.map((a) => [a.nullifier, a]))
    const found = nullifiers.filter((n): n is string => typeof n === 'string' && byNullifier.has(n))
    const unknown = nullifiers.filter((n) => typeof n !== 'string' || !byNullifier.has(n))

    // Refuse rather than verify a partial set. A merchant disclosing ten
    // nullifiers of which two are not on the relay would otherwise get a
    // cheerful `true` for a total covering eight — the reconciliation is
    // arithmetically fine and answers a different question than the one asked.
    if (unknown.length > 0) {
      return json(res, 200, {
        verified: false,
        reason: 'some disclosed nullifiers are not published',
        unknownNullifiers: unknown,
      })
    }

    // One unit per disclosure, for the reason `blindSumFor` refuses to mix
    // them: the curve does not know what the scalars denominate, so a total
    // spanning XAF and EUR verifies perfectly and means nothing.
    const units = [...new Set(found.map((n) => byNullifier.get(n)!.unit))]
    if (units.length !== 1) {
      return json(res, 200, {
        verified: false,
        reason: 'a disclosure must cover exactly one currency',
        units,
      })
    }

    const commitments = found.map((n) => byNullifier.get(n)!.commitment)
    const verified = verifyDisclosedTotal(commitments, total, blindSum)
    metrics.disclosureChecks[verified ? 'verified' : 'rejected'] += 1

    return json(res, 200, {
      verified,
      redemptions: found.length,
      unit: units[0],
      total,
      note: verified
        ? 'The disclosed set sums to the disclosed total. This does NOT prove the set is complete: the merchant chooses which nullifiers to disclose, and omitting one reconciles at a lower total. Completeness must come from elsewhere.'
        : 'The published commitments do not sum to a commitment to this total.',
    })
  }

  json(res, 404, { error: 'not found' })
}

export const server = createServer((req, res) => {
  const started = Date.now()
  void route(req, res)
    .catch((error) => {
      console.error('[audit-api] request failed', error)
      metrics.errors++
      if (!res.headersSent) json(res, 503, { error: 'audit stream unavailable' })
    })
    .finally(() => {
      metrics.requests++
      metrics.requestSeconds += (Date.now() - started) / 1000
    })
})

// `import.meta.url` guard so the module can be imported by tests without
// binding a port.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  server.listen(PORT, () => {
    console.log(`[audit-api] listening on ${PORT}, reading ${RELAY_URL}`)
  })
}
