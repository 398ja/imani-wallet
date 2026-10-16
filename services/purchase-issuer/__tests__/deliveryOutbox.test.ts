/**
 * @vitest-environment node
 */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { purchaseIdempotencyKey } from '../issuer'
import { purchaseNonce } from '../delegatedWarrant'
import { PurchasesApi } from '../purchasesApi'
import { runPass, type WorkerDeps } from '../worker'
import type { Ports } from '../discharge'
import { DeliveryOutbox, FileOutboxStore, MemoryOutboxStore, runDeliveryPass, type OutboxStore } from '../outbox'
import { STALL, delegatedCredential } from './stallFixture'

/**
 * imani-wallet#274 (card atomicity audit U8): a card purchase's coupon is ALWAYS eventually
 * delivered, or parked for a human. Never stuck, never duplicated.
 *
 * Driven through the real `runPass`, `discharge`, `issueAsStall`, `deliver`, `PurchasesApi` and
 * the delivery outbox, against two in-memory fakes:
 *  - payment-adapter's purchases API (claim, discharge, failure, and #280's `/attention`);
 *  - gateway-customer, modelling gc#232: a voucher is replayed for a warrant nonce it has seen,
 *    whatever the `Idempotency-Key` store remembers, and a nonce whose first run never recorded
 *    its voucher is refused 409 UNRECORDED.
 */

const PAYMENTS = 'http://payments.test'
const GATEWAY = 'http://gateway.test'

interface Row {
  eventId: string
  paymentRequestId: string
  stallPubkey: string
  recipientPubkey: string
  amountMinor: number
  currency: string
  livemode: boolean
  attempts: number
  processorReference: string
  status: 'OWED' | 'ISSUING' | 'ISSUED' | 'DISCHARGED' | 'BLOCKED' | 'NEEDS_ATTENTION'
  claimedUntil: number
  claimedBy?: string
  voucherId?: string
  attention?: { reason: string; voucherId?: string | null; detail?: string }
}

function world({ leaseMs = 60_000, attentionRoute = true } = {}) {
  let clock = 1_000_000
  const rows = new Map<string, Row>()
  const minted: { key: string | null; nonce: string; voucherId: string }[] = []
  const byNonce = new Map<string, string>()
  const unrecordedNonces = new Set<string>()
  const sends: { ok: boolean; prid: string; token: string; voucherId?: string; recorded: boolean }[] = []
  const calls: string[] = []
  // `records`: gc#287 U2. false models a gc that publishes the DM but does not (yet) record it in core.
  const gw = { dmFail: false, dmHeader: null as null | string, dmStatus: 502, dmBody: { error: 'relay down' } as unknown, records: true, tokenReads: 0, refuse: null as null | { status: number; code: string } }

  const add = (eventId: string, pi = `pi_${eventId}`) =>
    rows.set(eventId, {
      eventId,
      paymentRequestId: `req-${eventId}`.padEnd(32, '0'),
      stallPubkey: STALL,
      recipientPubkey: 'c'.repeat(64),
      amountMinor: 2500,
      currency: 'gbp',
      livemode: true,
      attempts: 0,
      processorReference: pi,
      status: 'OWED',
      claimedUntil: 0,
    })

  const json = (status: number, body: unknown = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

  const fetchImpl = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input)
    const body = init.body ? JSON.parse(String(init.body)) : {}

    if (url.startsWith(GATEWAY)) {
      const path = new URL(url).pathname
      if (path === '/api/v1/wallet/vouchers' && init.method === 'POST') {
        const key = (init.headers as Record<string, string>)['Idempotency-Key'] ?? null
        const nonce = JSON.parse(body.issuance_warrant).nonce as string
        if (gw.refuse) return json(gw.refuse.status, { error: { code: gw.refuse.code, message: 'refused' } })
        if (unrecordedNonces.has(nonce)) {
          return json(409, { error: { code: 'UNRECORDED', message: 'delegated warrant use never recorded' } })
        }
        const prior = byNonce.get(nonce)
        if (prior) return json(201, { voucher_id: prior, issuer_id: STALL, token: 'cashuB-replayed' })
        const voucherId = `v${minted.length + 1}`
        minted.push({ key, nonce, voucherId })
        byNonce.set(nonce, voucherId)
        return json(201, { voucher_id: voucherId, issuer_id: STALL, token: 'cashuB-fresh' })
      }
      const read = /^\/api\/v1\/wallet\/vouchers\/([^/]+)$/.exec(path)
      if (read && (init.method ?? 'GET') === 'GET') {
        gw.tokenReads += 1
        return json(200, { token: `cashuB-reread-${read[1]}` })
      }
      if (path === '/api/v1/dm/tokens/send') {
        // Like U2: gc records the delivery in core only when the send names the voucher it carries.
        const recorded = !gw.dmFail && gw.records && typeof body.voucher_id === 'string'
        sends.push({ ok: !gw.dmFail, prid: body.payment_request_id, token: body.token, voucherId: body.voucher_id, recorded })
        if (gw.dmFail) {
          const r = json(gw.dmStatus, gw.dmBody)
          if (gw.dmHeader) r.headers.set('X-Imani-Issuance-Refused', gw.dmHeader)
          return r
        }
        return json(200, recorded ? { event_id: 'dm-1', fulfilment_recorded: true } : { event_id: 'dm-1' })
      }
      if (path === '/api/v1/nostr/events') return json(200, {})
      return json(404)
    }

    const match = /\/api\/v1\/purchases(?:\/([^/]+)\/(\w+))?/.exec(new URL(url).pathname)
    const eventId = match?.[1] ? decodeURIComponent(match[1]) : ''
    const action = match?.[2]
    if (action) calls.push(`${action}:${eventId}`)
    const row = rows.get(eventId)

    if (url.endsWith('/owed')) {
      return json(
        200,
        [...rows.values()].filter((r) => r.status === 'OWED' || (r.status === 'ISSUING' && r.claimedUntil < clock)),
      )
    }
    if (action === 'attention' && !attentionRoute) return json(404, { error: 'Not Found' })
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
      // Like gateway-core after #287: only a RECORDED delivery of this very voucher counts.
      const sent = sends.some((s) => s.recorded && s.prid === row.paymentRequestId && s.voucherId === body.voucherId)
      if (!sent) return json(409)
      row.status = 'DISCHARGED'
      row.voucherId = body.voucherId
      return json(200)
    }
    if (action === 'failure') {
      if (body.voucherId) {
        row.status = 'ISSUED'
        row.voucherId = body.voucherId
      } else if (body.keepClaim && row.status === 'ISSUING') {
        // left to lapse
      } else if (row.status === 'ISSUING') {
        row.status = body.permanent ? 'BLOCKED' : 'OWED'
      }
      return json(202)
    }
    if (action === 'attention') {
      if (row.status === 'DISCHARGED') return json(409)
      if (row.status !== 'NEEDS_ATTENTION') {
        row.status = 'NEEDS_ATTENTION'
        row.attention = { reason: body.reason, voucherId: body.voucherId, detail: body.detail }
      }
      return json(200)
    }
    return json(404)
  }) as typeof fetch

  const ports: Ports = {
    credentialFor: async () => delegatedCredential({ credentialId: 'c1' }),
    tokenFor: async (_credential, voucherId) => {
      const r = await fetchImpl(`${GATEWAY}/api/v1/wallet/vouchers/${voucherId}`, { method: 'GET' })
      return ((await r.json()) as { token: string }).token
    },
    now: () => clock,
    sleep: async () => {},
    fileSale: vi.fn().mockResolvedValue(true),
  }

  const api = () =>
    new PurchasesApi(PAYMENTS, 't', fetchImpl, undefined, { reportBackoffsMs: [1, 1], sleep: async () => {} })

  const outboxOn = (store: OutboxStore = new MemoryOutboxStore()) =>
    new DeliveryOutbox(store, { now: () => clock, maxAttempts: 4, baseBackoffMs: 10_000, maxBackoffMs: 60_000 })

  const worker = (id: string, outbox?: DeliveryOutbox): WorkerDeps => ({
    api: api(),
    ports,
    gatewayUrl: GATEWAY,
    livemode: true,
    workerId: id,
    outbox,
  })

  const deliveryPass = (outbox: DeliveryOutbox, worker = 'a') =>
    runDeliveryPass({ outbox, api: api(), ports, gatewayUrl: GATEWAY, workerId: worker })

  return {
    rows,
    minted,
    sends,
    calls,
    gw,
    ports,
    unrecordedNonces,
    add,
    fetchImpl,
    worker,
    outboxOn,
    deliveryPass,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the issue key and the warrant nonce come from the payment intent (U8)', () => {
  it('maps any re-drive of one pi_ to one key and one nonce, whatever the event id', () => {
    expect(purchaseIdempotencyKey('pi_3Abc')).toBe('purchase:pi:pi_3Abc')
    // v2: a different preimage from the event-id nonce, so a pi_ can never collide with one.
    expect(purchaseNonce('pi_3Abc')).toMatch(/^[0-9a-f]{32}$/)
    expect(purchaseNonce('pi_3Abc')).toBe(purchaseNonce('pi_3Abc'))
    expect(purchaseNonce('pi_3Abc')).not.toBe(purchaseNonce('pi_3Abd'))
  })

  it('mints once when two events (a re-drive) carry the same pi_', async () => {
    const w = world()
    w.add('evt_1', 'pi_same')
    w.add('evt_2', 'pi_same')
    vi.stubGlobal('fetch', w.fetchImpl)

    await runPass(w.worker('a', w.outboxOn()))

    expect(w.minted).toHaveLength(1)
    expect(w.minted[0].key).toBe('purchase:pi:pi_same')
    expect(w.minted[0].nonce).toBe(purchaseNonce('pi_same'))
  })
})

describe('gc 409 UNRECORDED (U8, gc#232)', () => {
  it('is never retried: the row is parked gateway_unrecorded through /attention', async () => {
    const w = world({ leaseMs: 1 })
    w.add('evt_1')
    w.unrecordedNonces.add(purchaseNonce('pi_evt_1'))
    vi.stubGlobal('fetch', w.fetchImpl)

    const result = await runPass(w.worker('a', w.outboxOn()))

    expect(result.blocked).toBe(1)
    expect(w.rows.get('evt_1')).toMatchObject({
      status: 'NEEDS_ATTENTION',
      attention: { reason: 'gateway_unrecorded' },
    })
    expect(w.calls).not.toContain('failure:evt_1')

    // Parked rows are off the owed feed, so nothing tries again.
    w.advance(10)
    await runPass(w.worker('b', w.outboxOn()))
    expect(w.calls.filter((c) => c === 'claim:evt_1')).toHaveLength(1)
    expect(w.minted).toHaveLength(0)
  })

  // Review of #279: these answer every retry the same way, and the first attempt may have minted.
  // Retryable before, so the row went back to OWED and looped forever without ever parking.
  it.each([
    [409, 'WARRANT_ALREADY_USED'],
    [422, 'IDEMPOTENCY_KEY_REUSED'],
    [409, 'IDEMPOTENCY_PREVIOUS_ATTEMPT_UNRECORDED'],
  ])('parks gateway_unrecorded on gc %i %s, never back to OWED', async (status, code) => {
    const w = world()
    w.add('evt_1')
    w.gw.refuse = { status, code }
    vi.stubGlobal('fetch', w.fetchImpl)

    await runPass(w.worker('a', w.outboxOn()))

    expect(w.rows.get('evt_1')).toMatchObject({
      status: 'NEEDS_ATTENTION',
      attention: { reason: 'gateway_unrecorded' },
    })
    expect(w.minted).toHaveLength(0)
  })

  it('still retries a 409 IDEMPOTENCY_IN_PROGRESS (the first request is running)', async () => {
    const w = world()
    w.add('evt_1')
    w.gw.refuse = { status: 409, code: 'IDEMPOTENCY_IN_PROGRESS' }
    vi.stubGlobal('fetch', w.fetchImpl)

    await runPass(w.worker('a', w.outboxOn()))

    expect(w.rows.get('evt_1')!.status).toBe('OWED')
    expect(w.calls).not.toContain('attention:evt_1')
  })

  it('falls back to a permanent /failure on a payment-adapter without /attention (404)', async () => {
    const w = world({ attentionRoute: false })
    w.add('evt_1')
    w.unrecordedNonces.add(purchaseNonce('pi_evt_1'))
    vi.stubGlobal('fetch', w.fetchImpl)

    await runPass(w.worker('a', w.outboxOn()))

    expect(w.calls).toEqual(['claim:evt_1', 'attention:evt_1', 'failure:evt_1'])
    expect(w.rows.get('evt_1')!.status).toBe('BLOCKED')
    expect(w.minted).toHaveLength(0)
  })
})

describe('the delivery outbox (U8)', () => {
  it('re-delivers after the relay recovers, then discharges, with one mint', async () => {
    const w = world()
    w.add('evt_1')
    vi.stubGlobal('fetch', w.fetchImpl)
    const outbox = w.outboxOn()
    w.gw.dmFail = true

    await runPass(w.worker('a', outbox))
    expect(w.rows.get('evt_1')).toMatchObject({ status: 'ISSUED', voucherId: 'v1' })
    expect(await outbox.size()).toBe(1)

    // Not due yet: backoff.
    w.gw.dmFail = false
    await w.deliveryPass(outbox)
    expect(w.sends.filter((s) => s.ok)).toHaveLength(0)

    w.advance(10_001)
    const pass = await w.deliveryPass(outbox)

    expect(pass.delivered).toBe(1)
    expect(w.sends.filter((s) => s.ok)).toHaveLength(1)
    // The token is re-read from the gateway, never kept on disk.
    expect(w.sends.at(-1)!.token).toBe('cashuB-reread-v1')
    expect(w.rows.get('evt_1')).toMatchObject({ status: 'DISCHARGED', voucherId: 'v1' })
    expect(w.minted).toHaveLength(1)
    expect(await outbox.size()).toBe(0)
  })

  // imani-wallet#287 (U3), red on main: the DM body carried no voucher_id, so gc never recorded
  // the delivery in gateway-core and every card discharge was refused (staging S2, E2).
  it('names the voucher it carries in every delivery, inline and from the outbox (#287)', async () => {
    const w = world()
    w.add('evt_1')
    vi.stubGlobal('fetch', w.fetchImpl)
    const outbox = w.outboxOn()
    w.gw.dmFail = true
    await runPass(w.worker('a', outbox))
    w.gw.dmFail = false
    w.advance(10_001)
    await w.deliveryPass(outbox)

    expect(w.sends).toHaveLength(2)
    expect(w.sends.map((s) => s.voucherId)).toEqual(['v1', 'v1'])
    expect(w.rows.get('evt_1')).toMatchObject({ status: 'DISCHARGED', voucherId: 'v1' })
  })

  // imani-wallet#287 (U3), red on main: a 2xx WITHOUT fulfilment_recorded was taken as delivered,
  // the outbox entry dropped, and the row sat ISSUED with nothing left to re-send it.
  it('retries a 2xx without fulfilment_recorded, then discharges once gc records it (#287)', async () => {
    const w = world()
    w.add('evt_1')
    vi.stubGlobal('fetch', w.fetchImpl)
    const outbox = w.outboxOn()
    w.gw.records = false

    await runPass(w.worker('a', outbox))
    expect(w.sends.filter((s) => s.ok)).toHaveLength(1)
    expect(w.rows.get('evt_1')).toMatchObject({ status: 'ISSUED', voucherId: 'v1' })
    expect(await outbox.size()).toBe(1)

    w.advance(10_001)
    await w.deliveryPass(outbox)
    expect(await outbox.size()).toBe(1)
    expect(w.rows.get('evt_1')!.status).toBe('ISSUED')

    w.gw.records = true
    w.advance(60_001)
    const pass = await w.deliveryPass(outbox)

    expect(pass.delivered).toBe(1)
    expect(w.rows.get('evt_1')).toMatchObject({ status: 'DISCHARGED', voucherId: 'v1' })
    expect(await outbox.size()).toBe(0)
  })

  // imani-wallet#287 (U3) + core#163, red before this commit: a 503 mint_unavailable and a 502 are
  // retried, and a permanent receipt refusal (422 proofs_not_unspent, as gc#235 may forward it) is
  // parked delivery_exhausted at once, naming the code, with no further send.
  it('retries 502/503, parks a permanent receipt refusal without retrying (#287, core#163)', async () => {
    for (const [status, body] of [[503, { error: 'mint_unavailable' }], [502, { error: 'core unreachable' }]] as const) {
      const w = world()
      w.add('evt_1')
      vi.stubGlobal('fetch', w.fetchImpl)
      const outbox = w.outboxOn()
      Object.assign(w.gw, { dmFail: true, dmStatus: status, dmBody: body })
      await runPass(w.worker('a', outbox))
      w.gw.dmFail = false
      w.advance(10_001)
      await w.deliveryPass(outbox)
      expect(w.rows.get('evt_1')!.status).toBe('DISCHARGED')
    }

    for (const [status, body, header, code] of [
      // gc#235: 422 + X-Imani-Issuance-Refused, the code goes into last_failure.
      [422, { error: 'refused' }, 'proofs_not_unspent', 'proofs_not_unspent'],
      [422, {}, 'refused', 'refused'],
      [422, {}, null, 'refused'],
    ] as const) {
      const w = world()
      w.add('evt_1')
      vi.stubGlobal('fetch', w.fetchImpl)
      const outbox = w.outboxOn()
      Object.assign(w.gw, { dmFail: true, dmStatus: status, dmBody: body, dmHeader: header })
      await runPass(w.worker('a', outbox))
      await w.deliveryPass(outbox)
      w.advance(3_600_001)
      await w.deliveryPass(outbox)

      expect(w.sends).toHaveLength(1)
      expect(w.rows.get('evt_1')!.status).toBe('NEEDS_ATTENTION')
      expect(w.rows.get('evt_1')!.attention).toMatchObject({ reason: 'delivery_exhausted', voucherId: 'v1' })
      expect(w.rows.get('evt_1')!.attention!.detail).toContain(`422 ${code}`)
      expect(await outbox.size()).toBe(0)
    }
  })

  // imani-wallet#287 (U3): the retry is idempotent. Re-sending the same voucher never mints, and
  // every re-send carries the same voucher id and payment request (gc and core dedupe on those).
  it('re-sends the same voucher under the same payment request, minting once (#287)', async () => {
    const w = world()
    w.add('evt_1')
    vi.stubGlobal('fetch', w.fetchImpl)
    const outbox = w.outboxOn()
    w.gw.records = false
    await runPass(w.worker('a', outbox))
    for (let i = 0; i < 2; i++) {
      w.advance(120_001)
      await w.deliveryPass(outbox)
    }
    w.gw.records = true
    w.advance(120_001)
    await w.deliveryPass(outbox)
    await runPass(w.worker('a', outbox))

    expect(w.minted).toHaveLength(1)
    const prids = new Set(w.sends.map((s) => s.prid))
    expect(prids.size).toBe(1)
    expect(new Set(w.sends.map((s) => s.voucherId))).toEqual(new Set(['v1']))
    expect(w.sends.filter((s) => s.recorded)).toHaveLength(1)
    expect(w.rows.get('evt_1')!.status).toBe('DISCHARGED')
  })

  it('parks the row delivery_exhausted, naming the voucher, after N attempts', async () => {
    const w = world()
    w.add('evt_1')
    vi.stubGlobal('fetch', w.fetchImpl)
    const outbox = w.outboxOn()
    w.gw.dmFail = true

    await runPass(w.worker('a', outbox))
    for (let i = 0; i < 10; i++) {
      w.advance(60_001)
      await w.deliveryPass(outbox)
    }

    // 1 inline + 3 retries = maxAttempts 4.
    expect(w.sends).toHaveLength(4)
    expect(w.rows.get('evt_1')).toMatchObject({
      status: 'NEEDS_ATTENTION',
      attention: { reason: 'delivery_exhausted', voucherId: 'v1' },
    })
    expect(await outbox.size()).toBe(0)
    expect(w.minted).toHaveLength(1)
  })

  it('drops an exhausted entry whose row PA already closed (409), instead of asking hourly forever', async () => {
    const w = world()
    w.add('evt_1')
    vi.stubGlobal('fetch', w.fetchImpl)
    const outbox = w.outboxOn()
    w.gw.dmFail = true

    await runPass(w.worker('a', outbox))
    // PA's recheck closed it meanwhile (the send was verified another way).
    w.rows.get('evt_1')!.status = 'DISCHARGED'
    for (let i = 0; i < 10; i++) {
      w.advance(60_001)
      await w.deliveryPass(outbox)
    }

    expect(w.calls.filter((c) => c === 'attention:evt_1')).toHaveLength(1)
    expect(await outbox.size()).toBe(0)
  })

  it('never writes a token gc echoes in a refused send into the outbox file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'outbox-'))
    const path = join(dir, 'purchase-outbox.json')
    const w = world()
    w.add('evt_1')
    const echoing = (async (input: string | URL, init: RequestInit = {}) => {
      if (String(input).endsWith('/api/v1/dm/tokens/send')) {
        const token = JSON.parse(String(init.body)).token as string
        return new Response(
          JSON.stringify({ error: { code: 'VALIDATION_FAILED', field_errors: [{ field: 'token', rejected_value: token }] } }),
          { status: 400 },
        )
      }
      return w.fetchImpl(input, init)
    }) as typeof fetch
    vi.stubGlobal('fetch', echoing)
    const outbox = w.outboxOn(new FileOutboxStore(path))

    await runPass(w.worker('a', outbox))
    w.advance(10_001)
    await w.deliveryPass(outbox)

    const onDisk = await readFile(path, 'utf8')
    expect(onDisk).toContain('v1')
    expect(onDisk).not.toMatch(/cashuB-(fresh|reread)/)
  })

  it('backs off exponentially, capped', async () => {
    const outbox = new DeliveryOutbox(new MemoryOutboxStore(), {
      now: () => 0,
      maxAttempts: 10,
      baseBackoffMs: 1000,
      maxBackoffMs: 5000,
    })
    expect([1, 2, 3, 4, 5].map((n) => outbox.backoffMs(n))).toEqual([1000, 2000, 4000, 5000, 5000])
  })

  it('survives a restart: a fresh process over the same file delivers what was queued', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'outbox-'))
    const path = join(dir, 'purchase-outbox.json')
    const w = world()
    w.add('evt_1')
    vi.stubGlobal('fetch', w.fetchImpl)
    w.gw.dmFail = true

    await runPass(w.worker('a', w.outboxOn(new FileOutboxStore(path))))
    const onDisk = await readFile(path, 'utf8')
    expect(onDisk).toContain('v1')
    // A bearer token is value: it is never written down.
    expect(onDisk).not.toContain('cashuB')

    // "Restart": a new outbox over the same file.
    w.gw.dmFail = false
    w.advance(10_001)
    const pass = await w.deliveryPass(w.outboxOn(new FileOutboxStore(path)))

    expect(pass.delivered).toBe(1)
    expect(w.rows.get('evt_1')!.status).toBe('DISCHARGED')
    expect(w.minted).toHaveLength(1)
  })

  it('refuses to start over a corrupt outbox file rather than silently forget it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'outbox-'))
    const path = join(dir, 'purchase-outbox.json')
    await writeFile(path, '{not json')
    await expect(new FileOutboxStore(path).read()).rejects.toThrow()
  })

  it('a crash after the mint and before the outbox write re-claims and replays the same voucher', async () => {
    const w = world({ leaseMs: 1 })
    w.add('evt_1')
    vi.stubGlobal('fetch', w.fetchImpl)
    const dying = new DeliveryOutbox(
      { read: async () => [], write: async () => { throw new Error('SIGKILL') } },
      { now: () => 0, maxAttempts: 4, baseBackoffMs: 10, maxBackoffMs: 10 },
    )
    w.gw.dmFail = true
    // The queue write throws: the worker must not report the row as unminted.
    await runPass(w.worker('a', dying)).catch(() => undefined)
    expect(w.rows.get('evt_1')!.status).not.toBe('OWED')

    w.gw.dmFail = false
    w.rows.get('evt_1')!.status = 'ISSUING' // as if the process died holding the claim
    w.advance(10)
    await runPass(w.worker('b', w.outboxOn()))

    expect(w.minted).toHaveLength(1)
    expect(w.rows.get('evt_1')).toMatchObject({ status: 'DISCHARGED', voucherId: 'v1' })
  })
})

describe('the sale record is owned by the outbox (U8 over U9 #278)', () => {
  it('is retried until it lands, independent of delivery, and not re-sent once filed', async () => {
    const w = world()
    w.add('evt_1')
    vi.stubGlobal('fetch', w.fetchImpl)
    const fileSale = w.ports.fileSale as ReturnType<typeof vi.fn>
    fileSale.mockResolvedValueOnce(false).mockResolvedValueOnce(false)
    const outbox = w.outboxOn()

    await runPass(w.worker('a', outbox))
    // Delivered inline; only the sale is still pending.
    expect(w.rows.get('evt_1')!.status).toBe('DISCHARGED')
    expect(await outbox.size()).toBe(1)

    w.advance(10_001)
    await w.deliveryPass(outbox)
    w.advance(60_001)
    await w.deliveryPass(outbox)
    w.advance(60_001)
    await w.deliveryPass(outbox)

    expect(fileSale).toHaveBeenCalledTimes(3)
    expect(fileSale.mock.calls[2][1]).toMatchObject({ voucherId: 'v1', faceValue: 2500 })
    expect(await outbox.size()).toBe(0)
    // Delivery was never repeated for the sale's sake.
    expect(w.sends).toHaveLength(1)
  })
})
