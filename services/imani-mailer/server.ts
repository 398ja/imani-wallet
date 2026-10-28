/**
 * imani-mailer as a process: `POST /v1/send`, `POST /v1/bounce`, `GET /health`.
 *
 *   MAILER_TOKEN=… MAILER_FROM='Imani gifts <gifts@imani.casa>' MAILER_ALLOWED_HOSTS=imani.casa \
 *     npx tsx --tsconfig tsconfig.services.json services/imani-mailer/server.ts
 *
 * Callers authenticate with a bearer token (internal network only). No provider is wired yet: the
 * default provider REFUSES every send (fails closed, nothing leaves the box), and
 * `MAILER_PROVIDER=log` accepts and logs only the template and a recipient hash, for local runs.
 * A real provider (SPF/DKIM/DMARC on a dedicated sending domain, tracking off) plugs in as a
 * `Provider` and gets its secrets from the environment, never from a request.
 */
import { createServer } from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'

import { createMailer, type Provider } from './mailer.ts'

const refusing: Provider = {
  send: async () => {
    throw new Error('no mail provider configured')
  },
}
const logOnly: Provider = { send: async () => ({ id: `log-${randomUUID()}` }) }

function bearerOk(header: string | undefined, token: string): boolean {
  if (!token || !header?.startsWith('Bearer ')) return false
  const a = Buffer.from(header.slice(7))
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

function main() {
  const token = process.env.MAILER_TOKEN ?? ''
  if (!token) {
    console.error('[imani-mailer] refusing to start: MAILER_TOKEN is required')
    process.exit(1)
  }
  const mailer = createMailer({
    provider: process.env.MAILER_PROVIDER === 'log' ? logOnly : refusing,
    from: process.env.MAILER_FROM ?? 'Imani <gifts@imani.casa>',
    allowedHosts: (process.env.MAILER_ALLOWED_HOSTS ?? 'imani.casa').split(',').map((h) => h.trim()).filter(Boolean),
    now: () => Date.now(),
    log: (line) => console.log(JSON.stringify(line)),
  })
  const server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
    if (req.url === '/health') return send(200, { ok: true })
    if (!bearerOk(req.headers.authorization, token)) return send(401, { error: 'unauthorised' })
    let raw = ''
    for await (const chunk of req) {
      raw += chunk
      if (raw.length > 32 * 1024) return send(413, { error: 'too large' })
    }
    let body: Record<string, unknown>
    try {
      body = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return send(400, { error: 'not json' })
    }
    if (req.method === 'POST' && req.url === '/v1/send') {
      const out = await mailer.send(body as never)
      return send(out.status, out)
    }
    if (req.method === 'POST' && req.url === '/v1/bounce') {
      return send(200, { recipient: mailer.bounce(String(body.to ?? ''), body.hard === true) })
    }
    send(404, { error: 'no route' })
  })
  server.listen(Number(process.env.PORT ?? 8095), () => console.log('[imani-mailer] listening'))
}

if (process.argv[1]?.endsWith('server.ts')) main()
