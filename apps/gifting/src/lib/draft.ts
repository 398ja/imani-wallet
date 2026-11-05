/**
 * The gift form, its validation, and the Purchase Draft it becomes (#410 §2, §3).
 *
 * The form is kept in sessionStorage per shop so that signing in mid-flow, the Edit links on the
 * review page, and coming back from Stripe all find it again (§5). The draft itself lives on the
 * server: what the server pinned is what the review page shows and what gets delivered (G-R1).
 */

import { isNip05 } from './handle'

/**
 * Who a gift goes to: an email address, and nothing else (#410 rework, 2026-11-04). Sending to an
 * Imani handle was removed from the site. `'handle'` stays in {@link IssuedDeliveryKind} only so a
 * draft issued before the change still reads correctly on the return page.
 */
export type DeliveryKind = 'email'
export type IssuedDeliveryKind = DeliveryKind | 'handle'

/**
 * What a gift is: a voucher for the stall (always), or a checkout code for the stall's online shop
 * (only where `codeGiftAvailable` says so).
 */
export type GiftKind = 'voucher' | 'code'

export interface GiftForm {
  amount: string
  gift: GiftKind
  email: string
  message: string
  from: string
  buyerEmail: string
}

export const EMPTY_FORM: GiftForm = {
  amount: '',
  gift: 'voucher',
  email: '',
  message: '',
  from: '',
  buyerEmail: '',
}

export const MESSAGE_MAX = 280
export const FROM_MAX = 80

export type FormErrors = Partial<Record<keyof GiftForm, string>>

const EMAIL = /^[^\s@<>()[\]\\,;:"]{1,64}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i
const URLISH = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|net|org|io|xyz|casa|co|me|app|link|ly)\b)/i

export function isEmail(value: string): boolean {
  return value.length <= 254 && EMAIL.test(value.trim())
}

/** Amount as minor units in the stall's currency, or null. Rejects rather than rounds. */
export function toMinorUnits(raw: string, decimals = 2): number | null {
  const trimmed = raw.trim()
  const pattern = decimals === 0 ? /^\d+$/ : new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`)
  if (!pattern.test(trimmed)) return null
  const minor = Math.round(Number(trimmed) * 10 ** decimals)
  return Number.isSafeInteger(minor) && minor > 0 ? minor : null
}

/** Plain text only: no links, no HTML (§2, "Abuse and privacy"). */
export function messageProblem(message: string): string | null {
  if (message.length > MESSAGE_MAX) return `Keep the message to ${MESSAGE_MAX} characters.`
  if (/[<>]/.test(message)) return 'The message must be plain text.'
  if (URLISH.test(message)) return "The message can't contain links."
  return null
}

export function validate(
  form: GiftForm,
  ctx: { decimals?: number; codeGifts?: boolean },
): FormErrors {
  const errors: FormErrors = {}
  if (toMinorUnits(form.amount, ctx.decimals) === null) errors.amount = 'Enter an amount like 25.00.'
  if (!isEmail(form.email)) errors.email = 'Enter an email address.'
  // A kept form from a shop that has since dropped its online shop must not send a code.
  if (form.gift === 'code' && !ctx.codeGifts) errors.gift = "This shop doesn't take codes online right now."
  const m = messageProblem(form.message)
  if (m) errors.message = m
  if (form.from.length > FROM_MAX) errors.from = `Keep the name to ${FROM_MAX} characters.`
  // G15: every gift needs the sender's email (the receipt, the return link, and the claimed /
  // not-claimed notices).
  if (!isEmail(form.buyerEmail)) errors.buyerEmail = "We need your email to tell you when it's claimed."

  return errors
}

// ─── The draft, as the server pins it ───────────────────────────────────────

export interface DraftRequest {
  stallPubkey: string
  stallHandle: string
  amountMinor: number
  currency: string
  termsVersion: string
  /** Only sent for a code gift. Absent means a voucher, as on every draft before the rework. */
  gift?: 'code'
  delivery: {
    kind: DeliveryKind
    email: string
    refundPubkey?: string
    sealed?: string
  }
  message?: string
  from?: string
  buyerEmail?: string
}

export interface Draft {
  draftId: string
  expiresAt: string
  stallPubkey: string
  amountMinor: number
  currency: string
  /** Absent on every voucher draft, including those issued before codes existed. */
  gift?: GiftKind
  delivery: {
    kind: IssuedDeliveryKind
    recipientPubkey?: string
    email?: string
    refundPubkey?: string
    claimWindowDays: number
  }
  message?: string
  from?: string
}

/** The stall terms a draft pins; a change in any of them invalidates it (§Edge cases). */
export function termsVersion(record: { issuanceCurrency: string; voucherValidityDays: number; eventAt?: number }): string {
  return `${record.issuanceCurrency.toUpperCase()}:${record.voucherValidityDays}:${record.eventAt ?? 0}`
}

export function draftRequest(
  form: GiftForm,
  ctx: {
    stallPubkey: string
    stallHandle: string
    currency: string
    terms: string
    decimals?: number
    refundPubkey?: string
    sealed?: string
  },
): DraftRequest {
  const amountMinor = toMinorUnits(form.amount, ctx.decimals)
  if (amountMinor === null) throw new Error('amount')
  const delivery: DraftRequest['delivery'] = { kind: 'email', email: form.email.trim(), refundPubkey: ctx.refundPubkey, sealed: ctx.sealed }
  return {
    stallPubkey: ctx.stallPubkey,
    stallHandle: ctx.stallHandle,
    amountMinor,
    currency: ctx.currency.toUpperCase(),
    termsVersion: ctx.terms,
    ...(form.gift === 'code' ? { gift: 'code' as const } : {}),
    delivery,
    message: form.message.trim() || undefined,
    from: form.from.trim() || undefined,
    buyerEmail: form.buyerEmail.trim(),
  }
}

/**
 * Does this draft deliver what the buyer reviewed? Checked when the server answers, so a server
 * (or a proxy) that pinned something else is caught before Pay is ever shown.
 */
export function draftMatches(draft: Draft, req: DraftRequest): boolean {
  if (draft.stallPubkey !== req.stallPubkey || draft.amountMinor !== req.amountMinor) return false
  if (draft.currency.toUpperCase() !== req.currency) return false
  if (draft.delivery.kind !== req.delivery.kind) return false
  if (draft.delivery.email?.toLowerCase() !== req.delivery.email.toLowerCase()) return false
  if (draft.delivery.refundPubkey !== req.delivery.refundPubkey) return false
  // A server that does not know codes pins a voucher: a code must never be paid as one, or back.
  if ((draft.gift ?? 'voucher') !== (req.gift ?? 'voucher')) return false
  return true
}

export function isExpired(draft: Pick<Draft, 'expiresAt'>, now = Date.now()): boolean {
  const t = Date.parse(draft.expiresAt)
  return !Number.isFinite(t) || t <= now
}

/** G17: the most a gift waits to be claimed. */
export const MAX_CLAIM_WINDOW_DAYS = 14

/**
 * G11 + G17: half the voucher's validity, at most {@link MAX_CLAIM_WINDOW_DAYS} (and never more than
 * `windowDays`), so a gift taken back unclaimed keeps half its life: the voucher keeps its original
 * expiry. `validityDays` 0 means it never expires. Mirrors purchase-issuer's `claimWindowEnd`.
 */
export function claimDeadline(issuedAt: number, validityDays: number, windowDays = MAX_CLAIM_WINDOW_DAYS): Date {
  const window = issuedAt + Math.min(windowDays, MAX_CLAIM_WINDOW_DAYS) * 86_400_000
  if (!validityDays) return new Date(window)
  return new Date(Math.min(window, issuedAt + Math.floor((validityDays * 86_400_000) / 2)))
}

export { isNip05 }

// ─── Keeping the form across sign-in, Edit and Stripe ───────────────────────

const key = (shop: string) => `imani:gift:${shop}`

export interface Kept {
  form: GiftForm
  draftId?: string
  /** Guest-only refund secret, kept so the return page can show the return link again. */
  refundSecret?: string
}

export function keep(shop: string, kept: Kept, storage: Pick<Storage, 'setItem'> | undefined = safeSession()): void {
  try {
    storage?.setItem(key(shop), JSON.stringify(kept))
  } catch {
    // Private mode: the guest flow still works within one page load (§Edge cases).
  }
}

export function recall(shop: string, storage: Pick<Storage, 'getItem'> | undefined = safeSession()): Kept | null {
  try {
    const raw = storage?.getItem(key(shop))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<Kept>
    return { ...parsed, form: keptForm(parsed.form) }
  } catch {
    return null
  }
}

/**
 * A form kept by an older version of the page may be a handle gift (`deliver: 'handle'`). It comes
 * back as an email gift with the email as it was (usually empty), so the buyer is asked for one.
 */
function keptForm(raw: unknown): GiftForm {
  const f = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const str = (k: 'amount' | 'email' | 'message' | 'from' | 'buyerEmail') => (typeof f[k] === 'string' ? (f[k] as string) : EMPTY_FORM[k])
  return {
    amount: str('amount'),
    gift: f.gift === 'code' ? 'code' : 'voucher',
    email: str('email'),
    message: str('message'),
    from: str('from'),
    buyerEmail: str('buyerEmail'),
  }
}

function safeSession(): Storage | undefined {
  try {
    return typeof sessionStorage === 'undefined' ? undefined : sessionStorage
  } catch {
    return undefined
  }
}
