/**
 * imani-mailer: the shared outbound mailer (#410 owner edit 2; not gifting-specific).
 *
 * One small HTTP service that turns a TEMPLATE plus its fields into an email and hands it to a
 * provider. Callers (purchase-issuer first) never build email bodies and never hold provider
 * credentials. Rules it enforces for every caller:
 *
 * - **Templates only.** No free-form HTML or subjects from callers; fields are escaped plain text.
 * - **Link tracking off.** Nothing is rewritten, so a claim URL's fragment reaches the recipient
 *   untouched and no click tracker ever fetches it (G-R4).
 * - **No secrets or addresses in logs.** A log line names the template, a hash of the recipient
 *   and the caller's idempotency key. Never the address, the body or a URL.
 * - **Idempotent.** The same `idempotencyKey` sends once (one email per gift, G-R6).
 * - **Rate limited** per recipient, and **bounce-aware**: a hard bounce suppresses the address and
 *   is reported to the caller's webhook (the buyer is told; nothing is re-sent elsewhere).
 */
import { createHash } from 'node:crypto'

export type TemplateName = 'gift-claim' | 'gift-receipt' | 'gift-return-link' | 'gift-bounced' | 'gift-reminder'

export interface Rendered {
  subject: string
  text: string
}

const MAX_FIELD = 2000

/** Plain text in, plain text out: control characters and angle brackets are removed. */
export function clean(value: unknown, max = MAX_FIELD): string {
  if (typeof value !== 'string') return ''
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  return value.replace(/[\u0000-\u0008\u000B-\u001F\u007F<>]/g, '').slice(0, max).trim()
}

/** Only https URLs on an allowed host, so a template link cannot be pointed elsewhere. */
export function safeUrl(value: unknown, allowedHosts: readonly string[]): string | null {
  if (typeof value !== 'string') return null
  try {
    const u = new URL(value)
    if (u.protocol !== 'https:' || !allowedHosts.includes(u.host)) return null
    return u.toString()
  } catch {
    return null
  }
}

export class TemplateError extends Error {}

const FOOTER = 'Imani never asks for card details or passwords. If you did not expect this email, you can ignore it.'

/**
 * Render a template. Throws `TemplateError` on a missing or unsafe field rather than sending a
 * broken email. Secrets reach the body only through `url` fields, and never the subject.
 */
export function render(name: TemplateName, fields: Record<string, unknown>, allowedHosts: readonly string[]): Rendered {
  const f = (k: string, max?: number) => clean(fields[k], max)
  const url = (k: string) => {
    const u = safeUrl(fields[k], allowedHosts)
    if (!u) throw new TemplateError(`${k} must be an https link on an allowed host`)
    return u
  }
  const need = (...ks: string[]) => {
    for (const k of ks) if (!f(k)) throw new TemplateError(`${k} is required`)
  }
  const from = f('from', 80) || 'Someone'
  const message = f('message', 280)
  switch (name) {
    case 'gift-claim':
      need('stall', 'amount', 'claimBy')
      return {
        subject: `${from} sent you a voucher for ${f('stall', 120)}`,
        text: [
          `${from} sent you a ${f('amount', 40)} voucher for ${f('stall', 120)}.`,
          ...(message ? ['', message] : []),
          '',
          `Claim it by ${f('claimBy', 60)}:`,
          url('claimUrl'),
          '',
          'Open the link, create or open an Imani wallet, and tap Claim.',
          "Anyone with this link can claim it. Don't forward it.",
          '',
          FOOTER,
        ].join('\n'),
      }
    case 'gift-receipt':
      need('stall', 'amount', 'recipient')
      return {
        subject: `Your ${f('stall', 120)} voucher gift`,
        text: [
          `You paid ${f('amount', 40)} to ${f('stall', 120)} for a voucher for ${f('recipient', 320)}.`,
          'The recipient may need to check their spam folder.',
          'Refunds are the stall’s decision.',
          '',
          FOOTER,
        ].join('\n'),
      }
    case 'gift-return-link':
      need('stall', 'claimBy')
      return {
        subject: `If your ${f('stall', 120)} gift isn't claimed`,
        text: [
          `If your gift isn't claimed by ${f('claimBy', 60)}, use this link to take it back into a wallet:`,
          url('returnUrl'),
          '',
          'Keep it private: it is yours, not the recipient’s.',
          '',
          FOOTER,
        ].join('\n'),
      }
    case 'gift-bounced':
      need('recipient')
      return {
        subject: "We couldn't deliver your gift",
        text: [
          `We couldn't deliver to ${f('recipient', 320)}.`,
          'The gift is still safe. Take it back with your return link, or from Activity in your wallet.',
          '',
          FOOTER,
        ].join('\n'),
      }
    case 'gift-reminder':
      need('stall', 'when')
      return {
        subject: `Your ${f('stall', 120)} gift: ${f('when', 60)}`,
        text: [`A reminder about your ${f('stall', 120)} gift: ${f('when', 60)}.`, url('returnUrl'), '', FOOTER].join('\n'),
      }
    default:
      throw new TemplateError('unknown template')
  }
}

/** What a log line may say about a recipient: a short hash, never the address. */
export function recipientTag(address: string): string {
  return createHash('sha256').update(address.trim().toLowerCase()).digest('hex').slice(0, 12)
}

export interface Provider {
  /** Hand one message to the provider. Resolves with its id once ACCEPTED (§4c.4). Tracking must be off. */
  send(message: { to: string; from: string; subject: string; text: string }): Promise<{ id: string }>
}

export interface MailerDeps {
  provider: Provider
  from: string
  allowedHosts: readonly string[]
  now(): number
  log(line: Record<string, unknown>): void
  /** Per-recipient sends per hour (a service limit, not a purchase cap). */
  perRecipientPerHour?: number
}

export type SendResult =
  | { status: 202; id: string; duplicate: boolean }
  | { status: 400 | 409 | 429 | 502; error: string }

const EMAIL = /^[^\s@<>()[\]\\,;:"]{1,64}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i

export function createMailer(deps: MailerDeps) {
  const sent = new Map<string, string>()
  const suppressed = new Set<string>()
  const recent = new Map<string, number[]>()
  const limit = deps.perRecipientPerHour ?? 10

  return {
    async send(req: { template: TemplateName; to: string; fields: Record<string, unknown>; idempotencyKey: string }): Promise<SendResult> {
      const to = typeof req.to === 'string' ? req.to.trim() : ''
      if (!EMAIL.test(to) || to.length > 254) return { status: 400, error: 'bad recipient' }
      if (typeof req.idempotencyKey !== 'string' || !/^[\w:.-]{8,200}$/.test(req.idempotencyKey)) return { status: 400, error: 'bad idempotency key' }
      const tag = recipientTag(to)
      const already = sent.get(req.idempotencyKey)
      if (already) return { status: 202, id: already, duplicate: true }
      if (suppressed.has(tag)) return { status: 409, error: 'recipient suppressed after a hard bounce' }
      const now = deps.now()
      const window = (recent.get(tag) ?? []).filter((t) => now - t < 3_600_000)
      if (window.length >= limit) return { status: 429, error: 'too many emails to this recipient' }
      let rendered: Rendered
      try {
        rendered = render(req.template, req.fields ?? {}, deps.allowedHosts)
      } catch (e) {
        return { status: 400, error: e instanceof TemplateError ? e.message : 'bad template' }
      }
      try {
        const { id } = await deps.provider.send({ to, from: deps.from, subject: rendered.subject, text: rendered.text })
        sent.set(req.idempotencyKey, id)
        recent.set(tag, [...window, now])
        deps.log({ event: 'mail_accepted', template: req.template, to: tag, key: req.idempotencyKey, id })
        return { status: 202, id, duplicate: false }
      } catch {
        deps.log({ event: 'mail_failed', template: req.template, to: tag, key: req.idempotencyKey })
        return { status: 502, error: 'the mail provider did not accept the message' }
      }
    },
    /** Provider bounce webhook: a hard bounce suppresses the address. Answers the tag to notify on. */
    bounce(to: string, hard: boolean): string {
      const tag = recipientTag(to)
      if (hard) suppressed.add(tag)
      deps.log({ event: hard ? 'mail_hard_bounce' : 'mail_soft_bounce', to: tag })
      return tag
    },
  }
}
