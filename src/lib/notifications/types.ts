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
 * The WIRE VALUES do not, and cannot. `voucher_received` is a string chosen by
 * gateway-core and `notifyVoucherClaimed` is a column in its
 * push_subscription table; renaming either here would not rename it there.
 *
 * Everything the WALLET owns does obey the glossary — the preference fields
 * are `couponReceived`, `couponClaimed`, `couponExpiring`. An earlier version
 * of this comment defended calling them `voucher*` on the grounds that a
 * translation layer would be pure cost. That was wrong: gateway.ts already had
 * to map `couponExpiring` onto the server's `notifyVoucherExpired`, because
 * the server calls the flag `expired` while the event it gates is `expiring`.
 * The layer existed, so the rename cost nothing.
 *
 * The rule: the glossary governs what we SAY and what we OWN, the server
 * governs what we SEND. The boundary is the request body in gateway.ts and the
 * `NotificationType` values below, and it should not spread past them.
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
 * against gateway-core on 2026-09-17, counting only non-test callers:
 *
 *   voucher_claimed    EMITTED  — PaymentReceiptController.fireSettlementPush
 *   voucher_received   EMITTED  — AtomicSendService.processDmDelivery
 *   voucher_expiring   wired, no production caller yet
 *
 * All three have an implemented, public `notifyVoucher*` method, so the
 * preference flags reach real code and the switches are not decorative.
 *
 * `voucher_received` was in the "no caller" column until 2026-09-17, and the
 * consequence is worth recording: the RECIPIENT's phone never rang. The method
 * was fully built — preference flag, repository query filtering on it, rendered
 * payload — and nothing called it, while the sender's `voucher_claimed` fired
 * reliably from the receipts controller. The in-app advance-notice toast hid
 * it, because that surface only exists while the app is OPEN, so anyone testing
 * with the wallet in front of them saw a notification and concluded push
 * worked. A phone in a pocket got nothing.
 *
 * `voucher_expiring` is the one still dark: expiry is a clock event with no
 * request to hang a call on, so it needs a scheduler that does not exist yet.
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
  couponReceived: boolean
  /** A coupon you sent was claimed. */
  couponClaimed: boolean
  /** A coupon you hold is about to expire. */
  couponExpiring: boolean
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
  couponReceived: true,
  couponClaimed: true,
  couponExpiring: true,
}

/** Maps a preference flag to the event it governs. */
export const PREFERENCE_FOR_TYPE: Record<NotificationType, keyof NotificationPreferences> = {
  voucher_received: 'couponReceived',
  voucher_claimed: 'couponClaimed',
  voucher_expiring: 'couponExpiring',
}

/**
 * Where the permission actually stands.
 *
 * `unsupported` is its own state rather than a flavour of `denied`: a browser
 * with no Notification API and a user who said no need different words, and
 * only one of them is worth offering a retry.
 */
export type PermissionState = 'granted' | 'denied' | 'prompt' | 'unsupported'
