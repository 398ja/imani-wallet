/**
 * Spec 049 FR-027a-e: remember this device's receipt check and recall the earlier ones.
 *
 * The rules (who counts, who is named) are `checks.ts`; this is the state around them, with every
 * dependency passed in so the tests need no relay, gateway or storage:
 *
 * 1. Read the payment's checks from the gateway cache (reads never go to a relay), plus this
 *    device's own record, so a till that is offline still knows what IT checked.
 * 2. Publish this check, signed by the device. Unsent ones wait in an outbox and go out on the
 *    next check or when the device comes back online.
 * 3. Answer with the earlier checks, labelled for the viewer, and whether the cache answered:
 *    `known: false` means "could not see other devices", never "first check".
 *
 * A check made seconds ago by this same device (a re-render, a double tap) is not a new check,
 * and is not shown as an earlier one either.
 */
import type { Event } from 'nostr-tools'

import {
  CHECK_KIND,
  MAX_LOCAL,
  buildCheckEvent,
  checkLocator,
  labelChecks,
  readChecks,
  type KnownCheck,
  type PriorCheck,
  type TerminalProof,
} from './checks'

/** Seconds within which this device's own check is the same check, not a repeat. */
export const SAME_CHECK_SECONDS = 15

export interface KeyValueStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface CheckDevice {
  /** This device's key: the stall's on the owner's wallet, the till's own on a terminal. */
  device: string
  withKey: <T>(use: (key: Uint8Array) => T) => T
  /** On a till: its authority, so other tills can trust its checks. Absent on the owner's wallet. */
  terminal?: TerminalProof
  /** Owner side: terminal keys in its roster, and their names. Absent on a till (FR-027e). */
  roster?: { keys: ReadonlySet<string>; nameOf: (terminalPubkey: string) => string }
  /** Resolves true when a relay or the gateway took the event. Never throws. */
  publish: (e: Event) => Promise<boolean>
  /** Gateway cache read. Throws when it did not answer. */
  query: (filter: Record<string, unknown>) => Promise<Event[]>
  store: KeyValueStore
  /** Epoch seconds. */
  now: () => number
}

export interface CheckMemory {
  prior: PriorCheck[]
  /** False when the cache did not answer: other devices' checks are unknown. */
  known: boolean
  /** What happened to this check's record, or null when it was the same check as a moment ago. */
  record: 'published' | 'deferred' | null
}

const ownKey = (device: string) => `imani:receipt-checks:${device.toLowerCase()}`
const outboxKey = (device: string) => `imani:receipt-check-outbox:${device.toLowerCase()}`

function readList<T>(store: KeyValueStore, key: string, ok: (x: unknown) => x is T): T[] {
  try {
    const raw = JSON.parse(store.getItem(key) ?? '[]') as unknown
    return Array.isArray(raw) ? raw.filter(ok) : []
  } catch {
    return []
  }
}

function writeList(store: KeyValueStore, key: string, list: unknown[]): void {
  try {
    if (list.length === 0) store.removeItem(key)
    else store.setItem(key, JSON.stringify(list.slice(-MAX_LOCAL)))
  } catch {
    // Quota: the check still went out, or stays unsent. Nothing to tell the person at the till.
  }
}

interface OwnCheck {
  locator: string
  at: number
}
const isOwn = (x: unknown): x is OwnCheck =>
  !!x && typeof (x as OwnCheck).locator === 'string' && Number.isFinite((x as OwnCheck).at)
const isEvent = (x: unknown): x is Event =>
  !!x && typeof (x as Event).id === 'string' && typeof (x as Event).sig === 'string' && Array.isArray((x as Event).tags)

/** Send what the outbox holds. Returns how many are still waiting. Never throws. */
export async function flushCheckOutbox(d: Pick<CheckDevice, 'device' | 'publish' | 'store'>): Promise<number> {
  const waiting = readList(d.store, outboxKey(d.device), isEvent)
  if (waiting.length === 0) return 0
  const left: Event[] = []
  for (const e of waiting) {
    const sent = await d.publish(e).catch(() => false)
    if (!sent) left.push(e)
  }
  // Re-read: a check made while this flush ran must not be overwritten.
  const now = readList(d.store, outboxKey(d.device), isEvent)
  const still = now.filter((e) => left.some((l) => l.id === e.id) || !waiting.some((w) => w.id === e.id))
  writeList(d.store, outboxKey(d.device), still)
  return still.length
}

/**
 * Record this device's check of a payment paid to `payee`, and say what was known before it.
 * Never throws: a failure anywhere leaves the verdict standing with `known: false`.
 */
export async function rememberCheck(d: CheckDevice, payee: string, paymentId: string): Promise<CheckMemory> {
  const me = d.device.toLowerCase()
  const locator = checkLocator(payee, paymentId)
  const now = d.now()
  const own = readList(d.store, ownKey(me), isOwn)
  const mineHere = own.filter((c) => c.locator === locator)
  const sameCheck = mineHere.some((c) => now - c.at < SAME_CHECK_SECONDS && c.at <= now)
  // This device's own earlier checks, even with the cache down. Excludes the check in progress.
  const fromHere: KnownCheck[] = mineHere.filter((c) => now - c.at >= SAME_CHECK_SECONDS).map((c) => ({ at: c.at, device: me }))

  void flushCheckOutbox(d)

  let fromCache: KnownCheck[] = []
  let known = true
  try {
    const events = await d.query({ kinds: [CHECK_KIND], tags: { '#x': [locator] }, limit: 500 })
    fromCache = readChecks(events, payee, paymentId, d.roster?.keys, now)
  } catch {
    known = false
  }

  // One list, one entry per (device, second): the cache also returns this device's own events.
  const merged = new Map<string, KnownCheck>()
  for (const c of [...fromHere, ...fromCache]) {
    if (c.device.toLowerCase() === me && now - c.at < SAME_CHECK_SECONDS) continue
    merged.set(`${c.device.toLowerCase()}:${c.at}`, c)
  }
  const prior = labelChecks(
    [...merged.values()].sort((a, b) => a.at - b.at),
    { device: me, payee, ...(d.roster ? { nameOf: d.roster.nameOf } : {}) },
  )

  let record: CheckMemory['record'] = null
  if (!sameCheck) {
    writeList(d.store, ownKey(me), [...own, { locator, at: now }])
    try {
      const e = buildCheckEvent({ payee, paymentId, at: now, ...(d.terminal ? { terminal: d.terminal } : {}) }, d.withKey)
      const sent = await d.publish(e).catch(() => false)
      if (!sent) writeList(d.store, outboxKey(me), [...readList(d.store, outboxKey(me), isEvent), e])
      record = sent ? 'published' : 'deferred'
    } catch {
      record = 'deferred'
    }
  }
  return { prior, known, record }
}
