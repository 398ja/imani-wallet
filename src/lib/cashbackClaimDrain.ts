import { toast } from 'sonner'

import { displayDecimals, formatFace, toEpochMs } from './format'
import { signedFetch } from './nip98'
import { getTransactionRow, recordCashbackStatus, walletIsOpen } from './wallet'
import { recordNotification } from './notifications/inbox'
import { wantsInApp } from './notifications/wants'
import type { PushPayload } from './notifications/types'

/**
 * "A cashback this stall issued was claimed" (#158), the merchant's half of
 * imani-gateway-portal#59.
 *
 * The portal tells the issuing merchant by two independent routes, the same pair
 * `paymentReceiptDrain.ts` uses for "your coupon was claimed":
 *
 *  1. a Web Push, sent through gateway-core the moment claim-notify moves the
 *     record to Claimed, which needs no client running. The service worker hands
 *     it to `listener.ts`, which calls {@link fileCashbackClaimPush};
 *  2. a drainable notice this loop collects while the tab is open, which still
 *     works when the browser refuses notifications. The portal files one for a
 *     claim the reconcile repaired too, where it deliberately sends no push.
 *
 * Both end in {@link fileCashbackClaim}, keyed `cashback-claimed:<cashbackId>`,
 * so a claim delivered both ways is ONE bell row and one toast.
 *
 * Filing also stamps the cashback row's cached `cashbackStatus = Claimed` and
 * `claimedAt`, so the Vouchers list and the voucher detail (#155) read Claimed
 * without asking the portal. Stamped BEFORE the notification preference is
 * consulted: a merchant who silenced the bell has not asked for stale records.
 *
 * Same 10s cadence, visibility handling and never-throw posture as the receipt
 * drain. The claim already happened; failing to hear about it must never
 * surface as an error.
 */

const DRAIN_ENDPOINT = '/api/v1/portal/cashback/claim-notices/drain'
const ACK_ENDPOINT = '/api/v1/portal/cashback/claim-notices/ack'
const DRAIN_INTERVAL_MS = 10 * 1000
const DRAIN_LIMIT = 50
const LOG_PREFIX = '[cashback-claim-drain]'

/**
 * Answers that will not change within a session: not a stall (403), or a
 * portal that has no such route (404/405/410). Everything else (401 during a
 * lock cycle, 429, 5xx, the network) is retried on the normal 10s tick.
 */
const PERMANENT_REFUSALS = new Set([403, 404, 405, 410])

/** The wire type the portal pushes with. */
export const CASHBACK_CLAIMED = 'cashback_claimed'

/** One claim as the portal reports it. Never carries the code, claim ref or token. */
export interface CashbackClaim {
  cashbackId: string
  amountMinor: number
  unit: string
  decimals?: number
  /** Epoch milliseconds. */
  claimedAt?: number
}

interface DrainedNotice {
  cashbackId?: unknown
  amountMinor?: unknown
  unit?: unknown
  decimals?: unknown
  claimedAt?: unknown
}

interface DrainResponse {
  notices?: DrainedNotice[]
  moreAvailable?: boolean
}

let drainTimerId: ReturnType<typeof setInterval> | null = null
let drainInFlight = false
let activePubkey: string | null = null

/** The id both routes collapse onto. Matches the portal's `notificationId`. */
export function cashbackClaimNotificationId(cashbackId: string): string {
  return `cashback-claimed:${cashbackId}`
}

/** The row `buildCashbackTransaction` wrote for this cashback. */
const rowIdFor = (cashbackId: string) => `cashback:${cashbackId}`

function asClaim(raw: DrainedNotice | Record<string, unknown> | undefined): CashbackClaim | null {
  if (!raw) return null
  const { cashbackId, amountMinor, unit, decimals, claimedAt } = raw as DrainedNotice
  if (typeof cashbackId !== 'string' || cashbackId === '') return null
  if (typeof amountMinor !== 'number' || !Number.isFinite(amountMinor)) return null
  if (typeof unit !== 'string' || unit === '') return null
  return {
    cashbackId,
    amountMinor,
    unit,
    decimals: typeof decimals === 'number' ? decimals : undefined,
    // ISO from the drain, epoch ms from the push: toEpochMs takes either.
    claimedAt: toEpochMs(claimedAt as number | string | undefined),
  }
}

/**
 * Stamp the cached status, then file the bell row. Returns whether a NEW row was
 * filed, which is false for a claim already seen. Never throws.
 */
export async function fileCashbackClaim(pubkey: string, claim: CashbackClaim): Promise<boolean> {
  try {
    if (!claim || !claim.cashbackId) return false
    const claimCode = await stampRow(claim)

    if (!wantsInApp(pubkey, CASHBACK_CLAIMED)) return false

    // The wallet's own money formatting, as the receipt drain uses, so "€5.00"
    // here and on the Vouchers list agree, and a 5000 XAF cashback is not "50.00".
    const amount = formatFace(claim.amountMinor, {
      unit: claim.unit,
      decimals: displayDecimals(claim.unit, claim.decimals),
    })
    const body = `${amount} cashback claimed${claimCode ? ` (${claimCode})` : ''}`

    const filed = recordNotification(pubkey, {
      id: cashbackClaimNotificationId(claim.cashbackId),
      type: CASHBACK_CLAIMED,
      title: 'Cashback claimed',
      body,
      url: '/merchant/transactions',
      receivedAt: claim.claimedAt,
    })

    // Once per claim: a redelivery files nothing and must not toast either.
    if (filed) {
      try {
        toast.success(body, { id: 'cashback-claimed-' + claim.cashbackId, duration: 6000 })
      } catch (error) {
        console.warn(LOG_PREFIX, 'could not toast a claim', error)
      }
    }
    return filed
  } catch (error) {
    console.warn(LOG_PREFIX, 'could not file a cashback claim', error)
    return false
  }
}

/**
 * Write Claimed onto this device's cashback row, if it has one, and hand back
 * the code for the bell row. The code is read from OUR OWN row: the portal never
 * sends it. Never throws.
 */
async function stampRow(claim: CashbackClaim): Promise<string | undefined> {
  try {
    if (!walletIsOpen()) return undefined
    const row = (await getTransactionRow(rowIdFor(claim.cashbackId))) as unknown as Record<string, unknown> | null
    if (!row) return undefined
    // Already Claimed: the first claimedAt stands, and a rewrite would wake
    // every screen for nothing.
    if (row.cashbackStatus !== 'Claimed') {
      await recordCashbackStatus(rowIdFor(claim.cashbackId), { status: 'Claimed', claimedAt: claim.claimedAt })
    }
    return typeof row.claimCode === 'string' && row.claimCode ? row.claimCode : undefined
  } catch (error) {
    console.warn(LOG_PREFIX, 'could not stamp the cashback row', error)
    return undefined
  }
}

/**
 * The push route: a `cashback_claimed` payload the service worker or the native
 * plugin passed on. Never throws; a payload missing the fields files nothing.
 */
export async function fileCashbackClaimPush(pubkey: string, payload: PushPayload): Promise<boolean> {
  try {
    const claim = asClaim(payload?.data)
    if (!claim) return false
    return await fileCashbackClaim(pubkey, claim)
  } catch (error) {
    console.warn(LOG_PREFIX, 'could not file a cashback claim push', error)
    return false
  }
}

/** One drain pass. Never throws. */
export async function runCashbackClaimDrainTick(): Promise<void> {
  if (drainInFlight || activePubkey === null) return
  drainInFlight = true
  const pubkey = activePubkey

  try {
    const response = await signedFetch(DRAIN_ENDPOINT, 'POST', { limit: DRAIN_LIMIT })
    if (!response.ok) {
      // 403 is a wallet that is not a stall: no cashback of its own can ever be
      // claimed, so stop asking for the rest of this session rather than
      // polling the portal every ten seconds for the same answer. Starting it
      // again at the next login picks up a stall registered in between.
      //
      // 404, 405 and 410 are just as permanent for this session: a portal
      // without the route (deployed before imani-gateway-portal#59) answers
      // the same way every tick, and a warning every ten seconds forever is
      // noise in every merchant's console. The push still reaches the bell.
      if (PERMANENT_REFUSALS.has(response.status)) {
        if (response.status !== 403) {
          console.warn(LOG_PREFIX, 'drain unavailable, stopping for this session', response.status)
        }
        stopCashbackClaims()
        return
      }
      // 401 during a lock cycle is routine; anything else is worth a line.
      if (response.status !== 401) {
        console.warn(LOG_PREFIX, 'drain refused', response.status)
      }
      return
    }

    const body = (await response.json()) as DrainResponse
    const notices = Array.isArray(body.notices) ? body.notices : []
    if (notices.length === 0) return

    const ids: string[] = []
    for (const notice of notices) {
      // File first, ack second: an acked notice that was never filed is lost.
      const claim = asClaim(notice)
      if (claim) await fileCashbackClaim(pubkey, claim)
      // Ack even the unreadable ones: no retry will make them readable.
      if (typeof notice.cashbackId === 'string' && notice.cashbackId) ids.push(notice.cashbackId)
    }

    if (ids.length > 0) {
      const ack = await signedFetch(ACK_ENDPOINT, 'POST', { cashbackIds: ids })
      if (!ack.ok) {
        // They come back next tick; the inbox dedupes, so the cost is a round trip.
        console.warn(LOG_PREFIX, 'ack refused', ack.status)
      }
    }

    if (body.moreAvailable) {
      console.log(LOG_PREFIX, 'more notices queued, continuing on the next tick')
    }
  } catch (error) {
    console.warn(LOG_PREFIX, 'drain tick failed', error)
  } finally {
    drainInFlight = false
  }
}

/** Begin collecting for this account. Safe to call repeatedly. */
export function startCashbackClaims(pubkey: string): void {
  if (drainTimerId !== null && activePubkey === pubkey) return
  if (drainTimerId !== null) stopCashbackClaims()

  activePubkey = pubkey
  // Boot tick: a claim while the tab was closed is the common case.
  void runCashbackClaimDrainTick()

  drainTimerId = setInterval(() => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    void runCashbackClaimDrainTick()
  }, DRAIN_INTERVAL_MS)

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange)
  }
}

function onVisibilityChange(): void {
  if (document.visibilityState === 'visible' && activePubkey !== null) {
    void runCashbackClaimDrainTick()
  }
}

/** Stop collecting. Safe to call when not running. */
export function stopCashbackClaims(): void {
  if (drainTimerId !== null) {
    clearInterval(drainTimerId)
    drainTimerId = null
  }
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', onVisibilityChange)
  }
  activePubkey = null
  drainInFlight = false
}
