import {
  createBundleReceiptStore,
  type BundleReceiptRecord,
  type BundleReceiptStorageAdapter,
  type BundleReceiptStore,
} from '@imani/nostr-transactions'

import { createAccountStore } from './accountStore'
import { MISMATCH_NOTE, vouchers } from './bundleWording'
import { displayDecimals, formatFace } from './format'

/**
 * One multi-coupon payment, told as one payment (#94).
 *
 * A €6 send drawn from €3 + €3 coupons travels as two independent parts, each
 * its own gift wrap and redemption. Before this, each part announced itself, so
 * the recipient saw two "€3.00 received" toasts and two bell rows and had no
 * way to tell whether that was everything the sender meant to send.
 *
 * The sender already declares, on every part, the bundle it belongs to: its id,
 * the total, this part's index and the part count. This module keeps the two
 * kinds of number apart, which is the whole design:
 *
 *   - DECLARED (`declaredTotal`, `declaredCount`) is what the sender says the
 *     bundle holds. Sender-written and unverified, so it is only ever shown as
 *     "expected" and never books, caps or settles anything. Nothing here
 *     touches the ledger; the rows dm-poll writes are exactly what they were.
 *   - RECEIVED (`receivedTotal`, `receivedCount`) is the sum of parts that
 *     actually redeemed, at the same face value the arrival toast already
 *     trusts.
 *
 * Aggregation is `BundleReceiptStore`'s, not re-implemented: dedup by part
 * index, first declaration wins, author mismatch rejected, a wait window after
 * which an unfinished bundle is INCOMPLETE. It runs display-only here (no
 * TransactionStore), because the wallet's ledger already has one row per part
 * and a second, declaration-derived row would be the thing trust rule 1 forbids.
 */

/**
 * How long a bundle waits for its missing parts before saying so.
 *
 * NOT the store's 90 s. A rate-limited part legitimately waits out the
 * gateway's one-minute window, possibly twice (`RATE_LIMIT_BACKOFFS_MS` in
 * dmPoll sums to 155 s), and calling a queued coupon "has not arrived" is the
 * wallet crying wolf about its own limiter — the exact thing queuedToast.ts
 * exists to avoid.
 *
 * #110 put pacing in front of that retry (receivePacer.ts), counted per CALL
 * and shared with burns (acks are exempt from the gateway limit since
 * imani-gateway-customer#120). `worstCaseBundleMs` counts every call an
 * 8-part bundle can make through the pacer at its per-token caps, assumes a
 * full window on arrival, and adds every retry sleep and a two-minute margin:
 * about 13 minutes. Fifteen minutes outlasts it. Deliberately pessimistic: a
 * part is only called missing once the wallet can no longer be the reason it
 * is late. A test pins the relationship.
 */
export const BUNDLE_WAIT_WINDOW_MS = 900_000

/** Bundles kept per account. Far above anything a person has in flight. */
const MAX_BUNDLES = 50

const BUNDLE_ID = /^[0-9a-f]{32}$/


/** What one redeemed part tells the tracker. */
export interface ArrivedPart {
  bundleId: string
  /** Declared by the sender. Display only. */
  declaredTotal: number
  declaredCount: number
  partIndex: number
  /** The trusted figure: what the arrival toast shows for this part. */
  amount: number
  unit: string
  decimals?: number
  /** Who the wallet credits the payment to. Checked for consistency across parts. */
  senderPubkey: string
  /** The gift wrap, for the store's secondary dedup key. */
  eventId?: string
}

export type BundleState = 'in_flight' | 'complete' | 'incomplete'

/** A bundle as the notification surfaces see it. */
export interface BundleView {
  bundleId: string
  senderPubkey: string
  unit: string
  decimals: number
  declaredTotal: number
  declaredCount: number
  receivedTotal: number
  receivedCount: number
  state: BundleState
  /** Parts disagreed about the declaration, the sender, or the currency. */
  mismatch: boolean
}

export type TrackResult =
  | { kind: 'bundle'; view: BundleView; previous: BundleState | undefined }
  /**
   * Announce this part on its own, as before #94. Either it cannot belong to
   * the bundle (another sender, another currency, a part index already
   * filled by different money) or the declaration was unusable. Money that
   * arrived is never folded out of sight.
   */
  | { kind: 'standalone'; reason: string; view?: BundleView }
  /**
   * The same gift wrap again (an SSE reconnect re-reading a window it saw).
   * Already counted and already announced: say nothing.
   */
  | { kind: 'repeat'; view: BundleView }

/* ------------------------------------------------------------------------ */
/* Storage: per account, bounded, synchronous under an async face.          */
/* ------------------------------------------------------------------------ */

const records = createAccountStore<BundleReceiptRecord>({
  name: 'bundle-arrivals',
  limit: MAX_BUNDLES,
  idOf: (r) => r.bundleId,
  // An old finished bundle is the cheapest thing to forget.
  ageOf: (r) => Date.parse(r.createdAt) || 0,
  isValid: (r): r is BundleReceiptRecord =>
    !!r && typeof r === 'object' && typeof (r as BundleReceiptRecord).bundleId === 'string',
})

const storage: BundleReceiptStorageAdapter = {
  async get(userId, bundleId) {
    return records.get(userId, bundleId) ?? null
  },
  async upsert(record) {
    records.put(record.userId, record)
    return record
  },
  async listAll(userId) {
    return records.list(userId)
  },
}

const store: BundleReceiptStore = createBundleReceiptStore({
  storage,
  waitWindowMs: BUNDLE_WAIT_WINDOW_MS,
})

/**
 * One operation at a time.
 *
 * The store reads, decides, then writes, with awaits between. Two parts
 * redeemed back to back would otherwise both read "no bundle yet" and the
 * second would overwrite the first — losing a part from the count, which is
 * the one error this module must not make.
 */
let queue: Promise<unknown> = Promise.resolve()
/**
 * Bumped on logout or an account switch. Work queued before the bump is
 * dropped rather than run, so a part still in the queue cannot write the
 * previous account's bundle back into storage after logout wiped it.
 */
let epoch = 0
function serial<T>(fn: () => Promise<T>, dropped: T): Promise<T> {
  const queuedAt = epoch
  const guarded = () => (queuedAt === epoch ? fn() : Promise.resolve(dropped))
  const run = queue.then(guarded, guarded)
  queue = run.catch(() => undefined)
  return run
}

/** Drop every queued operation. Called when the account's session ends. */
export function stopBundleTracking(): void {
  epoch += 1
}

/** The current epoch, so a caller can tell its session ended mid-await. */
export function bundleEpoch(): number {
  return epoch
}

/* ------------------------------------------------------------------------ */
/* Tracking                                                                  */
/* ------------------------------------------------------------------------ */

export function isBundleId(value: unknown): value is string {
  return typeof value === 'string' && BUNDLE_ID.test(value)
}

function toView(record: BundleReceiptRecord): BundleView {
  const unit = record.faceUnit ?? ''
  return {
    bundleId: record.bundleId,
    senderPubkey: record.senderPubkeyHex,
    unit,
    decimals: displayDecimals(unit, record.faceDecimals),
    declaredTotal: record.declaredTotal,
    declaredCount: record.declaredPartCount,
    receivedTotal: record.receivedAmount,
    receivedCount: record.receivedParts.length,
    state:
      record.state === 'IN_FLIGHT'
        ? 'in_flight'
        : record.state === 'INCOMPLETE'
          ? 'incomplete'
          : 'complete',
    mismatch: record.disagreements.length > 0,
  }
}

async function flag(record: BundleReceiptRecord, partIndex: number, field: 'faceUnit', value: string) {
  record.disagreements.push({
    bundlePartId: `${record.bundleId}:${partIndex}`,
    field,
    claimedValue: value.slice(0, 64),
    recordedAt: new Date().toISOString(),
  })
  await storage.upsert(record)
}

/**
 * File one redeemed part against its bundle.
 *
 * Never throws: it runs after the money has landed, and a display tracker that
 * failed must not turn a redemption into a reported error. A failure reads as
 * `standalone`, which is exactly today's behaviour.
 */
export function trackArrival(recipientPubkey: string, part: ArrivedPart): Promise<TrackResult> {
  return serial(async (): Promise<TrackResult> => {
    try {
      if (!isBundleId(part.bundleId)) return { kind: 'standalone', reason: 'bundle_id' }

      const before = await store.get(recipientPubkey, part.bundleId)

      // The store sums whatever it is handed, currency or not. Two units in one
      // bundle cannot be one figure, so the odd one out is announced alone.
      if (before && (before.faceUnit ?? '') !== part.unit) {
        await flag(before, part.partIndex, 'faceUnit', part.unit)
        return { kind: 'standalone', reason: 'unit_mismatch', view: toView(before) }
      }

      const directive = await store.ingest({
        userId: recipientPubkey,
        receivedAt: new Date(),
        senderPubkeyHex: part.senderPubkey,
        giftWrapEventId: part.eventId ?? '',
        partAmount: part.amount,
        bundle: {
          bundleId: part.bundleId,
          bundleTotal: part.declaredTotal,
          bundlePartIndex: part.partIndex,
          bundlePartCount: part.declaredCount,
          bundlePartId: `${part.bundleId}:${part.partIndex}`,
        },
        faceUnit: part.unit,
        faceDecimals: part.decimals,
      })

      const after = await store.get(recipientPubkey, part.bundleId)
      switch (directive.kind) {
        case 'BUNDLE_PART_INGESTED':
          if (!after) return { kind: 'standalone', reason: 'not_stored' }
          return { kind: 'bundle', view: toView(after), previous: before ? toView(before).state : undefined }
        case 'BUNDLE_REJECTED_AUTHOR_MISMATCH':
          return { kind: 'standalone', reason: 'author_mismatch', view: after ? toView(after) : undefined }
        case 'BUNDLE_PART_DUPLICATE':
          if (!after) return { kind: 'standalone', reason: 'not_stored' }
          // The same wrap processed twice is one part, counted once. Without an
          // event id on either side there is nothing to tell them apart by, and
          // the ledger row is what it is either way, so it is treated the same.
          if (isSameDelivery(after, part)) return { kind: 'repeat', view: toView(after) }
          // A DIFFERENT delivery claiming an index already filled: real money,
          // shown on its own, and not counted towards a declaration it
          // contradicts.
          await flagDuplicate(after, part.partIndex)
          return { kind: 'standalone', reason: 'duplicate_index', view: toView(after) }
        default:
          return { kind: 'standalone', reason: directive.reason ?? 'declaration' }
      }
    } catch (e) {
      console.warn('[bundle] could not track a bundle part:', e)
      return { kind: 'standalone', reason: 'error' }
    }
  }, { kind: 'standalone', reason: 'stopped' })
}

async function flagDuplicate(record: BundleReceiptRecord, partIndex: number) {
  record.disagreements.push({
    bundlePartId: `${record.bundleId}:${partIndex}`,
    field: 'declaredPartCount',
    claimedValue: `duplicate index ${partIndex}`,
    recordedAt: new Date().toISOString(),
  })
  await storage.upsert(record)
}

function isSameDelivery(record: BundleReceiptRecord, part: ArrivedPart): boolean {
  const existing = record.receivedParts.find((p) => p.bundlePartIndex === part.partIndex)
  if (!existing) return false
  // Only a matching gift-wrap id proves it is the same delivery. Without one
  // on both sides it is announced on its own: a duplicate toast is a
  // nuisance, a coupon hidden as a "repeat" is money the user never hears of.
  return !!existing.eventId && existing.eventId === part.eventId
}

/** The current view of one bundle, if the account has it. */
export function bundleView(recipientPubkey: string, bundleId: string): Promise<BundleView | undefined> {
  return serial(async () => {
    const record = await store.get(recipientPubkey, bundleId)
    return record ? toView(record) : undefined
  }, undefined)
}

/**
 * Close out bundles whose wait window has passed. Returns the ones that
 * changed state, so the caller can say so once.
 */
export function reconcileBundles(recipientPubkey: string, now = new Date()): Promise<BundleView[]> {
  return serial(async () => {
    try {
      const results = await store.reconcileExpired(recipientPubkey, now)
      const views: BundleView[] = []
      for (const r of results) {
        const record = await store.get(recipientPubkey, r.bundleId)
        if (record) views.push(toView(record))
      }
      return views
    } catch (e) {
      console.warn('[bundle] could not reconcile bundles:', e)
      return []
    }
  }, [])
}

/** Bundles still waiting on parts, with when their window closes (epoch ms). */
export function openBundles(recipientPubkey: string): Array<{ bundleId: string; expiresAt: number }> {
  return records.list(recipientPubkey)
    .filter((r) => r.state === 'IN_FLIGHT')
    .map((r) => ({ bundleId: r.bundleId, expiresAt: Date.parse(r.waitWindowExpiresAt) }))
    .filter((r) => Number.isFinite(r.expiresAt))
}

/** When this bundle's window closes, if it is still open. */
export function bundleExpiresAt(recipientPubkey: string, bundleId: string): number | undefined {
  return openBundles(recipientPubkey).find((b) => b.bundleId === bundleId)?.expiresAt
}

/* ------------------------------------------------------------------------ */
/* Wording                                                                   */
/* ------------------------------------------------------------------------ */


export interface BundleWording {
  /** The figure beside the sender's name: received, with the expected total when short. */
  amount: string
  /** The line under it: progress against the declaration. */
  progress: string
  /** The bell body, which has no room for a name and no second line. */
  body: string
  /** Settled one way or the other: worth a fresh badge. */
  settled: boolean
}

/**
 * Say where a bundle stands, keeping declared and received apart.
 *
 * Received is always the headline figure — it is the money that is actually
 * in the balance. The declared total only ever appears as "of" or "expected",
 * and when more arrived than was declared the received figure is still shown
 * in full (trust rule 3: never cap or hide money that arrived).
 */
export function describeBundle(view: BundleView, opts: { queued?: number } = {}): BundleWording {
  const fmt = (n: number) => formatFace(n, { unit: view.unit, decimals: view.decimals })
  const received = fmt(view.receivedTotal)
  const declared = fmt(view.declaredTotal)
  const over = view.receivedTotal > view.declaredTotal || view.receivedCount > view.declaredCount
  const short = view.receivedTotal < view.declaredTotal
  const missing = Math.max(0, view.declaredCount - view.receivedCount)
  const caveat = view.mismatch ? ` ${MISMATCH_NOTE}` : ''

  if (over) {
    return {
      amount: received,
      progress: `More than the ${declared} expected`,
      body: `${received} received, more than the ${declared} the sender declared (${vouchers(view.receivedCount)}).${caveat}`,
      settled: view.state !== 'in_flight',
    }
  }

  // #552: a bundle is one payment, counted only once every declared part is in. Until then it
  // reads as on its way: the gateway publishes parts only after it has decided to deliver all of
  // them, so a missing part is late, never stopped.
  if (view.state === 'in_flight' || (view.state === 'incomplete' && missing > 0 && !over)) {
    const queued = opts.queued ?? 0
    const progress =
      queued > 0
        ? `${view.receivedCount} of ${view.declaredCount} in — ${queued} still receiving`
        : `${view.receivedCount} of ${view.declaredCount} vouchers so far`
    return {
      amount: `${declared} on its way`,
      progress,
      body: `${declared} on its way (${view.receivedCount} of ${view.declaredCount} vouchers in).${caveat}`,
      settled: false,
    }
  }

  if (!short) {
    return {
      amount: received,
      progress: vouchers(view.receivedCount),
      body: `${received} received (${vouchers(view.receivedCount)}).${caveat}`,
      settled: true,
    }
  }

  // Finished short: either the window closed with parts missing, or every
  // declared part came and they still add up to less than was declared.
  const why =
    missing > 0
      ? `${vouchers(missing)} ${missing === 1 ? 'has' : 'have'} not arrived.`
      : `All ${vouchers(view.declaredCount)} arrived, but add up to less.`
  return {
    amount: `${received} of ${declared}`,
    progress: missing > 0 ? `${vouchers(missing)} not arrived` : 'Less than expected',
    body: `${received} of an expected ${declared} received. ${why}${caveat}`,
    settled: true,
  }
}

/** Test seam: forget every bundle for an account and drop the queue. */
export function _resetBundleArrivalsForTests(pubkey?: string): void {
  queue = Promise.resolve()
  epoch = 0
  if (pubkey) {
    try {
      localStorage.removeItem(`imani-wallet:bundle-arrivals:${pubkey}`)
    } catch {
      /* nothing to clear */
    }
  }
}
