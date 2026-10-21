/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest'
import type { VoucherRow } from '@imani/wallet-storage'

import { CARD_SALES_CHECKING, CARD_SALES_NOT_READY, LOG_IN_TO_PAY, NO_CARDS, NO_VOUCHERS, merchantActions, payPath, validVoucherCount } from '../merchantActions'
import { rememberAfterLogin, takeAfterLogin } from '../afterLogin'

/** Buy and Pay enablement, exactly as #280's acceptance table states it. */

const STALL = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)
const future = Math.floor(Date.now() / 1000) + 86_400
const past = Math.floor(Date.now() / 1000) - 86_400

function row(over: Partial<VoucherRow>): VoucherRow {
  return { token_id: Math.random().toString(36), issuer_id: STALL, status: 'unspent', expires_at: future, ...over } as VoucherRow
}

describe('merchantActions', () => {
  it('Stripe and no vouchers: Buy enabled, Pay disabled with its reason', () => {
    const { buy, pay } = merchantActions({ acceptsCards: true, cardSales: 'ready', validVouchers: 0, loggedIn: true })
    expect(buy).toEqual({ enabled: true })
    expect(pay).toEqual({ enabled: false, reason: NO_VOUCHERS })
  })

  it('no Stripe and valid vouchers: Buy disabled with its reason, Pay enabled', () => {
    const { buy, pay } = merchantActions({ acceptsCards: false, validVouchers: 2, loggedIn: true })
    expect(buy).toEqual({ enabled: false, reason: NO_CARDS })
    expect(pay).toEqual({ enabled: true })
  })

  it('logged out: Buy still enabled (it leads through login), Pay disabled', () => {
    const { buy, pay } = merchantActions({ acceptsCards: true, cardSales: 'ready', validVouchers: 0, loggedIn: false })
    expect(buy.enabled).toBe(true)
    expect(pay).toEqual({ enabled: false, reason: LOG_IN_TO_PAY })
  })
})

/**
 * imani-wallet#298: a stall can take card payments (Stripe, `acceptsCards`) without being able to
 * ISSUE what was paid for (the purchase issuer not enrolled). Buy must not take that money. It
 * fails safe: only an explicit "ready" from the issuer enables it, and the reason sits beside it.
 */
describe('Buy for a stall whose card sales are not ready (#298)', () => {
  // Stripe connected, issuer not enrolled: Buy disabled, with the reason adjacent.
  it('is disabled when the issuer is not enrolled', () => {
    const { buy } = merchantActions({ acceptsCards: true, cardSales: 'not-ready', validVouchers: 0, loggedIn: true })
    expect(buy).toEqual({ enabled: false, reason: CARD_SALES_NOT_READY })
  })

  // Still asking: disabled (unknown never sells), with a quiet reason.
  it('is disabled while readiness is unknown', () => {
    const { buy } = merchantActions({ acceptsCards: true, cardSales: 'checking', validVouchers: 0, loggedIn: true })
    expect(buy).toEqual({ enabled: false, reason: CARD_SALES_CHECKING })
  })

  // No Stripe at all still says so, whatever the issuer would say.
  it('keeps the no-cards reason when the stall takes no cards', () => {
    const { buy } = merchantActions({ acceptsCards: false, cardSales: 'ready', validVouchers: 0, loggedIn: true })
    expect(buy).toEqual({ enabled: false, reason: NO_CARDS })
  })
})

describe('validVoucherCount', () => {
  it('counts only this stall\'s unspent, unexpired coupons', () => {
    const rows = [row({}), row({ issuer_id: OTHER }), row({ expires_at: past }), row({ status: 'spent' }), row({ status: 'redeemed' })]
    expect(validVoucherCount(rows, STALL)).toBe(1)
  })

  it('only expired or spent vouchers leave Pay disabled', () => {
    const n = validVoucherCount([row({ expires_at: past }), row({ status: 'spent' })], STALL)
    expect(merchantActions({ acceptsCards: true, validVouchers: n, loggedIn: true }).pay.enabled).toBe(false)
  })
})

describe('payPath', () => {
  it('is the existing send flow, addressed to the stall, spending its coupons', () => {
    expect(payPath(STALL)).toBe(`/send?from=${STALL}&to=${STALL}`)
  })
})

describe('afterLogin', () => {
  it('returns a remembered purchase once', () => {
    rememberAfterLogin(`/buy/${STALL}`)
    expect(takeAfterLogin()).toBe(`/buy/${STALL}`)
    expect(takeAfterLogin()).toBeUndefined()
  })

  it('refuses anything but a purchase path', () => {
    rememberAfterLogin('https://evil.example/')
    expect(takeAfterLogin()).toBeUndefined()
    sessionStorage.setItem('imani:afterLogin', '//evil.example')
    expect(takeAfterLogin()).toBeUndefined()
  })
})
