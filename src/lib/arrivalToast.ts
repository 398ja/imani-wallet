import { createElement } from 'react'
import { toast } from 'sonner'

import { ReceivedPaymentToast } from '../components/ui/IncomingPaymentToast'
import { createBoundedSet } from './boundedSet'
import {
  bundleEpoch,
  describeBundle,
  isBundleId,
  openBundles,
  reconcileBundles,
  stopBundleTracking,
  trackArrival,
  type BundleView,
} from './bundleArrival'
import { displayDecimals, formatFace } from './format'
import { recordNotification, upsertNotification } from './notifications/inbox'
import { wantsInApp } from './notifications/wants'
import { onBundleQueueChange, queuedInBundle } from './queuedToast'

/**
 * The toast that fires when a coupon has ACTUALLY arrived.
 *
 * The wallet already had an incoming-payment toast, but it only ever fired from
 * one place: the Artemis advance-notice queue, which is fed by exactly one
 * caller — `AtomicSendService.processDmDelivery`, the atomic-send saga. Every
 * other way a coupon can reach someone announced nothing at all. A payment that
 * arrived over the ordinary NIP-17 gift-wrap path, which is how the merchant
 * flows and the legacy bridge deliver, was silently redeemed: the balance moved
 * and a row appeared in history, but nothing on screen said so. That is the
 * "valverde got no toast for simon's 4 FCFA" report, and no amount of fixing the
 * queue would have produced one, because no envelope was ever enqueued.
 *
 * So settlement announces itself, from dm-poll's redemption path, where the
 * money demonstrably landed. This is the complement of the advance notice, not a
 * replacement:
 *
 *   - advance notice ("on its way") is optimistic, may never be followed by
 *     settlement, and is best-effort by design.
 *   - this one ("received") is the truth, and fires for every arrival however it
 *     was delivered.
 *
 * When both fire for the same payment the user sees the pending toast and then
 * the confirmation, which is the intended pair. When only one can fire — the
 * common case for non-atomic-send deliveries — it is this one, which is the
 * important half.
 *
 * De-duplicated on the voucher id, because dm-poll can legitimately process the
 * same gift wrap twice (an SSE reconnect re-queries a window it already saw) and
 * a second announcement of one payment reads as a second payment.
 */

/** Voucher ids already announced. Shared bounded-set policy; see boundedSet.ts. */
const announced = createBoundedSet(200)

export interface ArrivedVoucher {
  voucher_id?: string
  face_value?: number
  face_unit?: string
  face_decimals?: number
  sender_pubkey?: string
  memo?: string
}

/**
 * Announce an arrival. Safe to call for anything dm-poll redeemed; it decides
 * whether there is something worth showing.
 *
 * Never throws. It is called from inside the redemption path, and a toast that
 * failed to render must not turn a successful redemption into a failed one —
 * that would burn the proofs and then report an error, which is the worst
 * outcome available here.
 *
 * `recipientPubkey` is the wallet this landed in — our own key, not the
 * sender's. It is what scopes the inbox row and the preference lookup, both of
 * which are per-account. Optional so a caller with no identity to hand (tests,
 * and any path that runs before the session is established) still gets the
 * toast; without it the bell is skipped, because there is no inbox to write to.
 */
export function announceArrival(
  voucher: ArrivedVoucher | undefined,
  recipientPubkey?: string,
): void {
  try {
    if (!voucher) return

    // The user's own switch, honoured on the in-app surfaces for the first
    // time here. Checked BEFORE the dedupe set is touched: marking an
    // announcement that never happened would suppress the real one if the
    // preference were turned back on mid-session.
    if (!wantsInApp(recipientPubkey, 'voucher_received')) return

    // Keyed on the voucher id where there is one. Without it there is no stable
    // identity to dedupe on, and announcing is still better than silence — a
    // duplicate toast is a nuisance, a missed payment is the bug being fixed.
    const key = voucher.voucher_id
    if (key) {
      // add() returns false when it has seen this id, so eviction policy
      // lives in one place rather than being restated per call site.
      if (!announced.add(key)) return
    }

    /*
     * The currency decides the decimals, NOT the stored row.
     *
     * The gateway stamps `face_decimals: 2` on every currency regardless of unit
     * (recorded as §15.9 of the retired design spec, now in git history only).
     * XAF is a zero-decimal currency, so the first
     * version of this toast announced a real 4 XAF coupon as "FCFA 0.04" while
     * the balance card beside it read "FCFA 4" — caught on staging, against a
     * genuinely-issued coupon whose row does carry `face_decimals: 2`.
     *
     * `displayDecimals` is the wallet's single answer to this question, shared
     * with the coupon list, the history statement and the wallet pass, so a
     * pre-DEV-238 row renders the same everywhere instead of each screen
     * picking its own fallback. It asks Intl (which knows XAF and JPY take
     * none) and keeps the row's value only for a merchant's own non-ISO unit.
     */
    const unit = voucher.face_unit ?? ''
    const decimals = displayDecimals(unit, voucher.face_decimals)
    const amount = formatFace(voucher.face_value ?? 0, { unit, decimals })

    toast.success(
      createElement(ReceivedPaymentToast, {
        pubkey: voucher.sender_pubkey,
        amount,
        memo: voucher.memo,
      }),
      {
        // Namespaced away from the pending toast's `pending-` ids so the two
        // never collapse onto each other: they are different statements about
        // the same payment and the user should see both.
        id: key ? 'received-' + key : undefined,
        // The tick is right here, unlike on the pending toast: the money has
        // landed. It comes from the Toaster's own success icon.
        duration: 6000,
      },
    )

    /*
     * And the same fact in the bell, which is the half that survives.
     *
     * The toast is gone in six seconds. Until this, settlement left NOTHING
     * behind: the advance-notice drain wrote an inbox row for "payment on its
     * way", and the arrival that actually moved the money wrote none — so a
     * recipient who looked away saw one notification for a payment that had
     * two events, and the one they kept was the optimistic one. That is the
     * "B only gets the first notification" report.
     *
     * Namespaced `arrival:` so it cannot collide with the advance notice's
     * `notificationId`, which is a different statement about the same payment
     * and must remain its own line.
     *
     * Only with a voucher id: `recordNotification` dedupes on id, and a
     * synthesised one would file a fresh row on every redelivery.
     */
    if (recipientPubkey && key) {
      recordNotification(recipientPubkey, {
        id: 'arrival:' + key,
        type: 'voucher_received',
        title: 'Payment received',
        body: voucher.memo ? `${amount} received — ${voucher.memo}` : `${amount} received.`,
        // The coupon list, where the thing that arrived actually is. The
        // advance notice points at `/` because at that point there is nothing
        // to look at yet; by now there is.
        url: '/receive',
      })
    }
  } catch (e) {
    console.warn('[arrival] could not announce a received coupon:', e)
  }
}

/** Test seam: forget what has been announced. */
export function resetAnnounced(): void {
  announced.clear()
  live.clear()
  for (const timer of timers.values()) clearTimeout(timer)
  timers.clear()
}

/* ------------------------------------------------------------------------ */
/* One payment in several coupons (#94)                                      */
/* ------------------------------------------------------------------------ */

/** What the sender declared about the bundle this coupon belongs to. */
export interface DeclaredBundle {
  bundleId?: string
  /** Sender-written. Display only, never money. */
  total?: number
  index?: number
  count?: number
}

/**
 * Bundles with a toast on screen this session, so a queued part or a closing
 * window can redraw the same toast in place. Keyed by bundle id.
 */
const live = new Map<string, { view: BundleView; recipient?: string; memo?: string }>()

/** Wait-window timers, one per open bundle. */
const timers = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * Announce a coupon that may be one part of a multi-coupon payment.
 *
 * With no usable declaration this is `announceArrival`, unchanged: a single
 * coupon, or a sender that does not speak the bundle fields, behaves exactly
 * as before. With one, every part of the bundle updates ONE toast and ONE bell
 * row, showing what has arrived against what the sender said was coming.
 *
 * Never rejects, for the same reason `announceArrival` never throws.
 */
export async function announceBundleArrival(
  voucher: ArrivedVoucher | undefined,
  declared: DeclaredBundle | undefined,
  recipientPubkey?: string,
  deliveryEventId?: string,
): Promise<void> {
  try {
    if (
      !voucher ||
      !recipientPubkey ||
      !declared ||
      !isBundleId(declared.bundleId) ||
      declared.total === undefined ||
      declared.index === undefined ||
      declared.count === undefined ||
      // A one-part "bundle" is a single coupon: nothing to aggregate.
      declared.count < 2
    ) {
      announceArrival(voucher, recipientPubkey)
      return
    }
    if (!wantsInApp(recipientPubkey, 'voucher_received')) return

    const unit = voucher.face_unit ?? ''
    const session = bundleEpoch()
    const result = await trackArrival(recipientPubkey, {
      bundleId: declared.bundleId,
      declaredTotal: declared.total,
      declaredCount: declared.count,
      partIndex: declared.index,
      amount: Number(voucher.face_value ?? 0),
      unit,
      decimals: voucher.face_decimals,
      senderPubkey: voucher.sender_pubkey ?? '',
      eventId: deliveryEventId,
    })

    // The account logged out while this part was being counted.
    if (session !== bundleEpoch()) return
    if (result.kind === 'repeat') return
    if (result.kind === 'standalone') {
      // Money that could not be counted towards the bundle is still money:
      // announced on its own, exactly as it would have been before #94.
      announceArrival(voucher, recipientPubkey)
      // And if it was turned away because it contradicted the bundle, the
      // bundle's own line now carries the caveat.
      if (result.view && live.has(result.view.bundleId)) {
        renderBundle(result.view, recipientPubkey, live.get(result.view.bundleId)?.memo, false)
      }
      return
    }

    // Counted. The voucher id joins the announced set so a later standalone
    // path (a re-read without the bundle fields) cannot announce it again.
    if (voucher.voucher_id) announced.add(voucher.voucher_id)
    const memo = voucher.memo ?? live.get(result.view.bundleId)?.memo
    const settledNow = result.view.state !== 'in_flight' && result.previous !== result.view.state
    renderBundle(result.view, recipientPubkey, memo, settledNow)
    if (result.view.state === 'in_flight') schedule(recipientPubkey, result.view.bundleId)
    else unschedule(result.view.bundleId)
  } catch (e) {
    console.warn('[arrival] could not announce a bundle part:', e)
  }
}

/**
 * Draw the one toast and the one bell row for a bundle. `reopen` puts the bell
 * row back to unread, for the transitions worth a second look.
 */
function renderBundle(
  view: BundleView,
  recipientPubkey: string | undefined,
  memo: string | undefined,
  reopen: boolean,
  opts: { toast?: boolean } = {},
): void {
  const queued = queuedInBundle(view.bundleId)
  const words = describeBundle(view, { queued })
  const open = view.state === 'in_flight'

  if (open) live.set(view.bundleId, { view, recipient: recipientPubkey, memo })
  else live.delete(view.bundleId)

  const message = createElement(ReceivedPaymentToast, {
    pubkey: view.senderPubkey || undefined,
    amount: words.amount,
    memo,
    progress: words.progress,
    settledLine: open
      ? view.receivedCount === 0
        ? 'Nothing has arrived yet — your coupon is safe.'
        : 'What has arrived is in your balance.'
      : view.state === 'incomplete'
        ? 'What arrived is in your balance.'
        : undefined,
  })
  const options = {
    // One id for the whole bundle, so each part redraws the same toast.
    // Namespaced away from the per-coupon `received-<voucher>` ids.
    id: 'received-bundle-' + view.bundleId,
    // Held open while a part is waiting out the limiter, for the reason
    // queuedToast gives: a status that vanishes leaves the guessing it was
    // raised to end. Otherwise it times out like any arrival.
    duration: open && queued > 0 ? Infinity : 6000,
  }
  if (opts.toast !== false) {
    // A shortfall is status, not an error (the money that came is safe), so
    // it wears the neutral toast rather than the success tick or a warning.
    if (view.state === 'incomplete') toast(message, options)
    else toast.success(message, options)
  }

  if (recipientPubkey) {
    upsertNotification(
      recipientPubkey,
      {
        id: 'arrival:bundle:' + view.bundleId,
        type: 'voucher_received',
        title: view.state === 'incomplete' ? 'Payment partly received' : 'Payment received',
        body: memo ? `${words.body} — ${memo}` : words.body,
        url: '/receive',
      },
      { reopen },
    )
  }
}

/** Arm the wait-window timer for an open bundle, once. */
function schedule(recipientPubkey: string, bundleId: string, expiresAt?: number): void {
  if (timers.has(bundleId)) return
  const due = expiresAt ?? openBundles(recipientPubkey).find((b) => b.bundleId === bundleId)?.expiresAt
  if (due === undefined) return
  const timer = setTimeout(() => {
    timers.delete(bundleId)
    void closeExpired(recipientPubkey)
  }, Math.max(0, due - Date.now()) + 50)
  timers.set(bundleId, timer)
}

function unschedule(bundleId: string): void {
  const timer = timers.get(bundleId)
  if (timer) clearTimeout(timer)
  timers.delete(bundleId)
}

/**
 * How long after a window closed its outcome is still news. A bundle that ran
 * out while the app was shut for a day is recorded in the bell, not popped up
 * over whatever the user opened the app to do.
 */
const STALE_CLOSE_MS = 10 * 60 * 1000

/** Settle every bundle whose window has closed, and say how each ended. */
async function closeExpired(recipientPubkey: string): Promise<void> {
  try {
    const session = bundleEpoch()
    const now = Date.now()
    const closing = new Map(openBundles(recipientPubkey).map((b) => [b.bundleId, b.expiresAt]))
    const closed = await reconcileBundles(recipientPubkey)
    if (session !== bundleEpoch() || !wantsInApp(recipientPubkey, 'voucher_received')) return
    for (const view of closed) {
      const expiredAt = closing.get(view.bundleId) ?? now
      renderBundle(view, recipientPubkey, live.get(view.bundleId)?.memo, true, {
        toast: now - expiredAt < STALE_CLOSE_MS,
      })
    }
  } catch (e) {
    console.warn('[arrival] could not close expired bundles:', e)
  }
}

/**
 * Pick up bundles left open by a previous session.
 *
 * A tab closed between two parts leaves a bundle IN_FLIGHT in storage with
 * nothing to close it. Called when the poller starts for an account: the ones
 * already past their window are settled now, the rest get their timer back.
 */
export function resumeBundleArrivals(recipientPubkey: string): void {
  try {
    const session = bundleEpoch()
    void closeExpired(recipientPubkey).then(() => {
      if (session !== bundleEpoch()) return
      for (const open of openBundles(recipientPubkey)) {
        schedule(recipientPubkey, open.bundleId, open.expiresAt)
      }
    })
  } catch (e) {
    console.warn('[arrival] could not resume bundle arrivals:', e)
  }
}

/** Drop every timer and live toast, on logout or an account switch. */
export function stopBundleArrivals(): void {
  stopBundleTracking()
  for (const timer of timers.values()) clearTimeout(timer)
  timers.clear()
  live.clear()
}

// A queued part redraws its bundle's toast ("1 of 2 in, 1 still receiving")
// instead of raising a toast of its own. Returns whether there was a bundle
// toast to carry it.
onBundleQueueChange((bundleId, seed) => {
  try {
    const entry = live.get(bundleId)
    if (entry && entry.view.state === 'in_flight') {
      // Redrawn, never dismissed. With no part still queued the toast drops
      // its hold and times out like any arrival, so a part that gave up does
      // not leave "still receiving" up forever; and a part that succeeded is
      // redrawn in place a moment later by its own arrival, with no flicker.
      renderBundle(entry.view, entry.recipient, entry.memo, false)
      return true
    }
    // The FIRST part to reach the wallet is the one being held back. Open the
    // bundle's toast at "0 of 2" from what the part declares, so that when the
    // other part lands it redraws this toast instead of standing beside it.
    if (!seed || !isBundleId(bundleId) || seed.declaredCount < 2) return false
    if (seed.recipientPubkey && !wantsInApp(seed.recipientPubkey, 'voucher_received')) return false
    const view: BundleView = {
      bundleId,
      senderPubkey: seed.senderPubkey ?? '',
      unit: seed.unit,
      decimals: displayDecimals(seed.unit, seed.decimals),
      declaredTotal: seed.declaredTotal,
      declaredCount: seed.declaredCount,
      receivedTotal: 0,
      receivedCount: 0,
      state: 'in_flight',
      mismatch: false,
    }
    // No bell row yet: nothing has arrived, and the advance notice already
    // says the payment is on its way. The first landed part files the row.
    renderBundle(view, undefined, undefined, false)
    return true
  } catch (e) {
    console.warn('[arrival] could not redraw a bundle for a queued part:', e)
    return false
  }
})
