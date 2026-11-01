/**
 * Sends this wallet has already settled, and the payment requests they paid (#461).
 *
 * The pending-send ledger forgets a send the moment it settles, so before this nothing on the
 * payer's side remembered that a request was paid. A second payment of the same request then
 * reached the gateway, which (under the old voucher_id key) replayed the FIRST send's COMPLETED
 * answer, and `settleSend` took that as its own: it deleted the change coupon and booked a
 * payment that never left. This ledger is what lets both doors say "already paid" instead.
 *
 * Local and best effort: a wiped wallet loses it, which is why gateway-core refuses the same
 * thing server side (request_already_paid). Capped, newest first.
 */

const MAX_ENTRIES = 200

export interface SettledSend {
  sendId: string
  /** The source coupon this send consumed. */
  tokenId: string
  paymentRequestId?: string
  /** Minor units delivered by this send. */
  amount: number
  at: number
}

export const settledSendsKey = (pubkey: string) => `imani-wallet:settled-sends:${pubkey}`

export function loadSettledSends(pubkey: string): SettledSend[] {
  try {
    const raw = localStorage.getItem(settledSendsKey(pubkey))
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (s): s is SettledSend => typeof (s as SettledSend)?.sendId === 'string',
    )
  } catch {
    return []
  }
}

export function rememberSettledSend(pubkey: string, send: SettledSend): void {
  try {
    const others = loadSettledSends(pubkey).filter((s) => s.sendId !== send.sendId)
    localStorage.setItem(
      settledSendsKey(pubkey),
      JSON.stringify([send, ...others].slice(0, MAX_ENTRIES)),
    )
  } catch (error) {
    // Never fails a send that has already settled; it only weakens the replay guard.
    console.error('[pay] could not record a settled send', error)
  }
}

export function isSettledSend(pubkey: string, sendId: string): boolean {
  return loadSettledSends(pubkey).some((s) => s.sendId === sendId)
}

/** Minor units this wallet has already delivered against a payment request. */
export function settledAgainstRequest(pubkey: string, paymentRequestId: string): number {
  return loadSettledSends(pubkey)
    .filter((s) => s.paymentRequestId === paymentRequestId)
    .reduce((sum, s) => sum + (Number.isFinite(s.amount) ? s.amount : 0), 0)
}

/**
 * This wallet already paid the request (or the gateway answered with a send it already settled).
 * Nothing was sent this time and no coupon was touched.
 */
export class RequestAlreadyPaidError extends Error {
  constructor(
    readonly paymentRequestId: string | undefined,
    readonly sendId?: string,
  ) {
    super(
      'This request is already paid. Nothing was sent this time and your vouchers are unchanged.',
    )
    this.name = 'RequestAlreadyPaidError'
  }
}
