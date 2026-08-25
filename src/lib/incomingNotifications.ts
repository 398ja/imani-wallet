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
import { signedFetch } from './nip98'
import { validateEnvelope, type IncomingPaymentNotificationEnvelope } from './incomingNotification'

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

function loadSeen(pubkey: string): string[] {
  try {
    const raw = localStorage.getItem(seenKey(pubkey))
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

function markSeen(pubkey: string, notificationId: string): void {
  try {
    const next = loadSeen(pubkey).filter((id) => id !== notificationId)
    next.push(notificationId)
    localStorage.setItem(seenKey(pubkey), JSON.stringify(next.slice(-SEEN_LIMIT)))
  } catch (e) {
    // A full or denied localStorage must not stop the toast; it only means the
    // de-duplication degrades to the in-memory set for this session.
    console.warn(LOG_PREFIX, 'could not persist the seen marker:', e)
  }
}

function hasSeen(pubkey: string, notificationId: string): boolean {
  return loadSeen(pubkey).includes(notificationId)
}

/**
 * notificationIds whose validation already failed this session, so a stale or
 * spoofed envelope redelivered every tick warns ONCE, not every 10s.
 */
const rejectedThisSession = new Set<string>()

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
    amount: env.total.display,
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

  raiseToast(env, recipientPubkeyHex)
  // Acked whether or not this call was the one that announced it: if it was
  // already seen, the server is redelivering something the user has read.
  return env.notificationId
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
 */
export function startIncomingNotifications(pubkey: string): void {
  if (drainTimerId !== null && activePubkey === pubkey) return
  if (drainTimerId !== null) {
    console.log(LOG_PREFIX, 'identity changed, restarting drain loop')
    stopIncomingNotifications()
  }

  activePubkey = pubkey
  rejectedThisSession.clear()
  // NOT cleared: the seen set is persistent and per-account by design. Clearing
  // it here would restore the original bug, where every login re-announced
  // every unsettled payment still sitting on the queue.

  // Boot tick: catch anything already queued. Never throws.
  void runDrainTick()

  drainTimerId = setInterval(() => {
    void runDrainTick()
  }, DRAIN_INTERVAL_MS)
}

/** Stop the drain loop and clear session state. Safe to call when not running. */
export function stopIncomingNotifications(): void {
  if (drainTimerId !== null) {
    clearInterval(drainTimerId)
    drainTimerId = null
  }
  activePubkey = null
  drainInFlight = false
  rejectedThisSession.clear()
}
