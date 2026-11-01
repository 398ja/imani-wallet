/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * imani-wallet#158: a cashback this stall issued was claimed. The portal says so
 * twice, by Web Push and by a drainable notice (imani-gateway-portal#59), and the
 * merchant must see ONE bell row, with the row on the Vouchers list stamped
 * Claimed so no status fetch is needed.
 *
 * The inbox is real so the assertions are about what the bell would show.
 */

const MERCHANT = '35f7a28b6adc9a923686a4506a02cae0fcf634cb32f42675872a5bd07d67af47'
const CASHBACK_ID = '11111111-2222-3333-4444-555555555555'
const CLAIMED_AT_ISO = '2026-05-02T13:42:01Z'
const CLAIMED_AT_MS = Date.parse(CLAIMED_AT_ISO)

const signedFetch = vi.fn<(path: string, method: string, body?: unknown) => Promise<Response>>(
  async () => new Response(null, { status: 200 }),
)
vi.mock('../nip98', () => ({
  signedFetch: (...args: Parameters<typeof signedFetch>) => signedFetch(...args),
}))

/** The wallet store, as far as this flow touches it: one cashback row. */
let rows: Record<string, Record<string, unknown>> = {}
const recordCashbackStatus = vi.fn(async (id: string, reading: { status: string; claimedAt?: number }) => {
  if (rows[id]) rows[id] = { ...rows[id], cashbackStatus: reading.status, claimedAt: reading.claimedAt }
})
let storeThrows = false
vi.mock('../wallet', () => ({
  walletIsOpen: () => true,
  getTransactionRow: async (id: string) => {
    if (storeThrows) throw new Error('indexeddb gone')
    return rows[id] ?? null
  },
  recordCashbackStatus: (id: string, reading: { status: string; claimedAt?: number }) =>
    recordCashbackStatus(id, reading),
}))

const toasts: Array<{ message: unknown; options?: Record<string, unknown> }> = []
vi.mock('sonner', () => ({
  toast: {
    success: (message: unknown, options?: Record<string, unknown>) => {
      toasts.push({ message, options })
      return 'id'
    },
  },
}))
let wanted = true
vi.mock('../notifications/wants', () => ({ wantsInApp: () => wanted }))

const {
  fileCashbackClaim,
  fileCashbackClaimPush,
  runCashbackClaimDrainTick,
  startCashbackClaims,
  stopCashbackClaims,
} = await import('../cashbackClaimDrain')
const { listNotifications, _resetInboxCacheForTests } = await import('../notifications/inbox')

const NOTICE = { cashbackId: CASHBACK_ID, amountMinor: 500, unit: 'EUR', decimals: 2, claimedAt: CLAIMED_AT_ISO }

/** The push exactly as the portal builds it (CashbackClaimNotifier.pushData). */
const PUSH = {
  title: 'Cashback claimed',
  body: '5.00 EUR cashback claimed',
  type: 'cashback_claimed',
  data: {
    type: 'cashback_claimed',
    notificationId: `cashback-claimed:${CASHBACK_ID}`,
    cashbackId: CASHBACK_ID,
    amountMinor: 500,
    unit: 'EUR',
    decimals: 2,
    claimedAt: CLAIMED_AT_MS,
    url: '/merchant/transactions',
  },
}

function serve(notices: unknown[], ackStatus = 200) {
  signedFetch.mockImplementation(async (path: string) =>
    path.endsWith('/drain')
      ? new Response(JSON.stringify({ notices, moreAvailable: false }), { status: 200 })
      : new Response(JSON.stringify({ acknowledged: notices.length }), { status: ackStatus }),
  )
}

beforeEach(async () => {
  localStorage.clear()
  _resetInboxCacheForTests()
  rows = {
    [`cashback:${CASHBACK_ID}`]: {
      id: `cashback:${CASHBACK_ID}`,
      type: 'cashback',
      cashbackId: CASHBACK_ID,
      claimCode: 'CB-ABCDE-FGHIJ',
      amount: 500,
      unit: 'EUR',
      decimals: 2,
    },
  }
  storeThrows = false
  wanted = true
  toasts.length = 0
  signedFetch.mockReset()
  recordCashbackStatus.mockClear()
  // A clean boot drain, so the loop starts at the normal cadence with no backoff.
  serve([])
  startCashbackClaims(MERCHANT)
  // Let the boot tick finish, so it does not hold the in-flight guard.
  await new Promise((resolve) => setTimeout(resolve, 0))
  signedFetch.mockClear()
})

afterEach(() => {
  stopCashbackClaims()
})

describe('the bell row', () => {
  it('names the amount in the wallet money format and the code', async () => {
    serve([NOTICE])

    await runCashbackClaimDrainTick()

    const items = listNotifications(MERCHANT)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: `cashback-claimed:${CASHBACK_ID}`,
      type: 'cashback_claimed',
      title: 'Cashback claimed',
      body: '€5.00 cashback claimed (CB-ABCDE-FGHIJ)',
      url: '/merchant/transactions',
      receivedAt: CLAIMED_AT_MS,
    })
  })

  it('still names the amount when this device has no row for the cashback', async () => {
    rows = {}
    serve([NOTICE])

    await runCashbackClaimDrainTick()

    expect(listNotifications(MERCHANT)[0]?.body).toBe('€5.00 cashback claimed')
  })

  // Zero-decimal units must not read as hundredths: 5000 XAF is not "50.00".
  it.each([
    [{ amountMinor: 5000, unit: 'XAF', decimals: 0 }, /^FCFA\s?5[,.\u202f\u00a0]?000 cashback claimed$/],
    [{ amountMinor: 5000, unit: 'XAF' }, /^FCFA\s?5[,.\u202f\u00a0]?000 cashback claimed$/],
    [{ amountMinor: 2100, unit: 'SAT', decimals: 0 }, /^SAT\s?2[,.\u202f\u00a0]?100 cashback claimed$/],
    [{ amountMinor: 2100, unit: 'sat' }, /^SAT\s?2[,.\u202f\u00a0]?100 cashback claimed$/],
    [{ amountMinor: 5, unit: 'EUR', decimals: 2 }, /^€0\.05 cashback claimed$/],
  ])('formats %o', async (amount, expected) => {
    rows = {}
    serve([{ ...NOTICE, decimals: undefined, ...amount }])

    await runCashbackClaimDrainTick()

    expect(listNotifications(MERCHANT)[0]?.body).toMatch(expected)
  })
})

describe('push and drain together', () => {
  it('push first, then drain: one row and one toast', async () => {
    fileCashbackClaimPush(MERCHANT, PUSH)
    await vi.waitFor(() => expect(listNotifications(MERCHANT)).toHaveLength(1))
    serve([NOTICE])

    await runCashbackClaimDrainTick()

    expect(listNotifications(MERCHANT)).toHaveLength(1)
    expect(listNotifications(MERCHANT)[0]?.body).toBe('€5.00 cashback claimed (CB-ABCDE-FGHIJ)')
    expect(toasts).toHaveLength(1)
  })

  it('drain first, then push: one row', async () => {
    serve([NOTICE])
    await runCashbackClaimDrainTick()

    await fileCashbackClaimPush(MERCHANT, PUSH)

    expect(listNotifications(MERCHANT)).toHaveLength(1)
    expect(toasts).toHaveLength(1)
  })

  it('a redelivered notice is still one row', async () => {
    serve([NOTICE])
    await runCashbackClaimDrainTick()
    await runCashbackClaimDrainTick()

    expect(listNotifications(MERCHANT)).toHaveLength(1)
  })
})

describe('stamping the cashback row', () => {
  it('drain stamps Claimed and claimedAt on the row', async () => {
    serve([NOTICE])

    await runCashbackClaimDrainTick()

    expect(recordCashbackStatus).toHaveBeenCalledWith(`cashback:${CASHBACK_ID}`, {
      status: 'Claimed',
      claimedAt: CLAIMED_AT_MS,
    })
    expect(rows[`cashback:${CASHBACK_ID}`]).toMatchObject({ cashbackStatus: 'Claimed', claimedAt: CLAIMED_AT_MS })
  })

  it('push stamps it too, so a closed-then-opened app is right without the drain', async () => {
    await fileCashbackClaimPush(MERCHANT, PUSH)

    expect(rows[`cashback:${CASHBACK_ID}`]).toMatchObject({ cashbackStatus: 'Claimed', claimedAt: CLAIMED_AT_MS })
  })

  it('stamps even when the merchant turned the bell entry off', async () => {
    wanted = false
    serve([NOTICE])

    await runCashbackClaimDrainTick()

    expect(listNotifications(MERCHANT)).toHaveLength(0)
    expect(rows[`cashback:${CASHBACK_ID}`]).toMatchObject({ cashbackStatus: 'Claimed' })
  })

  it('does not overwrite a row already stamped Claimed', async () => {
    rows[`cashback:${CASHBACK_ID}`]!.cashbackStatus = 'Claimed'
    rows[`cashback:${CASHBACK_ID}`]!.claimedAt = 1
    serve([NOTICE])

    await runCashbackClaimDrainTick()

    expect(recordCashbackStatus).not.toHaveBeenCalled()
  })
})

describe('the drain loop', () => {
  it('acks every drained notice by cashback id', async () => {
    serve([NOTICE, { ...NOTICE, cashbackId: 'bad' }])

    await runCashbackClaimDrainTick()

    const ack = signedFetch.mock.calls.find(([path]) => path.endsWith('/ack'))
    expect(ack?.[0]).toBe('/api/v1/portal/cashback/claim-notices/ack')
    expect(ack?.[2]).toEqual({ cashbackIds: [CASHBACK_ID, 'bad'] })
  })

  it('asks the portal drain with a limit', async () => {
    serve([])

    await runCashbackClaimDrainTick()

    expect(signedFetch.mock.calls[0]).toEqual(['/api/v1/portal/cashback/claim-notices/drain', 'POST', { limit: 50 }])
  })
})

describe('never throws', () => {
  it('a network failure is swallowed', async () => {
    signedFetch.mockRejectedValue(new Error('offline'))

    await expect(runCashbackClaimDrainTick()).resolves.toBeUndefined()
  })

  it('a refused drain is swallowed and acks nothing', async () => {
    signedFetch.mockResolvedValue(new Response(null, { status: 500 }))

    await expect(runCashbackClaimDrainTick()).resolves.toBeUndefined()
    expect(signedFetch).toHaveBeenCalledTimes(1)
  })

  it('an unreadable body is swallowed', async () => {
    signedFetch.mockResolvedValue(new Response('not json', { status: 200 }))

    await expect(runCashbackClaimDrainTick()).resolves.toBeUndefined()
  })

  it('a broken store still files the bell row', async () => {
    storeThrows = true
    serve([NOTICE])

    await runCashbackClaimDrainTick()

    expect(listNotifications(MERCHANT)[0]?.body).toBe('€5.00 cashback claimed')
  })

  it('a malformed push files nothing and does not throw', async () => {
    await expect(fileCashbackClaimPush(MERCHANT, { type: 'cashback_claimed', data: { amountMinor: 'x' } })).resolves.toBe(false)
    await expect(fileCashbackClaim(MERCHANT, { cashbackId: '' } as never)).resolves.toBe(false)
    expect(listNotifications(MERCHANT)).toHaveLength(0)
  })

  it('a customer wallet (403) stops polling for the session', async () => {
    signedFetch.mockResolvedValue(new Response(null, { status: 403 }))
    await runCashbackClaimDrainTick()
    signedFetch.mockClear()

    await runCashbackClaimDrainTick()

    expect(signedFetch).not.toHaveBeenCalled()
  })

  it.each([404, 405, 410])('a portal without the route (%i) stops polling for the session', async (status) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    signedFetch.mockResolvedValue(new Response(null, { status }))
    await runCashbackClaimDrainTick()
    signedFetch.mockClear()

    await runCashbackClaimDrainTick()

    expect(signedFetch).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('a 401 during a lock cycle keeps polling at the normal cadence', async () => {
    signedFetch.mockResolvedValue(new Response(null, { status: 401 }))
    await runCashbackClaimDrainTick()
    signedFetch.mockClear()

    await runCashbackClaimDrainTick()

    expect(signedFetch).toHaveBeenCalledTimes(1)
  })

  it('does nothing when stopped', async () => {
    stopCashbackClaims()
    serve([NOTICE])

    await runCashbackClaimDrainTick()

    expect(signedFetch).not.toHaveBeenCalled()
  })
})

/**
 * An old portal answered the missing route with 500 (imani-gateway-portal#59 e2e),
 * and a broken one may do so for hours. The loop must back off instead of asking
 * every 10s, warn only when the backoff level changes, and snap back on success.
 */
describe('backoff on transient failure', () => {
  const drainCalls = () => signedFetch.mock.calls.filter(([path]) => path.endsWith('/drain')).length

  beforeEach(() => {
    stopCashbackClaims()
    vi.useFakeTimers({ now: 0, toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] })
    // Jitter factor of exactly 1, so the schedule is deterministic.
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    signedFetch.mockReset()
  })

  afterEach(() => {
    stopCashbackClaims()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it.each([429, 500, 503])('%i x N backs off exponentially, capped at 5 minutes', async (status) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    signedFetch.mockResolvedValue(new Response(null, { status }))

    startCashbackClaims(MERCHANT)
    await vi.advanceTimersByTimeAsync(0)
    expect(drainCalls()).toBe(1)

    // Delays 10, 20, 40, 80, 160, 300, 300 s: attempts at 0, 10, 30, 70, 150, 310, 610.
    await vi.advanceTimersByTimeAsync(610_000)
    expect(drainCalls()).toBe(7)

    // At the cap, another 15 minutes is 3 more attempts, not 90.
    await vi.advanceTimersByTimeAsync(900_000)
    expect(drainCalls()).toBe(10)

    // One warning per backoff level (10, 20, 40, 80, 160, 300 s), then silence at the cap.
    expect(warn).toHaveBeenCalledTimes(6)
  })

  it('a network error backs off too', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    signedFetch.mockRejectedValue(new TypeError('Failed to fetch'))

    startCashbackClaims(MERCHANT)
    await vi.advanceTimersByTimeAsync(610_000)

    expect(drainCalls()).toBe(7)
  })

  it('a success resets the backoff to the 10s cadence', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    signedFetch.mockResolvedValue(new Response(null, { status: 500 }))
    startCashbackClaims(MERCHANT)
    await vi.advanceTimersByTimeAsync(150_000) // attempts at 0, 10, 30, 70, 150
    expect(drainCalls()).toBe(5)

    signedFetch.mockReset()
    serve([])
    await vi.advanceTimersByTimeAsync(160_000) // next attempt at 310 succeeds
    expect(drainCalls()).toBe(1)

    await vi.advanceTimersByTimeAsync(30_000)
    expect(drainCalls()).toBe(4)
  })

  it('a later failure after a success warns again from the first level', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    signedFetch.mockResolvedValue(new Response(null, { status: 500 }))
    startCashbackClaims(MERCHANT)
    await vi.advanceTimersByTimeAsync(30_000) // 3 failures, 3 levels
    expect(warn).toHaveBeenCalledTimes(3)

    serve([])
    await vi.advanceTimersByTimeAsync(40_000) // success at 70
    signedFetch.mockResolvedValue(new Response(null, { status: 500 }))
    await vi.advanceTimersByTimeAsync(10_000) // fails at 80

    expect(warn).toHaveBeenCalledTimes(4)
    expect(warn.mock.calls[3][2]).toEqual({ reason: 500, retryInSeconds: 10 })
  })

  it('a visibility change does not bypass the backoff', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    signedFetch.mockResolvedValue(new Response(null, { status: 500 }))
    startCashbackClaims(MERCHANT)
    await vi.advanceTimersByTimeAsync(10_000) // 2 failures, next at 30
    expect(drainCalls()).toBe(2)

    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)

    expect(drainCalls()).toBe(2)
  })
})
