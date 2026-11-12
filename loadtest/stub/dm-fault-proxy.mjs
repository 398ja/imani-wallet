// A fault-injecting proxy between gateway-core and customer-wallet, for a LOCAL stack only
// (imani-wallet#552). It stands where the relay failure of 2026-11-07 happened: the gift-wrap
// publish of an atomic send.
//
//   docker run -d --name dm-fault-proxy --network imani-test_imani-internal \
//     -v "$PWD/loadtest/stub/dm-fault-proxy.mjs:/proxy.mjs:ro" \
//     -e FAIL_SHARE=0.3 node:22-alpine node /proxy.mjs
//   # then point gateway-core at it:
//   GATEWAY_ATOMIC_SEND_DELIVERY_NIP17_CUSTOMER_WALLET_BASE_URL=http://dm-fault-proxy:8082
//
// Every request is forwarded to UPSTREAM unchanged, except the atomic send's DM publish
// (POST /internal/v1/wallet/dm/tokens/send). For a FAIL_SHARE of sends, chosen by hashing the
// Idempotency-Key gateway-core sends (`send:<send id>`, so the choice is stable per send), the
// first FAIL_ATTEMPTS attempts are answered 502 RELAY_PUBLISH_FAILED WITHOUT being forwarded.
// That is exactly what customer-wallet answers when no relay acknowledged the gift wrap: nothing
// reached the recipient, and gateway-core moves the send to DM_ERROR and retries it later.
//
// GET /__fault/stats answers what was injected, so a run can report it rather than assume it.
// Never deploy this anywhere but a throwaway local stack: it drops real deliveries on purpose.
import http from 'node:http'
import { createHash } from 'node:crypto'

const PORT = Number(process.env.PORT || 8082)
const UPSTREAM = new URL(process.env.UPSTREAM || 'http://gateway-customer:8082')
const FAIL_SHARE = Number(process.env.FAIL_SHARE || 0.3)
const FAIL_ATTEMPTS = Number(process.env.FAIL_ATTEMPTS || 1)
const DM_PATH = '/internal/v1/wallet/dm/tokens/send'

/** Attempts seen per idempotency key, so only the first FAIL_ATTEMPTS of a chosen send fail. */
const attempts = new Map()
const stats = { forwarded: 0, dm_seen: 0, dm_failed: 0, dm_forwarded: 0, sends_chosen: 0, upstream_errors: 0 }

function chosen(key) {
  if (!key || FAIL_SHARE <= 0) return false
  const h = createHash('sha256').update(key).digest()
  return h.readUInt32BE(0) / 0x1_0000_0000 < FAIL_SHARE
}

function forward(req, res, body) {
  stats.forwarded++
  const upstream = http.request(
    {
      hostname: UPSTREAM.hostname,
      port: UPSTREAM.port || 80,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: UPSTREAM.host },
    },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers)
      up.pipe(res)
    },
  )
  upstream.on('error', (e) => {
    stats.upstream_errors++
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error_code: 'PROXY_UPSTREAM_ERROR', message: e.message }))
  })
  upstream.end(body)
}

http
  .createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/__fault/stats') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ...stats, fail_share: FAIL_SHARE, fail_attempts: FAIL_ATTEMPTS }))
      return
    }
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      if (req.method === 'POST' && req.url.split('?')[0] === DM_PATH) {
        stats.dm_seen++
        const key = String(req.headers['idempotency-key'] || '')
        // Only the delivery DM ("send:<id>"). A self-DM returning a reclaim is never failed here.
        if (key.startsWith('send:') && chosen(key)) {
          const n = (attempts.get(key) || 0) + 1
          attempts.set(key, n)
          if (n === 1) stats.sends_chosen++
          if (n <= FAIL_ATTEMPTS) {
            stats.dm_failed++
            console.log(`fail ${key} attempt=${n}`)
            res.writeHead(502, { 'content-type': 'application/json' })
            res.end(JSON.stringify({
              error_code: 'RELAY_PUBLISH_FAILED',
              message: 'dm-fault-proxy: injected relay publish failure (imani-wallet#552)',
              operation: 'dm_tokens_send',
            }))
            return
          }
        }
        stats.dm_forwarded++
      }
      forward(req, res, body)
    })
  })
  .listen(PORT, '0.0.0.0', () => {
    console.log(`dm-fault-proxy :${PORT} -> ${UPSTREAM.href} fail_share=${FAIL_SHARE} fail_attempts=${FAIL_ATTEMPTS}`)
  })
