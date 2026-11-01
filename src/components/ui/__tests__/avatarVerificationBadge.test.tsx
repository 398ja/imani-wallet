/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'

/**
 * The avatar wears the verification badge a stall has earned (#418), and only while it is valid.
 * The orange merchant badge is gone: having a stall no longer earns a mark on its own.
 */

const windows = new Map<string, Array<{ badge: string; validFrom: number; validTo: number }>>()
vi.mock('../../../lib/verificationReader', () => ({
  VERIFICATION_CHANGED_EVENT: 'imani:verification-changed',
  badgeWindows: async (pubkey: string) => windows.get(pubkey) ?? [],
}))
// Were the merchant hook still consulted, every key would wear a badge.
vi.mock('../../../lib/merchant', () => ({ isMerchantPubkey: async () => true }))

import { Avatar } from '../Avatar'

const NOW = 1_800_000_000
const STALL = 'a'.repeat(64)
const CUSTOMER = 'c'.repeat(64)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  vi.setSystemTime(NOW * 1000)
  windows.clear()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

async function draw(pubkey: string) {
  const out = render(<Avatar name="Rosa Green Farm" pubkey={pubkey} />)
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  return out
}

const badgeOf = (c: HTMLElement) => c.querySelector('[data-badge]')?.getAttribute('data-badge') ?? null

describe('the verification badge on the avatar', () => {
  it('a key with no subscription wears none, merchant or not', async () => {
    const { container } = await draw(CUSTOMER)
    expect(badgeOf(container)).toBeNull()
    expect(container.textContent).not.toMatch(/Merchant/)
  })

  it.each([
    ['bronze', 'Essentials'],
    ['silver', 'Pro'],
    ['gold', 'the top tier'],
  ])('wears a %s check for %s, with an accessible name', async (badge) => {
    windows.set(STALL, [{ badge, validFrom: NOW - 10, validTo: NOW + 100 }])
    const { container } = await draw(STALL)
    expect(badgeOf(container)).toBe(badge)
    expect(container.textContent).toContain(`Verified business (${badge})`)
  })

  it('takes the badge off when the window ends, on a screen left open', async () => {
    windows.set(STALL, [{ badge: 'bronze', validFrom: NOW - 10, validTo: NOW + 5 }])
    const { container } = await draw(STALL)
    expect(badgeOf(container)).toBe('bronze')
    await act(async () => {
      vi.advanceTimersByTime(6_000)
    })
    expect(badgeOf(container)).toBeNull()
  })

  it('shows nothing before the window opens', async () => {
    windows.set(STALL, [{ badge: 'silver', validFrom: NOW + 60, validTo: NOW + 600 }])
    const { container } = await draw(STALL)
    expect(badgeOf(container)).toBeNull()
  })

  it('a reused avatar never wears the previous person’s badge', async () => {
    windows.set(STALL, [{ badge: 'gold', validFrom: NOW - 10, validTo: NOW + 100 }])
    const { container, rerender } = await draw(STALL)
    expect(badgeOf(container)).toBe('gold')
    rerender(<Avatar name="Someone" pubkey={CUSTOMER} />)
    expect(badgeOf(container)).toBeNull()
  })
})
