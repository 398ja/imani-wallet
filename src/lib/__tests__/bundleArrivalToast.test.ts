/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The recipient's side of #94: a €6 payment sent as €3 + €3 is ONE toast and
 * ONE bell row, ending at "€6.00 received (2 vouchers)" — not two "€3.00
 * received" toasts that leave the reader guessing whether that was all.
 *
 * The inbox is real (jsdom localStorage) so the assertions are about the rows a
 * person would actually see in the bell. Sonner is captured at the boundary.
 */

type Call = { kind: 'success' | 'plain' | 'loading' | 'dismiss'; message?: unknown; options?: Record<string, unknown> }
const calls: Call[] = []
vi.mock('sonner', () => {
  const toast = (message: unknown, options?: Record<string, unknown>) => {
    calls.push({ kind: 'plain', message, options })
    return 'id'
  }
  toast.success = (message: unknown, options?: Record<string, unknown>) => {
    calls.push({ kind: 'success', message, options })
    return 'id'
  }
  toast.loading = (message: unknown, options?: Record<string, unknown>) => {
    calls.push({ kind: 'loading', message, options })
    return 'id'
  }
  toast.dismiss = (id?: unknown) => {
    calls.push({ kind: 'dismiss', options: { id } })
  }
  return { toast }
})

vi.mock('../../components/ui/IncomingPaymentToast', () => ({
  IncomingPaymentToast: () => null,
  ReceivedPaymentToast: () => null,
}))

vi.mock('../notifications/wants', () => ({ wantsInApp: () => true }))

const { announceBundleArrival, resetAnnounced, resumeBundleArrivals, stopBundleArrivals } = await import(
  '../arrivalToast'
)
const { announceQueued, settleQueued } = await import('../queuedToast')
const { listNotifications, _resetInboxCacheForTests } = await import('../notifications/inbox')
const { _resetBundleArrivalsForTests, BUNDLE_WAIT_WINDOW_MS } = await import('../bundleArrival')

const ME = 'a'.repeat(64)
const ALICE = 'b'.repeat(64)
const BUNDLE = 'fedcba9876543210fedcba9876543210'

const coupon = (id: string, face = 300) => ({
  voucher_id: id,
  face_value: face,
  face_unit: 'EUR',
  face_decimals: 2,
  sender_pubkey: ALICE,
})
const declared = (index: number) => ({ bundleId: BUNDLE, total: 600, index, count: 2 })

const toasts = () => calls.filter((c) => c.kind === 'success' || c.kind === 'plain')
const props = (c: Call) => (c.message as { props: Record<string, string> }).props

beforeEach(() => {
  calls.length = 0
  localStorage.clear()
  _resetInboxCacheForTests()
  _resetBundleArrivalsForTests(ME)
  resetAnnounced()
})

afterEach(() => {
  stopBundleArrivals()
  vi.useRealTimers()
})

describe('a two-part payment on the recipient', () => {
  it('ends as one toast id and one bell row reading €6.00 received (2 vouchers)', async () => {
    await announceBundleArrival(coupon('v1'), declared(0), ME, 'wrap-0')
    await announceBundleArrival(coupon('v2'), declared(1), ME, 'wrap-1')

    const ids = new Set(toasts().map((c) => c.options?.id))
    expect(ids).toEqual(new Set(['received-bundle-' + BUNDLE]))

    const last = toasts().at(-1)!
    expect(props(last).amount).toMatch(/6\.00/)
    expect(props(last).progress).toBe('2 vouchers')

    const rows = listNotifications(ME)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 'arrival:bundle:' + BUNDLE, title: 'Payment received', readAt: null })
    expect(rows[0]!.body).toMatch(/6\.00 received \(2 vouchers\)/)
  })

  it('shows X of Y while a part is outstanding', async () => {
    await announceBundleArrival(coupon('v1'), declared(0), ME, 'wrap-0')

    expect(props(toasts()[0]!).amount).toMatch(/3\.00.*of.*6\.00/)
    expect(props(toasts()[0]!).progress).toBe('1 of 2 vouchers so far')
    expect(listNotifications(ME)[0]!.body).toMatch(/1 of 2 vouchers/)
  })

  it('says a re-read wrap nothing at all', async () => {
    await announceBundleArrival(coupon('v1'), declared(0), ME, 'wrap-0')
    calls.length = 0
    await announceBundleArrival(coupon('v1'), declared(0), ME, 'wrap-0')
    expect(toasts()).toHaveLength(0)
  })

  it('states the shortfall against the declaration once the window closes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    await announceBundleArrival(coupon('v1'), declared(0), ME, 'wrap-0')
    calls.length = 0

    await vi.advanceTimersByTimeAsync(BUNDLE_WAIT_WINDOW_MS + 1_000)

    const closing = toasts().at(-1)!
    // Neutral, not a success tick and not an error: what came is safe.
    expect(closing.kind).toBe('plain')
    const row = listNotifications(ME)[0]!
    expect(row.title).toBe('Payment partly received')
    expect(row.body).toMatch(/3\.00 of an expected €6\.00 received\. 1 voucher has not arrived\./)
    expect(row.readAt).toBeNull()
  })

  it('closes a bundle left open by a previous session', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    await announceBundleArrival(coupon('v1'), declared(0), ME, 'wrap-0')
    stopBundleArrivals() // the tab closed

    vi.setSystemTime(Date.now() + BUNDLE_WAIT_WINDOW_MS + 5_000)
    resumeBundleArrivals(ME)
    await vi.runAllTimersAsync()

    expect(listNotifications(ME)[0]!.title).toBe('Payment partly received')
  })
})

describe('a rate-limited part', () => {
  it('rides the bundle toast as "still receiving" rather than a toast of its own', async () => {
    await announceBundleArrival(coupon('v1'), declared(0), ME, 'wrap-0')
    calls.length = 0

    announceQueued('v2', 20_000, BUNDLE)

    expect(calls.some((c) => c.kind === 'loading')).toBe(false)
    const redraw = toasts().at(-1)!
    expect(redraw.options?.id).toBe('received-bundle-' + BUNDLE)
    expect(props(redraw).progress).toBe('1 of 2 in — 1 still receiving')
    // Held open while the part waits, like the queued toast it replaces.
    expect(redraw.options?.duration).toBe(Infinity)

    settleQueued('v2', BUNDLE)
    expect(props(toasts().at(-1)!).progress).toBe('1 of 2 vouchers so far')
  })

  it('falls back to the ordinary queued toast when no part has landed yet', () => {
    announceQueued('v1', 20_000, BUNDLE)
    expect(calls.some((c) => c.kind === 'loading')).toBe(true)
  })
})

describe('what does not change', () => {
  it('a single-voucher send is announced exactly as before', async () => {
    await announceBundleArrival(coupon('solo', 600), undefined, ME, 'wrap-solo')
    expect(toasts()[0]!.options?.id).toBe('received-solo')
    expect(listNotifications(ME)[0]!.id).toBe('arrival:solo')
  })

  it('a DM with a bundle id but no declaration is announced per part, as before', async () => {
    await announceBundleArrival(coupon('v1'), { bundleId: BUNDLE }, ME, 'wrap-0')
    await announceBundleArrival(coupon('v2'), { bundleId: BUNDLE }, ME, 'wrap-1')
    expect(toasts().map((c) => c.options?.id)).toEqual(['received-v1', 'received-v2'])
  })

  it('a part from another sender is still announced, on its own', async () => {
    await announceBundleArrival(coupon('v1'), declared(0), ME, 'wrap-0')
    await announceBundleArrival({ ...coupon('v2'), sender_pubkey: 'c'.repeat(64) }, declared(1), ME, 'wrap-1')
    expect(toasts().map((c) => c.options?.id)).toContain('received-v2')
  })
})
