// A stub gateway for checking market-day.js without a deployment. NOT the gateway: it answers
// only the calls a market day makes (NAP login, issue, the voucher poll, deliver, drain, ack),
// enough to prove the script's thresholds can pass and can fail. It verifies no signature.
//
//   node loadtest/stub/market-day-gateway.mjs &          # healthy, 127.0.0.1:18082
//   BROKEN=504  node loadtest/stub/market-day-gateway.mjs &  # every voucher poll 504s
//   BROKEN=hang node loadtest/stub/market-day-gateway.mjs &  # every voucher poll hangs, then drops
//
// BROKEN=504 is the edge's answer while gateway-customer was out of heap on 2026-11-06
// (imani-gateway-customer#298). BROKEN=hang is the 499 half of it: the client gives up on a
// request nothing answers, which k6 records as status 0.
import http from 'node:http'
import { randomUUID } from 'node:crypto'

const PORT = Number(process.env.PORT || 18082)
const BROKEN = process.env.BROKEN || ''
// Long enough to be a timeout, short enough that a smoke run finishes.
const HANG_MS = Number(process.env.HANG_MS || 3000)
// Polls a coupon answers PENDING before ISSUED, so the mint wait is exercised.
const PENDING_POLLS = Number(process.env.PENDING_POLLS || 1)

const polls = new Map()
const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(typeof body === 'string' ? body : JSON.stringify(body))
}

http
  .createServer((req, res) => {
    let raw = ''
    req.on('data', (d) => (raw += d))
    req.on('end', () => {
      const { pathname } = new URL(req.url, 'http://x')
      const base = `http://${req.headers.host}`

      if (pathname === '/api/v1/resolve')
        return send(res, 404, { error: 'not found' })
      if (pathname === '/api/v1/config')
        return send(res, 200, { relay_url: 'ws://stub-relay:7777' })

      // NAP login, as napLogin() drives it.
      if (pathname === '/api/v1/auth/init') {
        return send(res, 200, {
          challenge_id: randomUUID(),
          challenge: randomUUID(),
          auth_url: `${base}/api/v1/auth/complete`,
          auth_method: 'POST',
        })
      }
      if (pathname === '/api/v1/auth/complete') {
        return send(
          res,
          200,
          {},
          { 'set-cookie': `NAP_SESSION=${randomUUID()}; Path=/; HttpOnly` },
        )
      }
      if (pathname === '/api/v1/auth/validate') {
        return send(
          res,
          200,
          {},
          { 'x-auth-permissions': 'coupon:issue,coupon:pay,coupon:receive' },
        )
      }

      if (pathname === '/api/v1/portal/vouchers' && req.method === 'POST') {
        const id = randomUUID()
        polls.set(id, 0)
        return send(res, 201, { items: [{ voucher_id: id }] })
      }

      const voucher = /^\/api\/v1\/wallet\/vouchers\/([^/]+)$/.exec(pathname)
      if (voucher) {
        if (BROKEN === '504')
          return send(res, 504, '<html>504 Gateway Time-out</html>', {
            'content-type': 'text/html',
          })
        if (BROKEN === 'hang') {
          setTimeout(() => req.socket.destroy(), HANG_MS)
          return
        }
        const id = voucher[1]
        const seen = (polls.get(id) ?? 0) + 1
        polls.set(id, seen)
        if (seen <= PENDING_POLLS)
          return send(res, 200, { voucher_id: id, status: 'PENDING' })
        return send(res, 200, {
          voucher_id: id,
          status: 'ISSUED',
          token: 'cashuBstub',
          face_value: 500,
          face_unit: 'EUR',
          face_decimals: 2,
          token_amount: 500,
          backing_strategy: 'stub',
          expires_at: Math.floor(Date.now() / 1000) + 90 * 86400,
        })
      }

      if (pathname === '/api/v1/dm/tokens/send')
        return send(res, 200, { sent: true })
      if (pathname === '/api/v1/incoming-notifications/drain')
        return send(res, 200, { envelopes: [] })
      if (pathname === '/api/v1/incoming-notifications/ack')
        return send(res, 200, { acknowledged: 0 })

      return send(res, 404, { error: 'not stubbed', path: pathname })
    })
  })
  .listen(PORT, '127.0.0.1', () =>
    console.log(
      `stub market-day gateway on 127.0.0.1:${PORT}${BROKEN ? ` (BROKEN=${BROKEN})` : ''}`,
    ),
  )
