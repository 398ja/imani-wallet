/**
 * imani-mailer as a process. Internal network only; never exposed through the edge.
 *
 *   POST   /v1/send           send one templated email                  (client token, template scope)
 *   POST   /v1/suppressions   {to, reason}: hard bounce, complaint      (client token with bounce)
 *   DELETE /v1/suppressions   {to}: lift a suppression                  (client token with bounce)
 *   POST   /v1/suppressions/check {to}: is it suppressed (a bounce)     (client token with bounce or `check`)
 *   GET    /v1/templates      the templates this client may send, with their fields
 *   GET    /health            liveness, no auth
 *   GET    /ready             the transport answers EHLO (and STARTTLS/AUTH), no auth
 *   GET    /metrics           Prometheus; MAILER_METRICS_TOKEN as bearer when set
 *
 * Every request: bearer token compared in constant time against sha256 hashes (the tokens are not
 * in configuration), JSON only, body capped, unknown properties refused, header and request
 * timeouts, no CORS (browsers are not callers). Configuration: config.ts and README.md.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createHash, timingSafeEqual } from 'node:crypto'

import { ConfigError, describeConfig, loadConfig, type ClientConfig, type MailerConfig } from './config.ts'
import { describe as describeTemplate } from './templates.ts'
import { createMailer, type Mailer } from './mailer.ts'
import { createStore } from './store.ts'
import { transportFor, type Transport } from './transport.ts'

const SECURITY_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

/** The client a bearer token belongs to. Every client's hash is compared, so timing names none. */
export function authenticate(header: string | undefined, clients: readonly ClientConfig[]): ClientConfig | null {
  if (!header || !/^Bearer [\x21-\x7e]{16,512}$/.test(header)) return null
  const presented = sha256(header.slice(7))
  let found: ClientConfig | null = null
  for (const c of clients) {
    if (timingSafeEqual(presented, Buffer.from(c.tokenSha256, 'hex')) && !found) found = c
  }
  return found
}

class HttpError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
  if (type !== 'application/json') throw new HttpError(415, 'unsupported_media_type', 'send application/json')
  const declared = Number(req.headers['content-length'] ?? '0')
  if (declared > maxBytes) throw new HttpError(413, 'too_large', 'request body too large')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > maxBytes) throw new HttpError(413, 'too_large', 'request body too large')
    chunks.push(chunk as Buffer)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'invalid_json', 'the body is not JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(400, 'invalid_request', 'expected a JSON object')
  return parsed as Record<string, unknown>
}

export interface Running {
  server: Server
  mailer: Mailer
  transport: Transport
  url: string
  close(): Promise<void>
}

export function createApp(config: MailerConfig, opts: { transport?: Transport; log?: (line: Record<string, unknown>) => void } = {}) {
  const log = opts.log ?? ((line: Record<string, unknown>) => console.log(JSON.stringify(line)))
  const transport = opts.transport ?? transportFor(config)
  const store = createStore({ file: config.stateFile, ttlMs: config.idempotencyTtlHours * 3_600_000 })
  const mailer = createMailer({ config, transport, store, log })

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const reply = (status: number, body: unknown, extra: Record<string, string> = {}) => {
      if (res.headersSent) return
      res.writeHead(status, { ...SECURITY_HEADERS, ...extra })
      res.end(typeof body === 'string' ? body : JSON.stringify(body))
    }
    const path = (req.url ?? '/').split('?')[0]
    const method = req.method ?? 'GET'
    try {
      if (path === '/health' && method === 'GET') return reply(200, { ok: true })
      if (path === '/ready' && method === 'GET') {
        const ok = await transport.verify()
        return reply(ok ? 200 : 503, { ok, transport: transport.kind })
      }
      if (path === '/metrics' && method === 'GET') {
        if (config.metricsToken) {
          const h = req.headers.authorization ?? ''
          const a = sha256(h)
          const b = sha256(`Bearer ${config.metricsToken}`)
          if (!timingSafeEqual(a, b)) return reply(401, { error: 'unauthorised' })
        }
        res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; version=0.0.4' })
        return res.end(mailer.metrics())
      }

      const client = authenticate(req.headers.authorization, config.clients)
      if (!client) {
        log({ event: 'mail_unauthorised', path })
        return reply(401, { error: 'unauthorised', message: 'a valid bearer token is required' }, { 'WWW-Authenticate': 'Bearer' })
      }

      if (path === '/v1/send') {
        if (method !== 'POST') return reply(405, { error: 'method_not_allowed' }, { Allow: 'POST' })
        const body = await readJson(req, config.limits.maxBodyBytes)
        const out = await mailer.send(client, body as never)
        const headers: Record<string, string> = out.ok || !out.retryAfterSeconds ? {} : { 'Retry-After': String(out.retryAfterSeconds) }
        return reply(out.status, out, headers)
      }
      if (path === '/v1/suppressions/check') {
        // A sender asks whether a recipient it mailed has since hard-bounced (#410). POST so the
        // address travels in the body, never in a URL or an access log.
        if (!client.bounce && !client.check) return reply(403, { error: 'forbidden', message: 'this client may not check suppressions' })
        if (method !== 'POST') return reply(405, { error: 'method_not_allowed' }, { Allow: 'POST' })
        const body = await readJson(req, 4096)
        const extra = Object.keys(body).filter((k) => k !== 'to')
        if (extra.length) return reply(400, { error: 'invalid_request', message: `unknown property ${extra[0]}` })
        const to = typeof body.to === 'string' ? body.to.trim() : ''
        if (!to || to.length > 254 || !to.includes('@')) return reply(400, { error: 'invalid_request', message: 'to must be an email address' })
        return reply(200, mailer.isSuppressed(client, to))
      }
      if (path === '/v1/suppressions') {
        if (!client.bounce) return reply(403, { error: 'forbidden', message: 'this client may not manage suppressions' })
        if (method !== 'POST' && method !== 'DELETE') return reply(405, { error: 'method_not_allowed' }, { Allow: 'POST, DELETE' })
        const body = await readJson(req, 4096)
        const extra = Object.keys(body).filter((k) => !['to', 'reason'].includes(k))
        if (extra.length) return reply(400, { error: 'invalid_request', message: `unknown property ${extra[0]}` })
        const to = typeof body.to === 'string' ? body.to.trim() : ''
        if (!to || to.length > 254 || !to.includes('@')) return reply(400, { error: 'invalid_request', message: 'to must be an email address' })
        if (method === 'DELETE') return reply(200, { removed: mailer.unsuppress(client, to) })
        const reason = body.reason
        if (reason !== 'hard-bounce' && reason !== 'complaint' && reason !== 'manual') {
          return reply(400, { error: 'invalid_request', message: 'reason must be hard-bounce, complaint or manual' })
        }
        return reply(200, { suppressed: true, tag: mailer.suppress(client, to, reason) })
      }
      if (path === '/v1/templates' && method === 'GET') {
        const visible = [...config.templates.values()].filter((t) => client.templates.includes('*') || client.templates.includes(t.name))
        return reply(200, { templates: visible.map(describeTemplate) })
      }
      return reply(404, { error: 'not_found' })
    } catch (e) {
      if (e instanceof HttpError) return reply(e.status, { error: e.code, message: e.message })
      log({ event: 'mail_internal_error', path, detail: e instanceof Error ? e.message.slice(0, 200) : 'unknown' })
      return reply(500, { error: 'internal', message: 'internal error' })
    }
  }

  const server = createServer({ requestTimeout: 30_000, headersTimeout: 10_000, keepAliveTimeout: 5_000, maxHeaderSize: 8192 }, (req, res) => {
    void handler(req, res)
  })
  server.maxRequestsPerSocket = 1000
  const housekeeping = setInterval(() => mailer.housekeeping(), 60_000)
  housekeeping.unref()

  return {
    server,
    mailer,
    transport,
    listen(port = config.port, host = config.host): Promise<Running> {
      return new Promise((resolve) => {
        server.listen(port, host, () => {
          const addr = server.address()
          const p = typeof addr === 'object' && addr ? addr.port : port
          resolve({
            server,
            mailer,
            transport,
            url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${p}`,
            close: () =>
              new Promise<void>((done) => {
                clearInterval(housekeeping)
                server.close(() => {
                  transport.close()
                  done()
                })
                server.closeAllConnections()
              }),
          })
        })
      })
    },
  }
}

async function main() {
  let config: MailerConfig
  try {
    config = loadConfig()
  } catch (e) {
    console.error(e instanceof ConfigError ? e.message : `[imani-mailer] ${(e as Error).message}`)
    process.exit(1)
  }
  const app = createApp(config)
  const running = await app.listen()
  console.log(JSON.stringify({ event: 'mailer_started', url: running.url, config: describeConfig(config) }))
  if (!(await running.transport.verify())) {
    console.log(JSON.stringify({ event: 'mailer_transport_not_ready', transport: running.transport.kind }))
  }
  const stop = (signal: string) => {
    console.log(JSON.stringify({ event: 'mailer_stopping', signal }))
    void running.close().then(() => process.exit(0))
    setTimeout(() => process.exit(1), 10_000).unref()
  }
  process.on('SIGTERM', () => stop('SIGTERM'))
  process.on('SIGINT', () => stop('SIGINT'))
}

if (process.argv[1]?.endsWith('server.ts')) void main()
