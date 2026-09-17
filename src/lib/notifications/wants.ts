/**
 * "Does this user want to hear about this?" — for the IN-APP surfaces.
 *
 * Push is filtered server-side: `setPreferences` sends the flags to the gateway
 * and an off switch stops the push being SENT. The toasts and the bell have no
 * such server in the loop — they are raised by the drain loops and by dm-poll
 * from inside the running app — so until this module they ignored the settings
 * screen completely. A user who turned "coupon claimed" off still got the row
 * in their bell, because nothing on this side had ever asked.
 *
 * ## Why this does NOT consult `preferences.enabled`
 *
 * That flag means "we hold a push subscription", and it is false by default
 * precisely because turning it on requires an OS permission prompt (see
 * DEFAULT_PREFERENCES). Reading it here would mean a wallet that has never been
 * granted notification permission — the majority — shows no toasts and keeps an
 * empty bell while money moves in and out. That is a far worse bug than the one
 * being fixed.
 *
 * The two are genuinely different questions:
 *
 *   enabled        — may the OS interrupt you when the app is CLOSED?
 *   couponReceived — do you care about this event AT ALL?
 *
 * The per-event flags answer the second, which is the only one an in-app toast
 * needs. So the master switch governs push alone, and the event flags govern
 * both transports. A user who wants no interruptions but still wants the record
 * is expressible, which it was not before.
 *
 * Defaults to TRUE on anything unreadable. A corrupt or denied localStorage
 * must not silence a payment notification: showing one the user had switched
 * off is a nuisance, and hiding money movement is not.
 */

import { loadPreferences } from './manager'
import { PREFERENCE_FOR_TYPE, type NotificationType } from './types'

/**
 * Whether an in-app notification of this type should surface for this account.
 *
 * Never throws. Every call site is a toast or an inbox write sitting on a
 * completed redemption, and a preference lookup must not be the thing that
 * turns one into a failure.
 */
export function wantsInApp(pubkey: string | undefined, type: NotificationType): boolean {
  if (!pubkey) return true
  try {
    const flag = PREFERENCE_FOR_TYPE[type]
    const value = loadPreferences(pubkey)[flag]
    // Only an explicit `false` suppresses. An older stored shape missing the
    // flag entirely reads as undefined, which must mean "not chosen", not "no".
    return value !== false
  } catch {
    return true
  }
}
