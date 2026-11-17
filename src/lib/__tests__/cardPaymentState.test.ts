/**
 * @vitest-environment jsdom
 *
 * imani-wallet#277: the state mapping a refunded card voucher is shown and refused by, and the
 * two lookups. Every lookup failure reads as unknown, never as refunded.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../nip98', () => ({
  signedFetch: vi.fn(),
}))

import { signedFetch } from '../nip98'
import {
  __resetCardPaymentStateCache,
  cardPaymentExplanation,
  cardPaymentLabel,
  cardPaymentMerchantNote,
  holderCardPaymentState,
  isUnspendable,
  parsePurchaseState,
  refusalOf,
  stallCardPaymentStates,
  stateFor,
  VoucherPaymentRefundedError,
} from '../cardPaymentState'

const gbp = (minor: number) => `£${(minor / 100).toFixed(2)}`
const PI = 'pi_3UQtbaAbc'
const STALL = 'a'.repeat(64)

function body(status: string, paid: number, refunded: number, disputed = false) {
  return {
    voucher_id: 'v1',
    ref: PI,
    paid_minor: paid,
    currency: 'gbp',
    refunded_amount_minor: refunded,
    disputed,
    dispute_status: disputed ? 'OPEN' : null,
    reversed_at: '2026-11-17T10:00:00Z',
    backed_minor: disputed ? 0 : paid - refunded,
    status,
  }
}

describe('the state mapping', () => {
  it('reads each status', () => {
    expect(parsePurchaseState(body('PAID', 1000, 0))?.status).toBe('paid')
    expect(parsePurchaseState(body('REFUNDED', 1000, 1000))?.status).toBe('refunded')
    expect(parsePurchaseState(body('PARTLY_REFUNDED', 1000, 300))).toMatchObject({
      status: 'partly_refunded',
      paidMinor: 1000,
      refundedMinor: 300,
      backedMinor: 700,
      voucherId: 'v1',
      ref: PI,
    })
    expect(parsePurchaseState(body('DISPUTED', 1000, 0, true))).toMatchObject({ status: 'disputed', backedMinor: 0 })
  })

  it('refuses what it cannot read', () => {
    expect(parsePurchaseState(null)).toBeUndefined()
    expect(parsePurchaseState({ status: 'SOMETHING' })).toBeUndefined()
  })

  it('labels, explains and blocks', () => {
    const partly = parsePurchaseState(body('PARTLY_REFUNDED', 1000, 300))!
    expect(cardPaymentLabel(partly, gbp)).toBe('Partly refunded £3.00 of £10.00')
    expect(cardPaymentExplanation(partly, gbp)).toContain('£7.00')
    expect(cardPaymentMerchantNote(partly, gbp)).toContain('£7.00')
    expect(isUnspendable(partly)).toBe(false)
    const refunded = parsePurchaseState(body('REFUNDED', 1000, 1000))!
    expect(cardPaymentLabel(refunded, gbp)).toBe('Refunded')
    expect(cardPaymentExplanation(refunded, gbp)).toBe('Can’t be spent: the card payment for this voucher was refunded.')
    expect(isUnspendable(refunded)).toBe(true)
    const disputed = parsePurchaseState(body('DISPUTED', 1000, 0, true))!
    expect(cardPaymentLabel(disputed, gbp)).toBe('Disputed')
    expect(isUnspendable(disputed)).toBe(true)
  })

  it('matches a stall sale by ref, then voucher id', () => {
    const s = [parsePurchaseState(body('REFUNDED', 1000, 1000))!]
    expect(stateFor(s, { ref: PI })?.status).toBe('refunded')
    expect(stateFor(s, { voucherId: 'v1' })?.status).toBe('refunded')
    expect(stateFor(s, { ref: 'pi_other' })).toBeUndefined()
    expect(stateFor(undefined, { ref: PI })).toBeUndefined()
  })
})

describe('the gateway refusal', () => {
  it('reads VOUCHER_PAYMENT_REFUNDED from a receive 422 in any shape the clients pass on', () => {
    expect(refusalOf({ error: { code: 'VOUCHER_PAYMENT_REFUNDED', details: 'refunded:0' } })).toEqual({
      status: 'refunded',
      remainingMinor: 0,
    })
    expect(refusalOf({ data: { error: { code: 'VOUCHER_PAYMENT_REFUNDED', details: 'partly_refunded:700' } } })).toEqual({
      status: 'partly_refunded',
      remainingMinor: 700,
    })
    expect(refusalOf({ code: 'VOUCHER_PAYMENT_REFUNDED', details: 'disputed:0' })?.status).toBe('disputed')
    expect(refusalOf({ code: 'VOUCHER_FULLY_REDEEMED' })).toBeUndefined()
    expect(refusalOf(new Error('x'))).toBeUndefined()
  })

  it('names the send refusal per state', () => {
    expect(new VoucherPaymentRefundedError('refunded').message).toContain('refunded')
    expect(new VoucherPaymentRefundedError('disputed').message).toContain('disputed')
  })
})

describe('the lookups', () => {
  beforeEach(() => __resetCardPaymentStateCache())
  afterEach(() => vi.restoreAllMocks())

  it('asks the holder route by ref and caches it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body('REFUNDED', 1000, 1000))))
    vi.stubGlobal('fetch', fetchMock)
    expect((await holderCardPaymentState(PI))?.status).toBe('refunded')
    await holderCardPaymentState(PI)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/v1/purchase-state/holder/${PI}`)
  })

  it('is unknown, never refunded, when it cannot ask', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')))
    expect(await holderCardPaymentState(PI)).toBeUndefined()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })))
    expect(await holderCardPaymentState(PI)).toBeUndefined()
    expect(await holderCardPaymentState('ch_not_a_pi')).toBeUndefined()
    expect(await holderCardPaymentState(undefined)).toBeUndefined()
  })

  it('signs the stall read as the stall', async () => {
    vi.mocked(signedFetch).mockResolvedValue(new Response(JSON.stringify([body('DISPUTED', 1000, 0, true)])))
    const states = await stallCardPaymentStates(STALL)
    expect(states?.[0]?.status).toBe('disputed')
    expect(vi.mocked(signedFetch).mock.calls[0]?.slice(0, 2)).toEqual([`/api/v1/purchase-state/stall/${STALL}`, 'GET'])
    expect(await stallCardPaymentStates('not-a-key')).toBeUndefined()
  })
})
