import { useRef, useSyncExternalStore } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bell, CheckCheck } from 'lucide-react'

import {
  listNotifications,
  markAllRead,
  isUnread,
  markRead,
  subscribeToNotifications,
  type InboxItem,
} from '../../lib/notifications/inbox'

/**
 * The bell in the header, and the panel it opens.
 *
 * A push notification is gone once dismissed and the sonner toast lasts five
 * seconds. This is where "I felt it buzz and want to look now" goes.
 *
 * ## Built like the account menu, deliberately
 *
 * Same `<details>`/`<summary>` construction as the hamburger beside it, for the
 * reasons already written there: the element gives open/close, Escape, focus
 * handling and keyboard activation for free. Two adjacent controls that look
 * alike must behave alike, so this one is not a hand-rolled popover with
 * different keyboard behaviour.
 *
 * It wears `materialize` and `material` for the same reason too: the panel
 * grows from the control that opened it, so the link between trigger and
 * content is spatial rather than something to work out.
 *
 * ## The dot is a dot, not a number
 *
 * A count answers "how many unread", which nobody acts on, and forces a
 * decision about what 100+ looks like. The dot answers "is there anything new",
 * which is the actual question. It sits on the glyph's top-right with a ring in
 * the header's own colour so it reads as floating above the bell rather than
 * drawn onto it.
 */
export function NotificationBell({ pubkey }: { pubkey: string }) {
  const navigate = useNavigate()
  const panel = useRef<HTMLDetailsElement>(null)

  // useSyncExternalStore rather than useState + an effect: the inbox is written
  // from outside React (the push handler, the drain loop), and this is the hook
  // built for exactly that. The store returns a stable reference until
  // something writes, which is what stops this re-rendering forever.
  const items = useSyncExternalStore(
    subscribeToNotifications,
    () => listNotifications(pubkey),
    () => listNotifications(pubkey),
  )

  // Counted from the array being rendered, not re-read from storage, so the
  // badge can never disagree with the list below it. `isUnread` is inbox.ts's
  // definition, shared so the two cannot drift apart.
  const unread = items.filter(isUnread).length

  const open = (item: InboxItem) => {
    markRead(pubkey, item.id)
    panel.current?.removeAttribute('open')
    navigate(item.url)
  }

  return (
    <details
      ref={panel}
      className="relative shrink-0"
      onBlur={(e) => {
        // Focus leaving the subtree closes the panel — the outside-click case,
        // handled without a document listener, exactly as the menu does.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          e.currentTarget.removeAttribute('open')
        }
      }}
    >
      <summary
        className="pressable relative flex h-11 w-11 cursor-pointer list-none items-center justify-center rounded-full outline-none ring-mono-400 focus-visible:ring-2 [&::-webkit-details-marker]:hidden"
        // The count belongs in the accessible name even though it is not shown:
        // a screen reader user cannot see a dot.
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
      >
        <Bell className="h-6 w-6" aria-hidden="true" />
        {unread > 0 && (
          <span
            aria-hidden="true"
            className="absolute right-2 top-2 h-2 w-2 rounded-full bg-red-500 ring-2 ring-mono-50 dark:ring-mono-950"
          />
        )}
      </summary>

      {/* Wider than the account menu (w-80 vs w-56) because these rows carry a
          sentence rather than a label. Capped and scrollable so a long backlog
          cannot push the panel off-screen. */}
      <nav className="materialize material absolute right-0 top-full mt-2 flex max-h-[70vh] w-80 origin-top-right flex-col overflow-hidden rounded-[14px] shadow-xl shadow-mono-950/20 ring-1 ring-mono-900/5 dark:ring-mono-50/10">
        <header className="flex items-center justify-between gap-3 border-b border-mono-900/[0.07] px-4 py-3 dark:border-mono-50/[0.08]">
          <h2 className="text-[15px] font-semibold text-mono-900 dark:text-mono-50">
            Notifications
          </h2>
          {unread > 0 && (
            <button
              type="button"
              onClick={() => markAllRead(pubkey)}
              className="pressable flex items-center gap-1.5 rounded-full text-[13px] font-medium text-mono-500 outline-none ring-mono-400 hover:text-mono-900 focus-visible:ring-2 dark:hover:text-mono-50"
            >
              <CheckCheck className="h-4 w-4" aria-hidden="true" />
              Mark all read
            </button>
          )}
        </header>

        {items.length === 0 ? (
          // Says what WILL appear, not just that nothing has. An empty state
          // that only reports emptiness leaves the user wondering if it is
          // broken.
          <p className="px-4 py-8 text-center text-[13px] text-mono-500">
            Nothing yet. Coupons you receive and claims on coupons you sent will
            show up here.
          </p>
        ) : (
          <ul className="divide-y divide-mono-900/[0.07] overflow-y-auto dark:divide-mono-50/[0.08]">
            {items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => open(item)}
                  className="press-row flex w-full min-h-11 items-start gap-3 px-4 py-3 text-left"
                >
                  {/* The unread marker keeps its column whether or not it is
                      drawn, so titles align down the list rather than shifting
                      left as rows are read. */}
                  <span className="flex w-2 shrink-0 justify-center pt-1.5">
                    {isUnread(item) && (
                      <span
                        aria-hidden="true"
                        className="h-2 w-2 rounded-full bg-blue-500"
                      />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      className={`block text-[15px] ${
                        isUnread(item)
                          ? 'font-semibold text-mono-900 dark:text-mono-50'
                          : 'font-medium text-mono-500'
                      }`}
                    >
                      {item.title}
                    </span>
                    <span className="mt-0.5 block text-[13px] leading-snug text-mono-500">
                      {item.body}
                    </span>
                    <span className="mt-1 block text-[11px] uppercase tracking-wide text-mono-400">
                      {relativeTime(item.receivedAt)}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </nav>
    </details>
  )
}

/**
 * "3m ago", not a timestamp.
 *
 * A notification's age is the only temporal thing worth knowing here, and
 * "14:32" makes the reader do the subtraction. Coarse on purpose: past a week
 * the exact day stops mattering.
 */
export function relativeTime(epochMs: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - epochMs) / 1000))
  if (seconds < 45) return 'Just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days}d ago`
  const weeks = Math.round(days / 7)
  return `${weeks}w ago`
}
