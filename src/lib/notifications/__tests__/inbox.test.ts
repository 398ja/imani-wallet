/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  _resetInboxCacheForTests,
  clearNotifications,
  listNotifications,
  markAllRead,
  markRead,
  recordNotification,
  subscribeToNotifications,
  unreadCount,
} from '../inbox'

const PUBKEY = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)

function add(pubkey: string, id: string, receivedAt = Date.now()) {
  return recordNotification(pubkey, {
    id,
    type: 'voucher_received',
    title: 'Coupon received',
    body: 'A coupon arrived.',
    url: '/receive',
    receivedAt,
  })
}

describe('notification inbox', () => {
  beforeEach(() => {
    localStorage.clear()
    _resetInboxCacheForTests()
  })

  it('keeps notifications newest first', () => {
    add(PUBKEY, 'one', 1000)
    add(PUBKEY, 'two', 2000)

    expect(listNotifications(PUBKEY).map((n) => n.id)).toEqual(['two', 'one'])
  })

  it('counts only the unread', () => {
    add(PUBKEY, 'one')
    add(PUBKEY, 'two')
    expect(unreadCount(PUBKEY)).toBe(2)

    markRead(PUBKEY, 'one')
    expect(unreadCount(PUBKEY)).toBe(1)

    markAllRead(PUBKEY)
    expect(unreadCount(PUBKEY)).toBe(0)
  })

  it('ignores a repeat of an id it already holds', () => {
    // The same event can arrive by push AND by the drain loop. One event is
    // one line, whichever gets there first.
    expect(add(PUBKEY, 'same')).toBe(true)
    expect(add(PUBKEY, 'same')).toBe(false)
    expect(listNotifications(PUBKEY)).toHaveLength(1)
  })

  it('keeps two accounts apart on a shared device', () => {
    add(PUBKEY, 'mine')
    add(OTHER, 'theirs')

    expect(listNotifications(PUBKEY).map((n) => n.id)).toEqual(['mine'])
    expect(listNotifications(OTHER).map((n) => n.id)).toEqual(['theirs'])
  })

  it('survives a reload', () => {
    add(PUBKEY, 'persisted')
    _resetInboxCacheForTests() // simulates a fresh page load

    expect(listNotifications(PUBKEY).map((n) => n.id)).toEqual(['persisted'])
  })

  it('bounds the list so localStorage cannot fill up', () => {
    for (let i = 0; i < 60; i += 1) add(PUBKEY, `n${i}`, i)

    const items = listNotifications(PUBKEY)
    expect(items).toHaveLength(50)
    // The newest survive; the oldest fall off.
    expect(items[0].id).toBe('n59')
    expect(items.some((n) => n.id === 'n0')).toBe(false)
  })

  it('returns a stable reference until something writes', () => {
    // useSyncExternalStore compares by reference; a fresh array every call
    // would re-render forever.
    add(PUBKEY, 'one')
    expect(listNotifications(PUBKEY)).toBe(listNotifications(PUBKEY))

    add(PUBKEY, 'two')
    expect(listNotifications(PUBKEY)).not.toBe(undefined)
  })

  it('notifies subscribers when something arrives', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeToNotifications(listener)

    add(PUBKEY, 'one')
    expect(listener).toHaveBeenCalledTimes(1)

    unsubscribe()
    add(PUBKEY, 'two')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('does not churn when marking an already-read item', () => {
    add(PUBKEY, 'one')
    markRead(PUBKEY, 'one')

    const listener = vi.fn()
    subscribeToNotifications(listener)
    markRead(PUBKEY, 'one')

    expect(listener).not.toHaveBeenCalled()
  })

  it('clears everything for one account only', () => {
    add(PUBKEY, 'mine')
    add(OTHER, 'theirs')

    clearNotifications(PUBKEY)

    expect(listNotifications(PUBKEY)).toHaveLength(0)
    expect(listNotifications(OTHER)).toHaveLength(1)
  })

  it('drops corrupt rows rather than failing the header', () => {
    localStorage.setItem(
      `imani-wallet:notifications:${PUBKEY}`,
      JSON.stringify([{ id: 'good', type: 'generic', title: 't', body: 'b', url: '/', receivedAt: 1, readAt: null }, { nonsense: true }, 'not an object']),
    )
    _resetInboxCacheForTests()

    expect(listNotifications(PUBKEY).map((n) => n.id)).toEqual(['good'])
  })

  it('keeps working when localStorage is denied', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })

    expect(() => add(PUBKEY, 'one')).not.toThrow()
    // The session still sees it, even though it will not survive a reload.
    expect(listNotifications(PUBKEY)).toHaveLength(1)

    setItem.mockRestore()
  })
})
