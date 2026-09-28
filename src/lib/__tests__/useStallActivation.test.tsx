/** @vitest-environment jsdom */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const login = vi.fn()
vi.mock('../nap', () => ({ getSession: () => ({ login }) }))
vi.mock('../relay', () => ({ newestAddressable: vi.fn() }))

const { useStallActivation } = await import('../useStallActivation')
const { markStallActivation, isStallActivationPending } = await import('../stallActivation')

const CUSTOMER = ['coupon:receive', 'coupon:pay']
const MERCHANT = [...CUSTOMER, 'coupon:issue']

beforeEach(() => {
  sessionStorage.clear()
  login.mockReset()
  vi.useFakeTimers()
})

afterEach(() => vi.useRealTimers())

describe('useStallActivation (#114)', () => {
  it('is idle for a session that was not just registered as a merchant', () => {
    const { result } = renderHook(() => useStallActivation('pk', true, CUSTOMER))
    expect(result.current).toBe('idle')
  })

  it('shows "activating", re-runs the handshake, and clears once it can sell', async () => {
    markStallActivation('pk')
    login.mockResolvedValue({ permissions: MERCHANT })
    const { result, rerender } = renderHook(({ perms }) => useStallActivation('pk', true, perms), {
      initialProps: { perms: CUSTOMER },
    })
    expect(result.current).toBe('activating')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000)
    })
    expect(login).toHaveBeenCalledTimes(1)

    rerender({ perms: MERCHANT })
    expect(result.current).toBe('idle')
    expect(isStallActivationPending('pk')).toBe(false)
  })

  it('says it gave up rather than spinning forever', async () => {
    markStallActivation('pk')
    login.mockResolvedValue({ permissions: CUSTOMER })
    const { result } = renderHook(() => useStallActivation('pk', true, CUSTOMER))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000)
    })
    expect(result.current).toBe('gave-up')
  })
})
