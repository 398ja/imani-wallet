/**
 * subscription.imani.casa's API, as a process: Node's http around `app.ts`.
 *
 *   docker build -f services/subscription/Dockerfile -t imani-subscription .
 *
 * Serves the API under /v1 and, when SUBSCRIPTION_STATIC_DIR is set, the built site
 * (`apps/subscription`) from the same origin, so the browser's NIP-98 `u` tag and the API share
 * one origin and no CORS is needed.
 */
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'

import { createApp } from './app.ts'
import { readConfig, ConfigError } from './config.ts'
import { LicenceIssuer, sellerFrom } from './issuer.ts'
import { Ledger } from './ledger.ts'
import { stripeClient } from './stripe.ts'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
}

async function main() {
  let config
  try {
    config = readConfig()
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`[subscription] refusing to start: ${error.message}`)
      process.exit(1)
    }
    throw error
  }
  const seller = sellerFrom(config.sellerNsec)
  const app = createApp({
    config,
    seller,
    ledger: new Ledger(config.ledgerPath),
    issuer: new LicenceIssuer({ walletUrl: config.walletUrl, edgeSecret: config.edgeSecret, internalRelay: config.internalRelay, seller }),
    stripe: stripeClient(config.stripeSecretKey),
    catalogBody: (await readFile(config.catalogPath, 'utf8')).trim(),
  })
  const staticDir = process.env.SUBSCRIPTION_STATIC_DIR?.trim()
  const base = config.basePath

  const server = createServer(async (req, res) => {
    const full = new URL(req.url ?? '/', 'http://x')
    // Mounted under a path (e.g. /subscription on the wallet origin): strip it, so routes and the
    // NIP-98 check see the same path the app signs relative to (`site()` puts it back).
    if (base && !(full.pathname === base || full.pathname.startsWith(`${base}/`))) {
      if (full.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}')
        return
      }
      res.writeHead(404).end()
      return
    }
    const url = new URL((base ? full.pathname.slice(base.length) || '/' : full.pathname) + full.search, 'http://x')
    if (!url.pathname.startsWith('/v1/') && url.pathname !== '/health' && staticDir) {
      return serveStatic(staticDir, url.pathname, res)
    }
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      size += (chunk as Buffer).length
      if (size > 64 * 1024) {
        res.writeHead(413).end()
        return
      }
      chunks.push(chunk as Buffer)
    }
    try {
      const out = await app.handle({
        method: req.method ?? 'GET',
        path: url.pathname + url.search,
        headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])),
        body: Buffer.concat(chunks).toString('utf8'),
      })
      res.writeHead(out.status, { 'Content-Type': 'application/json', ...(out.headers ?? {}) })
      res.end(JSON.stringify(out.body))
    } catch (error) {
      console.error(JSON.stringify({ event: 'request_failed', path: url.pathname, error: String(error) }))
      res.writeHead(500, { 'Content-Type': 'application/json' }).end('{"error":"internal error"}')
    }
  })
  server.listen(config.port, () => console.log(`[subscription] listening on :${config.port} as seller ${seller.pk.slice(0, 12)}…`))
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => server.close(() => process.exit(0)))
}

async function serveStatic(dir: string, path: string, res: import('node:http').ServerResponse) {
  const safe = normalize(path).replace(/^(\.\.[/\\])+/, '')
  let file = join(dir, safe)
  try {
    if (!(await stat(file)).isFile()) throw new Error('dir')
  } catch {
    // A single-page app: unknown paths are the app's routes.
    file = join(dir, 'index.html')
  }
  const type = MIME[extname(file)] ?? 'application/octet-stream'
  res.writeHead(200, {
    'Content-Type': type,
    'Cache-Control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  })
  res.end(await readFile(file))
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) void main()
