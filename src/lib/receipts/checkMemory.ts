/**
 * Spec 049 FR-027a-e: remember this device's receipt check and recall the earlier ones.
 *
 * The rules (who counts, who is named) are `checks.ts`; this is the state around them, with every
 * dependency passed in so the tests need no relay, gateway or storage:
 *
 * 1. Read the payment's checks from the gateway cache (reads never go to a relay), every page of
 *    them, plus this device's own record, so a till that is offline still knows what IT checked.
 * 2. Publish this check. Unsent ones wait in an outbox and go out on the next check, when the
 *    device comes back online, and when the app opens (`flushCheckOutbox`).
 * 3. Answer with the earlier checks, labelled for the viewer, and whether the history is known:
 *    `known: false` means "could not see other devices", never "first check".
 *
 * Anyone holding a receipt can compute its locator and file junk under it. Junk never counts
 * (`readChecks`), and it cannot push real checks out of view: every page is read, and past
 * `MAX_EVENTS` the history is reported unknown rather than first.
 *
 * A check made seconds ago by this same device (a re-render, a double tap) is not a new check,
 * and is not shown as an earlier one either.
 */
import type { Event } from 'nostr-tools'

import { CHECK_KIND, MAX_LOCAL, buildCheckEvent, checkLocator, labelChecks, readChecks, type KnownCheck, type PriorCheck, type RosterView, type TerminalProof } from './checks'

/** Seconds within which this device's own check is the same check, not a repeat. */
export const SAME_CHECK_SECONDS = 15
/** One gateway page. */
export const PAGE = 500
/** Past this many events under one locator the history is not trusted: reported unknown. */
export const MAX_EVENTS = 4000

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
  /** Owner side: its tills (with revocation times) and their names. Absent on a till (FR-027e). */
  roster?: RosterView & { nameOf: (terminalPubkey: string) => string }
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
  /** False when the history could not be read whole: other devices' checks are unknown. */
  known: boolean
  /** What happened to this check's record, or null when it was the same check as a moment ago. */
  record: 'published' | 'deferred' | null
}

const ownKey = (device: string) => `imani:receipt-checks:${device.toLowerCase()}`
const outboxKey = (device: string) => `imani:receipt-check-outbox:${device.toLowerCase()}`
const DEVICE_ID_KEY = 'imani:receipt-check-device'

/** A random id for this install, so the owner's phone and laptop are told apart. */
export function installId(store: KeyValueStore): string {
  try {
    const have = store.getItem(DEVICE_ID_KEY)
    if (have && /^[0-9a-f]{32}$/.test(have)) return have
  } catch {
    // fall through to a fresh one
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  const id = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  try {
    store.setItem(DEVICE_ID_KEY, id)
  } catch {
    // An id that is not kept only means this install's checks read as "another device" later.
  }
  return id
}

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
  /** The event that carried it, once built: the cache returns the same event, deduped by it. */
  id?: string
}
const isOwn = (x: unknown): x is OwnCheck =>
  !!x && typeof (x as OwnCheck).locator === 'string' && Number.isFinite((x as OwnCheck).at)
const isEvent = (x: unknown): x is Event =>
  !!x && typeof (x as Event).id === 'string' && typeof (x as Event).sig === 'string' && Array.isArray((x as Event).tags)

const flushing = new Map<string, Promise<number>>()

/** Send what the outbox holds. Returns how many are still waiting. Never throws. One at a time per device. */
export function flushCheckOutbox(d: Pick<CheckDevice, 'device' | 'publish' | 'store'>): Promise<number> {
  const key = d.device.toLowerCase()
  const running = flushing.get(key)
  if (running) return running
  const run = (async () => {
    const waiting = readList(d.store, outboxKey(key), isEvent)
    if (waiting.length === 0) return 0
    const sent = new Set<string>()
    for (const e of waiting) {
      if (await d.publish(e).catch(() => false)) sent.add(e.id)
    }
    // Re-read: a check queued while this flush ran must not be overwritten.
    const still = readList(d.store, outboxKey(key), isEvent).filter((e) => !sent.has(e.id))
    writeList(d.store, outboxKey(key), still)
    return still.length
  })().finally(() => flushing.delete(key))
  flushing.set(key, run)
  return run
}

/** Every event under the locator, page by page. Throws when the cache did not answer or the set is too large. */
async function allUnder(d: CheckDevice, locator: string): Promise<Event[]> {
  const seen = new Map<string, Event>()
  let until: number | undefined
  for (;;) {
    const page = await d.query({ kinds: [CHECK_KIND], tags: { '#x': [locator] }, limit: PAGE, ...(until === undefined ? {} : { until }) })
    let fresh = 0
    for (const e of page) {
      if (!seen.has(e.id)) {
        seen.set(e.id, e)
        fresh++
      }
    }
    if (seen.size > MAX_EVENTS) throw new Error('too many events under one locator')
    if (page.length < PAGE) break
    // A full page with nothing new: more events share one second than a page holds, so the rest
    // cannot be paged to. Say unknown rather than present what was seen as the whole history.
    if (fresh === 0) throw new Error('cannot page past one second')
    until = Math.min(...page.map((e) => e.created_at))
  }
  return [...seen.values()]
}

/**
 * Record this device's check of a payment paid to `payee`, and say what was known before it.
 * Never throws: a failure anywhere leaves the verdict standing with `known: false`.
 *
 * @param paidAt the payment's own date (epoch seconds), so a check dated before it is ignored
 */
export async function rememberCheck(d: CheckDevice, payee: string, paymentId: string, paidAt?: number): Promise<CheckMemory> {
  const me = d.device.toLowerCase()
  const deviceId = installId(d.store)
  const locator = checkLocator(payee, paymentId)
  const now = d.now()
  const near = (at: number) => Math.abs(now - at) < SAME_CHECK_SECONDS

  // Decide "same check" and claim this one BEFORE any await, so two overlapping calls (a re-render,
  // a double scan) cannot both publish.
  const own = readList(d.store, ownKey(me), isOwn)
  const mineHere = own.filter((c) => c.locator === locator)
  const sameCheck = mineHere.some((c) => near(c.at))
  const claimed: OwnCheck = { locator, at: now }
  if (!sameCheck) writeList(d.store, ownKey(me), [...own, claimed])

  void flushCheckOutbox(d)

  let fromCache: KnownCheck[] = []
  let known = true
  try {
    fromCache = readChecks(await allUnder(d, locator), payee, paymentId, { ...(d.roster ? { roster: d.roster } : {}), now, ...(paidAt ? { paidAt } : {}) })
  } catch {
    known = false
  }

  // This install's own earlier checks, even with the cache down; the cache's copy wins by event id.
  const cacheIds = new Set(fromCache.map((c) => c.id))
  const fromHere: KnownCheck[] = mineHere
    .filter((c) => !near(c.at) && !(c.id && cacheIds.has(c.id)))
    .map((c) => ({ id: c.id ?? `local:${c.at}`, at: c.at, device: me, deviceId }))
  const earlier = [...fromCache.filter((c) => !(c.device === me && c.deviceId === deviceId && near(c.at))), ...fromHere]
  const prior = labelChecks(
    earlier.sort((a, b) => a.at - b.at),
    { device: me, deviceId, payee, ...(d.roster ? { nameOf: d.roster.nameOf } : {}) },
  )

  let record: CheckMemory['record'] = null
  if (!sameCheck) {
    try {
      const e = buildCheckEvent({ payee, paymentId, at: now, device: me, deviceId, ...(d.terminal ? { terminal: d.terminal } : {}) }, d.withKey)
      writeList(
        d.store,
        ownKey(me),
        readList(d.store, ownKey(me), isOwn).map((c) => (c.locator === locator && c.at === now && !c.id ? { ...c, id: e.id } : c)),
      )
      const sent = await d.publish(e).catch(() => false)
      if (!sent) writeList(d.store, outboxKey(me), [...readList(d.store, outboxKey(me), isEvent), e])
      record = sent ? 'published' : 'deferred'
    } catch {
      record = 'deferred'
    }
  }
  return { prior, known, record }
}
