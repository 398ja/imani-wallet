/**
 * subscription.imani.casa's API, as a process: Node's http around `app.ts`.
 *
 *   docker build -f services/subscription/Dockerfile -t imani-subscription .
 *
 * Serves the API under /v1 and, when SUBSCRIPTION_STATIC_DIR is set, the built site
 * (`apps/subscription`) from the same origin, so the session cookie rides every API call and no
 * CORS is needed (only the public catalog answers cross-origin). The site has no login page: the
 * wallet signs its NAP login cross-origin (#411).
 */
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'

import { createApp } from './app.ts'
import { readConfig, ConfigError } from './config.ts'
import { LicenceIssuer, sellerFrom } from './issuer.ts'
import { relayStatusNotifier } from './statusNotifier.ts'
import { Ledger } from './ledger.ts'
import { cachedMerchantReader, readMerchantStanding } from './merchantRole.ts'
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
  const issuer = new LicenceIssuer({ walletUrl: config.walletUrl, nip98BaseUrl: config.walletPublicUrl, edgeSecret: config.edgeSecret, internalRelay: config.internalRelay, seller })
  const app = createApp({
    config,
    seller,
    ledger: new Ledger(config.ledgerPath),
    issuer,
    stripe: stripeClient(config.stripeSecretKey),
    catalogBody: (await readFile(config.catalogPath, 'utf8')).trim(),
    // gateway-customer serves the public `POST /api/v1/nostr/query` the role is read from.
    merchantStanding: cachedMerchantReader((pubkey) => readMerchantStanding(config.walletUrl, pubkey)),
    // A cancellation in Stripe reaches the wallet as a seller-sealed DM: published to the relay and
    // stored in the gateway's index, which is what the wallet's DM poll reads.
    notifier: relayStatusNotifier({ seller, relayUrl: config.internalRelay, store: (event) => issuer.storeEvent(event) }),
  })
  const staticDir = process.env.SUBSCRIPTION_STATIC_DIR?.trim()
  const base = config.basePath

  const server = createServer(async (req, res) => {
    const full = new URL(req.url ?? '/', 'http://x')
    // Mounted under a path (only if the edge mounts it under one; production is the root of
    // subscription.imani.casa): strip it, so routes see app paths (`site()` puts it back for the
    // NAP login audience and the cookie path).
    if (base && !(full.pathname === base || full.pathname.startsWith(`${base}/`))) {
      if (full.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}')
        return
      }
      res.writeHead(404).end()
      return
    }
    const url = new URL((base ? full.pathname.slice(base.length) || '/' : full.pathname) + full.search, 'http://x')
    if (!url.pathname.startsWith('/v1/') && url.pathname !== '/health' && url.pathname !== '/metrics' && staticDir) {
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
      res.writeHead(out.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(out.headers ?? {}) })
      // A string body is already text (Prometheus exposition); anything else is JSON.
      res.end(typeof out.body === 'string' ? out.body : JSON.stringify(out.body))
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
    // The wallet opens this site in a tab and signs its NAP login over `postMessage` (NAP extension
    // 0002, src/lib/sisterSiteSigner.ts). That needs the tab to keep its opener, and ANY other COOP
    // value on a cross-origin page opened this way severs it (checked in Chromium by nap's e2e). The
    // wallet keeps its own stricter `same-origin-allow-popups`; this page must be `unsafe-none`.
    'Cross-Origin-Opener-Policy': 'unsafe-none',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "frame-ancestors 'none'",
  })
  res.end(await readFile(file))
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) void main()
