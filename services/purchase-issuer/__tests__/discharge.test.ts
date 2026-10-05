/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { discharge, type Obligation, type Ports } from '../discharge'
import { CREDENTIAL_HEADER, IssuanceFailed, issueBody } from '../issuer'
import { STALL, delegatedCredential } from './stallFixture'

/**
 * What happens when issuing a paid-for coupon goes wrong.
 *
 * The happy path is one test. The rest are about money, and they encode two
 * rules that cost real customers to learn:
 *
 * - **Never discharge a debt on an attempt.** Only a coupon that exists and a
 *   delivery that returned.
 * - **Never report an issued coupon as unminted.** A second pass would mint a
 *   second coupon for one payment.
 */

// A real stall and its real delegation: since #152 nothing mints without one.
const CREDENTIAL = delegatedCredential()

const OBLIGATION: Obligation = {
  id: 'evt_1',
  paymentRequestId: '0123456789abcdef0123456789abcdef',
  stallPubkey: STALL,
  faceValue: 2500,
  faceUnit: 'GBP',
  faceDecimals: 2,
  memo: 'Voucher',
  recipient: { kind: 'pubkey', pubkey: 'c'.repeat(64) },
  attempts: 0,
}

function ports(over: Partial<Ports> = {}): Ports {
  return {
    credentialFor: async () => CREDENTIAL,
    tokenFor: async () => '',
    now: () => Date.now(),
    sleep: async () => {},
    ...over,
  }
}

function reply(status: number, body: unknown) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
}

describe('discharging a purchase', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('mints and delivers, then reports the debt discharged', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply(201, { voucher_id: 'v1', token: 'cashuB123' }))
      .mockResolvedValueOnce(reply(200, { event_id: 'ev1' }))
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await discharge('http://gw', OBLIGATION, ports())

    expect(outcome).toEqual({
      kind: 'discharged',
      voucherId: 'v1',
      issuerId: '',
      eventId: 'ev1',
    })
  })

  it('stamps the payment request id onto the delivery', async () => {
    // Without it the send answers no request, so the purchases API can never
    // confirm the discharge: the coupon would be issued and the debt would
    // stay open forever.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply(201, { voucher_id: 'v1', token: 't' }))
      .mockResolvedValueOnce(reply(200, { event_id: 'ev1' }))
    vi.stubGlobal('fetch', fetchMock)

    await discharge('http://gw', OBLIGATION, ports())

    const [, init] = fetchMock.mock.calls[1]
    // snake_case, matching SendTokenDmRequest's @JsonProperty. The DTO ignores
    // unknown fields, so a camelCase key is dropped in silence and the debt
    // can never be discharged.
    expect(JSON.parse(init.body).payment_request_id).toBe(
      '0123456789abcdef0123456789abcdef',
    )
    expect(JSON.parse(init.body).paymentRequestId).toBeUndefined()
  })

  it('issues as the stall, naming no issuer of its own', async () => {
    // The gateway derives the issuer from the credential. Sending one would be
    // asserting something we are not the authority on, and an unauthenticated
    // POST naming an arbitrary stall is the door imani-woo ADR 0008 records
    // being shut.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply(201, { voucher_id: 'v1', token: 't' }))
      .mockResolvedValueOnce(reply(200, {}))
    vi.stubGlobal('fetch', fetchMock)

    await discharge('http://gw', OBLIGATION, ports())

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toContain('/api/v1/wallet/vouchers')
    expect(url).not.toContain('/portal/')
    expect(init.headers[CREDENTIAL_HEADER]).toBe('cred-1')
    expect(JSON.parse(init.body)).not.toHaveProperty('issuer_id')
  })

  it('backs a coupon proportionally, so it can be spent in small amounts', () => {
    // MINIMAL backing shipped once and a customer paying £10.75 from a £25
    // coupon hit SPLIT_ERROR, unrecoverable. This is that bug's tripwire.
    expect(JSON.parse(issueBody({
      faceValue: 2500,
      faceUnit: 'GBP',
      faceDecimals: 2,
      memo: '',
      expiresInDays: 365,
    })).backing_strategy).toBe('PROPORTIONAL')
  })

  it('leaves the debt owed when the gateway is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))

    const outcome = await discharge('http://gw', OBLIGATION, ports())

    expect(outcome.kind).toBe('owed')
  })

  it('blocks rather than retries when the credential was burnt', async () => {
    // A stall revoking its issuer is a deliberate act. Retrying forever would
    // bury the one case needing a person under identical failures.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(403, 'forbidden')))

    const outcome = await discharge('http://gw', OBLIGATION, ports())

    expect(outcome.kind).toBe('blocked')
    if (outcome.kind === 'blocked') {
      expect(outcome.reason).toContain('no longer authorises')
    }
  })

  it('never says owed once a coupon exists', async () => {
    // The dangerous case. Delivery failed, but the coupon was minted; calling
    // this owed would mint a second one for the same payment.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply(201, { voucher_id: 'v1', token: 'cashuB123' }))
      .mockResolvedValueOnce(reply(500, 'gateway exploded'))
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await discharge('http://gw', OBLIGATION, ports())

    expect(outcome.kind).toBe('undelivered')
    if (outcome.kind === 'undelivered') {
      expect(outcome.voucherId).toBe('v1')
    }
  })

  it('reports undelivered rather than discharged when the mint has no token yet', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(reply(201, { voucher_id: 'v1', token: '' }))
    vi.stubGlobal('fetch', fetchMock)

    let clock = 0
    const outcome = await discharge('http://gw', OBLIGATION, ports({
      now: () => (clock += 1000),
      tokenFor: async () => '',
    }))

    expect(outcome.kind).toBe('undelivered')
  })

  it('collects a token that arrives late, and delivers it', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply(201, { voucher_id: 'v1', token: '' }))
      .mockResolvedValueOnce(reply(200, { event_id: 'ev1' }))
    vi.stubGlobal('fetch', fetchMock)

    let polls = 0
    const outcome = await discharge('http://gw', OBLIGATION, ports({
      tokenFor: async () => (++polls >= 2 ? 'cashuB123' : ''),
    }))

    expect(outcome.kind).toBe('discharged')
  })

  it('falls back to manual issuance when the stall holds no credential', async () => {
    // Not an error. A stall that never enrolled an issuer is the ordinary
    // configuration, and the debt is discharged by hand.
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await discharge('http://gw', OBLIGATION, ports({
      credentialFor: async () => null,
    }))

    expect(outcome).toEqual({ kind: 'manual' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not throw when a poll fails mid-wait', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply(201, { voucher_id: 'v1', token: '' }))
      .mockResolvedValueOnce(reply(200, {}))
    vi.stubGlobal('fetch', fetchMock)

    let polls = 0
    const outcome = await discharge('http://gw', OBLIGATION, ports({
      tokenFor: async () => {
        if (++polls === 1) throw new Error('transient')
        return 'cashuB123'
      },
    }))

    expect(outcome.kind).toBe('discharged')
  })

  it('marks a failed issuance retryable or not, and never silently drops it', () => {
    expect(new IssuanceFailed('x', true).retryable).toBe(true)
    expect(new IssuanceFailed('x', false).retryable).toBe(false)
  })
})
