// The checkout code store's calls, as a shop makes them (imani-wallet#402).
//
// The store is its own service (imani-checkout-codes). On staging it is proxied SAME-ORIGIN at
// `/v1/checkout-codes` by the wallet host (imani-deploy `checkout-codes-locations.snippet`), so
// `CODES_URL` defaults to the gateway origin, and the NIP-98 `u` tag names that host, which is in
// `CHECKOUT_CODES_PUBLIC_BASE_URL`. The shops' own host (codes.staging.398ja.xyz) serves the same
// routes behind the same limits.
//
// Request shapes are the store's README and `CheckoutCodeController`, and the order bodies are
// what imani-coupon-core's `CodeStoreClient` sends (e2e/checkout-codes-shop.php drives it):
//
//   GET  /v1/checkout-codes/{code}           shop S, NIP-98     the lookup a checkout makes
//   POST /v1/checkout-codes/{code}/hold      {order_ref}        reserved -> held
//   POST /v1/checkout-codes/{code}/release   {order_ref}        held -> reserved (no-op otherwise)
//   POST /v1/checkout-codes/{code}/redeem    {order_ref}        held -> redeemed, returns the parts
//   GET  /v1/code-check/{code}               NO auth            the public balance check (#9)
//
// Every miss (unknown, another shop's, malformed) answers the same bytes,
// `404 {"refusal":"NOT_FOUND"}` (R2), and a wrong state is `409 {"refusal":"<STATE>"}`.

import http from 'k6/http'

import { nip98Header } from './signed-request.js'
import { timed, gateway_ms } from './metrics.js'
import { GATEWAY } from './gateway.js'

export const CODES = (__ENV.CODES_URL || GATEWAY).replace(/\/$/, '')

/** The R2 bytes. A miss that answers anything else leaks which kind of miss it was. */
export const NOT_FOUND_BODY = '{"refusal":"NOT_FOUND"}'

/** `src/lib/checkoutCode.ts`: Crockford base32 without I, L, O, U. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

function luhnSum(symbols, firstFactor) {
  let factor = firstFactor
  let sum = 0
  for (let i = symbols.length - 1; i >= 0; i--) {
    const a = factor * ALPHABET.indexOf(symbols[i])
    sum += Math.floor(a / 32) + (a % 32)
    factor = factor === 2 ? 1 : 2
  }
  return sum
}

/** The check symbol for eleven data symbols, as `checkSymbol` in checkoutCode.ts. */
export function checkSymbol(data) {
  return ALPHABET[(32 - (luhnSum(data, 2) % 32)) % 32]
}

/** A well-formed code nobody made: passes the check symbol, so the store must look it up. */
export function unknownCode() {
  let data = ''
  for (let i = 0; i < 11; i++) data += ALPHABET[Math.floor(Math.random() * 32)]
  return `IMANI${data}${checkSymbol(data)}`
}

/** A real code with its check symbol wrong: the typo a shop's form would let through. */
export function typoOf(code) {
  const last = code[code.length - 1]
  const other = ALPHABET[(ALPHABET.indexOf(last) + 1) % 32]
  return code.slice(0, -1) + other
}

function signedStore(method, path, payload, shop, name) {
  const body = payload === undefined ? undefined : JSON.stringify(payload)
  const url = `${CODES}${path}`
  const headers = { Authorization: nip98Header(url, method, body, shop) }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  return { method, url, body, params: { headers, tags: { name } } }
}

function send(req) {
  return timed(gateway_ms, () => http.request(req.method, req.url, req.body, req.params))
}

/** The requests, signed but not sent, so a race can fire them in one `http.batch`. */
export const requests = {
  lookup: (shop, code) => signedStore('GET', `/v1/checkout-codes/${code}`, undefined, shop, 'code lookup'),
  hold: (shop, code, orderRef) => signedStore('POST', `/v1/checkout-codes/${code}/hold`, { order_ref: orderRef }, shop, 'code hold'),
  release: (shop, code, orderRef) =>
    signedStore('POST', `/v1/checkout-codes/${code}/release`, { order_ref: orderRef }, shop, 'code release'),
  redeem: (shop, code, orderRef) =>
    signedStore('POST', `/v1/checkout-codes/${code}/redeem`, { order_ref: orderRef }, shop, 'code redeem'),
}

export const lookupCode = (shop, code) => send(requests.lookup(shop, code))
export const holdCode = (shop, code, orderRef) => send(requests.hold(shop, code, orderRef))
export const releaseCode = (shop, code, orderRef) => send(requests.release(shop, code, orderRef))
export const redeemCode = (shop, code, orderRef) => send(requests.redeem(shop, code, orderRef))

/** Fire signed requests at the same instant. Signing happens first, so it is not in the race. */
export function batch(reqs) {
  return http.batch(reqs.map((r) => [r.method, r.url, r.body ?? null, r.params]))
}

/** The public check: no NIP-98, the code is the only credential. */
export function codeCheck(code) {
  return timed(gateway_ms, () => http.get(`${CODES}/v1/code-check/${code}`, { tags: { name: 'code check' } }))
}

/** The store's public key: unauthenticated, used to prove it answers before load. */
export function storeInfo() {
  return http.get(`${CODES}/v1/checkout-codes/info`, { tags: { name: 'store info' } })
}

/** `{"refusal":"X"}` -> `X`, or null. */
export function refusalOf(res) {
  try {
    return JSON.parse(res.body).refusal ?? null
  } catch {
    return null
  }
}

/** The edge's 429 and the store's own share this shape; both are the deployment defending itself. */
export const isRateLimited = (res) => res.status === 429
