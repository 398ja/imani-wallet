/**
 * imani-mailer: the shared outbound mailer (#410 owner edit 2; not gifting-specific).
 *
 * Callers name a TEMPLATE, one recipient and the template's fields. The mailer renders, checks and
 * hands the message to the configured transport; callers never build bodies, choose headers or
 * hold provider credentials. What it enforces, for every caller:
 *
 * - **Who may send what.** Each client has its own token and a list of templates it may use.
 * - **Templates only.** Typed fields, links limited to allowed hosts (templates.ts).
 * - **One recipient**, syntax-checked, then the recipient policy: allow/deny domains, suppressions
 *   after a hard bounce or complaint, and in staging a sandbox address that receives everything.
 * - **Idempotent.** An idempotency key sends at most once per client. The same key with a
 *   different request is a 409, never a silent no-op, and concurrent duplicates wait for the first.
 * - **Rate limited** per recipient, per client and globally (protects the sending reputation).
 * - **No addresses, bodies or links in logs.** A recipient is a keyed hash (`tag`).
 * - **Tracking off.** Nothing is rewritten, so a claim URL's fragment reaches the recipient (G-R4).
 */
import { createHmac, randomUUID } from 'node:crypto'

import type { ClientConfig, MailerConfig } from './config.ts'
import { checkUrl, isEmail, render, resolveFields, TemplateError } from './templates.ts'
import type { Store } from './store.ts'
import { TransportError, type Transport } from './transport.ts'

export interface SendRequest {
  template: string
  to: string
  fields?: Record<string, unknown>
  idempotencyKey: string
  /**
   * RFC 8058 one-click unsubscribe target for this one message (a reminder). Checked against the
   * link policy like a url field, then sent as `List-Unsubscribe` + `List-Unsubscribe-Post`. Never
   * logged (it carries a per-message token).
   */
  unsubscribeUrl?: string
}

export type SendOutcome =
  | { ok: true; status: 202; messageId: string; duplicate: boolean; sandboxed: boolean }
  | { ok: false; status: number; error: ErrorCode; message: string; retryable: boolean; retryAfterSeconds?: number }

export type ErrorCode =
  | 'invalid_request'
  | 'invalid_fields'
  | 'unknown_template'
  | 'template_not_allowed'
  | 'recipient_refused'
  | 'recipient_suppressed'
  | 'idempotency_conflict'
  | 'rate_limited'
  | 'transport_unavailable'
  | 'transport_rejected'

export const OUTCOME_LABELS = ['accepted', 'duplicate', 'refused', 'suppressed', 'rate_limited', 'conflict', 'invalid', 'transport_failed'] as const
type OutcomeLabel = (typeof OUTCOME_LABELS)[number]

export interface MailerDeps {
  config: MailerConfig
  transport: Transport
  store: Store
  now?: () => number
  log?: (line: Record<string, unknown>) => void
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_:.-]{8,200}$/

class Window {
  private readonly hits = new Map<string, number[]>()
  private readonly spanMs: number
  constructor(spanMs: number) {
    this.spanMs = spanMs
  }
  /** Seconds to wait, or 0 when one more hit fits under `limit` (and records it). */
  take(key: string, limit: number, now: number): number {
    const kept = (this.hits.get(key) ?? []).filter((t) => now - t < this.spanMs)
    if (kept.length >= limit) {
      this.hits.set(key, kept)
      return Math.max(1, Math.ceil((kept[0] + this.spanMs - now) / 1000))
    }
    kept.push(now)
    this.hits.set(key, kept)
    return 0
  }
  /** Give back a hit taken for a send that never happened. */
  give(key: string, at: number) {
    const kept = this.hits.get(key)
    const i = kept?.lastIndexOf(at) ?? -1
    if (kept && i >= 0) kept.splice(i, 1)
  }
  sweep(now: number) {
    for (const [k, v] of this.hits) if (v.every((t) => now - t >= this.spanMs)) this.hits.delete(k)
  }
}

export function createMailer(deps: MailerDeps) {
  const { config, transport, store } = deps
  const now = deps.now ?? (() => Date.now())
  const log = deps.log ?? ((line) => console.log(JSON.stringify(line)))
  const perRecipient = new Window(3_600_000)
  const perClient = new Window(60_000)
  const global = new Window(60_000)
  const inflight = new Map<string, Promise<SendOutcome>>()
  const counters = new Map<string, number>()
  const count = (template: string, outcome: OutcomeLabel) => {
    const k = `${template}\u0000${outcome}`
    counters.set(k, (counters.get(k) ?? 0) + 1)
  }

  /** The keyed hash a log line, a suppression and a sandbox header use for an address. */
  const tag = (address: string) => createHmac('sha256', config.tagKey).update(address.trim().toLowerCase()).digest('hex').slice(0, 16)

  const fingerprint = (req: SendRequest) => {
    const fields = Object.entries(req.fields ?? {}).sort(([a], [b]) => (a < b ? -1 : 1))
    return createHmac('sha256', config.tagKey)
      .update(JSON.stringify([req.template, req.to.trim().toLowerCase(), fields, ...(req.unsubscribeUrl ? [req.unsubscribeUrl] : [])]))
      .digest('hex')
  }

  const fail = (status: number, error: ErrorCode, message: string, retryable = false, retryAfterSeconds?: number): SendOutcome => ({
    ok: false,
    status,
    error,
    message,
    retryable,
    ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
  })

  const domainOf = (address: string) => address.slice(address.lastIndexOf('@') + 1).toLowerCase()
  const domainMatches = (domain: string, list: readonly string[]) => list.some((d) => domain === d || domain.endsWith(`.${d}`))

  async function deliver(client: ClientConfig, req: SendRequest, key: string): Promise<SendOutcome> {
    const to = req.to.trim()
    const recipientTag = tag(to)
    const base = { client: client.id, template: req.template, to: recipientTag, key: req.idempotencyKey }
    const fp = fingerprint(req)

    const prior = store.getSent(key)
    if (prior) {
      if (prior.fingerprint !== fp) {
        count(req.template, 'conflict')
        log({ event: 'mail_idempotency_conflict', ...base })
        return fail(409, 'idempotency_conflict', 'this idempotency key was already used for a different message')
      }
      count(req.template, 'duplicate')
      log({ event: 'mail_duplicate', ...base, messageId: prior.messageId })
      return { ok: true, status: 202, messageId: prior.messageId, duplicate: true, sandboxed: !!config.sandboxRedirect }
    }

    const compiled = config.templates.get(req.template)
    if (!compiled) {
      count('unknown', 'invalid')
      return fail(400, 'unknown_template', 'no such template')
    }
    let rendered
    try {
      rendered = render(compiled, resolveFields(compiled, req.fields ?? {}, config.links))
    } catch (e) {
      count(req.template, 'invalid')
      return fail(400, 'invalid_fields', e instanceof TemplateError ? e.message : 'the fields could not be rendered')
    }

    const domain = domainOf(to)
    if (domainMatches(domain, config.recipientDenyDomains) || (config.recipientAllowDomains && !domainMatches(domain, config.recipientAllowDomains))) {
      count(req.template, 'refused')
      log({ event: 'mail_recipient_refused', ...base })
      return fail(403, 'recipient_refused', 'this recipient domain is not allowed')
    }
    const suppressed = store.getSuppression(recipientTag)
    if (suppressed) {
      count(req.template, 'suppressed')
      log({ event: 'mail_suppressed', ...base, reason: suppressed.reason })
      return fail(409, 'recipient_suppressed', `this recipient is suppressed (${suppressed.reason})`)
    }

    const t = now()
    const waits: Array<[Window, string]> = []
    for (const [w, k, limit] of [
      [global, '*', config.limits.globalPerMinute],
      [perClient, client.id, client.perMinute],
      [perRecipient, recipientTag, config.limits.perRecipientPerHour],
    ] as const) {
      const wait = w.take(k, limit, t)
      if (wait) {
        for (const [taken, tk] of waits) taken.give(tk, t)
        count(req.template, 'rate_limited')
        log({ event: 'mail_rate_limited', ...base, scope: w === global ? 'global' : w === perClient ? 'client' : 'recipient' })
        return fail(429, 'rate_limited', 'too many emails; try again later', true, wait)
      }
      waits.push([w, k])
    }

    const messageId = `<${randomUUID()}@${config.messageIdDomain}>`
    const sandboxed = !!config.sandboxRedirect
    const headers: Record<string, string> = {
      'Auto-Submitted': 'auto-generated',
      'X-Auto-Response-Suppress': 'All',
      'X-Imani-Template': compiled.name,
    }
    if (sandboxed) headers['X-Imani-Sandbox-Recipient'] = recipientTag
    if (req.unsubscribeUrl) {
      headers['List-Unsubscribe'] = `<${req.unsubscribeUrl}>`
      headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click'
    }
    try {
      const result = await transport.send({
        to: sandboxed ? (config.sandboxRedirect as string) : to,
        fromName: rendered.fromName ?? config.fromName,
        subject: sandboxed ? `[sandbox] ${rendered.subject}` : rendered.subject,
        text: rendered.text,
        html: rendered.html,
        messageId,
        headers,
      })
      if (!result.accepted) throw new TransportError(`not accepted: ${result.response}`, true)
    } catch (e) {
      for (const [taken, tk] of waits) taken.give(tk, t)
      const transient = e instanceof TransportError ? e.transient : true
      count(req.template, 'transport_failed')
      log({ event: 'mail_transport_failed', ...base, transient, detail: e instanceof Error ? e.message : 'unknown' })
      return transient
        ? fail(503, 'transport_unavailable', 'the mail server did not accept the message; retry later', true, 30)
        : fail(502, 'transport_rejected', 'the mail server rejected the message', false)
    }
    store.putSent(key, { fingerprint: fp, messageId, at: t })
    count(req.template, 'accepted')
    log({ event: 'mail_accepted', ...base, messageId, sandboxed })
    return { ok: true, status: 202, messageId, duplicate: false, sandboxed }
  }

  return {
    tag,
    async send(client: ClientConfig, req: SendRequest): Promise<SendOutcome> {
      if (!req || typeof req !== 'object') return fail(400, 'invalid_request', 'expected a JSON object')
      const extra = Object.keys(req).filter((k) => !['template', 'to', 'fields', 'idempotencyKey', 'unsubscribeUrl'].includes(k))
      if (extra.length) return fail(400, 'invalid_request', `unknown property ${extra[0]}`)
      if (typeof req.template !== 'string' || !config.templates.has(req.template)) {
        count('unknown', 'invalid')
        return fail(400, 'unknown_template', 'no such template')
      }
      if (!client.templates.includes('*') && !client.templates.includes(req.template)) {
        count(req.template, 'refused')
        log({ event: 'mail_template_not_allowed', client: client.id, template: req.template })
        return fail(403, 'template_not_allowed', 'this client may not send that template')
      }
      if (typeof req.to !== 'string' || !isEmail(req.to.trim())) {
        count(req.template, 'invalid')
        return fail(400, 'invalid_request', 'to must be one email address')
      }
      if (req.fields !== undefined && (typeof req.fields !== 'object' || req.fields === null || Array.isArray(req.fields))) {
        count(req.template, 'invalid')
        return fail(400, 'invalid_request', 'fields must be an object')
      }
      if (typeof req.idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(req.idempotencyKey)) {
        count(req.template, 'invalid')
        return fail(400, 'invalid_request', 'idempotencyKey must be 8 to 200 of [A-Za-z0-9_:.-]')
      }
      if (req.unsubscribeUrl !== undefined) {
        const checked = typeof req.unsubscribeUrl === 'string' && req.unsubscribeUrl.length <= 2048 ? checkUrl(req.unsubscribeUrl.trim(), config.links) : null
        if (!checked) {
          count(req.template, 'invalid')
          return fail(400, 'invalid_request', 'unsubscribeUrl must be a link to an allowed host')
        }
        req = { ...req, unsubscribeUrl: checked }
      }
      // Namespaced per client: one caller's keys can never collide with, or probe, another's.
      const key = `${client.id}/${req.idempotencyKey}`
      const running = inflight.get(key)
      if (running) {
        await running.catch(() => undefined)
        return this.send(client, req)
      }
      const p = deliver(client, req, key)
      inflight.set(key, p)
      try {
        return await p
      } finally {
        inflight.delete(key)
      }
    },

    /** Record a hard bounce, complaint or manual block for an address. */
    suppress(client: ClientConfig, address: string, reason: 'hard-bounce' | 'complaint' | 'manual'): string {
      const t = tag(address)
      store.suppress(t, { reason, at: now() })
      log({ event: 'mail_suppression_added', client: client.id, to: t, reason })
      return t
    },

    /** Whether an address is suppressed, and why (a bounce check by a sender). Logs only the tag. */
    isSuppressed(client: ClientConfig, address: string): { suppressed: boolean; reason?: string } {
      const s = store.getSuppression(tag(address))
      log({ event: 'mail_suppression_checked', client: client.id, to: tag(address), suppressed: !!s })
      return s ? { suppressed: true, reason: s.reason } : { suppressed: false }
    },

    unsuppress(client: ClientConfig, address: string): boolean {
      const t = tag(address)
      const removed = store.unsuppress(t)
      log({ event: 'mail_suppression_removed', client: client.id, to: t, removed })
      return removed
    },

    housekeeping() {
      const t = now()
      store.prune(t)
      for (const w of [perRecipient, perClient, global]) w.sweep(t)
    },

    /** Prometheus text exposition. Labels are closed sets: template names and outcomes. */
    metrics(): string {
      const lines = [
        '# HELP imani_mailer_messages_total Send requests by template and outcome.',
        '# TYPE imani_mailer_messages_total counter',
      ]
      for (const [k, v] of counters) {
        const [template, outcome] = k.split('\u0000')
        lines.push(`imani_mailer_messages_total{template="${template}",outcome="${outcome}"} ${v}`)
      }
      const c = store.counts()
      lines.push(
        '# HELP imani_mailer_suppressed_recipients Recipients suppressed after a bounce or complaint.',
        '# TYPE imani_mailer_suppressed_recipients gauge',
        `imani_mailer_suppressed_recipients ${c.suppressed}`,
        '# HELP imani_mailer_idempotency_entries Remembered idempotency keys.',
        '# TYPE imani_mailer_idempotency_entries gauge',
        `imani_mailer_idempotency_entries ${c.sent}`,
      )
      return lines.join('\n') + '\n'
    },
  }
}

export type Mailer = ReturnType<typeof createMailer>
