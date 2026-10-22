/**
 * The notification inbox: what the bell in the header opens.
 *
 * A push notification is gone the moment it is dismissed, and the existing
 * sonner toast lasts five seconds. Neither survives "I felt the phone buzz on
 * the bus and want to look now". This is the record that does.
 *
 * ## Why localStorage and not IndexedDB
 *
 * The wallet has a perfectly good IDB layer (`@imani/wallet-storage`), and this
 * deliberately does not use it. That store holds vouchers and transactions:
 * money, with a schema, migrations and a shared-database contract. An inbox is
 * a short list of already-public strings — a title, a body, a route, a
 * timestamp — that the header reads synchronously on every render to decide
 * whether to show a dot.
 *
 * Putting it in IDB would make that read async, which means the bell would flash
 * unbadged on every mount and then correct itself. localStorage is synchronous,
 * survives reload, and carries nothing worth encrypting. The same reasoning the
 * `seen` set in `incomingNotifications.ts` already follows.
 *
 * ## Bounded, per account, and deduplicated
 *
 * Bounded because an unbounded list in localStorage eventually throws
 * QuotaExceeded, and the failure lands on whoever writes next rather than on
 * whoever filled it. Per account because two people using one device must not
 * see each other's money. Deduplicated because the same event can arrive twice
 * — once by push and once by the drain loop — and one event should be one line.
 */

import type { NotMoneyNoticeType, NotificationTypeOrGeneric } from './types'

/** Bell rows the wallet files itself about its own Cashlinks (#295 phase 0). Never on the push wire. */
export type WalletNoticeType = 'cashlink_expired'

/** One line in the inbox. */
export interface InboxItem {
  /** Stable identity, used to dedupe and to mark read. */
  id: string
  type: NotificationTypeOrGeneric | NotMoneyNoticeType | WalletNoticeType
  title: string
  body: string
  /** Wallet-relative route to open on tap. */
  url: string
  /** Epoch ms. */
  receivedAt: number
  readAt: number | null
}

/**
 * How many notifications to keep.
 *
 * Fifty is roughly a screen's worth of scrolling and far more than anyone
 * reads. The oldest fall off first: an unread notification from two hundred
 * events ago is not something a user is coming back for.
 */
const MAX_ITEMS = 50

const storageKey = (pubkey: string) => `imani-wallet:notifications:${pubkey}`

/**
 * Subscribers, so the header badge updates without polling.
 *
 * A plain callback set rather than an event emitter: the only consumer is a
 * `useSyncExternalStore` hook, which wants exactly this shape.
 */
const listeners = new Set<() => void>()

/**
 * Cached last-read snapshot, per account.
 *
 * `useSyncExternalStore` compares snapshots by reference and re-renders when
 * they differ. Parsing JSON on every call returns a new array every time, so
 * React would re-render forever. The cache makes the snapshot stable until
 * something actually writes.
 */
const snapshots = new Map<string, InboxItem[]>()

const EMPTY: InboxItem[] = []

function notify(): void {
  for (const listener of listeners) {
    try {
      listener()
    } catch (e) {
      console.warn('[notifications] listener failed:', e)
    }
  }
}

function isInboxItem(value: unknown): value is InboxItem {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Partial<InboxItem>
  return (
    typeof item.id === 'string' &&
    typeof item.title === 'string' &&
    typeof item.body === 'string' &&
    typeof item.url === 'string' &&
    typeof item.receivedAt === 'number' &&
    (item.readAt === null || typeof item.readAt === 'number')
  )
}

function read(pubkey: string): InboxItem[] {
  const cached = snapshots.get(pubkey)
  if (cached) return cached

  let items: InboxItem[] = EMPTY
  try {
    const raw = localStorage.getItem(storageKey(pubkey))
    if (raw) {
      const parsed: unknown = JSON.parse(raw)
      // Filtering rather than trusting: this survived a reload, may have been
      // written by an older build, and is trivially editable by hand.
      if (Array.isArray(parsed)) items = parsed.filter(isInboxItem)
    }
  } catch (e) {
    // A denied or corrupt localStorage must not take the header down with it.
    console.warn('[notifications] could not read inbox:', e)
  }

  snapshots.set(pubkey, items)
  return items
}

function write(pubkey: string, items: InboxItem[]): void {
  const bounded = items.slice(0, MAX_ITEMS)
  // The cache updates even if persistence fails, so the session stays correct
  // in a private window where localStorage throws on write.
  snapshots.set(pubkey, bounded)
  try {
    localStorage.setItem(storageKey(pubkey), JSON.stringify(bounded))
  } catch (e) {
    console.warn('[notifications] could not persist inbox:', e)
  }
  notify()
}

/** Newest first. The stable reference `useSyncExternalStore` needs. */
export function listNotifications(pubkey: string): InboxItem[] {
  return read(pubkey)
}

export function unreadCount(pubkey: string): number {
  return read(pubkey).filter(isUnread).length
}

/**
 * One definition of "unread", shared by everything that asks.
 *
 * Exported because the bell counts from the SAME array it renders rather than
 * calling `unreadCount`, and that is deliberate: a second read of localStorage
 * could disagree with the list on screen, showing a badge for an item the user
 * is looking at. Sharing the predicate keeps the two honest without coupling
 * the count to a re-read.
 */
export function isUnread(item: InboxItem): boolean {
  return item.readAt === null
}

/**
 * Record an arrival.
 *
 * Ignores a repeat of an id already present, which is what makes it safe to
 * call from both the push handler and the drain loop for the same event.
 * Returns whether anything was added, so a caller can avoid a redundant toast.
 */
export function recordNotification(
  pubkey: string,
  item: Omit<InboxItem, 'readAt' | 'receivedAt'> & { receivedAt?: number },
): boolean {
  const existing = read(pubkey)
  if (existing.some((candidate) => candidate.id === item.id)) return false

  const next: InboxItem = {
    ...item,
    receivedAt: item.receivedAt ?? Date.now(),
    readAt: null,
  }
  write(pubkey, [next, ...existing])
  return true
}

/**
 * Record or rewrite one line in place.
 *
 * For a notification that is one story told in several steps — a multi-coupon
 * payment arriving part by part (#94) — where `recordNotification`'s "first
 * write wins" would freeze the row at "€3.00 of €6.00" forever.
 *
 * The row keeps its position and its read state unless `reopen` is set, which
 * is for the transitions a user should look at again (the bundle finishing, or
 * being called incomplete). Without that a reader who opened the bell at "1 of
 * 2" would never see the badge for the outcome.
 *
 * Returns whether the row was new.
 */
export function upsertNotification(
  pubkey: string,
  item: Omit<InboxItem, 'readAt' | 'receivedAt'> & { receivedAt?: number },
  opts: { reopen?: boolean } = {},
): boolean {
  const existing = read(pubkey)
  const index = existing.findIndex((candidate) => candidate.id === item.id)
  if (index === -1) return recordNotification(pubkey, item)

  const current = existing[index]!
  const readAt = opts.reopen ? null : current.readAt
  if (
    current.title === item.title &&
    current.body === item.body &&
    current.url === item.url &&
    current.type === item.type &&
    current.readAt === readAt
  ) {
    // Nothing moved: do not churn storage or wake every subscriber.
    return false
  }
  const next = existing.slice()
  next[index] = {
    ...current,
    type: item.type,
    title: item.title,
    body: item.body,
    url: item.url,
    readAt,
  }
  write(pubkey, next)
  return false
}

export function markRead(pubkey: string, id: string): void {
  const items = read(pubkey)
  let changed = false
  const next = items.map((item) => {
    if (item.id !== id || item.readAt !== null) return item
    changed = true
    return { ...item, readAt: Date.now() }
  })
  // Guarded so tapping an already-read row does not churn storage or re-render.
  if (changed) write(pubkey, next)
}

export function markAllRead(pubkey: string): void {
  const items = read(pubkey)
  if (!items.some((item) => item.readAt === null)) return
  const now = Date.now()
  write(
    pubkey,
    items.map((item) => (item.readAt === null ? { ...item, readAt: now } : item)),
  )
}

/**
 * Empty one account's inbox.
 *
 * No production caller today, and kept anyway: logout erases the inbox by
 * sweeping every `imani-wallet:*` key, which happens to cover
 * `imani-wallet:notifications:<pubkey>` without naming it. If that sweep is
 * ever narrowed, this is the call that replaces it, and rediscovering the key
 * format at that point is how a stale inbox survives a logout.
 */
export function clearNotifications(pubkey: string): void {
  if (read(pubkey).length === 0) return
  write(pubkey, [])
}

/** Subscribe to changes. Returns an unsubscribe function. */
export function subscribeToNotifications(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Test seam: drops the in-memory cache so a fresh read hits storage. */
export function _resetInboxCacheForTests(): void {
  snapshots.clear()
  listeners.clear()
}
