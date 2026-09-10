/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import { NotificationBell, relativeTime } from '../NotificationBell'
import { _resetInboxCacheForTests, recordNotification } from '../../../lib/notifications/inbox'

const PUBKEY = 'a'.repeat(64)

function arrive(id: string, receivedAt = Date.now()) {
  recordNotification(PUBKEY, {
    id,
    type: 'voucher_received',
    title: `Coupon ${id}`,
    body: 'A coupon arrived.',
    url: '/receive',
    receivedAt,
  })
}

function show() {
  return render(
    <MemoryRouter>
      <NotificationBell pubkey={PUBKEY} />
    </MemoryRouter>,
  )
}

/** `<details>` does not toggle on a synthetic click in jsdom. */
function openPanel(container: HTMLElement) {
  const details = container.querySelector('details') as HTMLDetailsElement
  details.setAttribute('open', '')
  return details
}

describe('NotificationBell', () => {
  beforeEach(() => {
    localStorage.clear()
    _resetInboxCacheForTests()
  })
  afterEach(cleanup)

  it('says how many are unread, for a reader who cannot see the dot', () => {
    arrive('one')
    arrive('two')
    show()

    expect(screen.getByLabelText('Notifications, 2 unread')).toBeTruthy()
  })

  it('drops the count from the label once everything is read', () => {
    arrive('one')
    const { container } = show()
    openPanel(container)

    fireEvent.click(screen.getByRole('button', { name: /mark all read/i }))

    expect(screen.getByLabelText('Notifications')).toBeTruthy()
  })

  it('lists what arrived, newest first', () => {
    arrive('old', 1000)
    arrive('new', 2000)
    const { container } = show()
    openPanel(container)

    const rows = screen.getAllByRole('button').filter((b) => b.textContent?.includes('Coupon'))
    expect(rows[0].textContent).toContain('Coupon new')
    expect(rows[1].textContent).toContain('Coupon old')
  })

  it('marks one read when it is opened', () => {
    arrive('one')
    arrive('two')
    const { container } = show()
    openPanel(container)

    fireEvent.click(screen.getByRole('button', { name: /Coupon one/ }))

    expect(screen.getByLabelText('Notifications, 1 unread')).toBeTruthy()
  })

  it('offers mark-all-read only when something is unread', () => {
    arrive('one')
    const { container } = show()
    openPanel(container)
    expect(screen.queryByRole('button', { name: /mark all read/i })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /mark all read/i }))
    expect(screen.queryByRole('button', { name: /mark all read/i })).toBeNull()
  })

  it('says what will appear here, not merely that nothing has', () => {
    const { container } = show()
    openPanel(container)

    const panel = screen.getByRole('navigation')
    expect(within(panel).getByText(/coupons you receive/i)).toBeTruthy()
  })

  it('closes the panel when a notification is opened', () => {
    arrive('one')
    const { container } = show()
    const details = openPanel(container)

    fireEvent.click(screen.getByRole('button', { name: /Coupon one/ }))

    expect(details.hasAttribute('open')).toBe(false)
  })
})

describe('relativeTime', () => {
  const now = Date.UTC(2026, 0, 10, 12, 0, 0)

  it.each([
    [10 * 1000, 'Just now'],
    [5 * 60 * 1000, '5m ago'],
    [3 * 60 * 60 * 1000, '3h ago'],
    [2 * 24 * 60 * 60 * 1000, '2d ago'],
    [3 * 7 * 24 * 60 * 60 * 1000, '3w ago'],
  ])('renders an age of %sms as %s', (ago, expected) => {
    expect(relativeTime(now - ago, now)).toBe(expected)
  })

  it('never reports a future arrival as negative', () => {
    // Clock skew between the phone and the gateway is real.
    expect(relativeTime(now + 60_000, now)).toBe('Just now')
  })
})
