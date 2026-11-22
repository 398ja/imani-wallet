/**
 * imani-mailer configuration: environment first, files for anything secret or structured.
 *
 * Fail closed. Anything missing or contradictory refuses the boot with every problem listed at
 * once, and MAILER_ENV defaults to `production`, whose rules a local stack has to opt out of with
 * MAILER_ENV=development rather than a production deployment having to opt in.
 *
 * Every secret can come from a file (`<NAME>_FILE`), which is how Docker and Kubernetes secrets
 * mount; setting both the variable and its _FILE is refused, so there is never a question of which
 * one won. See README.md for the full list.
 */
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

import { BUILTIN_TEMPLATES } from './builtins.ts'
import { compile, isEmail, TemplateError, type CompiledTemplate, type LinkPolicy, type TemplateDef } from './templates.ts'

export type SmtpSecurity = 'tls' | 'starttls' | 'none'

export interface SmtpConfig {
  host: string
  port: number
  security: SmtpSecurity
  user: string | null
  password: string | null
  /** PEM bundle trusted for the server certificate, in addition to (not instead of) the system CAs. */
  ca: string | null
  rejectUnauthorized: boolean
  minTlsVersion: 'TLSv1.2' | 'TLSv1.3'
  /** Name sent in EHLO. */
  clientName: string | null
  pool: boolean
  maxConnections: number
  connectionTimeoutMs: number
  socketTimeoutMs: number
}

export interface DkimConfig {
  domain: string
  selector: string
  privateKey: string
}

export interface ClientConfig {
  id: string
  /** sha256 of the bearer token, hex. The token itself never sits in configuration. */
  tokenSha256: string
  /** Templates this client may send, or ['*']. */
  templates: readonly string[]
  /** May report bounces and lift suppressions (a provider webhook, an operator tool). */
  bounce: boolean
  /** May ask whether an address is suppressed (`POST /v1/suppressions/check`), nothing more. */
  check?: boolean
  /** Sends per minute for this client. */
  perMinute: number
}

export interface MailerConfig {
  env: 'production' | 'development'
  host: string
  port: number
  transport: 'smtp' | 'log' | 'refuse'
  smtp: SmtpConfig | null
  dkim: DkimConfig | null
  fromAddress: string
  fromName: string
  replyTo: string | null
  /** The right-hand side of Message-ID. */
  messageIdDomain: string
  links: LinkPolicy
  recipientAllowDomains: readonly string[] | null
  recipientDenyDomains: readonly string[]
  /** Staging: every message goes to this address instead (the original is never written into it). */
  sandboxRedirect: string | null
  clients: readonly ClientConfig[]
  templates: ReadonlyMap<string, CompiledTemplate>
  limits: { perRecipientPerHour: number; globalPerMinute: number; maxBodyBytes: number }
  /** HMAC key for recipient tags in logs and for idempotency fingerprints. */
  tagKey: Buffer
  stateFile: string | null
  idempotencyTtlHours: number
  metricsToken: string | null
}

export class ConfigError extends Error {
  readonly problems: string[]
  constructor(problems: string[]) {
    super(`imani-mailer configuration refused:\n  - ${problems.join('\n  - ')}`)
    this.problems = problems
  }
}

type Env = Record<string, string | undefined>

const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
const HOSTPORT = /^(?:localhost|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?::\d{1,5})?$/

export function loadConfig(env: Env = process.env, readFile: (path: string) => string = (p) => readFileSync(p, 'utf8')): MailerConfig {
  const problems: string[] = []
  const str = (name: string): string | null => {
    const v = env[name]
    return v === undefined || v.trim() === '' ? null : v.trim()
  }
  /** A value that may come from NAME or NAME_FILE, never both. */
  const secret = (name: string): string | null => {
    const direct = env[name]
    const file = str(`${name}_FILE`)
    if (direct !== undefined && direct !== '' && file) {
      problems.push(`${name} and ${name}_FILE are both set; use one`)
      return null
    }
    if (file) {
      try {
        return readFile(file).trim() || null
      } catch {
        problems.push(`${name}_FILE (${file}) cannot be read`)
        return null
      }
    }
    return direct === undefined || direct.trim() === '' ? null : direct.trim()
  }
  const int = (name: string, fallback: number, min: number, max: number): number => {
    const raw = str(name)
    if (raw === null) return fallback
    const n = Number(raw)
    if (!Number.isInteger(n) || n < min || n > max) {
      problems.push(`${name} must be an integer from ${min} to ${max}`)
      return fallback
    }
    return n
  }
  const bool = (name: string, fallback: boolean): boolean => {
    const raw = str(name)
    if (raw === null) return fallback
    if (/^(1|true|yes|on)$/i.test(raw)) return true
    if (/^(0|false|no|off)$/i.test(raw)) return false
    problems.push(`${name} must be true or false`)
    return fallback
  }
  const list = (name: string): string[] =>
    (str(name) ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)

  const envName = (str('MAILER_ENV') ?? 'production').toLowerCase()
  if (envName !== 'production' && envName !== 'development') problems.push('MAILER_ENV must be production or development')
  const production = envName !== 'development'

  // ---- sender
  const fromAddress = str('MAILER_FROM_ADDRESS') ?? ''
  if (!isEmail(fromAddress)) problems.push('MAILER_FROM_ADDRESS must be an email address')
  const fromName = str('MAILER_FROM_NAME') ?? 'Imani'
  if (/[\r\n<>"]/.test(fromName) || fromName.length > 80) problems.push('MAILER_FROM_NAME must be one short line without <, > or "')
  const replyTo = str('MAILER_REPLY_TO')
  if (replyTo && !isEmail(replyTo)) problems.push('MAILER_REPLY_TO must be an email address')
  const messageIdDomain = (str('MAILER_MESSAGE_ID_DOMAIN') ?? fromAddress.split('@')[1] ?? '').toLowerCase()
  if (!DOMAIN.test(messageIdDomain)) problems.push('MAILER_MESSAGE_ID_DOMAIN must be a domain')

  // ---- links
  const linkHosts = list('MAILER_LINK_HOSTS')
  if (linkHosts.length === 0) problems.push('MAILER_LINK_HOSTS is required: the hosts template links may point at')
  for (const h of linkHosts) if (!HOSTPORT.test(h)) problems.push(`MAILER_LINK_HOSTS: "${h}" is not a host[:port]`)
  const allowHttp = bool('MAILER_LINK_ALLOW_HTTP', false)
  if (allowHttp && production) problems.push('MAILER_LINK_ALLOW_HTTP is for development only')

  // ---- recipients
  const allow = list('MAILER_RECIPIENT_ALLOW_DOMAINS')
  const deny = list('MAILER_RECIPIENT_DENY_DOMAINS')
  for (const d of [...allow, ...deny]) if (!DOMAIN.test(d)) problems.push(`recipient domain "${d}" is not a domain`)
  const sandboxRedirect = str('MAILER_SANDBOX_REDIRECT')
  if (sandboxRedirect && !isEmail(sandboxRedirect)) problems.push('MAILER_SANDBOX_REDIRECT must be an email address')

  // ---- transport
  const transport = (str('MAILER_TRANSPORT') ?? 'refuse').toLowerCase()
  if (!['smtp', 'log', 'refuse'].includes(transport)) problems.push('MAILER_TRANSPORT must be smtp, log or refuse')
  if (production && transport !== 'smtp') problems.push(`MAILER_TRANSPORT=${transport} is for development only; production sends over smtp`)
  let smtp: SmtpConfig | null = null
  if (transport === 'smtp') {
    const host = str('MAILER_SMTP_HOST') ?? ''
    if (!host) problems.push('MAILER_SMTP_HOST is required for MAILER_TRANSPORT=smtp')
    const security = (str('MAILER_SMTP_SECURITY') ?? 'starttls').toLowerCase() as SmtpSecurity
    if (!['tls', 'starttls', 'none'].includes(security)) problems.push('MAILER_SMTP_SECURITY must be tls, starttls or none')
    if (security === 'none' && production) problems.push('MAILER_SMTP_SECURITY=none sends in clear text; development only')
    const user = str('MAILER_SMTP_USER')
    const password = secret('MAILER_SMTP_PASSWORD')
    if (!!user !== !!password) problems.push('MAILER_SMTP_USER and MAILER_SMTP_PASSWORD come together')
    if (user && security === 'none' && !bool('MAILER_SMTP_ALLOW_PLAINTEXT_AUTH', false)) {
      problems.push('SMTP credentials over an unencrypted connection; set MAILER_SMTP_ALLOW_PLAINTEXT_AUTH=true (development) or use TLS')
    }
    const caFile = str('MAILER_SMTP_CA_FILE')
    let ca: string | null = null
    if (caFile) {
      try {
        ca = readFile(caFile)
      } catch {
        problems.push(`MAILER_SMTP_CA_FILE (${caFile}) cannot be read`)
      }
    }
    const rejectUnauthorized = bool('MAILER_SMTP_TLS_VERIFY', true)
    if (!rejectUnauthorized && production) problems.push('MAILER_SMTP_TLS_VERIFY=false is for development only')
    const minTls = str('MAILER_SMTP_TLS_MIN_VERSION') ?? 'TLSv1.2'
    if (minTls !== 'TLSv1.2' && minTls !== 'TLSv1.3') problems.push('MAILER_SMTP_TLS_MIN_VERSION must be TLSv1.2 or TLSv1.3')
    smtp = {
      host,
      port: int('MAILER_SMTP_PORT', security === 'tls' ? 465 : 587, 1, 65535),
      security,
      user,
      password,
      ca,
      rejectUnauthorized,
      minTlsVersion: minTls as SmtpConfig['minTlsVersion'],
      clientName: str('MAILER_SMTP_CLIENT_NAME'),
      pool: bool('MAILER_SMTP_POOL', true),
      maxConnections: int('MAILER_SMTP_MAX_CONNECTIONS', 3, 1, 50),
      connectionTimeoutMs: int('MAILER_SMTP_CONNECT_TIMEOUT_MS', 10_000, 500, 120_000),
      socketTimeoutMs: int('MAILER_SMTP_SOCKET_TIMEOUT_MS', 30_000, 1_000, 300_000),
    }
  }

  // ---- DKIM
  let dkim: DkimConfig | null = null
  const dkimKey = secret('MAILER_DKIM_PRIVATE_KEY')
  const dkimDomain = str('MAILER_DKIM_DOMAIN')
  const dkimSelector = str('MAILER_DKIM_SELECTOR')
  if (dkimKey || dkimDomain || dkimSelector) {
    if (!dkimKey || !dkimDomain || !dkimSelector) problems.push('DKIM needs MAILER_DKIM_DOMAIN, MAILER_DKIM_SELECTOR and MAILER_DKIM_PRIVATE_KEY(_FILE) together')
    else if (!/-----BEGIN (RSA )?PRIVATE KEY-----/.test(dkimKey)) problems.push('MAILER_DKIM_PRIVATE_KEY must be a PEM private key')
    else if (!DOMAIN.test(dkimDomain.toLowerCase())) problems.push('MAILER_DKIM_DOMAIN must be a domain')
    else if (!/^[a-z0-9][a-z0-9._-]{0,62}$/i.test(dkimSelector)) problems.push('MAILER_DKIM_SELECTOR is not a selector')
    else dkim = { domain: dkimDomain.toLowerCase(), selector: dkimSelector, privateKey: dkimKey }
  }
  if (dkim && fromAddress && !fromAddress.toLowerCase().endsWith(`@${dkim.domain}`) && !fromAddress.toLowerCase().endsWith(`.${dkim.domain}`)) {
    problems.push('MAILER_DKIM_DOMAIN must be the From domain (or its parent), or DMARC will not align')
  }

  // ---- templates
  const templates = new Map<string, CompiledTemplate>()
  const defs: Record<string, TemplateDef> = { ...BUILTIN_TEMPLATES }
  const templatesFile = str('MAILER_TEMPLATES_FILE')
  if (templatesFile) {
    try {
      const parsed = JSON.parse(readFile(templatesFile)) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
      Object.assign(defs, parsed)
    } catch (e) {
      problems.push(`MAILER_TEMPLATES_FILE (${templatesFile}): ${(e as Error).message}`)
    }
  }
  for (const [name, def] of Object.entries(defs)) {
    try {
      templates.set(name, compile(name, def))
    } catch (e) {
      problems.push(e instanceof TemplateError ? e.message : `${name}: ${(e as Error).message}`)
    }
  }

  // ---- clients
  const clients: ClientConfig[] = []
  const clientsRaw = secret('MAILER_CLIENTS')
  if (!clientsRaw) problems.push('MAILER_CLIENTS (or MAILER_CLIENTS_FILE) is required: who may send, and what')
  else {
    let parsed: unknown
    try {
      parsed = JSON.parse(clientsRaw)
    } catch {
      problems.push('MAILER_CLIENTS is not JSON')
    }
    if (parsed !== undefined) {
      if (!Array.isArray(parsed) || parsed.length === 0) problems.push('MAILER_CLIENTS must be a non-empty array')
      else {
        const ids = new Set<string>()
        const hashes = new Set<string>()
        parsed.forEach((c: Record<string, unknown>, i) => {
          const where = `MAILER_CLIENTS[${i}]`
          const id = typeof c?.id === 'string' ? c.id : ''
          if (!/^[a-z][a-z0-9-]{1,63}$/.test(id)) return problems.push(`${where}.id must be [a-z0-9-]`)
          if (ids.has(id)) return problems.push(`${where}: duplicate id ${id}`)
          ids.add(id)
          const hash = typeof c.tokenSha256 === 'string' ? c.tokenSha256.toLowerCase() : ''
          if (!/^[0-9a-f]{64}$/.test(hash)) return problems.push(`${where}.tokenSha256 must be 64 hex (run: tsx services/imani-mailer/cli.ts token ${id})`)
          if (hashes.has(hash)) return problems.push(`${where}: shares a token with another client`)
          hashes.add(hash)
          const tpl = Array.isArray(c.templates) ? c.templates.filter((t): t is string => typeof t === 'string') : []
          if (tpl.length === 0 && c.bounce !== true) return problems.push(`${where} may do nothing: give it templates or bounce`)
          for (const t of tpl) if (t !== '*' && !templates.has(t) && !defs[t]) problems.push(`${where}: unknown template ${t}`)
          if (tpl.includes('*') && production) problems.push(`${where}: "*" templates is for development; list them`)
          const perMinute = c.perMinute === undefined ? 60 : Number(c.perMinute)
          if (!Number.isInteger(perMinute) || perMinute < 1 || perMinute > 100_000) return problems.push(`${where}.perMinute is out of range`)
          clients.push({ id, tokenSha256: hash, templates: tpl, bounce: c.bounce === true, check: c.check === true, perMinute })
        })
      }
    }
  }

  // ---- state and keys
  const tagKeyRaw = secret('MAILER_TAG_KEY')
  let tagKey: Buffer
  if (tagKeyRaw) {
    if (!/^[0-9a-f]{64,}$/i.test(tagKeyRaw)) problems.push('MAILER_TAG_KEY must be at least 32 bytes of hex (openssl rand -hex 32)')
    tagKey = Buffer.from(tagKeyRaw, 'hex')
  } else {
    if (production) problems.push('MAILER_TAG_KEY is required: recipient tags in logs and suppressions are keyed with it')
    tagKey = randomBytes(32)
  }
  const stateFile = str('MAILER_STATE_FILE')
  if (!stateFile && production) problems.push('MAILER_STATE_FILE is required: idempotency and suppressions must survive a restart')

  const metricsToken = secret('MAILER_METRICS_TOKEN')
  if (metricsToken && metricsToken.length < 24) problems.push('MAILER_METRICS_TOKEN must be at least 24 characters')

  const config: MailerConfig = {
    env: production ? 'production' : 'development',
    host: str('MAILER_HOST') ?? '0.0.0.0',
    port: int('MAILER_PORT', 8095, 0, 65535),
    transport: transport as MailerConfig['transport'],
    smtp,
    dkim,
    fromAddress,
    fromName,
    replyTo,
    messageIdDomain,
    links: { hosts: linkHosts, allowHttp },
    recipientAllowDomains: allow.length ? allow : null,
    recipientDenyDomains: deny,
    sandboxRedirect,
    clients,
    templates,
    limits: {
      perRecipientPerHour: int('MAILER_RATE_PER_RECIPIENT_HOUR', 10, 1, 10_000),
      globalPerMinute: int('MAILER_RATE_GLOBAL_MINUTE', 600, 1, 1_000_000),
      maxBodyBytes: int('MAILER_MAX_BODY_BYTES', 32 * 1024, 1024, 1024 * 1024),
    },
    tagKey,
    stateFile,
    idempotencyTtlHours: int('MAILER_IDEMPOTENCY_TTL_HOURS', 168, 1, 24 * 90),
    metricsToken,
  }
  if (problems.length) throw new ConfigError(problems)
  return config
}

/** What the boot log may say about the configuration: shape only, no secrets, no tokens. */
export function describeConfig(c: MailerConfig): Record<string, unknown> {
  return {
    env: c.env,
    transport: c.transport,
    smtp: c.smtp && {
      host: c.smtp.host,
      port: c.smtp.port,
      security: c.smtp.security,
      auth: !!c.smtp.user,
      customCa: !!c.smtp.ca,
      verify: c.smtp.rejectUnauthorized,
      minTls: c.smtp.minTlsVersion,
    },
    dkim: c.dkim ? `${c.dkim.selector}._domainkey.${c.dkim.domain}` : null,
    from: c.fromAddress,
    linkHosts: c.links.hosts,
    sandbox: !!c.sandboxRedirect,
    recipientAllow: c.recipientAllowDomains,
    recipientDeny: c.recipientDenyDomains.length,
    clients: c.clients.map((k) => ({ id: k.id, templates: k.templates, bounce: k.bounce, check: !!k.check })),
    templates: [...c.templates.keys()],
    persistent: !!c.stateFile,
  }
}
