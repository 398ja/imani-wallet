import { describe, expect, it } from 'vitest'

import {
  computeNotificationId,
  containsTokenMaterial,
  pickCorrelationId,
  validateEnvelope,
  type IncomingPaymentNotificationEnvelope,
} from '../incomingNotification'

/**
 * Tests for the incoming-payment envelope validator — the gate every drained
 * Artemis envelope passes before it can raise a toast. Ported from imani-apps'
 * `@imani/incoming-notifications` envelope tests, covering the 7-step order and
 * the money-relevant refusals (recipient mismatch, amount mismatch, token
 * smuggling, stale/future timestamps).
 */

const SENDER_PUBKEY = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const RECIPIENT_PUBKEY = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
const SENDER_NPUB = 'npub10000000000000000000000000000000000000000000000000000000'
const RECIPIENT_NPUB = 'npub1zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'
const DELIVERY_EVENT_ID = 'evt-2026-05-12T00:08:11-abc123'

function happyPath(
  overrides: Partial<IncomingPaymentNotificationEnvelope> = {},
): IncomingPaymentNotificationEnvelope {
  const notificationId = computeNotificationId({
    recipientPubkeyHex: RECIPIENT_PUBKEY,
    senderPubkeyHex: SENDER_PUBKEY,
    correlationId: DELIVERY_EVENT_ID,
    currencyUnit: 'EUR',
  })
  const now = new Date().toISOString()
  return {
    v: 1,
    kind: 'incoming_payment_notification',
    notificationId,
    state: 'pending',
    sender: { pubkeyHex: SENDER_PUBKEY, npub: SENDER_NPUB },
    recipient: { pubkeyHex: RECIPIENT_PUBKEY, npub: RECIPIENT_NPUB },
    currency: { unit: 'EUR', decimals: 2 },
    total: { minorUnits: 1050, display: '10.50 EUR' },
    parts: [
      { partId: 'p1', amount: { minorUnits: 800, display: '8.00 EUR' }, state: 'pending' },
      { partId: 'p2', amount: { minorUnits: 250, display: '2.50 EUR' }, state: 'pending' },
    ],
    correlation: { bundleId: null, deliveryEventId: DELIVERY_EVENT_ID, fallbackWindowId: null },
    createdAt: now,
    updatedAt: now,
    supportRef: notificationId.slice(0, 8),
    ...overrides,
  }
}

describe('computeNotificationId', () => {
  it('is deterministic', () => {
    const args = {
      recipientPubkeyHex: RECIPIENT_PUBKEY,
      senderPubkeyHex: SENDER_PUBKEY,
      correlationId: DELIVERY_EVENT_ID,
      currencyUnit: 'EUR',
    }
    expect(computeNotificationId(args)).toBe(computeNotificationId(args))
  })

  it('changes when any input changes', () => {
    const base = computeNotificationId({
      recipientPubkeyHex: RECIPIENT_PUBKEY,
      senderPubkeyHex: SENDER_PUBKEY,
      correlationId: DELIVERY_EVENT_ID,
      currencyUnit: 'EUR',
    })
    const other = computeNotificationId({
      recipientPubkeyHex: RECIPIENT_PUBKEY,
      senderPubkeyHex: SENDER_PUBKEY,
      correlationId: DELIVERY_EVENT_ID,
      currencyUnit: 'USD',
    })
    expect(base).not.toBe(other)
  })
})

describe('pickCorrelationId', () => {
  it('prefers deliveryEventId over bundleId over fallbackWindowId', () => {
    expect(
      pickCorrelationId({ deliveryEventId: 'd', bundleId: 'b', fallbackWindowId: 'f' }),
    ).toBe('d')
    expect(pickCorrelationId({ bundleId: 'b', fallbackWindowId: 'f' })).toBe('b')
    expect(pickCorrelationId({ fallbackWindowId: 'f' })).toBe('f')
  })
  it('returns null when nothing is populated', () => {
    expect(pickCorrelationId({})).toBeNull()
    expect(pickCorrelationId(null)).toBeNull()
  })
})

describe('validateEnvelope', () => {
  it('accepts a well-formed envelope addressed to us', () => {
    const res = validateEnvelope(happyPath(), RECIPIENT_PUBKEY)
    expect(res.ok).toBe(true)
  })

  it('accepts a backend id with a tracking prefix', () => {
    const base = happyPath()
    const res = validateEnvelope(
      { ...base, notificationId: 'ipn-' + base.notificationId },
      RECIPIENT_PUBKEY,
    )
    expect(res.ok).toBe(true)
  })

  it('rejects a non-object', () => {
    expect(validateEnvelope(null, RECIPIENT_PUBKEY)).toMatchObject({ ok: false })
    expect(validateEnvelope('x', RECIPIENT_PUBKEY)).toMatchObject({ ok: false })
  })

  it('rejects a wrong version or kind', () => {
    expect(validateEnvelope(happyPath({ v: 2 as never }), RECIPIENT_PUBKEY)).toMatchObject({
      ok: false,
      reason: 'bad_v',
    })
    expect(
      validateEnvelope(happyPath({ kind: 'something_else' as never }), RECIPIENT_PUBKEY),
    ).toMatchObject({ ok: false, reason: 'bad_kind' })
  })

  it('rejects an envelope addressed to someone else', () => {
    const res = validateEnvelope(happyPath(), SENDER_PUBKEY)
    expect(res).toMatchObject({ ok: false, reason: 'recipient_mismatch' })
  })

  it('rejects a tampered notificationId', () => {
    const res = validateEnvelope(
      happyPath({ notificationId: 'a'.repeat(64) }),
      RECIPIENT_PUBKEY,
    )
    expect(res).toMatchObject({ ok: false, reason: 'notificationId_mismatch' })
  })

  it('rejects when parts do not sum to total', () => {
    const base = happyPath()
    const res = validateEnvelope(
      {
        ...base,
        parts: [{ partId: 'p1', amount: { minorUnits: 999, display: '9.99' }, state: 'pending' }],
      },
      RECIPIENT_PUBKEY,
    )
    // notificationId is derived independent of parts, so the amount check fires.
    expect(res).toMatchObject({ ok: false, reason: 'amount_mismatch' })
  })

  it('rejects an envelope with no correlation source', () => {
    const base = happyPath({ correlation: {} })
    const res = validateEnvelope(base, RECIPIENT_PUBKEY)
    expect(res).toMatchObject({ ok: false, reason: 'no_correlation' })
  })

  it('rejects smuggled token material', () => {
    const base = happyPath()
    const res = validateEnvelope(
      { ...base, parts: [...base.parts], sneaky: { proofs: ['x'] } } as never,
      RECIPIENT_PUBKEY,
    )
    expect(res).toMatchObject({ ok: false, reason: 'forbidden_field' })
  })

  it('rejects a stale createdAt (older than 7 days)', () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
    const res = validateEnvelope(happyPath({ createdAt: eightDaysAgo }), RECIPIENT_PUBKEY)
    expect(res).toMatchObject({ ok: false, reason: 'createdAt_stale' })
  })

  it('rejects a future createdAt beyond skew tolerance', () => {
    const future = new Date(Date.now() + 5 * 60 * 1000).toISOString()
    const res = validateEnvelope(happyPath({ createdAt: future }), RECIPIENT_PUBKEY)
    expect(res).toMatchObject({ ok: false, reason: 'createdAt_future' })
  })
})

describe('containsTokenMaterial', () => {
  it('flags forbidden key substrings at any depth', () => {
    expect(containsTokenMaterial({ a: { b: { privateKey: '...' } } })).toBe(true)
    expect(containsTokenMaterial({ tokens: [] })).toBe(true)
    expect(containsTokenMaterial({ nested: { proofs: [1] } })).toBe(true)
  })
  it('flags cashu-shaped values in misnamed fields', () => {
    expect(containsTokenMaterial({ note: 'cashuAeyJ...' })).toBe(true)
    expect(containsTokenMaterial({ note: 'cashuBeyJ...' })).toBe(true)
  })
  it('passes a clean object', () => {
    expect(containsTokenMaterial({ amount: 10, display: '10 EUR' })).toBe(false)
  })
})

