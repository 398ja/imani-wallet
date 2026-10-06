/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { fulfilmentOf, idleLockMs, paidForStall, startIdleLock, terminalMintApi } from '../terminalTill'

/** The terminal's own clients and its idle lock (#160 phase 3). */

const STALL = 'a'.repeat(64)

afterEach(() => {
  vi.useRealTimers()
})

describe('the fulfilment check (spec 2.5)', () => {
  // The terminal asks gateway-core whether its request was paid, signed by the terminal key, at
  // the path the core controller serves.
  it('asks gateway-core about the request id, with a NIP-98 GET', async () => {
    const calls: Array<[string, string]> = []
    const check = fulfilmentOf(undefined, (async (path: string, method: string) => {
      calls.push([path, method])
      return new Response(JSON.stringify({ fulfilled: true, sendId: 's1', issuerId: STALL }))
    }) as never)

    const answer = await check('0123456789abcdef0123')

    expect(calls).toEqual([['/api/v1/atomic/fulfilment/0123456789abcdef0123', 'GET']])
    expect(answer).toEqual({ fulfilled: true, sendId: 's1', issuerId: STALL })
    expect(paidForStall(answer, STALL)).toBe(true)
  })

  // Never paid on an error path: a failed call is "still waiting".
  it('reads a failure as still waiting', async () => {
    const check = fulfilmentOf(undefined, (async () => new Response('', { status: 503 })) as never)
    expect(await check('0123456789abcdef0123')).toBeNull()
    expect(paidForStall(null, STALL)).toBe(false)
  })

  // A voucher from another stall did not pay this stall.
  it('does not count a payment in another stall’s voucher', () => {
    expect(paidForStall({ fulfilled: true, issuerId: 'b'.repeat(64) }, STALL)).toBe(false)
    expect(paidForStall({ fulfilled: false }, STALL)).toBe(false)
  })
})

describe('the mint client', () => {
  // The unlock check is the public NUT-07 endpoint and carries no signature.
  it('checks state at the public validate endpoint, unsigned', async () => {
    const seen: RequestInit[] = []
    const api = terminalMintApi(async (url, init) => {
      expect(url).toBe('/api/v1/wallet/token/validate')
      seen.push(init!)
      return new Response(JSON.stringify({ state: 'SPENT' }))
    })
    expect(await api.validateToken('cashuBx')).toEqual({ state: 'SPENT' })
    expect(JSON.stringify(seen[0].headers)).not.toMatch(/Authorization/)
  })
})

describe('the idle lock (decision 2)', () => {
  // 0 is off, missing is the 10-minute default, and an unreadable value is the default too, so a
  // bad setting cannot leave a till open all day.
  it('reads the owner’s setting', () => {
    expect(idleLockMs(0)).toBeNull()
    expect(idleLockMs(undefined)).toBe(10 * 60_000)
    expect(idleLockMs(3)).toBe(3 * 60_000)
    expect(idleLockMs(-1)).toBe(10 * 60_000)
    expect(idleLockMs(2.5)).toBe(10 * 60_000)
  })

  // Fires at N minutes with no touch, and a touch restarts the clock.
  it('locks at N minutes without a touch, and a touch restarts the clock', () => {
    vi.useFakeTimers()
    const onLock = vi.fn()
    const stop = startIdleLock(idleLockMs(10), onLock)

    vi.advanceTimersByTime(9 * 60_000)
    window.dispatchEvent(new Event('pointerdown'))
    vi.advanceTimersByTime(9 * 60_000)
    expect(onLock).not.toHaveBeenCalled()

    vi.advanceTimersByTime(60_000)
    expect(onLock).toHaveBeenCalledTimes(1)
    stop()
  })

  // Never means never: with the lock switched off nothing fires, however long the till sits.
  it('never fires when switched off', () => {
    vi.useFakeTimers()
    const onLock = vi.fn()
    const stop = startIdleLock(idleLockMs(0), onLock)
    vi.advanceTimersByTime(48 * 3600_000)
    expect(onLock).not.toHaveBeenCalled()
    stop()
  })
})
