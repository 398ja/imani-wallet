/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * A refused coupon must say so.
 *
 * The gap this covers was found by review and was invisible by construction:
 * `DmPollService` emitted `redemption:refused` and nothing in the wallet
 * subscribed, so a stall whose till turned a coupon away saw the coupon simply
 * not arrive — no balance change, no history row, no message — while a customer
 * stood in front of them believing they had paid.
 *
 * Two things are asserted and the second is the one that matters: that
 * SOMETHING is shown, and that the two refusals say DIFFERENT things. A single
 * generic "coupon refused" would tick the first box and still send a customer
 * away believing their coupon was spent when it was merely at the wrong stall.
 */

const toasts = vi.hoisted(() => ({
  errors: [] as Array<{ title: string; description?: string }>,
}))

vi.mock('sonner', () => ({
  toast: {
    error: (title: string, opts?: { description?: string }) =>
      toasts.errors.push({ title, description: opts?.description }),
  },
}))

import { announceRefusal } from '../refusalToast'

beforeEach(() => {
  toasts.errors = []
})

describe('telling a stall why a coupon was refused', () => {
  it('explains a coupon that belongs to another stall', () => {
    announceRefusal({ reason: 'another-stall' })

    expect(toasts.errors).toHaveLength(1)
    expect(toasts.errors[0].title).toMatch(/another stall/i)
    // The reassurance is the load-bearing half: nothing was taken, because the
    // refusal happens before the mint swap. A customer must not leave thinking
    // their coupon was consumed by the wrong till.
    expect(toasts.errors[0].description).toMatch(/nothing was taken/i)
  })

  it('explains a coupon that is already spent', () => {
    announceRefusal({ reason: 'over-redeemed' })

    expect(toasts.errors).toHaveLength(1)
    expect(toasts.errors[0].title).toMatch(/already spent/i)
  })

  it('says something DIFFERENT for each reason', () => {
    // The point of the typed reason. If both refusals produced one message,
    // every test above would still pass and the feature would be useless: a
    // stall would tell a customer at the wrong counter that their coupon was
    // spent, which is false and unrecoverable for them.
    announceRefusal({ reason: 'another-stall' })
    announceRefusal({ reason: 'over-redeemed' })

    expect(toasts.errors[0].title).not.toBe(toasts.errors[1].title)
  })
})

describe('what it refuses to announce', () => {
  it('stays silent on a reason this build does not know', () => {
    // A future refusal announced with wording chosen for a different situation
    // is worse than silence. Same judgement `checkCoupon` makes when it will
    // not turn an unknown into an accusation.
    announceRefusal({ reason: 'some-future-reason' as never })

    expect(toasts.errors).toEqual([])
  })

  it('stays silent on an event with no reason at all', () => {
    announceRefusal({})
    announceRefusal(undefined)

    expect(toasts.errors).toEqual([])
  })

  it('never throws, so a failed toast cannot break the redemption path', () => {
    // It runs in an event handler on the money path. An unhandled rejection
    // here would surface as a broken redemption for a refusal that was
    // correctly decided.
    const boom = {
      get reason(): never {
        throw new Error('render failed')
      },
    }

    expect(() => announceRefusal(boom as never)).not.toThrow()
  })
})

describe('telling a CUSTOMER why a coupon was refused (#160 5b-5)', () => {
  // The stall's wording asks it to question the customer. A customer refused a coupon a stall
  // just sold them needs the other side of that: nothing was taken, and what to ask the stall.
  it('speaks to the customer about an unwarranted coupon, not to a stall', () => {
    announceRefusal({ reason: 'unwarranted' }, 'customer')

    expect(toasts.errors).toHaveLength(1)
    expect(toasts.errors[0].title).toBe('Coupon not accepted')
    expect(toasts.errors[0].description).toMatch(/did not sign for this coupon/)
    expect(toasts.errors[0].description).toMatch(/Nothing was taken from you/)
    expect(toasts.errors[0].description).not.toMatch(/Ask the customer/)
  })

  // The stall keeps its own wording, which tells it to question where the coupon came from.
  it('keeps the stall’s wording for a stall', () => {
    announceRefusal({ reason: 'unwarranted' })
    expect(toasts.errors[0].title).toBe('Coupon not authorised')
    expect(toasts.errors[0].description).toMatch(/Ask the customer/)
  })

  // Reasons that already speak to whoever holds the coupon read the same for both.
  it('uses the shared wording where no customer variant exists', () => {
    announceRefusal({ reason: 'over-redeemed' }, 'customer')
    expect(toasts.errors[0].title).toMatch(/already spent/i)
  })
})
