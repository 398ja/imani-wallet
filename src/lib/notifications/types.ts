/**
 * Push notifications — the vocabulary shared by both transports.
 *
 * The wallet already notifies you about money while you are looking at it:
 * `incomingNotifications.ts` drains the gateway queue every 10s and raises a
 * sonner toast. That surface stops existing the moment the tab is closed, and a
 * coupon arriving while the phone is in a pocket is exactly the case that
 * matters. This module is the half that survives the app being closed.
 *
 * ## Two transports, one vocabulary
 *
 * The wallet ships as a web app AND as a Capacitor Android app, and those two
 * cannot receive a push the same way. The browser uses the Web Push API with a
 * VAPID key; the Android WebView cannot reliably, and native Android expects
 * FCM. So everything below the surface differs, and everything above it —
 * what the events mean, what the user chose to hear about, how a payload is
 * turned into words — is shared.
 *
 * The seam is `PushTransport` (see transport.ts). This file holds only the
 * nouns, so neither transport imports the other's types.
 *
 * ## Why this file says "voucher" when the glossary says "coupon"
 *
 * CONTEXT.md defines the domain noun as **Coupon** and lists _Avoid: Voucher_.
 * Every user-visible string below obeys that: the wallet says "Coupon
 * received", never "Voucher received".
 *
 * The identifiers do not, and deliberately. `voucher_received` is a value on
 * the WIRE, chosen by gateway-core, and `notifyVoucherClaimed` is a column in
 * its push_subscription table. Renaming them here would not rename them there;
 * it would only add a translation layer whose sole job is to disagree with the
 * server about what the same string is called, and every debugging session
 * would start by mapping one set of names onto the other.
 *
 * So the rule is: the glossary governs what we SAY, the server governs what we
 * SEND. The boundary is this file plus gateway.ts, and it should not spread
 * past them.
 *
 * ## The event set is the SERVER's, not ours
 *
 * `NotificationType` mirrors what `PushNotificationService` on gateway-core
 * can send: voucher_received, voucher_claimed, voucher_expiring. imani-apps'
 * preference model carries nine flags, six of which have no send method at all
 * — bitcoin_received and friends are aspirational there. Copying them would
 * put switches in the settings screen that cannot change anything, which is
 * worse than not offering them.
 *
 * Be precise about "can send", because the three are not equal today. Checked
 * against gateway-core on 2026-09-11, counting only non-test callers:
 *
 *   voucher_claimed    EMITTED  — PaymentReceiptController:174
 *   voucher_received   wired, no production caller yet
 *   voucher_expiring   wired, no production caller yet
 *
 * All three have an implemented, public `notifyVoucher*` method, so the
 * preference flags reach real code and the switches are not decorative. But
 * only a claim actually fires a push right now, and a reader who takes the
 * three as equally live will go looking for a bug that is not there when
 * testing the other two.
 *
 * This is deliberately NOT surfaced in the settings screen. A wallet that
 * labelled two of its three switches "not yet" would be describing the
 * server's roadmap to a customer who cannot act on it, and the labels would
 * then need changing the day a caller lands. The asymmetry belongs here, next
 * to the type, where the person it affects is looking.
 *
 * `generic` is the fallback for a payload whose type we do not recognise. A
 * server that starts sending a new type must still produce a readable
 * notification on a wallet that predates it, rather than silently dropping it.
 */

/**
 * The kinds of notification the gateway can send.
 *
 * Kept in step with `PushNotificationService.notify*` on gateway-core. The
 * wire values are snake_case because that is what the server puts in
 * `payload.data.type`.
 */
export const NOTIFICATION_TYPES = [
  'voucher_received',
  'voucher_claimed',
  'voucher_expiring',
] as const

export type NotificationType = (typeof NOTIFICATION_TYPES)[number]

/** A type we do not recognise still has to render. */
export type NotificationTypeOrGeneric = NotificationType | 'generic'

export function isNotificationType(value: unknown): value is NotificationType {
  return typeof value === 'string' && (NOTIFICATION_TYPES as readonly string[]).includes(value)
}

/**
 * A push payload as it arrives from the gateway.
 *
 * Everything is optional except the fact that it arrived: this crosses a
 * network from a service we version separately, so a missing field must
 * degrade rather than throw. `data` is deliberately `Record<string, unknown>`
 * — it is server-shaped and read defensively at the point of use.
 */
export interface PushPayload {
  title?: string
  body?: string
  type?: string
  data?: Record<string, unknown>
}

/**
 * A payload after we have made sense of it: always renderable.
 */
export interface RenderableNotification {
  title: string
  body: string
  type: NotificationTypeOrGeneric
  /** In-app route to open when tapped. Always wallet-relative. */
  url: string
  /**
   * Collapse key. Two notifications sharing a tag replace one another rather
   * than stacking, so a burst of claims on one voucher shows as one line.
   */
  tag: string
  data: Record<string, unknown>
}

/**
 * What the user chose to be told about.
 *
 * Only three flags, one per server-emitted event, plus a master switch. The
 * master switch is separate from OS permission on purpose: a user can revoke
 * permission in browser settings without us knowing, and can also turn
 * notifications off in the wallet while leaving permission granted. Those are
 * different states and conflating them makes the settings screen lie.
 */
export interface NotificationPreferences {
  /** Master switch. False means we hold no subscription at all. */
  enabled: boolean
  /** A coupon arrived for you. */
  voucherReceived: boolean
  /** A coupon you sent was claimed. */
  voucherClaimed: boolean
  /** A coupon you hold is about to expire. */
  voucherExpiring: boolean
}

/**
 * Defaults for a wallet that has never chosen.
 *
 * `enabled: false`, because turning this on requires an OS permission prompt
 * and a prompt the user did not ask for is the fastest way to be denied
 * permanently. Chrome and Safari both punish unsolicited prompts, and a
 * permanent denial cannot be undone from inside the app. So the three event
 * flags default to true — they describe what you WOULD hear about — and the
 * master switch waits for a deliberate tap.
 */
export const DEFAULT_PREFERENCES: NotificationPreferences = {
  enabled: false,
  voucherReceived: true,
  voucherClaimed: true,
  voucherExpiring: true,
}

/** Maps a preference flag to the event it governs. */
export const PREFERENCE_FOR_TYPE: Record<NotificationType, keyof NotificationPreferences> = {
  voucher_received: 'voucherReceived',
  voucher_claimed: 'voucherClaimed',
  voucher_expiring: 'voucherExpiring',
}

/**
 * Where the permission actually stands.
 *
 * `unsupported` is its own state rather than a flavour of `denied`: a browser
 * with no Notification API and a user who said no need different words, and
 * only one of them is worth offering a retry.
 */
export type PermissionState = 'granted' | 'denied' | 'prompt' | 'unsupported'
