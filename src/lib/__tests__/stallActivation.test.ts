/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../relay', () => ({ newestAddressable: vi.fn() }))

const {
  awaitMerchantSession,
  confirmStallVisible,
  RELOGIN_DELAYS_MS,
  markStallActivation,
  isStallActivationPending,
  clearStallActivation,
} = await import('../stallActivation')

const customer = { permissions: ['coupon:receive', 'coupon:pay'] }
const merchant = {
  permissions: ['coupon:receive', 'coupon:pay', 'coupon:issue', 'coupon:redeem'],
}

beforeEach(() => sessionStorage.clear())

describe('awaitMerchantSession (#114)', () => {
  it('re-runs the handshake until the session carries coupon:issue', async () => {
    const login = vi.fn().mockResolvedValueOnce(customer).mockResolvedValueOnce(merchant)
    const wait = vi.fn(async () => undefined)

    const result = await awaitMerchantSession({ login, wait })

    expect(result).toBe('merchant')
    expect(login).toHaveBeenCalledTimes(2)
  })

  it('keeps retrying past the 60 s gateway ACL cache before giving up', async () => {
    const login = vi.fn().mockResolvedValue(customer)
    const waited: number[] = []

    const result = await awaitMerchantSession({
      login,
      wait: async (ms) => void waited.push(ms),
    })

    expect(result).toBe('gave-up')
    expect(login).toHaveBeenCalledTimes(RELOGIN_DELAYS_MS.length)
    expect(waited.reduce((a, b) => a + b, 0)).toBeGreaterThan(60_000)
  })

  it('treats a failed handshake as one more try, not a failure', async () => {
    const login = vi.fn().mockRejectedValueOnce(new Error('503')).mockResolvedValueOnce(merchant)

    expect(await awaitMerchantSession({ login, wait: async () => undefined })).toBe('merchant')
  })

  it('stops when cancelled', async () => {
    const login = vi.fn().mockResolvedValue(customer)

    const result = await awaitMerchantSession({
      login,
      wait: async () => undefined,
      isCancelled: () => true,
    })

    expect(result).toBe('cancelled')
    expect(login).not.toHaveBeenCalled()
  })
})

describe('confirmStallVisible', () => {
  it('returns once the record we published reads back', async () => {
    const read = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ created_at: 100 })

    expect(
      await confirmStallVisible('p', 100, {
        read,
        wait: async () => undefined,
      }),
    ).toBe(true)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('ignores an older revision and gives up, bounded, without throwing', async () => {
    const read = vi.fn().mockResolvedValue({ created_at: 50 })

    expect(
      await confirmStallVisible('p', 100, {
        read,
        wait: async () => undefined,
        delaysMs: [0, 1, 1],
      }),
    ).toBe(false)
    expect(read).toHaveBeenCalledTimes(3)
  })
})

describe('the tab flag', () => {
  it('is scoped to the pubkey that registered', () => {
    markStallActivation('a')
    expect(isStallActivationPending('a')).toBe(true)
    expect(isStallActivationPending('b')).toBe(false)
    clearStallActivation()
    expect(isStallActivationPending('a')).toBe(false)
  })
})
