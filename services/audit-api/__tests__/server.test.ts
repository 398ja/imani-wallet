import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { finalizeEvent, type Event } from 'nostr-tools'
import { hexToBytes } from '@noble/hashes/utils'

/**
 * The audit API, driven over REAL HTTP against a stubbed relay.
 *
 * Requests go through `server.listen` and `fetch` rather than calling the route
 * function directly, because the things most likely to break are the things a
 * direct call skips: status codes, the JSON envelope, query-string parsing, and
 * the Prometheus content type. A handler tested in isolation can be perfect
 * while the service returns 404 to every caller.
 *
 * The relay is stubbed at `SimplePool` — the boundary this service does not own.
 * Everything below it, including signature verification, is the real reader.
 */

const LEDGER_A = hexToBytes('a'.repeat(64))
const LEDGER_B = hexToBytes('b'.repeat(64))
const commitment = (seed: string) => `02${seed.repeat(64).slice(0, 64)}`

let relayEvents: Event[] = []
let relayThrows = false

/**
 * Stubbed at `nostr-tools/pool`, which is the module the service actually
 * imports — not `nostr-tools`.
 *
 * They are separate module instances (see the note on the service's import), so
 * mocking the root leaves the real pool in place and every test fails with an
 * empty stream. That is the same distinction the production bug turned on, which
 * is why the mock names the subpath explicitly rather than the friendlier root.
 *
 * `useWebSocketImplementation` is a no-op here: there is no socket to configure
 * because `querySync` is replaced outright.
 */
vi.mock('nostr-tools/pool', async () => {
  const actual = await vi.importActual<typeof import('nostr-tools/pool')>('nostr-tools/pool')
  return {
    ...actual,
    useWebSocketImplementation: () => {},
    SimplePool: class {
      async querySync() {
        if (relayThrows) throw new Error('relay unreachable')
        return relayEvents
      }
      close() {}
    },
  }
})

const attest = (
  sk: Uint8Array,
  nullifier: string,
  opts: { unit?: string; commitment?: string; createdAt?: number } = {},
): Event =>
  finalizeEvent(
    {
      kind: 7377,
      created_at: opts.createdAt ?? Math.floor(Date.now() / 1000),
      tags: [
        ['n', nullifier],
        ['unit', opts.unit ?? 'XAF'],
        ['v', '1'],
      ],
      content: JSON.stringify({
        v: '1',
        nullifier,
        commitment: opts.commitment ?? commitment('1'),
        unit: opts.unit ?? 'XAF',
      }),
    },
    sk,
  )

// The real commitment primitive, so disclosures are built exactly as a
// merchant's wallet builds them rather than from a fixture that could drift.
// A small fetch limit, set BEFORE the service module is imported so it reads
// this rather than the production default. The truncation path is what is under
// test, not the size of the page: signing 5,000 real events to reach the real
// limit takes minutes and proves nothing extra.
process.env.AUDIT_FETCH_LIMIT = '3'

const { commitTo } = await import('../../../src/lib/audit')
const { server } = await import('../server')
const { resetMetrics } = await import('../metrics')

const N1 = '1'.repeat(64)
const N2 = '2'.repeat(64)

await new Promise<void>((resolve) => server.listen(0, resolve))
const port = (server.address() as { port: number }).port
const base = `http://127.0.0.1:${port}`

afterAll(() => void server.close())

beforeEach(() => {
  relayThrows = false
  relayEvents = []
  resetMetrics()
  // The service caches for 30s; tests must not inherit each other's snapshot.
  vi.setSystemTime(new Date(Date.now() + 120_000))
})

/**
 * The decoded JSON body.
 *
 * Deliberately not `Record<string, never>`, which is what this started as: that
 * type makes every nested read (`body.conflicts[0].claims`) an error while
 * looking like it type-checks, so the assertions below would have been written
 * against a shape the compiler thought was empty.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = Record<string, any>

const post = async (path: string, body: unknown) => {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as Body }
}

const get = async (path: string) => {
  const res = await fetch(`${base}${path}`)
  return { status: res.status, body: (await res.json()) as Body }
}

describe('summary: what the stream looks like without opening an amount', () => {
  it('counts redemptions, merchants and units', async () => {
    relayEvents = [
      attest(LEDGER_A, N1, { unit: 'XAF' }),
      attest(LEDGER_B, N2, { unit: 'EUR' }),
    ]
    const { status, body } = await get('/api/v1/audit/summary')

    expect(status).toBe(200)
    expect(body.redemptions).toBe(2)
    expect(body.merchants).toBe(2)
    expect(body.units).toEqual(['EUR', 'XAF'])
    // No total, anywhere. The API cannot expose what it cannot open, and a field
    // appearing here later would mean the commitments had been defeated.
    expect(Object.keys(body)).not.toContain('total')
  })

  it('reports refused events by reason instead of hiding them', async () => {
    relayEvents = [
      attest(LEDGER_A, N1),
      { ...attest(LEDGER_A, N2), sig: 'f'.repeat(128) } as Event,
    ]
    const { body } = await get('/api/v1/audit/summary')

    expect(body.redemptions).toBe(1)
    expect(body.refused).toBe(1)
    expect(body.refusedReasons).toEqual({ bad_signature: 1 })
  })
})

describe('checking one coupon: the SLA is enforced by the API, not just documented', () => {
  it('answers honoured for a published redemption', async () => {
    relayEvents = [attest(LEDGER_A, N1)]
    const { body } = await get(`/api/v1/audit/coupon/${N1}`)
    expect(body.verdict).toBe('honoured')
  })

  it('will NOT report a fresh gap as missing', async () => {
    // The false-accusation guard, over HTTP. A caller asking about a redemption
    // from a minute ago gets `pending`, and the answer says when that may change.
    relayEvents = []
    const { body } = await get(`/api/v1/audit/coupon/${N1}?redeemedAt=${Date.now() - 60_000}`)
    expect(body.verdict).toBe('pending')
    expect(body.slaMs).toBe(3_600_000)
  })

  it('reports missing past the hour, and says in the payload that it is not proof', async () => {
    relayEvents = []
    const { body } = await get(
      `/api/v1/audit/coupon/${N1}?redeemedAt=${Date.now() - 3_600_001}`,
    )
    expect(body.verdict).toBe('missing')
    // The caveat travels WITH the verdict. Whoever quotes "missing" at a
    // merchant should have to scroll past this to do it.
    expect(String(body.note)).toContain('NOT proof of a dishonest merchant')
  })

  it('cannot be made to accuse without a redemption time', async () => {
    relayEvents = []
    const { body } = await get(`/api/v1/audit/coupon/${N1}`)
    expect(body.verdict).toBe('pending')
  })

  it('refuses a nullifier that is not 64 hex characters', async () => {
    const { status } = await get('/api/v1/audit/coupon/not-a-nullifier')
    expect(status).toBe(400)
  })

  it('CANNOT be made to accuse by backdating redeemedAt', async () => {
    // The SLA bypass, caught in review. `redeemedAt` is supplied by whoever is
    // asking and a `missing` verdict is quotable at a merchant, so an
    // unvalidated value meant `?redeemedAt=0` returned `missing` instantly for
    // any nullifier — the SLA gated the caller's honesty rather than the
    // passage of time, which is no gate at all on a public endpoint.
    relayEvents = []
    expect((await get(`/api/v1/audit/coupon/${N1}?redeemedAt=0`)).status).toBe(400)
  })

  it('refuses a redeemedAt in the future', async () => {
    // Nonsense, and it would push `reportableAt` further out rather than in, so
    // it is refused rather than clamped.
    relayEvents = []
    const { status } = await get(`/api/v1/audit/coupon/${N1}?redeemedAt=${Date.now() + 86_400_000}`)
    expect(status).toBe(400)
  })

  it('still answers for a redemption inside the judging window', async () => {
    // The bounds must not break the honest case they exist to protect.
    relayEvents = []
    const { status, body } = await get(
      `/api/v1/audit/coupon/${N1}?redeemedAt=${Date.now() - 7_200_000}`,
    )
    expect(status).toBe(200)
    expect(body.verdict).toBe('missing')
  })
})

describe('a truncated stream cannot support an accusation', () => {
  it('downgrades missing to pending when the fetch hit its limit', async () => {
    // Truncation drops the OLDEST attestations, so the record for this coupon
    // may simply not be in view. `missing` would then describe our page size
    // rather than the merchant — the false accusation this service exists to
    // avoid, arriving by the back door.
    relayEvents = Array.from({ length: 3 }, (_, i) =>
      attest(LEDGER_A, i.toString(16).padStart(64, '0')),
    )
    const { body } = await get(`/api/v1/audit/coupon/${N1}?redeemedAt=${Date.now() - 7_200_000}`)

    expect(body.verdict).toBe('pending')
    expect(String(body.note)).toContain('truncated view')
  })

  it('reports truncation as a metric an operator can alert on', async () => {
    relayEvents = Array.from({ length: 3 }, (_, i) =>
      attest(LEDGER_A, i.toString(16).padStart(64, '0')),
    )
    await get('/api/v1/audit/summary')
    expect(await (await fetch(`${base}/metrics`)).text()).toContain(
      'audit_ledger_snapshot_truncated 1',
    )
  })
})

describe('duplicates: conflicts surface, sweeps do not', () => {
  it('reports one token claimed by two stalls', async () => {
    relayEvents = [
      attest(LEDGER_A, N1, { commitment: commitment('1') }),
      attest(LEDGER_B, N1, { commitment: commitment('7') }),
    ]
    const { body } = await get('/api/v1/audit/duplicates')
    expect(body.conflicts).toHaveLength(1)
    expect(body.conflicts[0].claims).toHaveLength(2)
  })

  it('stays silent about a republished sweep', async () => {
    // Byte-identical republication is the sweep working. Listing it as a finding
    // would train an operator to ignore this endpoint.
    relayEvents = [attest(LEDGER_A, N1), attest(LEDGER_A, N1)]
    const { body } = await get('/api/v1/audit/duplicates')
    expect(body.conflicts).toHaveLength(0)
  })
})

describe('one merchant, by ledger key', () => {
  it('returns only that key, and never another stall', async () => {
    relayEvents = [attest(LEDGER_A, N1), attest(LEDGER_B, N2)]
    const key = 'a'.repeat(64)
    const { body } = await get(
      `/api/v1/audit/ledger/${Buffer.from(
        (await import('@noble/curves/secp256k1.js')).schnorr.getPublicKey(hexToBytes(key)),
      ).toString('hex')}`,
    )
    expect(body.redemptions).toBe(1)
    expect(body.attestations).toHaveLength(1)
  })

  it('answers 200 with zero for an unknown key rather than 404', async () => {
    // A stall that redeemed nothing and a key that never existed are
    // indistinguishable on a pseudonymous stream. A 404 would invent a
    // distinction the data cannot support.
    relayEvents = []
    const { status, body } = await get(`/api/v1/audit/ledger/${'c'.repeat(64)}`)
    expect(status).toBe(200)
    expect(body.redemptions).toBe(0)
  })
})

describe('when the relay is down', () => {
  it('serves the last good snapshot rather than failing', async () => {
    // Serving stale beats a 502, and it beats reporting `missing` because the
    // relay blinked — which would be the false accusation this feature exists
    // to avoid.
    relayEvents = [attest(LEDGER_A, N1)]
    expect((await get('/api/v1/audit/summary')).body.redemptions).toBe(1)

    relayThrows = true
    vi.setSystemTime(new Date(Date.now() + 120_000))
    const { status, body } = await get('/api/v1/audit/summary')
    expect(status).toBe(200)
    expect(body.redemptions).toBe(1)
  })

  it('health stays up, because restarting mid-incident helps nobody', async () => {
    relayThrows = true
    expect((await get('/health')).status).toBe(200)
  })
})

describe('metrics are exposition text, because that is what a dashboard reads', () => {
  it('registers every coupon verdict before any check happens', async () => {
    // The rule from imani-deploy's add-a-metric.md: a series that appears only
    // when the bad thing happens cannot be alerted on beforehand. `missing` and
    // `conflicting` must exist at zero on a service that has served nothing.
    const res = await fetch(`${base}/metrics`)
    const text = await res.text()

    expect(res.headers.get('content-type')).toContain('text/plain')
    expect(text).toContain('audit_api_coupon_checks_total{verdict="missing"} 0')
    expect(text).toContain('audit_api_coupon_checks_total{verdict="conflicting"} 0')
    expect(text).toContain('audit_api_coupon_checks_total{verdict="honoured"} 0')
  })

  it('counts a verdict once it is answered', async () => {
    relayEvents = [attest(LEDGER_A, N1)]
    await get(`/api/v1/audit/coupon/${N1}`)
    const text = await (await fetch(`${base}/metrics`)).text()
    expect(text).toContain('audit_api_coupon_checks_total{verdict="honoured"} 1')
  })

  it('exposes the ledger gauges on a SCRAPE ALONE, with no API call first', async () => {
    // The regression that made 6 of 15 dashboard panels read "No data".
    //
    // /metrics used to render whatever was cached, and the cache is only filled
    // by an API request. Nothing calls this API on a schedule, so a real
    // deployment scraped `up`, collected the request counters, and never
    // produced a single `audit_ledger_*` sample. Found by pointing real
    // Prometheus at the service with the deploy repo's own config.
    //
    // This test therefore touches NO endpoint before scraping. Adding a warm-up
    // call above would restore the bug while keeping the test green.
    relayEvents = [attest(LEDGER_A, N1), attest(LEDGER_B, N2)]
    const text = await (await fetch(`${base}/metrics`)).text()

    expect(text).toContain('audit_ledger_redemptions 2')
    expect(text).toContain('audit_ledger_merchants 2')
    expect(text).toContain('audit_api_relay_up 1')
  })

  it('still renders counters when the relay is down, rather than failing the scrape', async () => {
    // A relay outage must surface as `audit_api_relay_up 0` beside the last
    // known figures. A failed scrape would also lose the counters that tell an
    // operator the service is alive, which is the opposite of useful mid-incident.
    relayThrows = true
    const res = await fetch(`${base}/metrics`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('audit_api_relay_up 0')
  })

  it('counts conflicts from the LEDGER, not from how often somebody asked', async () => {
    // The dashboard's headline fraud panel used to read
    // `audit_api_coupon_checks_total{verdict="conflicting"}`, which only moves
    // when a conflicted coupon is queried — so a stall double-claiming a token
    // nobody asks about read zero forever. Review caught it.
    relayEvents = [
      attest(LEDGER_A, N1, { commitment: commitment('1') }),
      attest(LEDGER_B, N1, { commitment: commitment('7') }),
    ]
    await get('/api/v1/audit/summary')
    // Nobody has called the coupon endpoint; the gauge must see it anyway.
    const text = await (await fetch(`${base}/metrics`)).text()
    expect(text).toContain('audit_ledger_conflicts 1')
    expect(text).toContain('audit_api_coupon_checks_total{verdict="conflicting"} 0')
  })

  it('exposes the ledger gauges the dashboard queries by name', async () => {
    relayEvents = [attest(LEDGER_A, N1), attest(LEDGER_B, N2)]
    await get('/api/v1/audit/summary')
    const text = await (await fetch(`${base}/metrics`)).text()

    // These exact names are wired into the Grafana dashboard JSON. Asserting
    // them here is what keeps the two in step — a renamed metric fails the
    // suite instead of silently emptying a panel.
    expect(text).toContain('audit_ledger_redemptions 2')
    expect(text).toContain('audit_ledger_merchants 2')
    expect(text).toMatch(/audit_ledger_refused_by_defect\{defect="bad_signature"\} 0/)
    expect(text).toContain('audit_api_relay_up 1')
  })

  it('reports the relay as down after a failed fetch', async () => {
    relayThrows = true
    await get('/api/v1/audit/summary').catch(() => undefined)
    const text = await (await fetch(`${base}/metrics`)).text()
    expect(text).toContain('audit_api_relay_up 0')
  })
})

describe('disclosure: a merchant proving a total without revealing any amount', () => {
  /**
   * The capability table's "read one merchant's totals — only on that
   * merchant's disclosure". Before this endpoint the maths was correct and
   * reachable by nothing: `verifyDisclosedTotal` was called only by its own
   * tests, so no auditor could perform the check the design advertises.
   *
   * These build the disclosure the way a merchant's wallet would — real
   * commitments over real blinds — so the arithmetic is exercised end to end
   * rather than against a fixture.
   */
  const N3 = '3'.repeat(64)

  /** Commitments and the summed blind, as `blindSumFor` would produce them. */
  const disclosure = (amounts: number[], blinds: bigint[]) => ({
    commitments: amounts.map((a, i) => commitTo(a, blinds[i])),
    total: amounts.reduce((x, y) => x + y, 0),
    blindSum: blinds.reduce((x, y) => x + y, 0n).toString(16),
  })

  it('verifies a true total against the published commitments', async () => {
    const blinds = [11111n, 22222n]
    const d = disclosure([1500, 2500], blinds)
    relayEvents = [
      attest(LEDGER_A, N1, { commitment: d.commitments[0] }),
      attest(LEDGER_A, N2, { commitment: d.commitments[1] }),
    ]
    const { body } = await post('/api/v1/audit/verify-total', {
      nullifiers: [N1, N2],
      total: d.total,
      blindSum: d.blindSum,
    })

    expect(body.verified).toBe(true)
    expect(body.redemptions).toBe(2)
    // The caveat travels WITH the answer. "Verified" is the claim most likely
    // to be overstated into "these are all their redemptions".
    expect(String(body.note)).toContain('does NOT prove the set is complete')
  })

  it('rejects an understated total', async () => {
    const blinds = [11111n, 22222n]
    const d = disclosure([1500, 2500], blinds)
    relayEvents = [
      attest(LEDGER_A, N1, { commitment: d.commitments[0] }),
      attest(LEDGER_A, N2, { commitment: d.commitments[1] }),
    ]
    const { body } = await post('/api/v1/audit/verify-total', {
      nullifiers: [N1, N2],
      total: 3000, // real total is 4000
      blindSum: d.blindSum,
    })
    expect(body.verified).toBe(false)
  })

  it('rejects an overstated total', async () => {
    const blinds = [11111n, 22222n]
    const d = disclosure([1500, 2500], blinds)
    relayEvents = [
      attest(LEDGER_A, N1, { commitment: d.commitments[0] }),
      attest(LEDGER_A, N2, { commitment: d.commitments[1] }),
    ]
    const { body } = await post('/api/v1/audit/verify-total', {
      nullifiers: [N1, N2],
      total: 5000,
      blindSum: d.blindSum,
    })
    expect(body.verified).toBe(false)
  })

  it('refuses a disclosure naming a redemption that is not published', async () => {
    // Otherwise a merchant disclosing ten nullifiers of which two are absent
    // gets a cheerful `true` for a total covering eight — arithmetically fine,
    // and an answer to a different question than the one asked.
    const d = disclosure([1500], [11111n])
    relayEvents = [attest(LEDGER_A, N1, { commitment: d.commitments[0] })]
    const { body } = await post('/api/v1/audit/verify-total', {
      nullifiers: [N1, N3],
      total: d.total,
      blindSum: d.blindSum,
    })
    expect(body.verified).toBe(false)
    expect(body.unknownNullifiers).toEqual([N3])
  })

  it('refuses a disclosure that mixes currencies', async () => {
    // The curve does not know what the scalars denominate, so a total spanning
    // XAF and EUR verifies perfectly and means nothing. `blindSumFor` refuses
    // to build one; this refuses to check one.
    const blinds = [11111n, 22222n]
    const d = disclosure([1500, 2500], blinds)
    relayEvents = [
      attest(LEDGER_A, N1, { commitment: d.commitments[0], unit: 'XAF' }),
      attest(LEDGER_A, N2, { commitment: d.commitments[1], unit: 'EUR' }),
    ]
    const { body } = await post('/api/v1/audit/verify-total', {
      nullifiers: [N1, N2],
      total: d.total,
      blindSum: d.blindSum,
    })
    expect(body.verified).toBe(false)
    expect(body.units).toEqual(['XAF', 'EUR'])
  })

  it('refuses malformed input rather than answering it', async () => {
    expect((await post('/api/v1/audit/verify-total', {})).status).toBe(400)
    expect((await post('/api/v1/audit/verify-total', { nullifiers: [], total: 1, blindSum: 'ab' })).status).toBe(400)
    expect((await post('/api/v1/audit/verify-total', { nullifiers: [N1], total: -5, blindSum: 'ab' })).status).toBe(400)
    expect((await post('/api/v1/audit/verify-total', { nullifiers: [N1], total: 1, blindSum: 'zz' })).status).toBe(400)
  })

  it('counts both outcomes as metrics', async () => {
    const d = disclosure([1500], [11111n])
    relayEvents = [attest(LEDGER_A, N1, { commitment: d.commitments[0] })]
    await post('/api/v1/audit/verify-total', { nullifiers: [N1], total: d.total, blindSum: d.blindSum })
    await post('/api/v1/audit/verify-total', { nullifiers: [N1], total: 9999, blindSum: d.blindSum })
    const text = await (await fetch(`${base}/metrics`)).text()
    expect(text).toContain('audit_api_disclosure_checks_total{outcome="verified"} 1')
    expect(text).toContain('audit_api_disclosure_checks_total{outcome="rejected"} 1')
  })
})
