import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchStallStatus, forgetStallStatus, statusTransport, closedMessage, mayTradeWith } from '../merchantStatus'
import { merchantActions, STALL_CLOSED, STALL_UNKNOWN, STALL_CHECKING, NO_CARDS } from '../merchantActions'
import { canRunStall, canTrade, hasStall, isMerchant, COUPON_ISSUE, type MerchantProfile } from '../merchant'

const STALL = 'a'.repeat(64)

function reply(status: number, body?: unknown) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status })
}

describe('stall status from the portal (#434)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>
  beforeEach(() => {
    forgetStallStatus()
    fetchSpy = vi.fn()
    vi.spyOn(statusTransport, 'fetch').mockImplementation(fetchSpy)
  })
  afterEach(() => vi.restoreAllMocks())

  it('reads open, and cards only when the portal says sellsByCard', async () => {
    fetchSpy.mockResolvedValue(reply(200, { merchant: true, open: true, sellsByCard: true, eventId: 'e1' }))
    expect(await fetchStallStatus(STALL)).toEqual({ status: 'open', sellsByCard: true, eventId: 'e1' })
    expect(fetchSpy.mock.calls[0][0]).toBe(`/api/v1/portal/merchants/public/${STALL}/status`)
  })

  it('reads closed, never selling by card', async () => {
    fetchSpy.mockResolvedValue(reply(200, { merchant: true, open: false, sellsByCard: true, eventId: 'e2' }))
    expect(await fetchStallStatus(STALL)).toMatchObject({ status: 'closed', sellsByCard: false })
  })

  it('reads 404 as not a merchant', async () => {
    fetchSpy.mockResolvedValue(reply(404))
    expect((await fetchStallStatus(STALL)).status).toBe('customer')
  })

  it.each([
    ['a 503', () => Promise.resolve(reply(503))],
    ['a 500', () => Promise.resolve(reply(500))],
    ['a network error', () => Promise.reject(new TypeError('offline'))],
    ['a body that is not a status', () => Promise.resolve(reply(200, { merchant: true }))],
  ])('fails closed on %s', async (_, impl) => {
    fetchSpy.mockImplementation(impl)
    expect(await fetchStallStatus(STALL)).toEqual({ status: 'unknown', sellsByCard: false })
  })

  it('polls with If-None-Match and reuses the answer on 304', async () => {
    fetchSpy.mockResolvedValueOnce(reply(200, { merchant: true, open: false, eventId: 'abc' }))
    await fetchStallStatus(STALL)
    fetchSpy.mockResolvedValueOnce(reply(304))
    expect((await fetchStallStatus(STALL)).status).toBe('closed')
    expect((fetchSpy.mock.calls[1][1] as RequestInit).headers).toMatchObject({ 'If-None-Match': '"abc"' })
  })

  it('never asks about something that is not a key', async () => {
    expect((await fetchStallStatus('npub1nope')).status).toBe('unknown')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('only open trades', () => {
    expect(mayTradeWith('open')).toBe(true)
    for (const s of ['closed', 'unknown', 'customer'] as const) expect(mayTradeWith(s)).toBe(false)
    expect(closedMessage('closed', 'Ada')).toMatch(/Ada is closed right now/)
    expect(closedMessage('open')).toBeNull()
  })
})

describe('role is not state (#434)', () => {
  const stall = (active: boolean) => ({ pubkey: STALL, active, categories: [], issuanceCurrency: 'EUR' }) as unknown as MerchantProfile

  it('a closed stall is still a stall, may still run its screens, but may not trade', () => {
    expect(hasStall(stall(false))).toBe(true)
    expect(canRunStall([COUPON_ISSUE], stall(false))).toBe(true)
    expect(canTrade([COUPON_ISSUE], stall(false))).toBe(false)
    expect(isMerchant(stall(false))).toBe(false)
  })

  it('an open stall trades; a customer is neither', () => {
    expect(canTrade([COUPON_ISSUE], stall(true))).toBe(true)
    expect(hasStall(null)).toBe(false)
    expect(canRunStall([COUPON_ISSUE], null)).toBe(false)
    expect(canRunStall([], stall(true))).toBe(false)
  })
})

describe('Buy and Pay at a stall gate on its status (#434)', () => {
  const base = { acceptsCards: true, cardSales: 'ready' as const, validVouchers: 2, loggedIn: true }

  it('open: both enabled', () => {
    const { buy, pay } = merchantActions({ ...base, stallOpen: 'open' })
    expect(buy.enabled && pay.enabled).toBe(true)
  })

  it.each([
    ['closed', STALL_CLOSED],
    ['unknown', STALL_UNKNOWN],
    ['customer', STALL_UNKNOWN],
    ['loading', STALL_CHECKING],
  ] as const)('%s: neither, with the reason', (stallOpen, reason) => {
    const { buy, pay } = merchantActions({ ...base, stallOpen })
    expect(buy).toEqual({ enabled: false, reason })
    expect(pay).toEqual({ enabled: false, reason })
  })

  it('a stall without cards says so while its status is still loading', () => {
    expect(merchantActions({ ...base, acceptsCards: false, stallOpen: 'loading' }).buy.reason).toBe(NO_CARDS)
  })

  it('no status given keeps the old behaviour', () => {
    expect(merchantActions(base).pay.enabled).toBe(true)
  })
})
