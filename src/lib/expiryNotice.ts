import type { LicenceStatus } from './licenceStatus'

/**
 * Telling a stall owner their subscription is ending, before it does.
 *
 * Ticket 06. Two channels, because they reach different moments: a DM reaches
 * an owner who is not looking at the app, and a banner reaches them at the till.
 * One missed message should not be a lapse.
 *
 * ## Derived, never stored
 *
 * There is no "notice dismissed" flag and no "notice shown" record anywhere in
 * this module. The notice is a pure function of the licence's signed expiry and
 * the clock, which is what makes the ticket's fourth requirement true for free:
 * "renewing clears the notice without the customer dismissing it". A renewal is
 * a new voucher with a later expiry, `licenceStatus` starts reporting that one,
 * and the notice evaluates to none on the very next render. Nothing has to
 * remember to clear anything.
 *
 * A stored flag would also be wrong in the other direction. Dismissing a notice
 * would hide the one warning before a lapse, and the customer who dismissed it
 * on day seven is exactly the one who needs it on day one.
 *
 * ## It is information, not a gate
 *
 * `noticeFor` returns something to SAY and never something to do. It cannot
 * block, and the banner that renders it cannot modal: the spec is explicit that
 * "a notice that interrupts trade to talk about billing would be the same
 * mistake the lapse design exists to avoid", and a merchant serving a queue
 * must never have to dismiss a billing message to take a payment.
 */

/** A day, in seconds — the unit `@imani/licence` works in throughout. */
const DAY = 86_400

/**
 * How far out the warning starts.
 *
 * Seven days is the spec's, and the reason is renewal LEAD TIME rather than
 * urgency: selling is out-of-band while this is a pilot, so renewing means
 * getting hold of a person and them minting a voucher. A day's warning would be
 * a warning nobody could act on.
 */
export const NOTICE_WINDOW_DAYS = 7

export const NOTICE_URGENCY = {
  /** Inside the window, with days to spare. */
  SOON: 'soon',
  /** The last day. The final nudge before it stops. */
  LAST_DAY: 'last-day',
} as const

export type NoticeUrgency = (typeof NOTICE_URGENCY)[keyof typeof NOTICE_URGENCY]

export interface ExpiryNotice {
  urgency: NoticeUrgency
  /** Unix SECONDS, the signed expiry. Callers format it; this module does not. */
  expiresAt: number
  /** Whole days remaining, floored. 0 on the last day. */
  daysLeft: number
  /** Carried so a DM can be addressed to the right subscription. */
  subscriptionId?: string
}

/**
 * Is there anything to say about this subscription right now?
 *
 * Null in every case but one: an ACTIVE licence, inside the window. That
 * exclusion list is the ticket's fifth requirement — "told twice and then simply
 * lapses, with no further nagging" — and each case is worth naming because each
 * is a different way to get it wrong:
 *
 * - **No licence, or a refused one.** Nothing to warn about; a stall that never
 *   subscribed is not "expiring". Warning here would nag every free merchant
 *   forever.
 * - **Already expired.** The lapse HAS happened. A notice saying "ending soon"
 *   would be false, and one saying "it ended" is what the subscription screen is
 *   for. Silence here is the whole of "and then simply lapses".
 * - **Granted under GRACE.** The device could not check, so its expiry is the
 *   one it remembered. Warning from a stale reading risks telling a merchant who
 *   renewed yesterday that they are about to lapse, because the renewal is
 *   exactly what could not be read.
 */
export function noticeFor(status: LicenceStatus, now: number): ExpiryNotice | null {
  const { decision } = status

  if (!decision.granted) return null
  // Only a fresh, verified answer. See above: a grace decision is a memory.
  if (decision.source !== 'verified') return null

  const expiresAt = decision.grant.expiresAt
  const remaining = expiresAt - now

  // Past its end, or exactly at it. `licenceStatus` would already refuse here,
  // so this is belt and braces against a caller passing a stale status.
  if (remaining <= 0) return null
  if (remaining > NOTICE_WINDOW_DAYS * DAY) return null

  const daysLeft = Math.floor(remaining / DAY)

  return {
    // The last DAY, not the last 24 hours: a merchant reading "1 day left" at
    // 9am and "0 days left" at 11am on the same day would think something had
    // changed. `daysLeft === 0` is the whole of the final day.
    urgency: daysLeft === 0 ? NOTICE_URGENCY.LAST_DAY : NOTICE_URGENCY.SOON,
    expiresAt,
    daysLeft,
    subscriptionId: decision.grant.subscriptionId,
  }
}

/**
 * What the banner says.
 *
 * Plain, and about the CONSEQUENCE rather than the billing: a stall owner needs
 * to know their extra tills stop, not that an invoice is due. The spec's lapse
 * design is that trade continues, so the sentence must not imply the stall
 * closes — that would frighten someone into thinking they cannot sell tomorrow.
 *
 * `formatDate` is the caller's job. This module has no opinion about locale and
 * returns the date as the number it was signed with.
 */
export function noticeText(notice: ExpiryNotice, formattedDate: string): string {
  if (notice.urgency === NOTICE_URGENCY.LAST_DAY) {
    return `Your subscription ends today. Renew to keep your extra tills; your stall keeps trading either way.`
  }
  const days = notice.daysLeft === 1 ? '1 day' : `${notice.daysLeft} days`
  return `Your subscription ends in ${days}, on ${formattedDate}. Renew to keep your extra tills.`
}

/**
 * The two moments a DM is sent, in whole days before expiry.
 *
 * Exactly two, and the second is the day itself. "One missed message should not
 * be a lapse" is the reason for the first; "no further nagging" is the reason
 * there is not a third.
 */
export const DM_NOTICE_DAYS = [NOTICE_WINDOW_DAYS, 0] as const

/**
 * Is today a day this subscription should be DM'd about?
 *
 * Whole days rather than an instant, because a sender runs on a schedule and
 * must not miss the moment by minutes, nor fire twice in one day. The caller
 * records what it sent — see `scripts/notify-expiring.mjs` — because the seller
 * is the one who knows what has already gone out.
 *
 * Note this is the SELLER's half. The app cannot DM on the owner's behalf about
 * their own subscription: the licence is ours, the delivery path is ours, and a
 * device that has lapsed offline could not send anything anyway.
 */
export function dmDueOn(expiresAt: number, now: number): number | null {
  const remaining = expiresAt - now
  if (remaining <= 0) return null

  const daysLeft = Math.floor(remaining / DAY)
  return DM_NOTICE_DAYS.includes(daysLeft as (typeof DM_NOTICE_DAYS)[number])
    ? daysLeft
    : null
}
