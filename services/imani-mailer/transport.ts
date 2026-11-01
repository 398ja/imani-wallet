/**
 * Transports: where a rendered message goes.
 *
 * - `smtp`   nodemailer over SMTP. `tls` (implicit, 465), `starttls` (587, and STARTTLS is
 *            REQUIRED: a server that does not offer it is refused rather than spoken to in clear
 *            text) or `none` (development, e.g. Mailpit). Certificates are verified against the
 *            system store plus MAILER_SMTP_CA_FILE; TLS 1.2 minimum. Optional DKIM signing.
 * - `log`    accepts and logs nothing but an id (development).
 * - `refuse` refuses every message (the default, so an unconfigured mailer sends nothing).
 *
 * The message is built HERE, from parts the mailer already checked: one To, the service's own
 * From, a fixed Subject. nodemailer encodes headers, so a value can never add a header, and the
 * envelope is set explicitly so it always matches the headers.
 */
import { isIP } from 'node:net'

import { createTransport, type Transporter } from 'nodemailer'
import type SMTPPool from 'nodemailer/lib/smtp-pool'

import type { MailerConfig } from './config.ts'

export interface OutgoingMessage {
  to: string
  fromName: string
  subject: string
  text: string
  html: string | null
  messageId: string
  /** Extra headers the MAILER sets (never caller-supplied). */
  headers: Record<string, string>
}

export interface Transport {
  readonly kind: string
  /** Resolves once the next hop ACCEPTED the message (2xx after DATA). */
  send(message: OutgoingMessage): Promise<{ accepted: boolean; response: string }>
  /** Is the next hop reachable and willing (EHLO, STARTTLS, AUTH)? For /ready. */
  verify(): Promise<boolean>
  close(): void
}

export class TransportError extends Error {
  /** True when retrying the same message later could work (4xx, network). */
  readonly transient: boolean
  constructor(message: string, transient: boolean) {
    super(message)
    this.transient = transient
  }
}

export function createSmtpTransport(config: MailerConfig): Transport {
  const s = config.smtp
  if (!s) throw new Error('smtp transport without smtp config')
  // Typed as the pool's options (a superset); `pool: false` makes nodemailer use one connection per message.
  const options: SMTPPool.Options = {
    host: s.host,
    port: s.port,
    secure: s.security === 'tls',
    requireTLS: s.security === 'starttls',
    ignoreTLS: s.security === 'none',
    ...(s.user && s.password ? { auth: { user: s.user, pass: s.password } } : {}),
    ...(s.clientName ? { name: s.clientName } : {}),
    pool: s.pool as true,
    maxConnections: s.maxConnections,
    connectionTimeout: s.connectionTimeoutMs,
    greetingTimeout: s.connectionTimeoutMs,
    socketTimeout: s.socketTimeoutMs,
    disableFileAccess: true,
    disableUrlAccess: true,
    tls: {
      rejectUnauthorized: s.rejectUnauthorized,
      minVersion: s.minTlsVersion,
      ...(s.ca ? { ca: [s.ca] } : {}),
      // SNI is a host name; an IP address is verified against the certificate's IP SANs instead.
      ...(isIP(s.host) ? {} : { servername: s.host }),
    },
    ...(config.dkim
      ? { dkim: { domainName: config.dkim.domain, keySelector: config.dkim.selector, privateKey: config.dkim.privateKey } }
      : {}),
    logger: false,
    debug: false,
  }
  const transporter: Transporter = createTransport(options)
  return {
    kind: 'smtp',
    async send(m) {
      try {
        const info = await transporter.sendMail({
          from: { name: m.fromName, address: config.fromAddress },
          to: m.to,
          ...(config.replyTo ? { replyTo: config.replyTo } : {}),
          subject: m.subject,
          text: m.text,
          ...(m.html ? { html: m.html } : {}),
          messageId: m.messageId,
          headers: m.headers,
          envelope: { from: config.fromAddress, to: [m.to] },
          disableFileAccess: true,
          disableUrlAccess: true,
          textEncoding: 'quoted-printable',
        })
        const accepted = Array.isArray(info.accepted) && info.accepted.length === 1
        return { accepted, response: String(info.response ?? '').slice(0, 200) }
      } catch (e) {
        const err = e as { responseCode?: number; code?: string; command?: string; message?: string }
        const code = err.responseCode
        // Permanent only when the server refused THIS message (5xx to MAIL, RCPT or DATA). A 5xx to
        // AUTH, a certificate the mailer will not trust, or a server without STARTTLS is the
        // deployment's problem, not the message's: the caller keeps it and retries once fixed.
        const permanent = code !== undefined && code >= 500 && /^(MAIL|RCPT|DATA)/i.test(err.command ?? 'DATA')
        throw new TransportError(
          `${err.code ?? 'SMTP'}${code ? ` ${code}` : ''}: ${(err.message ?? 'send failed').split('\n')[0].slice(0, 200)}`,
          !permanent,
        )
      }
    },
    async verify() {
      try {
        await transporter.verify()
        return true
      } catch {
        return false
      }
    },
    close() {
      transporter.close()
    },
  }
}

let logCounter = 0
export function createLogTransport(): Transport {
  return {
    kind: 'log',
    async send() {
      logCounter += 1
      return { accepted: true, response: `250 logged ${logCounter}` }
    },
    async verify() {
      return true
    },
    close() {},
  }
}

export function createRefusingTransport(): Transport {
  return {
    kind: 'refuse',
    async send() {
      throw new TransportError('no mail transport is configured (MAILER_TRANSPORT=refuse)', false)
    },
    async verify() {
      return false
    },
    close() {},
  }
}

export function transportFor(config: MailerConfig): Transport {
  if (config.transport === 'smtp') return createSmtpTransport(config)
  if (config.transport === 'log') return createLogTransport()
  return createRefusingTransport()
}
