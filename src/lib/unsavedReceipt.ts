import { toast } from 'sonner'

import { removeNotification, upsertNotification } from './notifications/inbox'

/**
 * A voucher the gateway settled but this device did not save (#112).
 *
 * `DmPollService` emits `redemption:unsaved` when the swap happened at the
 * gateway (the sender's voucher is spent) but the value never reached this
 * wallet. Before this module nothing listened, so the only trace was a console
 * line: the balance simply did not move, in front of someone told they had been
 * paid. Recovery is manual, through support, and support needs the receive id.
 *
 * ## What the person sees
 *
 * A WARNING, held until dismissed, plus a bell row: the same shape as the #94
 * incomplete-bundle warning, because it is the same kind of fact, money that was
 * sent and is not in the balance, and the one outcome the reader has to act on.
 * One plain sentence says what happened, one says what to do, and the receive id
 * is the thing to quote. No gateway, escrow or swap jargon.
 *
 * ## Why the record survives logout
 *
 * Logout sweeps every `imani-wallet:*` key. That is right for everything
 * recoverable from the relay, and wrong for this: the receive id exists nowhere
 * else on the device, and "log out and back in" is exactly what someone tries
 * when a payment looks missing. So `imani-wallet:unsaved-receipts:<pubkey>` is
 * exempt from the sweep (see `isKeptAcrossLogout`). It is keyed by the account
 * and only ever read for the signed-in pubkey, so another account on a shared
 * device never sees it. It holds no secret: a receive id and an event id.
 *
 * ## Reporting to the operator
 *
 * gateway-customer has no reconciliation/support endpoint yet (only
 * `/receive`, `/receive/{id}/ack`, `/receive/pending`), tracked as
 * gateway-customer#121. Until it lands the report is a structured
 * `console.error` with a stable tag the operator's log collection can match.
 *
 * Never throws: it runs from an event handler on the redemption path.
 */

export interface UnsavedReceipt {
  receiveId: string | null
  eventId: string
  senderPubkey: string | null
  reason: string | null
  /** Epoch ms. */
  at: number
}

export const UNSAVED_RECEIPTS_PREFIX = 'imani-wallet:unsaved-receipts:'
const LIMIT = 50

const storageKey = (pubkey: string) => UNSAVED_RECEIPTS_PREFIX + pubkey

/** The logout sweep's exemption. Only this ledger, only by exact prefix. */
export function isKeptAcrossLogout(key: string): boolean {
  return key.startsWith(UNSAVED_RECEIPTS_PREFIX) && key.length > UNSAVED_RECEIPTS_PREFIX.length
}

function valid(e: unknown): e is UnsavedReceipt {
  if (!e || typeof e !== 'object') return false
  const r = e as Record<string, unknown>
  return (
    typeof r.eventId === 'string' &&
    r.eventId !== '' &&
    typeof r.at === 'number' &&
    (r.receiveId === null || typeof r.receiveId === 'string') &&
    (r.senderPubkey === null || typeof r.senderPubkey === 'string') &&
    (r.reason === null || typeof r.reason === 'string')
  )
}

/** This account's records, newest first. Never another account's. */
export function listUnsavedReceipts(pubkey: string): UnsavedReceipt[] {
  try {
    if (!pubkey) return []
    const raw = localStorage.getItem(storageKey(pubkey))
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter(valid) : []
  } catch {
    return []
  }
}

function save(pubkey: string, record: UnsavedReceipt): void {
  const rest = listUnsavedReceipts(pubkey).filter((r) => r.eventId !== record.eventId)
  const next = [record, ...rest].sort((a, b) => b.at - a.at).slice(0, LIMIT)
  localStorage.setItem(storageKey(pubkey), JSON.stringify(next))
}

const TITLE = 'Voucher not saved'

function body(receiveId: string | null): string {
  return (
    'A voucher payment reached the gateway but was not saved on this device, so it is not in your balance. ' +
    (receiveId
      ? `Contact support and quote receive ID ${receiveId}.`
      : 'Contact support and quote the time of the payment.')
  )
}

function fileRow(pubkey: string, record: UnsavedReceipt, reopen: boolean): void {
  upsertNotification(
    pubkey,
    {
      id: 'unsaved:' + (record.receiveId ?? record.eventId),
      type: 'voucher_received',
      title: TITLE,
      body: body(record.receiveId),
      url: '/receive',
      receivedAt: record.at,
    },
    { reopen },
  )
}

/** Handle one `redemption:unsaved` for the signed-in `pubkey`. */
export function announceUnsaved(
  pubkey: string,
  event:
    | { eventId?: string; senderPubkey?: string; receiveId?: string | null; reason?: string | null }
    | undefined,
): void {
  try {
    if (!pubkey || !event?.eventId) return
    const record: UnsavedReceipt = {
      receiveId: typeof event.receiveId === 'string' && event.receiveId ? event.receiveId : null,
      eventId: event.eventId,
      senderPubkey: typeof event.senderPubkey === 'string' ? event.senderPubkey : null,
      reason: typeof event.reason === 'string' ? event.reason : null,
      at: Date.now(),
    }

    // Operator report. No endpoint exists yet (gateway-customer#121); a stable
    // tag and a flat object keep this greppable in collected logs.
    console.error('[unsaved-receipt] RECEIVE_SETTLED_NOT_SAVED', {
      receiveId: record.receiveId,
      eventId: record.eventId,
      reason: record.reason,
      at: new Date(record.at).toISOString(),
    })

    try {
      save(pubkey, record)
    } catch (e) {
      console.warn('[unsaved-receipt] could not persist:', e)
    }
    fileRow(pubkey, record, true)

    toast.warning(TITLE, {
      id: 'unsaved-' + (record.receiveId ?? record.eventId),
      description: body(record.receiveId),
      // Held until dismissed, like the #94 shortfall: this is the one outcome
      // the reader must act on, and the id has to be copied down.
      duration: Infinity,
      closeButton: true,
    })
  } catch (e) {
    console.warn('[unsaved-receipt] could not announce:', e)
  }
}

/**
 * Re-file the bell rows at sign-in. The inbox is swept at logout, the records
 * are not, so without this the warning would vanish the first time someone
 * logs out to "fix" a missing payment. Rows keep their read state.
 */
export function resumeUnsavedReceipts(pubkey: string): void {
  try {
    for (const record of listUnsavedReceipts(pubkey)) fileRow(pubkey, record, false)
  } catch (e) {
    console.warn('[unsaved-receipt] could not resume:', e)
  }
}

/** At most this many ids per gateway status call; the route accepts 50. */
const STATUS_BATCH = 50

/**
 * Looks up the escrow status of this account's own receives
 * (`POST /api/v1/wallet/receive/statuses`, gateway-customer, #560). Answers a
 * map of receive id to status; unknown ids are absent.
 */
export type ReceiveStatusLookup = (
  receiveIds: string[],
) => Promise<{ statuses?: Record<string, string> } | null | undefined>

/**
 * #560: drop records the gateway now reports ACKNOWLEDGED. Such a receive was
 * saved by this account (another device, or before a logout), so the warning
 * was false; its coupon comes back via NIP-60. The record and its bell row go.
 *
 * Records without a receive id, and any the gateway does not answer for, are
 * kept. A gateway without the route (404, older build) or any failure keeps
 * everything: never throws, and the records age out under LIMIT as before.
 * Returns how many records were dropped.
 */
export async function dropAcknowledgedReceipts(pubkey: string, lookup: ReceiveStatusLookup): Promise<number> {
  try {
    if (!pubkey) return 0
    const ids = [
      ...new Set(listUnsavedReceipts(pubkey).flatMap((r) => (r.receiveId ? [r.receiveId] : []))),
    ]
    if (ids.length === 0) return 0
    const acknowledged = new Set<string>()
    for (let i = 0; i < ids.length; i += STATUS_BATCH) {
      const answer = await lookup(ids.slice(i, i + STATUS_BATCH))
      const statuses = answer?.statuses ?? {}
      for (const [id, status] of Object.entries(statuses)) {
        if (typeof status === 'string' && status.toUpperCase() === 'ACKNOWLEDGED') acknowledged.add(id)
      }
    }
    if (acknowledged.size === 0) return 0
    // Re-read: an announce may have landed while the lookup was in flight.
    const all = listUnsavedReceipts(pubkey)
    const keep = all.filter((r) => !(r.receiveId && acknowledged.has(r.receiveId)))
    localStorage.setItem(storageKey(pubkey), JSON.stringify(keep))
    for (const id of acknowledged) {
      removeNotification(pubkey, 'unsaved:' + id)
      toast.dismiss?.('unsaved-' + id)
    }
    const dropped = all.length - keep.length
    console.info('[unsaved-receipt] dropped records the gateway reports acknowledged', { dropped })
    return dropped
  } catch (e) {
    console.warn('[unsaved-receipt] could not check acknowledged receipts:', e)
    return 0
  }
}
