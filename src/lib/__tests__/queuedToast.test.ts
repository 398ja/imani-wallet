/**
 * The queued-coupon toast.
 *
 * The gateway limits redemption to ten a minute per pubkey, so one part of a
 * multi-coupon payment can pause for a full minute while the others land. The
 * wallet retries and the coupon does arrive, but until it does, a queued
 * coupon and a failed one look identical — which is the one thing a person
 * cannot be left guessing about when it is their money (#40).
 *
 * The case worth pinning hardest is the failure: a toast saying "still
 * receiving" left open above a redemption that has given up is worse than
 * never showing one, because it asserts something untrue about the customer's
 * money and never takes it back.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('sonner', () => ({
  toast: {
    loading: vi.fn(),
    dismiss: vi.fn(),
  },
}))

import { toast } from 'sonner'

import { announceQueued, settleQueued } from '../queuedToast'

const loading = vi.mocked(toast.loading)
const dismiss = vi.mocked(toast.dismiss)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('announceQueued', () => {
  it('says the coupon is safe, not that something went wrong', () => {
    announceQueued('v1', 20_000)

    const [title, options] = loading.mock.calls[0]
    expect(title).toBe('Still receiving')
    // A queued coupon is status, not a warning. The wording has to carry that
    // or the wallet is crying wolf about its own rate limiter.
    expect(options?.description).toMatch(/safe/i)
  })

  it('reports the wait in seconds a person can read', () => {
    announceQueued('v1', 20_000)

    expect(loading.mock.calls[0][1]?.description).toContain('20s')
  })

  it('never shows a wait of zero seconds', () => {
    // Rounding a sub-second backoff to "0s" would read as broken.
    announceQueued('v1', 200)

    expect(loading.mock.calls[0][1]?.description).toContain('1s')
  })

  it('holds the toast open rather than expiring on a timer', () => {
    // A status toast that vanishes leaves exactly the ambiguity it was built
    // to remove: message gone, coupon still absent, user guessing again.
    announceQueued('v1', 5_000)

    expect(loading.mock.calls[0][1]?.duration).toBe(Infinity)
  })

  it('replaces itself on each retry instead of stacking', () => {
    announceQueued('v1', 5_000)
    announceQueued('v1', 20_000)

    // One coupon, one wait, however many attempts it takes.
    const ids = loading.mock.calls.map((c) => c[1]?.id)
    expect(ids[0]).toBe(ids[1])
  })

  it('keeps different coupons apart', () => {
    announceQueued('v1', 5_000)
    announceQueued('v2', 5_000)

    const [a, b] = loading.mock.calls.map((c) => c[1]?.id)
    expect(a).not.toBe(b)
  })

  it('namespaces its id away from the arrival toast', () => {
    // `received-` and `pending-` are already taken; a collision would make one
    // statement about a payment silently replace another.
    announceQueued('v1', 5_000)

    expect(String(loading.mock.calls[0][1]?.id)).toMatch(/^queued-/)
  })

  it('still announces a coupon with no id', () => {
    announceQueued(undefined, 5_000)

    expect(loading).toHaveBeenCalled()
    expect(loading.mock.calls[0][1]?.id).toBe('queued-unidentified')
  })

  it('does not throw when the toast layer fails', () => {
    // Called from inside the redemption path: a toast that failed to render
    // must not turn a recoverable pause into a failed redemption.
    loading.mockImplementationOnce(() => {
      throw new Error('no DOM')
    })

    expect(() => announceQueued('v1', 5_000)).not.toThrow()
  })
})

describe('settleQueued', () => {
  it('dismisses exactly the coupon that settled', () => {
    announceQueued('v1', 5_000)
    settleQueued('v1')

    expect(dismiss).toHaveBeenCalledWith(loading.mock.calls[0][1]?.id)
  })

  it('does not throw when dismissal fails', () => {
    dismiss.mockImplementationOnce(() => {
      throw new Error('no DOM')
    })

    expect(() => settleQueued('v1')).not.toThrow()
  })
})

describe('the redemption path', () => {
  /**
   * Mirrors the try/finally in `dmPoll.ts`. The wiring is what matters here:
   * `finally`, not a call on the success path, because the outcome that most
   * needs the toast cleared is the one that throws.
   */
  async function redeemLike(voucherId: string, redeem: () => Promise<string>) {
    try {
      announceQueued(voucherId, 5_000)
      return await redeem()
    } finally {
      settleQueued(voucherId)
    }
  }

  it('clears the toast when the coupon finally arrives', async () => {
    await redeemLike('v1', async () => 'voucher')

    expect(dismiss).toHaveBeenCalledWith('queued-v1')
  })

  it('clears the toast when the redemption gives up', async () => {
    // The important one. Without `finally` this toast stays on screen forever,
    // telling the customer a coupon is on its way that never will be.
    await expect(
      redeemLike('v1', async () => {
        throw new Error('retries exhausted')
      }),
    ).rejects.toThrow('retries exhausted')

    expect(dismiss).toHaveBeenCalledWith('queued-v1')
  })
})
