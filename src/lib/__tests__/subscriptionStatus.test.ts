/**
 * @vitest-environment jsdom
 *
 * The seller's word on a subscription's renewal (#407): the message, the per-account store, and
 * the DM path that only believes it from the pinned seller's verified seal.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools'

import { parseSubscriptionStatus, subscriptionStatusJson } from '../subscriptionStatus'
import { readSubscriptionStatuses, rememberSubscriptionStatus, subscriptionStatusFor } from '../subscriptionStatusStore'
import { unwrapSealed, wrapMessage } from '../giftWrap'

const ME = 'a'.repeat(64)
const OTHER = 'c'.repeat(64)
const msg = (over: Record<string, unknown> = {}) =>
  subscriptionStatusJson({ subscriptionId: 'sub_1', status: 'cancelled', endsAt: 1_900_000_000, at: 1_800_000_000, ...over } as never)

beforeEach(() => localStorage.clear())

describe('the message', () => {
  it('round-trips, and anything else is not one', () => {
    expect(parseSubscriptionStatus(msg())).toEqual({ subscriptionId: 'sub_1', status: 'cancelled', endsAt: 1_900_000_000, at: 1_800_000_000 })
    for (const bad of [
      'not json',
      '{}',
      JSON.stringify({ type: 'imani-subscription-status/1', subscription_id: 'sub_1', status: 'revoked', at: 1 }),
      JSON.stringify({ type: 'imani-subscription-status/1', subscription_id: 'sub 1!', status: 'active', at: 1 }),
      JSON.stringify({ type: 'imani-subscription-status/1', subscription_id: 'sub_1', status: 'active' }),
      JSON.stringify({ type: 'imani-subscription-status/1', subscription_id: 'sub_1', status: 'active', at: 1, ends_at: 'soon' }),
      JSON.stringify({ type: 'imani-terminal-credential/1', subscription_id: 'sub_1', status: 'active', at: 1 }),
    ]) {
      expect(parseSubscriptionStatus(bad), bad).toBeNull()
    }
  })
})

describe('the store', () => {
  it('keeps the newest per subscription, so a replayed older message never undoes a newer one', () => {
    expect(rememberSubscriptionStatus(ME, msg({ at: 100 }))).toBe(true)
    expect(rememberSubscriptionStatus(ME, msg({ status: 'active', at: 200 }))).toBe(true)
    expect(rememberSubscriptionStatus(ME, msg({ status: 'cancelled', at: 150 }))).toBe(false)
    expect(subscriptionStatusFor(ME, 'sub_1')?.status).toBe('active')
  })

  it('is per account, and drops an entry it cannot read', () => {
    rememberSubscriptionStatus(ME, msg())
    expect(subscriptionStatusFor(OTHER, 'sub_1')).toBeNull()
    localStorage.setItem(`imani.subscription.status.${ME}`, JSON.stringify({ sub_1: '{"type":"x"}', sub_2: msg({ subscriptionId: 'sub_2' }) }))
    expect(Object.keys(readSubscriptionStatuses(ME))).toEqual(['sub_2'])
  })

  it('announces a change, so an open screen updates', () => {
    const heard = vi.fn()
    window.addEventListener('imani:subscription-status', heard)
    rememberSubscriptionStatus(ME, msg())
    window.removeEventListener('imani:subscription-status', heard)
    expect(heard).toHaveBeenCalledTimes(1)
  })
})

describe('the seal is the sender (giftWrap)', () => {
  it('names the real sealer, so a stranger cannot pass as the seller', () => {
    const seller = generateSecretKey()
    const stranger = generateSecretKey()
    const stallSk = generateSecretKey()
    const stall = getPublicKey(stallSk)
    expect(unwrapSealed(wrapMessage(seller, stall, msg()), stallSk)?.sealer).toBe(getPublicKey(seller))
    expect(unwrapSealed(wrapMessage(stranger, stall, msg()), stallSk)?.sealer).toBe(getPublicKey(stranger))
  })
})
