/**
 * Serving the built bundle to a browser under measurement.
 *
 * A real static server on a real origin, because a `file://` URL is not how
 * the wallet is ever loaded and would measure a different thing: no origin, no
 * storage partition, different module resolution.
 *
 * When a gateway is needed, `/api` is proxied through the *same* routing table
 * `vite.config.ts` gives the dev server. That table is imported rather than
 * copied: its `changeOrigin` choices encode which routes are NIP-98 signed,
 * and getting one wrong in a copy produces a signature failure that nothing in
 * the error message explains.
 */

import { createServer, request as httpRequest } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { join, extname } from 'node:path'

import { proxy } from '../../vite.config'

const TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
}

export interface Site {
  url: string
  close: () => Promise<void>
}

interface ProxyRule {
  target: string
  changeOrigin?: boolean
}

/** Longest prefix wins, the way Vite resolves its own table. */
function routeFor(url: string): ProxyRule | undefined {
  const rules = Object.entries(proxy as Record<string, ProxyRule>)
    .filter(([prefix]) => url.startsWith(prefix))
    .sort((a, b) => b[0].length - a[0].length)
  return rules[0]?.[1]
}

export async function serve(dist: string, { withGateway = false } = {}): Promise<Site> {
  const server = createServer(async (req, res) => {
    const url = req.url ?? '/'
    const rule = withGateway ? routeFor(url) : undefined

    if (rule) {
      const body: Buffer[] = []
      for await (const chunk of req) body.push(chunk as Buffer)
      const headers = { ...req.headers } as Record<string, string>

      // The one detail that matters, and the reason this table is imported.
      //
      // `changeOrigin: true` rewrites Origin and Host to the target, which is
      // what the gateway's CORS check wants on the auth routes.
      //
      // `false` must preserve the browser's Host *exactly*. The gateway
      // reconstructs the request URL from that header to verify a NIP-98
      // signature, and the signature covers the URL the browser signed. Drop
      // the header and `fetch` regenerates it from the target, so every
      // authenticated call fails with 401 AUTH_002 "URL mismatch" — which
      // reads as a credential problem rather than a proxy one. The `/api` rule
      // in `vite.config.ts` carries this same warning.
      if (rule.changeOrigin) {
        const target = new URL(rule.target)
        headers.origin = target.origin
        headers.host = target.host
      }

      try {
        // `node:http` rather than `fetch`, because fetch treats Host as a
        // forbidden header and silently regenerates it from the target. That
        // silence is the whole problem: the request succeeds at the transport
        // level and fails at the signature level, several layers away.
        const target = new URL(rule.target)
        const upstream = await new Promise<{
          status: number
          headers: Record<string, string | string[] | undefined>
          body: Buffer
        }>((ok, no) => {
          const proxied = httpRequest(
            {
              protocol: target.protocol,
              hostname: target.hostname,
              port: target.port,
              method: req.method,
              path: url,
              headers,
            },
            (upstreamRes) => {
              const chunks: Buffer[] = []
              upstreamRes.on('data', (c: Buffer) => chunks.push(c))
              upstreamRes.on('end', () =>
                ok({
                  status: upstreamRes.statusCode ?? 502,
                  headers: upstreamRes.headers,
                  body: Buffer.concat(chunks),
                }),
              )
            },
          )
          proxied.on('error', no)
          if (body.length) proxied.write(Buffer.concat(body))
          proxied.end()
        })

        const outHeaders: Record<string, string | string[]> = {}
        for (const [k, v] of Object.entries(upstream.headers)) {
          if (k === 'content-encoding' || k === 'content-length') continue
          if (v !== undefined) outHeaders[k] = v
        }
        res.writeHead(upstream.status, outHeaders)
        res.end(upstream.body)
      } catch (e) {
        res.writeHead(502).end(String(e))
      }
      return
    }

    const path = url.split('?')[0]
    let file = join(dist, path === '/' ? 'index.html' : path)
    // A single-page app: an unknown path is a route, not a missing file.
    if (!existsSync(file) || extname(file) === '') file = join(dist, 'index.html')
    try {
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
      res.end(readFileSync(file))
    } catch {
      res.writeHead(404).end('not found')
    }
  })

  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()))
  const port = (server.address() as { port: number }).port
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((done) => server.close(() => done())),
  }
}
