/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * #295 phase 0: the bell says "Your Cashlink expired. Open Imani to take it back." once per
 * customer Cashlink, in plain words, deduped across runs and across a restore. A stall's Cashlink
 * (Sell, till) is not returned by design and gets no notice.
 */

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  merchant: false,
}))

vi.mock('../wallet', () => ({
  getWallet: () => ({
    getAllTransactions: async () => h.rows,
    updateTransaction: async (id: string, patch: Record<string, unknown>) => {
      const row = h.rows.find((r) => r.id === id)
      if (!row) return null
      Object.assign(row, patch)
      return row
    },
  }),
  notifyWalletChanged: () => {},
}))
vi.mock('../txRecords', () => ({ publishTx: async () => {} }))
vi.mock('../merchant', async (orig) => ({
  ...(await orig<typeof import('../merchant')>()),
  loadMerchant: () => (h.merchant ? { name: 'Stall' } : null),
}))

import { _resetInboxCacheForTests, clearNotifications, listNotifications } from '../notifications/inbox'
import {
  CASHLINK_EXPIRED_RETURNED_BODY,
  CASHLINK_EXPIRED_WAITING_BODY,
  runCashlinkExpiryNotices,
  runCashlinkExpiryNoticesAfterReconcile,
  runCashlinkExpiryNoticesIfSettled,
} from '../cashlinkExpiryNotice'
import { JARGON } from '../userMessage'

const ME = 'e'.repeat(64)
const X = 1_850_000_000
const BEFORE = (X - 60) * 1000
const AFTER = (X + 60) * 1000
const K = (n: number) => String(n).padStart(43, 'A')

function linkRow(n: number, status = 'outstanding', extra: Record<string, unknown> = {}) {
  return { id: `sent:t${n}`, type: 'sent', timestamp: n, link: { k: K(n), i: n, x: X, status, ...extra } }
}

beforeEach(() => {
  localStorage.clear()
  _resetInboxCacheForTests()
  clearNotifications(ME)
  h.rows = []
  h.merchant = false
})

describe('the Cashlink expiry notice (#295 phase 0)', () => {
  it('says nothing before the link expires', async () => {
    h.rows = [linkRow(0)]
    expect(await runCashlinkExpiryNotices(ME, BEFORE)).toBe(0)
    expect(listNotifications(ME)).toHaveLength(0)
  })

  it('tells the sender once, in plain words, when a link expires unclaimed', async () => {
    h.rows = [linkRow(0)]
    expect(await runCashlinkExpiryNotices(ME, AFTER)).toBe(1)
    const [item] = listNotifications(ME)
    expect(item.body).toBe('Your Cashlink expired. Open Imani to take it back.')
    expect(item.body).toBe(CASHLINK_EXPIRED_WAITING_BODY)
    expect(item.url).toBe('/transaction/sent%3At0')
    // The id is the row, never the link's secret.
    expect(item.id).not.toContain(K(0))
    expect(item.body).not.toMatch(JARGON)
    expect(CASHLINK_EXPIRED_RETURNED_BODY).not.toMatch(JARGON)
    expect(`${item.title} ${item.body}`).not.toMatch(/token|proof|mint|relay|nostr|key|NUT/i)
  })

  it('files one entry per link, however often it runs', async () => {
    h.rows = [linkRow(0), linkRow(1)]
    expect(await runCashlinkExpiryNotices(ME, AFTER)).toBe(2)
    expect(await runCashlinkExpiryNotices(ME, AFTER + 3_600_000)).toBe(0)
    expect(await runCashlinkExpiryNotices(ME, AFTER + 86_400_000)).toBe(0)
    expect(listNotifications(ME)).toHaveLength(2)
  })

  it('a bundle (several rows, one link) is one entry', async () => {
    h.rows = [linkRow(0), { ...linkRow(0), id: 'sent:t0b' }]
    expect(await runCashlinkExpiryNotices(ME, AFTER)).toBe(1)
  })

  it('survives a restore: the record carries noticedAt, so a fresh device does not tell again', async () => {
    h.rows = [linkRow(0)]
    await runCashlinkExpiryNotices(ME, AFTER)
    const link = h.rows[0].link as { noticedAt?: number }
    expect(link.noticedAt).toBe(AFTER)
    // A new device: empty bell, empty local storage, the history record restored as it was.
    localStorage.clear()
    _resetInboxCacheForTests()
    expect(await runCashlinkExpiryNotices(ME, AFTER + 60_000)).toBe(0)
    expect(listNotifications(ME)).toHaveLength(0)
  })

  it('says the voucher came back when the wallet took it back after the link expired', async () => {
    h.rows = [linkRow(0, 'reclaimed', { closedAt: AFTER })]
    expect(await runCashlinkExpiryNotices(ME, AFTER + 1000)).toBe(1)
    expect(listNotifications(ME)[0].body).toBe(CASHLINK_EXPIRED_RETURNED_BODY)
  })

  it('says nothing for a claimed link, one taken back by hand, or an old take-back', async () => {
    h.rows = [
      linkRow(0, 'claimed', { closedAt: AFTER }),
      linkRow(1, 'reclaimed', { closedAt: BEFORE }),
      linkRow(2, 'reclaimed', { closedAt: AFTER, noticedAt: AFTER }),
      linkRow(3, 'reclaimed', { closedAt: AFTER }),
    ]
    // Link 3 was taken back more than a day before this run (an update landing on old history).
    expect(await runCashlinkExpiryNotices(ME, AFTER + 2 * 86_400_000)).toBe(0)
    // Taken back by hand just now (takeBack sets noticedAt): still nothing.
    h.rows = [linkRow(4, 'reclaimed', { closedAt: AFTER, noticedAt: AFTER })]
    expect(await runCashlinkExpiryNotices(ME, AFTER + 1000)).toBe(0)
    expect(listNotifications(ME)).toHaveLength(0)
  })

  it('the hourly pass waits for start-up, so an open app never asks to be opened mid take-back', async () => {
    h.rows = [linkRow(0, 'reclaimed', { closedAt: AFTER })]
    expect(await runCashlinkExpiryNoticesIfSettled(ME, AFTER + 1000)).toBe(0)
    expect(await runCashlinkExpiryNoticesAfterReconcile(ME, AFTER + 1000)).toBe(1)
    h.rows.push(linkRow(1, 'reclaimed', { closedAt: AFTER }))
    expect(await runCashlinkExpiryNoticesIfSettled(ME, AFTER + 2000)).toBe(1)
  })

  it('a merchant Cashlink gets no take-back notice', async () => {
    // A stall's Cashlink (Sell, or a till) is a `cashback` row with no link record: never announced.
    h.rows = [
      { id: 'cashback:cb1', type: 'cashback', timestamp: 1, expiresAt: X, claimCode: 'ref' },
      { id: 'cashback:cb2', type: 'cashback', timestamp: 2, expiresAt: X, link: undefined },
    ]
    expect(await runCashlinkExpiryNotices(ME, AFTER)).toBe(0)
    // And a merchant account is never told to take a link back, even one it made as a customer.
    h.rows = [linkRow(0)]
    h.merchant = true
    expect(await runCashlinkExpiryNotices(ME, AFTER)).toBe(0)
    expect(listNotifications(ME)).toHaveLength(0)
  })
})
