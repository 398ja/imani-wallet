// A stub code store for checking checkout-codes.js without a deployment. NOT the store: it keeps
// only the hold/redeem state machine and the R2 404 bytes, enough to prove the script's assertions
// can pass and can fail. `BROKEN=double` lets two orders both win a hold, which the race must catch.
import http from 'node:http'

const codes = new Map(JSON.parse(process.env.STUB_CODES || '[]').map((c) => [c.code, { ...c, status: c.expires_at < Date.now() / 1000 ? 'expired' : 'reserved' }]))
const NF = '{"refusal":"NOT_FOUND"}'
const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(typeof body === 'string' ? body : JSON.stringify(body))
}
const pubOf = (auth) => {
  try {
    return JSON.parse(Buffer.from(auth.replace(/^Nostr /, ''), 'base64').toString()).pubkey
  } catch {
    return null
  }
}

http
  .createServer((req, res) => {
    let raw = ''
    req.on('data', (d) => (raw += d))
    req.on('end', () => {
      const url = new URL(req.url, 'http://x')
      if (url.pathname === '/v1/checkout-codes/info') return send(res, 200, { nostr_pubkey: 'stub' })
      const check = /^\/v1\/code-check\/([^/]+)$/.exec(url.pathname)
      if (check) {
        const c = codes.get(check[1])
        return c ? send(res, 200, { status: c.status === 'reserved' ? 'active' : c.status, remaining: c.amount, unit: c.unit }) : send(res, 404, NF)
      }
      const m = /^\/v1\/checkout-codes\/([^/]+)(?:\/(hold|redeem|release))?$/.exec(url.pathname)
      if (!m) return send(res, 404, NF)
      const c = codes.get(m[1])
      const caller = pubOf(req.headers.authorization || '')
      if (!caller) return send(res, 401, '{}')
      if (!c || c.shopKey !== caller) return send(res, 404, NF)
      const order = raw ? JSON.parse(raw).order_ref : undefined
      // Simulated latency so the two batched requests really overlap.
      setTimeout(() => {
        if (!m[2]) return send(res, 200, { status: c.status, amount: c.amount, unit: c.unit, stall_pubkey: c.stall, ...(c.held_by ? { held_by: c.held_by } : {}), parts: [] })
        if (c.status === 'expired') return send(res, 409, { refusal: 'EXPIRED' })
        if (m[2] === 'hold') {
          if (c.status === 'reserved' || (process.env.BROKEN === 'double' && c.status === 'held')) {
            c.status = 'held'
            c.held_by = order
            return send(res, 200, { status: 'held' })
          }
          if (c.status === 'held') return send(res, c.held_by === order ? 200 : 409, c.held_by === order ? { status: 'held' } : { refusal: 'HELD' })
          return send(res, 409, { refusal: c.status.toUpperCase() })
        }
        if (m[2] === 'redeem') {
          if (c.status === 'held' && c.held_by === order) {
            c.status = 'redeemed'
            return send(res, 200, { parts: [{ idx: 0, token: 'cashuBstub', amount: c.amount }], customer_pubkey: 'c' })
          }
          if (c.status === 'redeemed' && c.held_by === order) return send(res, 200, { parts: [{ idx: 0, token: 'cashuBstub', amount: c.amount }], customer_pubkey: 'c' })
          return send(res, 409, { refusal: c.status.toUpperCase() })
        }
        return send(res, 200, { status: c.status })
      }, 20)
    })
  })
  .listen(Number(process.env.PORT || 18087), '127.0.0.1')
