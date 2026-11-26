/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { VoucherRow } from '@imani/wallet-storage'

vi.mock('../licences', async (orig) => ({
  ...(await orig<typeof import('../licences')>()),
  isLicence: (row: { token_id?: string }) => row.token_id === 'licence',
}))
vi.mock('../notMoney', async (orig) => ({
  ...(await orig<typeof import('../notMoney')>()),
  isTerminalCredential: (row: { token_id?: string }) => row.token_id === 'credential',
}))

import { _resetInboxCacheForTests, clearNotifications, listNotifications } from '../notifications/inbox'
import {
  bannerState,
  carryExpiryReminders,
  dismissBanner,
  runExpiryReminders,
} from '../expiryReminders'
import { DAY_MS, HOUR_MS } from '../couponExpiry'

const ME = 'e'.repeat(64)
const STALL = 'a'.repeat(64)
const NOW = Date.UTC(2026, 9, 15, 10, 0, 0)
const at = (ms: number) => Math.floor((NOW + ms) / 1000)
const names = { [STALL]: 'Test Stall' }

function row(token_id: string, expiresIn: number | undefined, over: Partial<VoucherRow> = {}): VoucherRow {
  return {
    token_id,
    token: `cashuB-${token_id}`,
    amount: 250,
    face_value: 250,
    face_unit: 'EUR',
    face_decimals: 2,
    issuer_id: STALL,
    status: 'active',
    expires_at: expiresIn === undefined ? undefined : at(expiresIn),
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    ...over,
  }
}

const setPref = (couponExpiring: boolean) =>
  localStorage.setItem(`imani-wallet:notification-prefs:${ME}`, JSON.stringify({ couponExpiring }))

beforeEach(() => {
  localStorage.clear()
  _resetInboxCacheForTests()
})

describe('runExpiryReminders: the bell', () => {
  it('files one entry for a coupon inside 7 days, with the stall, the value and a link to the coupon', () => {
    runExpiryReminders(ME, [row('t1', 6 * DAY_MS + HOUR_MS)], { now: NOW, names })
    const items = listNotifications(ME)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: 'coupon-expiring:t1:7d',
      type: 'voucher_expiring',
      title: 'Voucher expiring',
      url: `/merchants/${STALL}/vouchers?open=t1`,
      readAt: null,
    })
    expect(items[0]!.body).toMatch(/^Your €2\.50 voucher from Test Stall expires in 6 days\.$/)
  })

  it('never repeats across reopens and reloads (in-memory cache dropped)', () => {
    const rows = [row('t1', 6 * DAY_MS)]
    runExpiryReminders(ME, rows, { now: NOW, names })
    _resetInboxCacheForTests()
    runExpiryReminders(ME, rows, { now: NOW + HOUR_MS, names })
    runExpiryReminders(ME, rows, { now: NOW + 2 * HOUR_MS, names })
    expect(listNotifications(ME)).toHaveLength(1)
  })

  it('does not come back after the bell lost it (cleared, or fell off the 50 cap)', () => {
    const rows = [row('t1', 6 * DAY_MS)]
    runExpiryReminders(ME, rows, { now: NOW, names })
    clearNotifications(ME)
    runExpiryReminders(ME, rows, { now: NOW + HOUR_MS, names })
    expect(listNotifications(ME)).toHaveLength(0)
  })

  it('files a SECOND entry when the same coupon crosses 1 day, and only once', () => {
    const rows = [row('t1', 6 * DAY_MS)]
    runExpiryReminders(ME, rows, { now: NOW, names })
    runExpiryReminders(ME, rows, { now: NOW + 5 * DAY_MS + HOUR_MS, names })
    runExpiryReminders(ME, rows, { now: NOW + 5 * DAY_MS + 2 * HOUR_MS, names })
    const ids = listNotifications(ME).map((i) => i.id)
    expect(ids).toEqual(['coupon-expiring:t1:1d', 'coupon-expiring:t1:7d'])
    expect(listNotifications(ME)[0]!.body).toMatch(/expires in 23 hours\.$/)
  })

  it('a coupon first seen inside 1 day gets the 1-day entry only, never a stale 7-day one', () => {
    runExpiryReminders(ME, [row('t1', 12 * HOUR_MS)], { now: NOW, names })
    expect(listNotifications(ME).map((i) => i.id)).toEqual(['coupon-expiring:t1:1d'])
  })

  it('excludes licences, terminal credentials, spent, never-expiring and own-issued coupons', () => {
    runExpiryReminders(
      ME,
      [
        row('licence', HOUR_MS * 5),
        row('credential', HOUR_MS * 5),
        row('spent', HOUR_MS * 5, { status: 'redeemed' }),
        row('never', undefined),
        row('mine', HOUR_MS * 5, { issuer_id: ME }),
        row('far', 30 * DAY_MS),
      ],
      { now: NOW, names },
    )
    expect(listNotifications(ME)).toEqual([])
  })

  it('switch OFF: no entry and no banner; turning it back on tells what is due NOW', () => {
    setPref(false)
    const rows = [row('t1', 6 * DAY_MS)]
    runExpiryReminders(ME, rows, { now: NOW, names })
    expect(listNotifications(ME)).toEqual([])
    expect(bannerState(ME, rows, NOW).show).toBe(false)
    setPref(true)
    runExpiryReminders(ME, rows, { now: NOW + HOUR_MS, names })
    // Turning it on is a fresh choice: what is inside the window now is told now.
    expect(listNotifications(ME)).toHaveLength(1)
  })

  it('falls back to "a stall" when no name is known, and never prints a key', () => {
    runExpiryReminders(ME, [row('t1', 6 * DAY_MS)], { now: NOW, names: {} })
    expect(listNotifications(ME)[0]!.body).toBe('Your €2.50 voucher expires in 6 days.')
  })

  it('a partial spend re-keys the coupon: its reminders and banner dismissal move with it (#269 review)', () => {
    // pay.ts replaceVoucherToken: the change is saved under a NEW content-derived token_id, same
    // expiry. Without the carry, the change got a second "7 days" entry and the banner came back.
    const before = row('old', 6 * DAY_MS)
    runExpiryReminders(ME, [before], { now: NOW, names })
    dismissBanner(ME, [before], NOW)
    carryExpiryReminders('old', 'new')
    const change = { ...before, token_id: 'new', token: 'cashuB-new', face_value: 100 }
    runExpiryReminders(ME, [change], { now: NOW + HOUR_MS, names })
    expect(listNotifications(ME).map((i) => i.id)).toEqual(['coupon-expiring:old:7d'])
    expect(bannerState(ME, [change], NOW + HOUR_MS).show).toBe(false)
    // The 1-day threshold is still new for it, once.
    runExpiryReminders(ME, [change], { now: NOW + 5 * DAY_MS + HOUR_MS, names })
    expect(listNotifications(ME).map((i) => i.id)).toEqual(['coupon-expiring:new:1d', 'coupon-expiring:old:7d'])
  })

  it('a re-key AFTER the 1-day entry does not file a second 1-day entry (#269 review, M5)', () => {
    const before = row('old', 12 * HOUR_MS)
    runExpiryReminders(ME, [before], { now: NOW, names })
    dismissBanner(ME, [before], NOW)
    carryExpiryReminders('old', 'new')
    const change = { ...before, token_id: 'new', token: 'cashuB-new' }
    runExpiryReminders(ME, [change], { now: NOW + HOUR_MS, names })
    expect(listNotifications(ME).map((i) => i.id)).toEqual(['coupon-expiring:old:1d'])
    expect(bannerState(ME, [change], NOW + HOUR_MS).show).toBe(false)
  })

  it("re-keying coupon A does not inherit coupon B's 1-day entry (#269 review, M4)", () => {
    const a = row('aaa', 6 * DAY_MS)
    const b = row('bbb', 12 * HOUR_MS)
    runExpiryReminders(ME, [a, b], { now: NOW, names })
    carryExpiryReminders('aaa', 'aaa2')
    const a2 = { ...a, token_id: 'aaa2', token: 'cashuB-aaa2' }
    // A reaches its last day: its 1-day entry is legitimate and must still fire.
    runExpiryReminders(ME, [a2, b], { now: NOW + 5 * DAY_MS + HOUR_MS, names })
    expect(listNotifications(ME).map((i) => i.id)).toContain('coupon-expiring:aaa2:1d')
    expect(listNotifications(ME).filter((i) => i.id.endsWith(':1d'))).toHaveLength(2)
  })

  it('carryExpiryReminders touches only accounts that had filed the old coupon, and never throws', () => {
    const OTHER = 'f'.repeat(64)
    runExpiryReminders(ME, [row('old', 6 * DAY_MS)], { now: NOW, names })
    carryExpiryReminders('old', 'new')
    expect(localStorage.getItem(`imani-wallet:expiry-reminders:${OTHER}`)).toBeNull()
    expect(() => carryExpiryReminders('', 'x')).not.toThrow()
  })

  it('is per account', () => {
    const OTHER = 'f'.repeat(64)
    runExpiryReminders(ME, [row('t1', 6 * DAY_MS)], { now: NOW, names })
    expect(listNotifications(OTHER)).toEqual([])
  })
})

describe('the home banner', () => {
  const two = [row('t1', 6 * DAY_MS), row('t2', 3 * DAY_MS), row('far', 20 * DAY_MS)]

  it('counts the coupons expiring within 7 days, singular and plural', () => {
    expect(bannerState(ME, two, NOW)).toEqual({ show: true, count: 2, text: '2 vouchers expire this week' })
    expect(bannerState(ME, [two[0]!], NOW)).toMatchObject({ show: true, text: '1 voucher expires this week' })
    expect(bannerState(ME, [two[2]!], NOW).show).toBe(false)
  })

  it('stays hidden once dismissed, across reloads', () => {
    dismissBanner(ME, two, NOW)
    expect(bannerState(ME, two, NOW).show).toBe(false)
    expect(bannerState(ME, two, NOW + HOUR_MS).show).toBe(false)
  })

  it('comes back when a NEW coupon crosses a threshold', () => {
    dismissBanner(ME, two, NOW)
    const plus = [...two, row('t3', 5 * DAY_MS)]
    expect(bannerState(ME, plus, NOW)).toMatchObject({ show: true, count: 3 })
  })

  it('comes back when a coupon already counted crosses the 1-day threshold', () => {
    dismissBanner(ME, two, NOW)
    expect(bannerState(ME, two, NOW + 2 * DAY_MS + HOUR_MS).show).toBe(true)
  })

  it('stays hidden when a dismissed coupon is merely spent', () => {
    dismissBanner(ME, two, NOW)
    expect(bannerState(ME, [two[0]!], NOW).show).toBe(false)
  })
})
