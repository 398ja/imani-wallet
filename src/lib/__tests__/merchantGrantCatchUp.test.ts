/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { catchUpMerchantGrant } from '../merchantGrantCatchUp'
import { COUPON_ISSUE, emptyMerchant, saveMerchant } from '../merchant'

const PUBKEY = 'b'.repeat(64)

/** A session whose /auth/session answers come from `answers`, in order. */
function fakeSession(initial: string[], answers: Array<string[] | null | Error>) {
  let permissions = initial
  const resume = vi.fn(async () => {
    const next = answers.shift()
    if (next instanceof Error) throw next
    if (next === null || next === undefined) return null
    permissions = next
    return {} as never
  })
  return {
    resume,
    getSession: () => ({ pubkey: PUBKEY, npub: 'npub', roles: [], permissions, expiresAt: 0 }),
    hasPermission: (p: string) => permissions.includes(p),
  }
}

const noWait = async () => {}

describe('catchUpMerchantGrant', () => {
  beforeEach(() => localStorage.clear())

  it('re-reads /auth/session when an active stall logged in as customer, and keeps the merchant answer', async () => {
    saveMerchant({ ...emptyMerchant(PUBKEY), active: true })
    const s = fakeSession(['coupon:pay'], [['coupon:pay'], ['coupon:pay', COUPON_ISSUE]])

    await catchUpMerchantGrant(s, [1, 1], noWait)

    expect(s.resume).toHaveBeenCalledTimes(2)
    expect(s.hasPermission(COUPON_ISSUE)).toBe(true)
  })

  it('stops after the first read that carries coupon:issue', async () => {
    saveMerchant({ ...emptyMerchant(PUBKEY), active: true })
    const s = fakeSession([], [[COUPON_ISSUE], [COUPON_ISSUE]])

    await catchUpMerchantGrant(s, [1, 1], noWait)

    expect(s.resume).toHaveBeenCalledTimes(1)
  })

  it('reads at most twice, then shows what the server says', async () => {
    saveMerchant({ ...emptyMerchant(PUBKEY), active: true })
    const s = fakeSession([], [[], [], [COUPON_ISSUE]])

    await catchUpMerchantGrant(s, undefined, noWait)

    expect(s.resume).toHaveBeenCalledTimes(2)
    expect(s.hasPermission(COUPON_ISSUE)).toBe(false)
  })

  it('never reads for a customer with no stall record', async () => {
    const s = fakeSession([], [[COUPON_ISSUE]])
    await catchUpMerchantGrant(s, [1, 1], noWait)
    expect(s.resume).not.toHaveBeenCalled()
  })

  it('never reads for a closed stall', async () => {
    saveMerchant({ ...emptyMerchant(PUBKEY), active: false })
    const s = fakeSession([], [[COUPON_ISSUE]])
    await catchUpMerchantGrant(s, [1, 1], noWait)
    expect(s.resume).not.toHaveBeenCalled()
  })

  it('never reads when the login already granted coupon:issue', async () => {
    saveMerchant({ ...emptyMerchant(PUBKEY), active: true })
    const s = fakeSession([COUPON_ISSUE], [[]])
    await catchUpMerchantGrant(s, [1, 1], noWait)
    expect(s.resume).not.toHaveBeenCalled()
  })

  it('gives up quietly on a failed read or a 401, leaving the login answer', async () => {
    saveMerchant({ ...emptyMerchant(PUBKEY), active: true })
    const failing = fakeSession([], [new Error('502'), [COUPON_ISSUE]])
    await expect(catchUpMerchantGrant(failing, [1, 1], noWait)).resolves.toBeUndefined()
    expect(failing.resume).toHaveBeenCalledTimes(1)

    const ended = fakeSession([], [null, [COUPON_ISSUE]])
    await catchUpMerchantGrant(ended, [1, 1], noWait)
    expect(ended.resume).toHaveBeenCalledTimes(1)
  })
})
