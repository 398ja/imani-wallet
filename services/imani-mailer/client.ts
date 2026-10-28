/**
 * The client other services use to send through imani-mailer. Dependency free (fetch).
 *
 *   const mail = mailerClient({ baseUrl: process.env.MAILER_URL, token: process.env.MAILER_TOKEN })
 *   const out = await mail.send({ template: 'gift-claim', to, fields, idempotencyKey: `${eventId}:claim` })
 *   if (!out.ok && out.retryable) retry later; if (!out.ok) park it for a person.
 *
 * Never throws for an answer the mailer gave: every outcome is a value, and network failures come
 * back as `transport_unavailable` with `retryable: true`, so a caller cannot mistake "the mailer was
 * down" for "the mail was refused". Use the SAME idempotency key on every retry of one message.
 */
import type { SendOutcome, SendRequest } from './mailer.ts'

export interface MailerClientOptions {
  baseUrl: string
  token: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

export function mailerClient(opts: MailerClientOptions) {
  const base = opts.baseUrl.replace(/\/+$/, '')
  const f = opts.fetchImpl ?? fetch
  const timeout = opts.timeoutMs ?? 20_000
  return {
    async send(req: SendRequest): Promise<SendOutcome> {
      let res: Response
      try {
        res = await f(`${base}/v1/send`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${opts.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(req),
          signal: AbortSignal.timeout(timeout),
          redirect: 'error',
        })
      } catch {
        return { ok: false, status: 0, error: 'transport_unavailable', message: 'imani-mailer is unreachable', retryable: true }
      }
      let body: Record<string, unknown> = {}
      try {
        body = (await res.json()) as Record<string, unknown>
      } catch {
        // fall through with the status alone
      }
      if (res.status === 202 && body.ok === true) return body as SendOutcome
      return {
        ok: false,
        status: res.status,
        error: (typeof body.error === 'string' ? body.error : 'transport_unavailable') as never,
        message: typeof body.message === 'string' ? body.message : `imani-mailer answered ${res.status}`,
        // The mailer's own verdict wins (a 502 transport_rejected is permanent). Only an answer
        // that is not the mailer's (a proxy's 502/503, no JSON) falls back to the status code.
        retryable: typeof body.retryable === 'boolean' ? body.retryable : res.status === 429 || res.status >= 500,
        ...(typeof body.retryAfterSeconds === 'number' ? { retryAfterSeconds: body.retryAfterSeconds } : {}),
      }
    },
  }
}
