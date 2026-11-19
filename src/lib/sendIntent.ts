import { SEND_INTENT_LIFETIME_MS, sendIntentsKey } from './inFlightMoney'

/**
 * One Idempotency-Key per user send intent (#179).
 *
 * A send's key used to be built per HTTP attempt from a 10-second clock window. When the answer
 * to `POST /api/v1/atomic-send` was lost (timeout, dropped connection, app killed) and the user
 * retried more than ten seconds later, or after a reload, the retry carried a NEW key: the
 * gateway could not tell it was the same send and ran it again, paying twice.
 *
 * Now the key is written to localStorage BEFORE the request goes out, beside the pending-send
 * ledger, and read back for every retry of the same send: an automatic retry, a manual retry,
 * a retry after a reload. Only an answer clears it: the gateway accepted (the send id moves to
 * the pending-send ledger) or refused it outright (nothing moved). A lost answer leaves it, so
 * the next attempt replays the original send instead of starting another.
 *
 * "The same send" is exactly what gateway-core hashes to recognise a retry
 * (`AtomicSendService.computeRequestHash`: sender, recipient, amount, voucher, memo), so a
 * reused key always comes with a body the gateway accepts as identical, and a different send
 * never borrows another's key.
 */
export interface SendIntent {
  key: string
  recipientPubkey: string
  amount: number
  voucherId: string
  memo?: string
  at: number
  /**
   * #389: what the pending-send ledger needs to settle this send once the gateway says what became
   * of it (the source row, the issuer, the unit). Stored, never compared: it is not part of "the
   * same send". Absent on an intent written by an older build.
   */
  pending?: IntentPending
}

/** The pending-send record of this send, less what only the gateway's answer gives. */
export interface IntentPending {
  tokenId: string
  unit: string
  decimals: number
  merchantPubkey: string
  merchantName?: string
  recipientName?: string
  sourceFaceValue: number
}

type Identity = Omit<SendIntent, 'key' | 'at' | 'pending'>

function sameSend(a: Identity, b: Identity): boolean {
  return (
    a.recipientPubkey.toLowerCase() === b.recipientPubkey.toLowerCase() &&
    a.amount === b.amount &&
    a.voucherId === b.voucherId &&
    (a.memo ?? '') === (b.memo ?? '')
  )
}

export function loadSendIntents(payer: string): SendIntent[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(sendIntentsKey(payer)) ?? '[]')
    if (!Array.isArray(parsed)) return []
    const now = Date.now()
    return parsed.filter(
      (i): i is SendIntent =>
        typeof i?.key === 'string' && typeof i?.at === 'number' && now - i.at < SEND_INTENT_LIFETIME_MS,
    )
  } catch {
    return []
  }
}

function save(payer: string, intents: SendIntent[]): void {
  if (intents.length === 0) localStorage.removeItem(sendIntentsKey(payer))
  else localStorage.setItem(sendIntentsKey(payer), JSON.stringify(intents.slice(0, 50)))
}

function newKey(): string {
  return `c2c_${crypto.randomUUID()}`
}

/**
 * The key for this send: the one already stored for the same send, or a fresh one stored now.
 * Synchronous on purpose, so two concurrent attempts of one send (a double tap) cannot both
 * miss the record and mint two keys.
 */
export function keyForSend(payer: string, send: Identity, pending?: IntentPending): string {
  const intents = loadSendIntents(payer)
  const existing = intents.find((i) => sameSend(i, send))
  if (existing) return existing.key
  const intent: SendIntent = { ...send, key: newKey(), at: Date.now(), ...(pending ? { pending } : {}) }
  save(payer, [intent, ...intents])
  return intent.key
}

/** The voucher a stored, unanswered send to this recipient for this amount was drawn on. */
export function pendingIntentVoucher(payer: string, recipientPubkey: string, amount: number, memo?: string): string | undefined {
  return loadSendIntents(payer).find(
    (i) =>
      i.recipientPubkey.toLowerCase() === recipientPubkey.toLowerCase() &&
      i.amount === amount &&
      (i.memo ?? '') === (memo ?? ''),
  )?.voucherId
}

/** The gateway answered for this key (accepted or refused): the next send of it is a new send. */
export function forgetSendIntent(payer: string, key: string): void {
  save(payer, loadSendIntents(payer).filter((i) => i.key !== key))
}

/**
 * Did the gateway answer, so the intent is settled either way? A failure with no HTTP status
 * (network, timeout) or a 5xx may have come after the send started, and a 409 is the gateway
 * saying the same key is still running: in those cases the key is kept for the retry.
 */
export function gatewayAnswered(error: unknown): boolean {
  const { status, code } = (error ?? {}) as { status?: unknown; code?: unknown }
  if (typeof status !== 'number') return false
  // gateway-core's two definite 409s: the coupon is busy with ANOTHER send, or this key belongs to
  // a different send. Neither started this one.
  if (status === 409) return code === 'SEND_CONCURRENT' || code === 'SEND_IDEMPOTENCY_MISMATCH'
  return status >= 400 && status < 500 && status !== 408 && status !== 429
}

/**
 * #389: how long after the request went out a send that is not in the gateway's history is taken
 * never to have reached it. Inside this a request may still be on its way, so it stays unknown.
 */
export const INTENT_ARRIVAL_GRACE_MS = 2 * 60 * 1000
/** Clock difference allowed between this device's `at` and the gateway's `created_at`. */
export const INTENT_CLOCK_SKEW_MS = 10 * 60 * 1000

/** One row of `GET /api/v1/atomic-send/history`, as far as matching an intent goes. */
export interface HistorySend {
  send_id?: string
  recipient_pubkey?: string
  amount?: number
  voucher_id?: string
  created_at?: string | number
}

export function historyTime(send: HistorySend): number | undefined {
  const c = send.created_at
  if (typeof c === 'number') return c < 1e12 ? c * 1000 : c
  if (typeof c === 'string') {
    const n = Date.parse(c)
    return Number.isNaN(n) ? undefined : n
  }
  return undefined
}

/**
 * The gateway's sends that could be this intent: the same recipient, amount and voucher, made no
 * earlier than the intent (less the clock skew). Newest first. The gateway's history carries no
 * memo, and it refuses a second ACTIVE send of one voucher, so these three fields and the time
 * are what tell a send apart.
 */
export function historyMatches(intent: SendIntent, history: HistorySend[]): HistorySend[] {
  return history
    .filter(
      (h) =>
        typeof h.send_id === 'string' &&
        (h.recipient_pubkey ?? '').toLowerCase() === intent.recipientPubkey.toLowerCase() &&
        h.amount === intent.amount &&
        h.voucher_id === intent.voucherId &&
        (historyTime(h) ?? Number.POSITIVE_INFINITY) >= intent.at - INTENT_CLOCK_SKEW_MS,
    )
    .sort((a, b) => (historyTime(b) ?? 0) - (historyTime(a) ?? 0))
}
