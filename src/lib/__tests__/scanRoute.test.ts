import { describe, expect, it, vi } from 'vitest'

const status = new Map<string, Promise<string>>()
vi.mock('../merchant', () => ({ merchantStatus: (p: string) => status.get(p) ?? Promise.resolve('customer') }))

const { routeForAddress } = await import('../scanRoute')

const STALL = 'a'.repeat(64)
const FRIEND = 'b'.repeat(64)
const DOWN = 'c'.repeat(64)
const SLOW = 'd'.repeat(64)

describe('routeForAddress (#280)', () => {
  it('a merchant opens its profile', async () => {
    status.set(STALL, Promise.resolve('merchant'))
    expect(await routeForAddress(STALL)).toBe(`/merchants/${STALL}`)
  })

  it('a non-merchant keeps the send flow', async () => {
    expect(await routeForAddress(FRIEND)).toBe(`/send?to=${FRIEND}`)
  })

  it('an unreachable relay keeps the send flow rather than guessing', async () => {
    status.set(DOWN, Promise.resolve('unknown'))
    expect(await routeForAddress(DOWN)).toBe(`/send?to=${DOWN}`)
  })

  it('a lookup that never answers does not hold the scan past its deadline', async () => {
    status.set(SLOW, new Promise(() => {}))
    expect(await routeForAddress(SLOW, 10)).toBe(`/send?to=${SLOW}`)
  })
})
