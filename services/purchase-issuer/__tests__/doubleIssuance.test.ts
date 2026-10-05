/**
 * @vitest-environment node
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { purchaseIdempotencyKey } from '../issuer'
import { PurchasesApi, ReportLostError, type OwedPurchase } from '../purchasesApi'
import { haltReason, loop, resetForTest, server } from '../server'
import { runPass, type WorkerDeps } from '../worker'
import type { Ports } from '../discharge'
import { STALL, delegatedCredential } from './stallFixture'

/**
 * imani-wallet#96: one payment, one coupon, whatever happens to the worker.
 *
 * The acceptance criteria, each driven through the REAL `runPass`,
 * `discharge`, `issueAsStall` and `PurchasesApi` against two in-memory fakes:
 *
 *  - `payments`: payment-adapter's purchases API with its real claim rule
 *    (OWED, or ISSUING with a lapsed lease, becomes ISSUING; anything else
 *    is 409), answered over HTTP the way `PurchasesApi` reads it.
 *  - `gateway`: a voucher-create endpoint that honours `Idempotency-Key` per
 *    caller, returning the ORIGINAL voucher for a replayed key.
 */

/** Node's own fetch, for probing the real health server; captured before any stub. */
const nativeFetch = globalThis.fetch
const PAYMENTS = 'http://payments.test'
const GATEWAY = 'http://gateway.test'

interface Row extends OwedPurchase {
  status: 'OWED' | 'ISSUING' | 'ISSUED' | 'DISCHARGED' | 'BLOCKED'
  claimedUntil: number
  claimedBy?: string
  voucherId?: string
}

function world({ leaseMs = 600_000 } = {}) {
  let clock = 1_000_000
  const rows = new Map<string, Row>()
  const minted: { key: string | null; voucherId: string }[] = []
  const byKey = new Map<string, string>()
  const down = { payments: false, failureEndpoint: false }

  const add = (eventId: string) =>
    rows.set(eventId, {
      eventId,
      paymentRequestId: `req-${eventId}`.padEnd(32, '0'),
      stallPubkey: STALL,
      recipientPubkey: 'c'.repeat(64),
      amountMinor: 2500,
      currency: 'gbp',
      livemode: true,
      attempts: 0,
      processorReference: `pi_${eventId}`,
      status: 'OWED',
      claimedUntil: 0,
    })

  const json = (status: number, body: unknown = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

  const fetchImpl = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input)
    const body = init.body ? JSON.parse(String(init.body)) : {}

    if (url.startsWith(GATEWAY)) {
      if (url.endsWith('/api/v1/wallet/vouchers')) {
        const key = (init.headers as Record<string, string>)['Idempotency-Key'] ?? null
        if (key && byKey.has(key)) {
          return json(201, { voucher_id: byKey.get(key), issuer_id: STALL, token: 'cashuB-replayed' })
        }
        const voucherId = `v${minted.length + 1}`
        minted.push({ key, voucherId })
        if (key) byKey.set(key, voucherId)
        return json(201, { voucher_id: voucherId, issuer_id: STALL, token: 'cashuB-fresh' })
      }
      // Delivery.
      return json(200, { event_id: 'dm-1' })
    }

    if (down.payments) throw new TypeError('fetch failed')
    const match = /\/api\/v1\/purchases(?:\/([^/]+)\/(\w+))?/.exec(new URL(url).pathname)
    const eventId = match?.[1] ? decodeURIComponent(match[1]) : ''
    const action = match?.[2]
    const row = rows.get(eventId)

    if (url.endsWith('/owed')) {
      return json(
        200,
        [...rows.values()].filter(
          (r) => r.status === 'OWED' || (r.status === 'ISSUING' && r.claimedUntil < clock),
        ),
      )
    }
    if (!row) return json(404)
    if (action === 'claim') {
      const claimable = row.status === 'OWED' || (row.status === 'ISSUING' && row.claimedUntil < clock)
      if (!claimable) return json(409)
      row.status = 'ISSUING'
      row.claimedUntil = clock + leaseMs
      row.claimedBy = body.worker
      return json(200)
    }
    if (action === 'discharge') {
      row.status = 'DISCHARGED'
      row.voucherId = body.voucherId
      return json(200)
    }
    if (action === 'failure') {
      if (down.failureEndpoint) throw new TypeError('fetch failed')
      // Mirrors PurchaseDischargeService.recordFailure in payment-adapter.
      const heldByAnother =
        row.status === 'ISSUING' && body.worker && row.claimedBy && body.worker !== row.claimedBy &&
        row.claimedUntil > clock
      if (body.voucherId) {
        row.status = 'ISSUED'
        row.voucherId = body.voucherId
      } else if (row.status === 'ISSUED' || heldByAnother) {
        // unchanged
      } else if (body.keepClaim && row.status === 'ISSUING') {
        // left to lapse
      } else {
        row.status = body.permanent ? 'BLOCKED' : 'OWED'
      }
      return json(202)
    }
    return json(404)
  }) as typeof fetch

  const ports: Ports = {
    // A real stall's delegation: since #152 nothing mints without one.
    credentialFor: async () => delegatedCredential({ credentialId: 'c1' }),
    tokenFor: async () => '',
    now: () => clock,
    sleep: async () => {},
  }

  const worker = (id: string, api = new PurchasesApi(PAYMENTS, 't', fetchImpl, undefined, {
    reportBackoffsMs: [1, 1, 1],
    sleep: async () => {},
  })): WorkerDeps => ({ api, ports, gatewayUrl: GATEWAY, livemode: true, workerId: id })

  return {
    rows,
    minted,
    down,
    add,
    fetchImpl,
    worker,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  resetForTest()
})

describe('two workers on one queue (#96)', () => {
  it('mint exactly one coupon per purchase', async () => {
    const w = world()
    for (const id of ['evt_1', 'evt_2', 'evt_3']) w.add(id)
    vi.stubGlobal('fetch', w.fetchImpl)

    // Interleaved: both read the same owed list before either claims.
    await Promise.all([runPass(w.worker('a')), runPass(w.worker('b'))])

    expect(w.minted).toHaveLength(3)
    expect(new Set(w.minted.map((m) => m.key))).toEqual(
      new Set(['evt_1', 'evt_2', 'evt_3'].map(purchaseIdempotencyKey)),
    )
    expect([...w.rows.values()].every((r) => r.status === 'DISCHARGED')).toBe(true)
  })
})

describe('a worker killed between the mint and the discharge (#96)', () => {
  it('is replaced by one that gets the ORIGINAL coupon back, not a second', async () => {
    const w = world({ leaseMs: 60_000 })
    w.add('evt_1')

    // Worker A claims and mints, then "dies": its discharge never lands.
    const dying = w.worker('a')
    const realFetch = w.fetchImpl
    vi.stubGlobal('fetch', (async (input: string | URL, init?: RequestInit) => {
      if (String(input).includes('/discharge')) throw new Error('SIGKILL')
      return realFetch(input, init)
    }) as typeof fetch)
    const dyingApi = new PurchasesApi(PAYMENTS, 't', (async (input: string | URL, init?: RequestInit) => {
      if (String(input).includes('/discharge') || String(input).includes('/failure')) {
        throw new Error('SIGKILL')
      }
      return realFetch(input, init)
    }) as typeof fetch, undefined, { reportBackoffsMs: [], sleep: async () => {} })
    await expect(runPass({ ...dying, api: dyingApi })).rejects.toBeInstanceOf(ReportLostError)

    expect(w.minted).toHaveLength(1)
    expect(w.rows.get('evt_1')!.status).toBe('ISSUING')

    // While the claim holds, a restarted worker does not even see the row.
    vi.stubGlobal('fetch', realFetch)
    await runPass(w.worker('b'))
    expect(w.minted).toHaveLength(1)

    // After the lease lapses a new worker re-claims and re-mints under the
    // same key; the gateway returns the original voucher.
    w.advance(60_001)
    const result = await runPass(w.worker('c'))

    expect(result.discharged).toBe(1)
    expect(w.minted).toHaveLength(1)
    expect(w.rows.get('evt_1')).toMatchObject({ status: 'DISCHARGED', voucherId: 'v1' })
  })
})

describe('a failure report that cannot be recorded (#96)', () => {
  it('halts the worker, reports it on /health, and the row is not re-minted', async () => {
    const w = world()
    w.add('evt_1')
    vi.stubGlobal('fetch', w.fetchImpl)
    // Delivery fails, so the worker must report "issued voucher v1" and the
    // purchases API's failure endpoint is down for every retry.
    const realFetch = w.fetchImpl
    vi.stubGlobal('fetch', (async (input: string | URL, init?: RequestInit) => {
      if (String(input).includes('/api/v1/dm/')) return new Response('down', { status: 503 })
      return realFetch(input, init)
    }) as typeof fetch)
    w.down.failureEndpoint = true

    await loop(w.worker('a'), 1)

    expect(haltReason()).toMatch(/voucher v1 was minted/)
    expect(w.minted).toHaveLength(1)
    // The row is still held by the dead claim, so nobody re-mints it inside
    // the lease; after it, the same key returns v1 (tested above).
    expect(w.rows.get('evt_1')!.status).toBe('ISSUING')

    const health = await new Promise<{ status: number; body: string }>((resolve) => {
      server.listen(0, async () => {
        const { port } = server.address() as { port: number }
        const res = await nativeFetch(`http://127.0.0.1:${port}/health`)
        resolve({ status: res.status, body: await res.text() })
        server.close()
      })
    })
    expect(health.status).toBe(503)
    expect(JSON.parse(health.body).status).toBe('halted')
  })

  it('retries a report before giving up', async () => {
    const calls: number[] = []
    let n = 0
    const api = new PurchasesApi(PAYMENTS, 't', (async () => {
      n += 1
      calls.push(n)
      if (n < 3) throw new TypeError('fetch failed')
      return new Response(null, { status: 202 })
    }) as typeof fetch, undefined, { reportBackoffsMs: [1, 1, 1], sleep: async () => {} })

    await api.reportFailure('evt_1', 'x', false, 'v1')
    expect(calls).toEqual([1, 2, 3])
  })
})

describe('the idempotency key', () => {
  it('is sent on every mint, derived from the purchase alone', async () => {
    const w = world()
    w.add('evt_1')
    vi.stubGlobal('fetch', w.fetchImpl)

    await runPass(w.worker('a'))

    expect(w.minted).toEqual([{ key: 'purchase:evt_1', voucherId: 'v1' }])
  })
})

describe('an ambiguous mint (#96 review)', () => {
  it('keeps the claim when the gateway 5xxs, and the retry after the lease gets the original', async () => {
    const w = world({ leaseMs: 60_000 })
    w.add('evt_1')
    const realFetch = w.fetchImpl
    let gatewayBroken = true
    vi.stubGlobal('fetch', (async (input: string | URL, init?: RequestInit) => {
      // The gateway MINTS, then fails to answer: the worst ambiguous case.
      if (gatewayBroken && String(input).endsWith('/api/v1/wallet/vouchers')) {
        await realFetch(input, init)
        return new Response('upstream died', { status: 502 })
      }
      return realFetch(input, init)
    }) as typeof fetch)

    const first = await runPass(w.worker('a'))
    expect(first.deferred).toBe(1)
    // Not handed straight back: the claim holds, so nobody re-mints yet.
    expect(w.rows.get('evt_1')!.status).toBe('ISSUING')
    await runPass(w.worker('b'))
    expect(w.minted).toHaveLength(1)

    gatewayBroken = false
    w.advance(60_001)
    await runPass(w.worker('c'))

    expect(w.minted).toHaveLength(1)
    expect(w.rows.get('evt_1')).toMatchObject({ status: 'DISCHARGED', voucherId: 'v1' })
  })
})

describe('the issuance warrant (#96)', () => {
  // A card purchase now carries a delegated warrant the till verifies (#152),
  // with the processor reference inside it, and two attempts at one purchase
  // still send byte-identical bodies so the idempotency key replays the same
  // request.
  it('marks a card purchase as delegated-warranted, verified by the wallet, and stable across attempts', async () => {
    const { parseIssuanceWarrant, verifyIssuanceWarrant } = await import('../../../src/lib/issuanceWarrant')
    const bodies: Record<string, unknown>[] = []
    const w = world({ leaseMs: 1 })
    w.add('evt_1')
    const realFetch = w.fetchImpl
    let crashed = true
    const crashing = (async (input: string | URL, init?: RequestInit) => {
      if (String(input).endsWith('/api/v1/wallet/vouchers')) bodies.push(JSON.parse(String(init?.body)))
      // The first worker "dies" after minting: neither its discharge nor its
      // failure report lands, so the row stays ISSUING under a claim.
      if (crashed && /\/(discharge|failure)$/.test(String(input))) throw new Error('SIGKILL')
      return realFetch(input, init)
    }) as typeof fetch
    vi.stubGlobal('fetch', crashing)
    const api = () =>
      new PurchasesApi(PAYMENTS, 't', crashing, undefined, { reportBackoffsMs: [], sleep: async () => {} })

    // Two attempts at one purchase (the first dies, its claim lapses, the
    // second re-mints): the bodies must match byte for byte, or the
    // idempotency key would be replaying a different request.
    await runPass(w.worker('a', api())).catch(() => {})
    crashed = false
    w.advance(10)
    await runPass(w.worker('b', api()))

    expect(bodies).toHaveLength(2)
    expect(bodies[0]).toEqual(bodies[1])

    const warrant = parseIssuanceWarrant(bodies[0].issuance_warrant as string)
    expect(warrant).toMatchObject({ state: 'present', form: 'delegated', reference: 'pi_evt_1', saleTotalMinor: 2500 })
    expect(
      verifyIssuanceWarrant(warrant, STALL, { faceValueMinor: 2500, unit: 'GBP', faceDecimals: 2 }),
    ).toEqual({ verdict: 'verified' })
  })
})

describe('the claim', () => {
  it('is never skipped: a worker that cannot claim does not mint', async () => {
    const w = world()
    w.add('evt_1')
    w.rows.get('evt_1')!.status = 'ISSUING'
    w.rows.get('evt_1')!.claimedUntil = Number.MAX_SAFE_INTEGER
    const api = new PurchasesApi(PAYMENTS, 't', w.fetchImpl)
    // Force the stale owed list a racing worker would have read.
    vi.spyOn(api, 'owed').mockResolvedValue([w.rows.get('evt_1')!])
    vi.stubGlobal('fetch', w.fetchImpl)

    const result = await runPass(w.worker('late', api))

    expect(result.skipped).toBe(1)
    expect(w.minted).toHaveLength(0)
  })

  it('does not mint when the purchases API cannot be reached for the claim', async () => {
    const w = world()
    w.add('evt_1')
    const api = new PurchasesApi(PAYMENTS, 't', w.fetchImpl)
    vi.spyOn(api, 'owed').mockResolvedValue([w.rows.get('evt_1')!])
    w.down.payments = true
    vi.stubGlobal('fetch', w.fetchImpl)

    const result = await runPass(w.worker('a', api))

    expect(result.deferred).toBe(1)
    expect(w.minted).toHaveLength(0)
  })
})
