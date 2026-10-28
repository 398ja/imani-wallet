/**
 * The gift form, its validation, and the Purchase Draft it becomes (#410 §2, §3).
 *
 * The form is kept in sessionStorage per shop so that signing in mid-flow, the Edit links on the
 * review page, and coming back from Stripe all find it again (§5). The draft itself lives on the
 * server: what the server pinned is what the review page shows and what gets delivered (G-R1).
 */

import { isNip05, normaliseRecipientHandle } from './handle'

export type DeliveryKind = 'self' | 'handle' | 'email'

export interface GiftForm {
  amount: string
  deliver: DeliveryKind
  handle: string
  email: string
  message: string
  from: string
  buyerEmail: string
}

export const EMPTY_FORM: GiftForm = {
  amount: '',
  deliver: 'handle',
  handle: '',
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
  ctx: { signedIn: boolean; decimals?: number; stallNip05?: string },
): FormErrors {
  const errors: FormErrors = {}
  if (toMinorUnits(form.amount, ctx.decimals) === null) errors.amount = 'Enter an amount like 25.00.'
  if (form.deliver === 'self' && !ctx.signedIn) errors.deliver = 'Sign in to send to yourself.'
  if (form.deliver === 'handle') {
    const h = normaliseRecipientHandle(form.handle)
    if (!h) errors.handle = 'Enter a handle like name@domain.'
    else if (ctx.stallNip05 && h === ctx.stallNip05) errors.handle = "You can't send a voucher to the stall that sells it."
  }
  if (form.deliver === 'email' && !isEmail(form.email)) errors.email = 'Enter an email address.'
  const m = messageProblem(form.message)
  if (m) errors.message = m
  if (form.from.length > FROM_MAX) errors.from = `Keep the name to ${FROM_MAX} characters.`
  if (!ctx.signedIn && !isEmail(form.buyerEmail)) errors.buyerEmail = 'We need your email for the receipt and the return link.'
  return errors
}

// ─── The draft, as the server pins it ───────────────────────────────────────

export interface DraftRequest {
  stallPubkey: string
  stallHandle: string
  amountMinor: number
  currency: string
  termsVersion: string
  delivery: {
    kind: DeliveryKind
    handle?: string
    email?: string
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
  delivery: {
    kind: DeliveryKind
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
    signedIn: boolean
  },
): DraftRequest {
  const amountMinor = toMinorUnits(form.amount, ctx.decimals)
  if (amountMinor === null) throw new Error('amount')
  const delivery: DraftRequest['delivery'] = { kind: form.deliver }
  if (form.deliver === 'handle') delivery.handle = normaliseRecipientHandle(form.handle) ?? undefined
  if (form.deliver === 'email') delivery.email = form.email.trim()
  if (form.deliver !== 'self') delivery.refundPubkey = ctx.refundPubkey
  if (form.deliver === 'email') delivery.sealed = ctx.sealed
  return {
    stallPubkey: ctx.stallPubkey,
    stallHandle: ctx.stallHandle,
    amountMinor,
    currency: ctx.currency.toUpperCase(),
    termsVersion: ctx.terms,
    delivery,
    message: form.message.trim() || undefined,
    from: form.from.trim() || undefined,
    buyerEmail: ctx.signedIn ? undefined : form.buyerEmail.trim(),
  }
}

/**
 * Does this draft deliver what the buyer reviewed? Checked when the server answers, so a server
 * (or a proxy) that pinned something else is caught before Pay is ever shown.
 */
export function draftMatches(draft: Draft, req: DraftRequest, expectedRecipient?: string): boolean {
  if (draft.stallPubkey !== req.stallPubkey || draft.amountMinor !== req.amountMinor) return false
  if (draft.currency.toUpperCase() !== req.currency) return false
  if (draft.delivery.kind !== req.delivery.kind) return false
  if (req.delivery.kind === 'email' && draft.delivery.email?.toLowerCase() !== req.delivery.email?.toLowerCase()) return false
  if (req.delivery.kind !== 'self' && draft.delivery.refundPubkey !== req.delivery.refundPubkey) return false
  if (expectedRecipient && draft.delivery.recipientPubkey !== expectedRecipient) return false
  return true
}

export function isExpired(draft: Pick<Draft, 'expiresAt'>, now = Date.now()): boolean {
  const t = Date.parse(draft.expiresAt)
  return !Number.isFinite(t) || t <= now
}

/** G11: 30 days, capped by the voucher expiry minus 24 h. `validityDays` 0 means it never expires. */
export function claimDeadline(issuedAt: number, validityDays: number, windowDays = 30): Date {
  const window = issuedAt + windowDays * 86_400_000
  if (!validityDays) return new Date(window)
  const cap = issuedAt + validityDays * 86_400_000 - 86_400_000
  return new Date(Math.min(window, cap))
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
    return { ...parsed, form: { ...EMPTY_FORM, ...(parsed.form ?? {}) } }
  } catch {
    return null
  }
}

function safeSession(): Storage | undefined {
  try {
    return typeof sessionStorage === 'undefined' ? undefined : sessionStorage
  } catch {
    return undefined
  }
}
