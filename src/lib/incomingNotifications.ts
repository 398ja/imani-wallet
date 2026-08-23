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
 *   2. de-duplicate on notificationId (the server leaves envelopes in the queue
 *      after a drain, so the same one returns every tick until settlement),
 *   3. raise ONE sonner toast per notificationId per page session.
 *
 * What this NEVER does (FR-013): write transaction history, balance, NIP-60
 * wallet state, or "token received" markers. Those are dm-poll's job and happen
 * on the real redemption. This surface is advance notice only.
 *
 * Auth: the drain endpoint is NIP-98 protected (same contract as spec 014
 * payment-receipts). We sign with the session signer via `signedFetch`, exactly
 * as the rest of the wallet authenticates gateway writes.
 */

import { toast } from 'sonner'

import { signedFetch } from './nip98'
import {
  formatSenderLabel,
  validateEnvelope,
  type IncomingPaymentNotificationEnvelope,
} from './incomingNotification'

/** Server-side Artemis producer drain endpoint. Same-origin; see dmPoll.ts. */
const DRAIN_ENDPOINT = '/api/v1/incoming-notifications/drain'
const DRAIN_INTERVAL_MS = 10 * 1000
const DRAIN_LIMIT = 50

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
 * notificationIds already toasted this page session. The drain redelivers every
 * unsettled envelope every 10s, so without this the toast would re-fire on each
 * tick. Cleared on stop()/start().
 */
const toastedThisSession = new Set<string>()
/**
 * notificationIds whose validation already failed this session, so a stale or
 * spoofed envelope redelivered every tick warns ONCE, not every 10s.
 */
const rejectedThisSession = new Set<string>()

/**
 * Raise the advance-notice toast for one validated envelope. Idempotent per
 * notificationId for the life of the page session.
 *
 * Wording mirrors imani-apps: "on its way" (pre-settlement) is deliberately
 * distinct from dm-poll's eventual "received" so the two states read
 * differently to the user.
 */
function raiseToast(env: IncomingPaymentNotificationEnvelope): void {
  if (toastedThisSession.has(env.notificationId)) return
  toastedThisSession.add(env.notificationId)

  const sender = formatSenderLabel(env.sender)
  const amount = env.total.display
  const message = sender
    ? `${sender} sent you ${amount}`
    : `You're receiving ${amount}`

  // A stable id so a same-notification re-render (e.g. React StrictMode double
  // mount, or a duplicate that slipped the Set) collapses onto one toast rather
  // than stacking. 'pending-' namespaces it away from any future settlement
  // toast keyed on the same id.
  toast.success(message, {
    id: 'pending-' + env.notificationId.slice(0, 16),
    description: 'On its way. Your balance updates once it settles.',
    duration: 5000,
  })
}

/**
 * Process one drained envelope: validate, then toast. Rejections are logged
 * once per session and dropped — an envelope that fails validation is a spoof,
 * a stale row, or a backend bug, and none of those should surface to the user.
 */
function handleInboundEnvelope(raw: unknown, recipientPubkeyHex: string): void {
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
    return
  }
  raiseToast(result.envelope)
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
    for (const envelope of envelopes) {
      try {
        handleInboundEnvelope(envelope, pubkey)
      } catch (e) {
        console.warn(
          LOG_PREFIX,
          'drain: handleInboundEnvelope failed:',
          e instanceof Error ? e.message : String(e),
        )
      }
    }
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
  toastedThisSession.clear()
  rejectedThisSession.clear()

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
  toastedThisSession.clear()
  rejectedThisSession.clear()
}
