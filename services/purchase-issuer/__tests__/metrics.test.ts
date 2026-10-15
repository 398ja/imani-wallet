/**
 * @vitest-environment node
 *
 * imani-deploy#210: the issuer's counters move on every outcome, and /metrics
 * carries no id, stall or amount.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { attemptCount, renderMetrics, resetMetricsForTest } from '../metrics'
import { runPass, type WorkerDeps } from '../worker'
import type { PurchasesApi, OwedPurchase } from '../purchasesApi'
import type { Ports } from '../discharge'
import { delegatedCredential } from './stallFixture'

function owed(over: Partial<OwedPurchase> = {}): OwedPurchase {
  return {
    eventId: 'evt_secret_1',
    paymentRequestId: '0123456789abcdef0123456789abcdef',
    stallPubkey: 'b'.repeat(64),
    recipientPubkey: 'c'.repeat(64),
    amountMinor: 2500,
    currency: 'gbp',
    livemode: true,
    attempts: 0,
    processorReference: 'pi_secret',
    ...over,
  }
}

function deps(): WorkerDeps & { api: PurchasesApi } {
  const api = {
    owed: vi.fn().mockResolvedValue([owed()]),
    claim: vi.fn().mockResolvedValue('claimed'),
    discharge: vi.fn().mockResolvedValue('accepted'),
    reportFailure: vi.fn().mockResolvedValue(undefined),
  } as unknown as PurchasesApi
  const ports: Ports = {
    credentialFor: async () => delegatedCredential({ credentialId: 'c1' }),
    tokenFor: async () => '',
    now: () => Date.now(),
    sleep: async () => {},
  }
  return { api, ports, gatewayUrl: 'http://gw', livemode: true } as never
}

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
const mock = (f: unknown) => f as ReturnType<typeof vi.fn>

describe('purchase-issuer metrics', () => {
  beforeEach(() => resetMetricsForTest())

  it('counts a discharge', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(reply(201, { voucher_id: 'v1', token: 't', issuer_id: 'i1' }))
      .mockResolvedValueOnce(reply(200, { event_id: 'ev1' })))
    await runPass(deps())
    expect(attemptCount('discharged')).toBe(1)
  })

  it('counts a refused discharge', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(reply(201, { voucher_id: 'v1', token: 't', issuer_id: 'i1' }))
      .mockResolvedValueOnce(reply(200, {})))
    const d = deps()
    mock(d.api.discharge).mockResolvedValue('refused')
    await runPass(d)
    expect(attemptCount('discharge_rejected')).toBe(1)
    expect(attemptCount('discharged')).toBe(0)
  })

  it('counts a burnt credential as blocked', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('no', { status: 403 })))
    await runPass(deps())
    expect(attemptCount('blocked')).toBe(1)
  })

  it('counts skips and lost or unreachable claims', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const d = deps()
    mock(d.api.owed).mockResolvedValue([owed({ livemode: false }), owed({ stallPubkey: null }), owed(), owed()])
    mock(d.api.claim).mockResolvedValueOnce('taken').mockResolvedValueOnce('unreachable')
    await runPass(d)
    expect(attemptCount('skipped')).toBe(2)
    expect(attemptCount('claim_lost')).toBe(1)
    expect(attemptCount('claim_unreachable')).toBe(1)
  })

  it('renders every series at zero and no identifying value', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('no', { status: 403 })))
    await runPass(deps())
    const text = renderMetrics()
    expect(text).toContain('imani_purchase_issuer_attempts_total{outcome="blocked"} 1')
    expect(text).toContain('imani_purchase_issuer_attempts_total{outcome="discharged"} 0')
    expect(text).toContain('imani_purchase_issuer_passes_total{result="halted"} 0')
    for (const leak of ['evt_secret', 'pi_secret', 'b'.repeat(16), '2500']) expect(text).not.toContain(leak)
  })
})
