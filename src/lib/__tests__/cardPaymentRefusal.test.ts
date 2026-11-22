/**
 * imani-wallet#277: the redeem and send sides of a refunded card voucher.
 *
 * Redeem: gateway-customer refuses it 422 `VOUCHER_PAYMENT_REFUNDED` before any swap, which dm-poll
 * must see as a typed TERMINAL refusal (retried, it is refused the same way every poll).
 * Send: the wallet does not offer it (UX only; the gateway is the guard).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RedemptionRefusedError } from '@imani/dm-poll'

import { asFullyRedeemedRefusal } from '../dmPoll'
import { REFUSAL_MESSAGES } from '../refusalToast'
import { __resetCardPaymentStateCache, VoucherPaymentRefundedError } from '../cardPaymentState'

vi.mock('../voucherToken', async (original) => {
  const actual = await original<typeof import('../voucherToken')>()
  return {
    ...actual,
    parseVoucherToken: (token: string) => ({
      voucher: { issuanceWarrant: token.startsWith('card:') ? 'W:' + token.slice(5) : undefined },
    }),
  }
})
vi.mock('../paymentReference', async (original) => {
  const actual = await original<typeof import('../paymentReference')>()
  return {
    ...actual,
    cardReferenceOf: (w: unknown) => (typeof w === 'string' && w.startsWith('W:') ? w.slice(2) : undefined),
  }
})

import { withoutRefundedCardVouchers } from '../pay'

describe('a card voucher refused at redeem', () => {
  const VOUCHER = '1b6f3e2a-9c44-4f0b-8a21-3d5e6f7a8b9c'

  function gatewayRefusal(details: string): Error {
    const error = new Error('This voucher can’t be spent') as Error & Record<string, unknown>
    error.status = 422
    error.code = 'VOUCHER_PAYMENT_REFUNDED'
    error.data = { error: { code: 'VOUCHER_PAYMENT_REFUNDED', details } }
    return error
  }

  it('becomes a terminal payment-refunded refusal', () => {
    const refusal = asFullyRedeemedRefusal(gatewayRefusal('refunded:0'), { voucherId: VOUCHER })
    expect(refusal).toBeInstanceOf(RedemptionRefusedError)
    expect((refusal as RedemptionRefusedError).reason).toBe('payment-refunded')
    expect((refusal as Error).message).toBe(REFUSAL_MESSAGES['payment-refunded'].detail)
  })

  it('carries what a partly refunded voucher may still take', () => {
    const refusal = asFullyRedeemedRefusal(gatewayRefusal('partly_refunded:700'), { voucherId: VOUCHER })
    expect((refusal as RedemptionRefusedError).signedFaceValue).toBe(700)
  })
})

describe('send refuses a refunded card voucher', () => {
  const states: Record<string, unknown> = {}
  beforeEach(() => {
    __resetCardPaymentStateCache()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const ref = url.split('/').pop()!
        return states[ref] ? new Response(JSON.stringify(states[ref])) : new Response('', { status: 404 })
      }),
    )
  })
  afterEach(() => vi.unstubAllGlobals())

  const v = (token: string, face: number) => ({ token, face_value: face }) as never
  const st = (status: string, paid: number, refunded: number) => ({
    status,
    paid_minor: paid,
    refunded_amount_minor: refunded,
    disputed: status === 'DISPUTED',
    backed_minor: status === 'DISPUTED' ? 0 : paid - refunded,
  })

  it('drops a refunded or disputed one, keeps the rest', async () => {
    states.pi_r = st('REFUNDED', 1000, 1000)
    states.pi_d = st('DISPUTED', 1000, 0)
    const kept = await withoutRefundedCardVouchers([v('card:pi_r', 1000), v('card:pi_d', 1000), v('plain', 500)], 500)
    expect(kept).toHaveLength(1)
  })

  it('throws when nothing else can pay, so the screen says why', async () => {
    states.pi_r = st('REFUNDED', 1000, 1000)
    await expect(withoutRefundedCardVouchers([v('card:pi_r', 1000)], 500)).rejects.toBeInstanceOf(VoucherPaymentRefundedError)
  })

  it('allows a partly refunded one up to what is backed, never more', async () => {
    states.pi_p = st('PARTLY_REFUNDED', 1000, 300)
    expect(await withoutRefundedCardVouchers([v('card:pi_p', 1000)], 700)).toHaveLength(1)
    await expect(withoutRefundedCardVouchers([v('card:pi_p', 1000)], 800)).rejects.toBeInstanceOf(VoucherPaymentRefundedError)
  })

  it('keeps a voucher whose payment cannot be looked up (the gateway decides)', async () => {
    expect(await withoutRefundedCardVouchers([v('card:pi_unknown', 1000)], 500)).toHaveLength(1)
  })
})
