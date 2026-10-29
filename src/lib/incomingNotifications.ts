/**
 * Incoming-payment notifications — the Artemis/JMS drain loop, ported from
 * imani-apps' `shared/incomingNotificationIntegration.js` (spec 018 T044).
 *
 * The gateway enqueues a token-free "payment on its way" envelope onto Artemis
 * the moment a sender starts a payment saga. Settlement (the actual coupon
 * redemption via dm-poll) can lag seconds to minutes behind; this loop closes
 * that gap by draining the queue every 10s and raising an instant sonner toast
 * so the recipient sees the payment before the money lands.
 *
 * What this does per drained envelope:
 *   1. validate against the v1 contract (see incomingNotification.ts),
 *   2. de-duplicate on notificationId, persistently — see `seen` below,
 *   3. skip anything already settled or dead (state is terminal),
 *   4. raise ONE sonner toast per notificationId, ever,
 *   5. ACK it, so the server stops redelivering it.
 *
 * Steps 2, 3 and 5 are all the same bug, found on staging: the toast reappeared
 * for a payment that had settled days earlier. Drain is a non-destructive
 * BROWSE, so the queue redelivered every envelope every 10s until its retention
 * expired; the only thing suppressing the repeat was an in-memory Set, which
 * every page reload emptied. Nothing ever told the server the user had seen it,
 * and nothing looked at whether the payment had since completed.
 *
 * What this NEVER does (FR-013): write transaction history, balance, NIP-60
 * wallet state, or "token received" markers. Those are dm-poll's job and happen
 * on the real redemption. This surface is advance notice only.
 *
 * Auth: the drain endpoint is NIP-98 protected (same contract as spec 014
 * payment-receipts). We sign with the session signer via `signedFetch`, exactly
 * as the rest of the wallet authenticates gateway writes.
 */

import { createElement } from 'react'
import { toast } from 'sonner'

import { IncomingPaymentToast } from '../components/ui/IncomingPaymentToast'
import { licenceSellerPubkey } from './licenceStatus'
import { createBoundedSet, createPersistentBoundedSet } from './boundedSet'
import { createAccountStore } from './accountStore'
import { MISMATCH_NOTE, vouchers } from './bundleWording'
import { displayDecimals, formatFace } from './format'
import { signedFetch } from './nip98'
import { validateEnvelope, type IncomingPaymentNotificationEnvelope } from './incomingNotification'
import { recordNotification, upsertNotification } from './notifications/inbox'
import { wantsInApp } from './notifications/wants'

/** Server-side Artemis producer drain endpoint. Same-origin; see dmPoll.ts. */
const DRAIN_ENDPOINT = '/api/v1/incoming-notifications/drain'
/** Consumes envelopes we have shown, so they stop coming back. */
const ACK_ENDPOINT = '/api/v1/incoming-notifications/ack'
const DRAIN_INTERVAL_MS = 10 * 1000
const DRAIN_LIMIT = 50

/**
 * States that mean the payment is over, one way or another.
 *
 * An envelope in one of these has nothing left to announce: `redeemed` is money
 * already in the balance and in the history, and the other two are failures the
 * user cannot act on from a toast. Announcing any of them as "on its way" is
 * exactly the false alarm reported from staging.
 */
const TERMINAL_STATES: ReadonlySet<string> = new Set([
  'redeemed',
  'failed_terminal',
  'expired',
])

const LOG_PREFIX = '[incoming-notif]'

/** Is this sender the licence seller this build pins (VITE_LICENCE_SELLER_PUBKEY)? Never when unpinned. */
function isLicenceSeller(pubkeyHex: string): boolean {
  const seller = licenceSellerPubkey()
  return seller !== '' && pubkeyHex.toLowerCase() === seller
}

interface DrainResponse {
  envelopes?: unknown[]
  moreAvailable?: boolean
}

/** Per-session lifecycle state. Cleared on stop()/start(). */
let drainTimerId: ReturnType<typeof setInterval> | null = null
let drainInFlight = false
let activePubkey: string | null = null

/**
 * notificationIds already toasted, PERSISTED per account.
 *
 * In-memory was the original bug. The drain redelivers every unsettled envelope
 * every 10s and the ack below is best-effort, so the set has to survive a
 * reload — otherwise a refresh re-announces every payment still on the queue,
 * which is precisely what staging showed. localStorage rather than IndexedDB
 * because it is a synchronous read on a hot path and the payload is a list of
 * hashes: no key material, nothing worth encrypting.
 *
 * Bounded, because it grows forever otherwise. The cap is far above any real
 * backlog and the oldest entries fall off first; re-announcing a payment from
 * a thousand notifications ago is an acceptable worst case for a bounded store.
 */
const SEEN_LIMIT = 500
const seenKey = (pubkey: string) => `imani-wallet:incoming-seen:${pubkey}`

/**
 * Per-account seen set. Cached because `createPersistentBoundedSet` keeps an
 * in-memory mirror, and rebuilding it per call would throw that mirror away —
 * which is the half that keeps working when localStorage is denied.
 */
const seenSets = new Map<string, ReturnType<typeof createPersistentBoundedSet>>()

function seenSet(pubkey: string) {
  let set = seenSets.get(pubkey)
  if (!set) {
    set = createPersistentBoundedSet(seenKey(pubkey), SEEN_LIMIT, (msg, e) =>
      console.warn(LOG_PREFIX, msg + ':', e),
    )
    seenSets.set(pubkey, set)
  }
  return set
}

function markSeen(pubkey: string, notificationId: string): void {
  seenSet(pubkey).add(notificationId)
}

function hasSeen(pubkey: string, notificationId: string): boolean {
  return seenSet(pubkey).has(notificationId)
}

/**
 * notificationIds whose validation already failed this session, so a stale or
 * spoofed envelope redelivered every tick warns ONCE, not every 10s.
 */
// Bounded: it was an unbounded Set, which grew for the life of the tab.
const rejectedThisSession = createBoundedSet(SEEN_LIMIT)

/**
 * Ids drained this tick that the server should stop sending us: everything we
 * showed, plus everything already terminal or already seen. Acked in one call
 * per tick rather than one per envelope.
 */
async function ack(notificationIds: string[]): Promise<void> {
  if (notificationIds.length === 0) return
  try {
    const res = await signedFetch(ACK_ENDPOINT, 'POST', { notificationIds })
    if (!res.ok) {
      // Non-fatal by construction: an un-acked envelope is redelivered, and the
      // persistent `seen` set keeps that from reaching the user twice.
      console.warn(LOG_PREFIX, 'ack: request failed status=' + res.status)
      return
    }
    console.log(LOG_PREFIX, 'ack: acknowledged', notificationIds.length, 'envelope(s)')
  } catch (e) {
    console.warn(LOG_PREFIX, 'ack failed:', e instanceof Error ? e.message : String(e))
  }
}

/**
 * The envelope's total, rendered in the currency's own decimals.
 *
 * `total.display` is pre-formatted server-side by
 * `IncomingNotificationService.formatMinorUnits`, using the `face_decimals` the
 * gateway stamped on the send — which is 2 for every currency, including the
 * zero-decimal ones. A genuine FCFA 2 payment therefore reaches the queue
 * labelled "0.02 XAF", and announcing that beside a balance in whole francs is
 * the same defect the settlement toast had.
 *
 * `minorUnits` is the integer the display string was derived from, so
 * re-rendering from it loses nothing.
 *
 * `displayDecimals` with the envelope's own `currency.decimals` as the
 * fallback: the unit decides where we recognise it, and for a merchant's own
 * non-ISO unit we defer to what the server recorded — which is the closest
 * thing to "the server's string is the better guess" that is actually true.
 * An earlier version of this comment claimed the code fell back to the
 * server's display string for non-ISO units; it never did, so `5 BEANS` was
 * re-rendered as `5.00 BEANS`. The comment described a branch that did not
 * exist.
 */
export function formatEnvelopeTotal(env: IncomingPaymentNotificationEnvelope): string {
  const unit = env.currency?.unit
  if (!unit) return env.total.display
  const minor = env.total.minorUnits
  if (!Number.isFinite(minor)) return env.total.display
  return formatFace(minor, { unit, decimals: displayDecimals(unit, env.currency?.decimals) })
}

/**
 * Raise the advance-notice toast for one validated envelope. Returns whether it
 * actually announced, so the caller knows to ack.
 *
 * Wording mirrors imani-apps: "on its way" (pre-settlement) is deliberately
 * distinct from dm-poll's eventual "received" so the two states read
 * differently to the user.
 *
 * The sender is rendered rather than described: `IncomingPaymentToast` looks up
 * the kind-0 profile itself, so the toast can go up on the drain tick without
 * waiting for a fetch, and fills in the face and handle when they arrive.
 */
function raiseToast(env: IncomingPaymentNotificationEnvelope, pubkey: string): boolean {
  if (hasSeen(pubkey, env.notificationId)) return false
  // Marked BEFORE the toast, not after: `toast()` can throw if the Toaster is
  // not mounted yet, and a throw between announcing and marking would re-announce
  // on the next tick.
  markSeen(pubkey, env.notificationId)

  const message = createElement(IncomingPaymentToast, {
    pubkey: env.sender.pubkeyHex,
    // NOT `env.total.display`, which the gateway pre-formats with the same
    // wrong decimals it stamps everywhere else: a real FCFA 2 payment arrives
    // on the queue as "0.02 XAF" (observed on staging, notificationId
    // 69046b1b…). The envelope carries the honest minor-unit integer alongside
    // it, so re-render from that and let the currency decide the decimals —
    // exactly as the settlement toast does. Falls back to the server's string
    // only when there is no unit to reason about.
    amount: formatEnvelopeTotal(env),
    fallbackName: env.sender.displayName ?? undefined,
    fallbackPicture: env.sender.picture ?? undefined,
  })

  // A stable id so a same-notification re-render (e.g. React StrictMode double
  // mount, or a duplicate that slipped the Set) collapses onto one toast rather
  // than stacking. 'pending-' namespaces it away from any future settlement
  // toast keyed on the same id.
  toast.success(message, {
    id: 'pending-' + env.notificationId.slice(0, 16),
    // The tick would say the money is here; it is not yet. The sender's own
    // avatar takes that slot instead, inside the message.
    icon: null,
    duration: 5000,
  })
  return true
}

/**
 * Process one drained envelope: validate, then toast. Rejections are logged
 * once per session and dropped — an envelope that fails validation is a spoof,
 * a stale row, or a backend bug, and none of those should surface to the user.
 *
 * Returns the notificationId when the server should stop redelivering it, which
 * covers three cases: shown, already shown, and settled-so-never-worth-showing.
 * A rejected envelope returns null deliberately — consuming something we could
 * not validate would destroy the evidence of a backend bug.
 */
function handleInboundEnvelope(raw: unknown, recipientPubkeyHex: string): string | null {
  const result = validateEnvelope(raw, recipientPubkeyHex)
  if (!result.ok) {
    // Best-effort id extraction purely for the dedup-warn key; never trusted.
    const id =
      raw && typeof raw === 'object' && typeof (raw as { notificationId?: unknown }).notificationId === 'string'
        ? (raw as { notificationId: string }).notificationId
        : null
    if (!id || !rejectedThisSession.has(id)) {
      if (id) rejectedThisSession.add(id)
      console.warn(LOG_PREFIX, 'drain: rejected envelope —', result.reason)
    }
    return null
  }

  const env = result.envelope

  // Already settled, failed for good, or expired. The money question is closed,
  // so there is nothing to announce — just tell the server to let it go. This is
  // the case that put a "payment on its way" toast on screen for a transaction
  // the user had completed days before.
  if (TERMINAL_STATES.has(env.state)) {
    console.log(LOG_PREFIX, 'drain: skipping terminal envelope state=' + env.state)
    return env.notificationId
  }

  // What the user asked to hear about. Acked either way: an envelope the user
  // has switched off is still an envelope the server should stop redelivering,
  // and leaving it queued would re-raise it the moment they switched it back
  // on — announcing a payment that had long since settled.
  if (!wantsInApp(recipientPubkeyHex, 'voucher_received')) {
    return env.notificationId
  }

  // A plan, not a payment (#407). The licence seller's delivery goes through the same gateway
  // route as a sale, so the gateway announces it as "Payment on its way". The wallet announces
  // the licence itself when it lands ("Imani Essentials plan activated", dmPoll.ts), so this advance
  // notice is dropped. Keyed on the sender being THIS build's pinned licence seller: an envelope
  // carries no token, so that is the only signal, and it is the same key the licence must name.
  if (isLicenceSeller(env.sender.pubkeyHex)) return env.notificationId

  // One part of a multi-coupon payment: fold it into that payment's one
  // "on its way" toast and bell row (#94). Acked the same way either way.
  if (announceBundlePart(env, recipientPubkeyHex)) return env.notificationId

  raiseToast(env, recipientPubkeyHex)
  // The toast lasts five seconds; the bell keeps it. Recorded even when the
  // toast was suppressed as already-seen, because a user who missed the toast
  // is precisely who opens the bell — and `recordNotification` dedupes on id,
  // so a redelivery never becomes a second line.
  recordNotification(recipientPubkeyHex, {
    id: env.notificationId,
    type: 'voucher_received',
    title: 'Payment on its way',
    body: `${formatEnvelopeTotal(env)} from ${env.sender.displayName ?? 'someone'}`,
    // Not `/receive`: this is advance notice of money arriving, and the wallet
    // home is where the balance it will land in is shown.
    url: '/',
  })
  // Acked whether or not this call was the one that announced it: if it was
  // already seen, the server is redelivering something the user has read.
  return env.notificationId
}

/* ------------------------------------------------------------------------ */
/* One payment in several coupons (#94), advance notice                      */
/* ------------------------------------------------------------------------ */

const BUNDLE_HEX = /^[0-9a-f]{32}$/

/** The advance notices seen so far for one bundle. */
interface PendingBundle {
  bundleId: string
  sender: string
  /** The first part's display name, so a mismatched later part cannot rename the row. */
  senderName?: string
  unit: string
  decimals: number
  /** First declaration wins, as on the settlement side. Absent on older gateways. */
  declaredTotal?: number
  declaredCount?: number
  /** notificationId → that part's minor units. */
  parts: Record<string, number>
  /** A later part disagreed with this bundle. Said on the row, never hidden. */
  conflict?: boolean
  updatedAt: number
}

const pendingBundles = createAccountStore<PendingBundle>({
  name: 'pending-bundles',
  limit: 50,
  idOf: (b) => b.bundleId,
  ageOf: (b) => b.updatedAt,
  isValid: (b): b is PendingBundle =>
    !!b &&
    typeof b === 'object' &&
    typeof (b as PendingBundle).bundleId === 'string' &&
    typeof (b as PendingBundle).parts === 'object',
})

/** A declared figure, if it is a sane one. Garbled hints are ignored, never fatal. */
function declaredOf(value: unknown, min: number): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min ? value : undefined
}

/**
 * Fold one advance notice into its bundle's single toast and bell row.
 *
 * Returns false when the envelope is not a bundle part (no bundle id, or the
 * gateway correlated it by bundle id alone, which makes the notificationId
 * already per-bundle), or when it cannot belong to this bundle (another
 * sender or currency). The caller then announces it exactly as before, and in
 * the second case the bundle's own row says something did not match.
 */
function announceBundlePart(env: IncomingPaymentNotificationEnvelope, pubkey: string): boolean {
  const correlation = env.correlation
  const bundleId = correlation?.bundleId
  if (!correlation || !bundleId || !BUNDLE_HEX.test(bundleId) || !correlation.deliveryEventId) return false

  const existing = pendingBundles.get(pubkey, bundleId)
  const declaredTotal = declaredOf(correlation.bundleTotal, 0)
  const declaredCount = declaredOf(correlation.bundlePartCount, 1)

  if (existing && (existing.sender !== env.sender.pubkeyHex || existing.unit !== env.currency.unit)) {
    if (!existing.conflict) {
      existing.conflict = true
      pendingBundles.put(pubkey, existing)
      showPendingBundle(pubkey, existing, env)
    }
    return false
  }

  const bundle: PendingBundle = existing ?? {
    bundleId,
    sender: env.sender.pubkeyHex,
    senderName: env.sender.displayName ?? undefined,
    unit: env.currency.unit,
    decimals: displayDecimals(env.currency.unit, env.currency.decimals),
    declaredTotal,
    declaredCount,
    parts: {},
    updatedAt: Date.now(),
  }
  // First declaration wins. A later one that differs is flagged, not adopted;
  // one first seen on a later part still counts if none came before.
  if (
    (declaredTotal !== undefined && bundle.declaredTotal !== undefined && declaredTotal !== bundle.declaredTotal) ||
    (declaredCount !== undefined && bundle.declaredCount !== undefined && declaredCount !== bundle.declaredCount)
  ) {
    bundle.conflict = true
  }
  bundle.declaredTotal ??= declaredTotal
  bundle.declaredCount ??= declaredCount

  const isNew = !(env.notificationId in bundle.parts)
  bundle.parts[env.notificationId] = env.total.minorUnits
  bundle.updatedAt = Date.now()
  pendingBundles.put(pubkey, bundle)

  // Toast once per part, never for a redelivery: the persistent seen set is
  // still the gate, exactly as on the per-part path.
  const toastIt = isNew && !hasSeen(pubkey, env.notificationId)
  markSeen(pubkey, env.notificationId)
  showPendingBundle(pubkey, bundle, env, toastIt)
  return true
}

/** Draw the bundle's one "on its way" bell row and, when asked, its toast. */
function showPendingBundle(
  pubkey: string,
  bundle: PendingBundle,
  env: IncomingPaymentNotificationEnvelope,
  toastIt = false,
): void {
  const seen = Object.values(bundle.parts)
  const seenTotal = seen.reduce((sum, n) => sum + n, 0)
  const fmt = (n: number) => formatFace(n, { unit: bundle.unit, decimals: bundle.decimals })
  // What has been announced is the headline. The sender's declared total only
  // ever appears as "of", the same rule as the settlement toast, since it is a
  // figure the sender chose.
  const headline =
    bundle.declaredTotal !== undefined && bundle.declaredTotal > seenTotal
      ? `${fmt(seenTotal)} of ${fmt(bundle.declaredTotal)}`
      : fmt(seenTotal)
  const count =
    bundle.declaredCount !== undefined && bundle.declaredCount >= seen.length ? bundle.declaredCount : seen.length
  const partsLabel = vouchers(count)
  const name = bundle.senderName ?? 'someone'
  const caveat = bundle.conflict ? ` ${MISMATCH_NOTE}` : ''

  if (toastIt) {
    try {
      toast.success(
        createElement(IncomingPaymentToast, {
          pubkey: bundle.sender,
          amount: headline,
          fallbackName: env.sender.displayName ?? undefined,
          fallbackPicture: env.sender.picture ?? undefined,
          progress: partsLabel,
        }),
        {
          // One id for the bundle, so each part redraws the same toast.
          id: 'pending-bundle-' + bundle.bundleId,
          icon: null,
          duration: 5000,
        },
      )
    } catch (e) {
      console.warn(LOG_PREFIX, 'could not toast a bundle part:', e)
    }
  }

  upsertNotification(pubkey, {
    id: 'pending:bundle:' + bundle.bundleId,
    type: 'voucher_received',
    title: 'Payment on its way',
    body: `${headline} from ${name} (${partsLabel}).${caveat}`,
    url: '/',
  })
}

/** One drain tick. Single-flight; self-heals on the next interval on any error. */
async function runDrainTick(): Promise<void> {
  if (drainInFlight) return
  const pubkey = activePubkey
  if (!pubkey) return

  drainInFlight = true
  try {
    const res = await signedFetch(DRAIN_ENDPOINT, 'POST', { limit: DRAIN_LIMIT })
    if (!res.ok) {
      // 401 (auth not ready yet) / 5xx — warn once per tick; the loop retries.
      console.warn(LOG_PREFIX, 'drain: request failed status=' + res.status)
      return
    }
    const body = (await res.json()) as DrainResponse
    const envelopes = Array.isArray(body.envelopes) ? body.envelopes : []
    if (envelopes.length === 0) return
    console.log(LOG_PREFIX, 'drain: received', envelopes.length, 'envelope(s)')
    const toAck: string[] = []
    for (const envelope of envelopes) {
      try {
        const ackId = handleInboundEnvelope(envelope, pubkey)
        if (ackId) toAck.push(ackId)
      } catch (e) {
        console.warn(
          LOG_PREFIX,
          'drain: handleInboundEnvelope failed:',
          e instanceof Error ? e.message : String(e),
        )
      }
    }
    // After the loop, so one request covers the tick. Awaited inside the
    // single-flight guard so a slow ack cannot overlap the next drain and
    // re-announce what this one is still consuming.
    await ack(toAck)
  } catch (e) {
    console.warn(LOG_PREFIX, 'drain: tick failed:', e instanceof Error ? e.message : String(e))
  } finally {
    drainInFlight = false
  }
}

/**
 * Start draining incoming-payment notifications for `pubkey`.
 *
 * Idempotent for the same identity (StrictMode-safe). An identity change is an
 * account switch: the previous poller is torn down so this session never toasts
 * a payment addressed to the account that just logged out. Mirrors dmPoll's
 * re-entry guard.
 *
 * A boot tick runs immediately so a payment already queued at login surfaces
 * without waiting a full interval.
 *
 * The loop PAUSES while the tab is hidden. Every tick is a NIP-98-signed POST —
 * a signature, a round trip and a gateway request thread — and a background tab
 * has no toast to show for it, because sonner renders into a document nobody is
 * looking at. A forgotten tab was doing this every 10s indefinitely: staging
 * logs show one client draining 119 times in 20 minutes while its user was
 * plainly elsewhere. Nothing is missed by waiting, since the envelope stays
 * queued until acked and the visibility handler runs a catch-up tick the moment
 * the tab comes back.
 */
export function startIncomingNotifications(pubkey: string): void {
  if (drainTimerId !== null && activePubkey === pubkey) return
  if (drainTimerId !== null) {
    console.log(LOG_PREFIX, 'identity changed, restarting drain loop')
    stopIncomingNotifications()
  }

  activePubkey = pubkey
  rejectedThisSession.clear()
  // Drop the cached seen-set wrappers, NOT the localStorage behind them. The
  // wrapper holds an in-memory mirror scoped to one run of the drain loop; a
  // restart (or a reload, which is the same thing from the module's point of
  // view) must re-read what was persisted rather than trust a stale mirror.
  seenSets.clear()
  // NOT cleared: the seen set is persistent and per-account by design. Clearing
  // it here would restore the original bug, where every login re-announced
  // every unsettled payment still sitting on the queue.

  // Boot tick: catch anything already queued. Never throws.
  void runDrainTick()

  drainTimerId = setInterval(() => {
    // `document` is guarded rather than assumed: this module is unit-tested in
    // a node environment where there is no DOM, and a bare reference would
    // throw inside the interval where nothing catches it.
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    void runDrainTick()
  }, DRAIN_INTERVAL_MS)

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange)
  }
}

/**
 * Catch up the moment the tab is looked at again, rather than waiting out the
 * remainder of an interval the user cannot see.
 */
function onVisibilityChange(): void {
  if (document.visibilityState === 'visible' && activePubkey !== null) {
    void runDrainTick()
  }
}

/** Stop the drain loop and clear session state. Safe to call when not running. */
export function stopIncomingNotifications(): void {
  if (drainTimerId !== null) {
    clearInterval(drainTimerId)
    drainTimerId = null
  }
  // Detached with the timer. A listener outliving the loop would call
  // runDrainTick on the next tab focus after logout — signing with a session
  // that is being torn down, for an account that is no longer the user's.
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', onVisibilityChange)
  }
  activePubkey = null
  drainInFlight = false
  rejectedThisSession.clear()
  seenSets.clear()
}
