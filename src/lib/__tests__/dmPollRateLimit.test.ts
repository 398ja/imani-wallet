/**
 * Retrying a rate-limited redemption.
 *
 * The gateway limits `/api/v1/wallet/receive` to 10 requests a minute per
 * pubkey, and dm-poll redeems in a tight sequential loop, so any wallet
 * receiving more than ten coupons in a minute trips it. Before #39 the failure
 * was silent and permanent: the service logged, moved on, and the coupon was
 * never redeemed. Measured at 120 coupons: 320 rate-limit errors, 50 stored.
 *
 * These pin the two decisions that matter — what counts as rate-limited, and
 * that the backoff can outlast a one-minute window — because both are easy to
 * regress into something that looks reasonable and drops coupons.
 */

import { describe, it, expect, vi } from 'vitest'

import { retryOnTransientMintError, RetryExhaustedError } from '@imani/dm-poll'

import { RATE_LIMIT_BACKOFFS_MS, isRateLimited } from '../dmPoll'

describe('isRateLimited', () => {
  it('recognises a 429 by status', () => {
    expect(isRateLimited(Object.assign(new Error('nope'), { status: 429 }))).toBe(true)
  })

  it('recognises the gateway message when status was lost', () => {
    // The legacy bridge rebuilds errors and does not always carry `status`.
    expect(isRateLimited(new Error('Rate limit exceeded for this endpoint'))).toBe(true)
  })

  it('does not treat other failures as transient', () => {
    // Retrying these would be worse than failing: a refused redemption is a
    // decision, and a 500 from the mint may already have taken the money.
    expect(isRateLimited(Object.assign(new Error('boom'), { status: 500 }))).toBe(false)
    expect(isRateLimited(new Error('Token validation failed at mint'))).toBe(false)
    expect(isRateLimited(undefined)).toBe(false)
  })
})

describe('RATE_LIMIT_BACKOFFS_MS', () => {
  it('can outlast a one-minute window', () => {
    // dm-poll's default is 1s/4s/15s, which exhausts itself INSIDE the window
    // it is waiting for and drops the coupon anyway.
    const total = RATE_LIMIT_BACKOFFS_MS.reduce((a, b) => a + b, 0)
    expect(total).toBeGreaterThan(60_000)
    expect(Math.max(...RATE_LIMIT_BACKOFFS_MS)).toBeGreaterThanOrEqual(60_000)
  })
})

describe('retrying a rate-limited redeem', () => {
  const instant = { sleep: async () => {} }

  it('recovers a coupon that was rate limited once', async () => {
    let calls = 0
    const redeem = vi.fn(async () => {
      calls++
      if (calls === 1) throw Object.assign(new Error('Rate limit exceeded'), { status: 429 })
      return { id: 'voucher-1' }
    })

    const voucher = await retryOnTransientMintError(redeem, {
      isTransient: isRateLimited,
      backoffsMs: [1, 1, 1],
      ...instant,
    })

    expect(voucher).toEqual({ id: 'voucher-1' })
    expect(redeem).toHaveBeenCalledTimes(2)
  })

  it('propagates a non-transient failure untouched, without retrying', async () => {
    const refused = Object.assign(new Error('over-redeemed'), { status: 403 })
    const redeem = vi.fn(async () => {
      throw refused
    })

    await expect(
      retryOnTransientMintError(redeem, {
        isTransient: isRateLimited,
        backoffsMs: [1],
        ...instant,
      }),
    ).rejects.toBe(refused)
    expect(redeem).toHaveBeenCalledTimes(1)
  })

  it('gives up eventually rather than retrying a coupon forever', async () => {
    const redeem = vi.fn(async () => {
      throw Object.assign(new Error('Rate limit exceeded'), { status: 429 })
    })

    await expect(
      retryOnTransientMintError(redeem, {
        isTransient: isRateLimited,
        backoffsMs: [1, 1],
        ...instant,
      }),
    ).rejects.toBeInstanceOf(RetryExhaustedError)
    // Three attempts: the first, plus one per backoff.
    expect(redeem).toHaveBeenCalledTimes(3)
  })
})
