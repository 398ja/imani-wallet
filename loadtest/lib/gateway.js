// Talking to the gateway the way the wallet talks to it.
//
// Every call here mirrors one the wallet makes, with the same path, verb and
// body shape, so a run measures the path customers actually take. Where the
// wallet's own source made a choice worth knowing, the reason is repeated
// rather than left to be rediscovered.
//
// The target is read from the environment and defaults to staging, so pointing
// a run at a local stack is a flag rather than an edit.

import http from 'k6/http'
import crypto from 'k6/crypto'
import { nip98Header, signDigest } from './signed-request.js'
import { gateway_ms, timed } from './metrics.js'

/** `src/lib/issuanceWarrant.ts` FIELD_SEPARATOR. */
const FIELD_SEPARATOR = '\u001f'

/**
 * Minor-unit decimals for the currencies these scenarios sell in. The wallet takes them from Intl
 * (`currencyDecimals`); k6 has no Intl, so the few that are not 2 are listed. The portal refuses a
 * warrant whose decimals differ from the sale's, so an unlisted 0- or 3-decimal currency fails
 * loudly rather than minting a wrong coupon.
 */
const ZERO_DECIMALS = new Set(['JPY', 'KRW', 'XAF', 'XOF', 'CLP', 'ISK', 'UGX', 'VND', 'RWF', 'PYG'])
const THREE_DECIMALS = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND'])
function decimalsFor(unit) {
  return ZERO_DECIMALS.has(unit) ? 0 : THREE_DECIMALS.has(unit) ? 3 : 2
}

/**
 * The stall's `merchant` issuance warrant for one sale, as the wallet's Sell signs it
 * (`src/lib/warrantSigner.ts`): sha256 of issuer, sale total, decimals, unit and a fresh nonce,
 * schnorr-signed by the stall. Without one the portal still issues (migration policy), but every
 * receiving wallet refuses the coupon, and it counts as `voucher_issuance_warrant_total{outcome="absent"}`.
 */
export function merchantWarrant(stall, saleTotalMinor, unit) {
  const faceDecimals = decimalsFor(unit)
  const nonce = crypto.sha256(`${Date.now()}-${Math.random()}-${stall.pubHex}`, 'hex').slice(0, 32)
  const preimage = [stall.pubHex, String(saleTotalMinor), String(faceDecimals), unit, nonce].join(FIELD_SEPARATOR)
  const sig = signDigest(stall.privHex, crypto.sha256(preimage, 'hex'))
  return JSON.stringify({ form: 'merchant', sale_total: saleTotalMinor, face_decimals: faceDecimals, unit, nonce, sig })
}

// `customer.staging.398ja.xyz` was the old default and is now explicitly 404'd
// as a retired host in imani-deploy's nginx, so a run that forgot the variable
// failed against a name that no longer exists rather than against staging.
// Every tier answers on this one name now: gateway-core, gateway-customer and
// gateway-portal all sit behind it, routed by path.
export const GATEWAY = (__ENV.GATEWAY_URL || 'https://wallet.staging.398ja.xyz').replace(/\/$/, '')
export const PORTAL = (__ENV.PORTAL_URL || GATEWAY).replace(/\/$/, '')

/**
 * The account tier, which is NOT the customer gateway.
 *
 * Sending and arrival notifications live here, and the customer gateway 404s
 * both. `vite.config.ts` documents the same split for the browser: a 404 on
 * one of these reads as "the endpoint does not exist" when it means "it is on
 * the other tier".
 */
export const ACCOUNT = (__ENV.ACCOUNT_URL || GATEWAY).replace(/\/$/, '')

/**
 * The secret an edge proxy uses to vouch for a caller.
 *
 * Staging runs an edge that authenticates the session and injects who the
 * caller is; locally there is no edge, so a run has to play that role itself.
 * The portal trusts X-Auth-Pubkey and X-Auth-Permissions only when paired with
 * this secret, which is why a page cannot simply claim a permission for itself.
 *
 * Without it, issuance returns 403 "Insufficient permissions" — a message that
 * reads as a problem with the stall's account rather than a missing header.
 */
const EDGE_SECRET = __ENV.EDGE_SECRET || ''

/**
 * gateway-core's `/internal/v1` tier, which is NOT reachable from outside.
 *
 * nginx declares `/internal` as an nginx-internal location, so the edge answers
 * 405 to a POST from the public side. Reaching it means running k6 where the
 * service is: on the deployment host against `http://gateway-core:8081`, or a
 * local stack. Defaulting to the local port keeps the failure mode "connection
 * refused" rather than a confusing 405 from the public edge.
 *
 * Note 8081, not 8080: gateway-core serves its API there and its actuator on a
 * separate management port. A probe against 8080 answers nothing at all.
 */
export const INTERNAL = (__ENV.INTERNAL_URL || 'http://localhost:8081').replace(/\/$/, '')

/**
 * The relay address the GATEWAY can reach, which is not the one a browser can.
 *
 * A delivered coupon names the relays to publish its gift wrap to, and the
 * gateway is what does the publishing. Sending the browser-facing name here
 * produces a DM the gateway cannot deliver. Same distinction, and the same
 * default, as `INTERNAL_RELAY_URL` in `src/lib/relay.ts`.
 */
export const INTERNAL_RELAY_URL = __ENV.INTERNAL_RELAY_URL || 'ws://nostr-relay:7777'

/**
 * The relay this deployment actually names, read from its own config.
 *
 * The default above is the local stack's internal alias, and it is wrong
 * anywhere else: staging answers `wss://relay.staging.398ja.xyz`. Guessing
 * produces a DM the gateway cannot publish, and nothing in the 200 it returns
 * says so.
 *
 * Called from `setup`, once, because every VU asking would be a request per VU
 * for a value that cannot change mid-run.
 */
export function deploymentRelayUrl() {
  if (__ENV.INTERNAL_RELAY_URL) return __ENV.INTERNAL_RELAY_URL
  const res = http.get(`${GATEWAY}/api/v1/config`, { tags: { name: 'config' } })
  if (res.status !== 200) return INTERNAL_RELAY_URL
  try {
    return JSON.parse(res.body).relay_url || INTERNAL_RELAY_URL
  } catch {
    return INTERNAL_RELAY_URL
  }
}

/**
 * Service credential for the `/internal/v1` tier.
 *
 * Row-scoped in `service_credentials.allowed_paths`, bcrypt-hashed, so this is
 * not a shared secret that unlocks the tier — it unlocks one path. A run
 * without it gets 401 and the scenario says so rather than reporting an empty
 * queue as a result.
 */
const SERVICE_ID = __ENV.SERVICE_ID || 'loadtest'
const SERVICE_TOKEN = __ENV.SERVICE_TOKEN || ''

/**
 * One signed request.
 *
 * The body is serialised exactly once and that same string is both signed and
 * sent. Re-serialising would produce a different `payload` hash and fail
 * verification, which is why this does not take an object and stringify twice.
 */
export function signed(base, path, method, payload, customer, name, permissions) {
  const body = payload === undefined ? undefined : JSON.stringify(payload)
  const url = `${base}${path}`

  const headers = { Authorization: nip98Header(url, method, body, customer) }
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  // Play the edge only when configured to. On staging a real edge does this
  // and would discard anything sent from here anyway.
  if (EDGE_SECRET) {
    headers['X-Auth-Pubkey'] = customer.pubHex
    headers['X-Edge-Auth'] = EDGE_SECRET
    if (permissions) headers['X-Auth-Permissions'] = permissions
  }

  return timed(gateway_ms, () =>
    http.request(method, url, body, { headers, tags: { name: name || path } }),
  )
}

/**
 * Ask a stall to issue one coupon.
 *
 * Issuance is a stall action and lives on the portal tier. The customer
 * gateway refuses it outright: coupons are client-held, so the backend must
 * not persist them, and a request landing there reads as a permissions problem
 * rather than a routing one.
 */
export function issueCoupon(stall, { faceValueMinor, currency, expiryDays, memo }) {
  return signed(
    PORTAL,
    '/api/v1/portal/vouchers',
    'POST',
    {
      face_value_minor: faceValueMinor,
      currency,
      quantity: 1,
      expiry_days: expiryDays,
      memo,
    },
    stall,
    'issue coupon',
    // The permission the portal actually checks for issuance.
    'coupon:issue',
  )
}

/**
 * Issue a coupon as a stall, authorised by a NAP SESSION rather than NIP-98.
 *
 * This is the path that actually works. `issueCoupon` above signs each request
 * with NIP-98, which authenticates perfectly and is then refused 403:
 * `coupon:issue` is granted only by `NapProxyAuthFilter`, on the session path.
 * MEASURED against staging, where a NIP-98 issue is 403 and the same key with
 * a NAP session is 201.
 *
 * The caller must hold a session from `napLogin`, and the identity must have
 * published a stall record (`loadtest/stalls.mjs`). A session without one
 * carries `coupon:pay,coupon:receive` and is refused, which is correct: a
 * customer is not a stall.
 */
export function issueCouponAsStall(session, { faceValueMinor, currency, expiryDays, memo }) {
  const body = JSON.stringify({
    face_value_minor: faceValueMinor,
    currency,
    quantity: 1,
    expiry_days: expiryDays,
    memo,
    // quantity is 1, so the sale total is the one coupon's face value. The session carries the
    // stall it logged in as (napLogin), which is who signs.
    ...(session.identity ? { issuance_warrant: merchantWarrant(session.identity, faceValueMinor, currency) } : {}),
  })
  return timed(gateway_ms, () =>
    http.post(`${PORTAL}/api/v1/portal/vouchers`, body, {
      headers: {
        'Content-Type': 'application/json',
        ...(session.cookie ? { Cookie: session.cookie } : {}),
      },
      tags: { name: 'issue coupon' },
    }),
  )
}

/**
 * Deliver an issued coupon to a customer, as a gift-wrapped DM.
 *
 * The third and last stage of a sale, and the one that makes a customer
 * actually hold something. `src/lib/issue.ts` calls this `deliver`, and
 * without it a coupon is minted and nobody has it.
 *
 * This is also what puts an envelope on the recipient's queue. Every scenario
 * in this directory measured drains against an EMPTY queue because nothing
 * here ever made a sale; `receive.js` works around that by publishing through
 * `/internal/v1`, which is not reachable from outside a deployment. A real
 * sale needs no such workaround.
 *
 * `issuer_id` and `sender_pubkey` are both the STALL, never the device that
 * sold: a customer must hold a coupon from a stall they can look up.
 */
export function deliverCoupon(stall, recipientPubkey, voucher, memo, relayUrl) {
  return signed(
    GATEWAY,
    '/api/v1/dm/tokens/send',
    'POST',
    {
      recipient_pubkey: recipientPubkey,
      token: voucher.token,
      memo: voucher.memo ?? memo,
      voucher_id: voucher.voucher_id,
      face_value: voucher.face_value,
      face_unit: voucher.face_unit,
      face_decimals: voucher.face_decimals,
      token_amount: voucher.token_amount,
      backing_strategy: voucher.backing_strategy,
      issuer_id: stall.pubHex,
      sender_pubkey: stall.pubHex,
      expires_at: epochSeconds(voucher.expires_at),
      relay_urls: [relayUrl || INTERNAL_RELAY_URL],
    },
    stall,
    'deliver coupon',
  )
}

/**
 * Epoch SECONDS from whatever the gateway returned.
 *
 * `expires_at` has been seen as an ISO string and as a number, and the number
 * as both seconds and milliseconds. The DM endpoint declares a `Long` in
 * seconds: an ISO string fails Jackson's binding, and milliseconds date the
 * coupon to the year 58000. Mirrors `toEpochSeconds` in `src/lib/issue.ts`.
 */
function epochSeconds(value) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return undefined
    return value > 1e11 ? Math.floor(value / 1000) : Math.floor(value)
  }
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : Math.floor(parsed / 1000)
}

/** Read a coupon back, to confirm issuance actually produced one. */
export function readCoupon(customer, couponId) {
  return signed(GATEWAY, `/api/v1/wallet/vouchers/${couponId}`, 'GET', undefined, customer, 'read coupon')
}

/**
 * Send coupons to another customer, as one escrowed saga.
 *
 * On the ACCOUNT tier, not the customer gateway, which 404s it. Verified
 * against this stack: :28081 answers 401 (wants a signature, so it is there),
 * :28082 answers 404 "Endpoint not found".
 */
export function sendCoupons(customer, payload) {
  return signed(ACCOUNT, '/api/v1/atomic-send', 'POST', payload, customer, 'send coupons')
}

/**
 * Splitting is NOT available over the network, by design.
 *
 * The customer gateway refuses it outright:
 *
 *   "Voucher split execution is not supported on JdbcWalletPort — the
 *    customer-wallet is self-custodial (Constitution Principle II)."
 *
 * It is kept here, exported and throwing, so that anyone who goes looking for
 * a split scenario finds the reason rather than an absence. This is the same
 * situation ADR 0003 records for redemption: the work happens on the device,
 * so measuring it belongs in the browser suite.
 */
export function splitCoupon() {
  throw new Error(
    'Splitting is client-side by design and has no gateway path to measure. ' +
      'The customer gateway refuses it: "not supported on JdbcWalletPort — the ' +
      'customer-wallet is self-custodial". Measure it in the browser suite, ' +
      'as ADR 0003 does for redemption.',
  )
}

/**
 * Enqueue an arrival notification, as a delivering service would.
 *
 * NOT a user-facing call, and deliberately not reachable as one: it is
 * `/internal/v1`, authenticated by X-Service-Id + X-Service-Token rather than
 * NIP-98, and the controller's own comment says it must NEVER be exposed on
 * `/api/v1` — the recipient comes from the BODY, so a user credential reaching
 * it would let any user enqueue for any other.
 *
 * Used here to populate the queue the drain scenario reads. The alternative was
 * to drive a real atomic-send saga, which needs issuance, which needs the
 * portal — and the portal is gated behind a session cookie a NIP-98 client
 * cannot obtain (see results/staging-2026-09-16.md). This publishes the same
 * envelope the saga publishes, through the same service, onto the same queue.
 *
 * What that buys and what it does not: the drain side is measured for real,
 * against real envelopes. The SEND side is not exercised, so this measures
 * arrival, not delivery end-to-end.
 *
 * `/internal` is not routed by the edge — nginx serves it as a static location
 * and answers 405 — so INTERNAL_URL must point INSIDE the deployment. There is
 * no path to this from outside, which is the intended posture.
 */
export function publishArrival(params) {
  // camelCase here, NOT snake_case — the opposite of `/api/v1/atomic-send`.
  // The public API takes snake_case (see sendCoupons, where copying the
  // wallet's camelCase made the gateway report `recipientPubkey` as a MISSING
  // field), but `PublishRequest` is a plain record and gateway-core sets no
  // property-naming strategy, so Jackson binds it by its Java names. Get this
  // wrong and every field arrives null: the controller answers 400 on the
  // recipient check, which reads as a bad pubkey rather than a bad convention.
  const body = JSON.stringify({
    recipientPubkey: params.recipientPubkey,
    senderPubkey: params.senderPubkey,
    deliveryEventId: params.deliveryEventId,
    currencyUnit: params.currencyUnit || 'EUR',
    currencyDecimals: params.currencyDecimals == null ? 2 : params.currencyDecimals,
    minorUnits: params.minorUnits == null ? 500 : params.minorUnits,
    bundleId: params.bundleId,
  })
  return timed(gateway_ms, () =>
    http.post(`${INTERNAL}/internal/v1/incoming-notifications/publish`, body, {
      headers: {
        'Content-Type': 'application/json',
        'X-Service-Id': SERVICE_ID,
        'X-Service-Token': SERVICE_TOKEN,
      },
      tags: { name: 'publish arrival' },
    }),
  )
}

/**
 * The envelopes in a drain response.
 *
 * The field is `envelopes`. `src/lib/incomingNotifications.ts` reads
 * `body.envelopes` and nothing else, and a real sale confirms it.
 *
 * This exists because reading the wrong field is INVISIBLE: a scenario that
 * looks for `notifications` finds nothing, reports "0 envelopes", and looks
 * exactly like a healthy run against an empty queue. `market-day.js` did
 * precisely that, and would have gone on reporting empty queues after the
 * sales that fill them. The fallbacks are kept for older shapes but
 * `envelopes` is what a current deployment sends.
 */
export function envelopesFrom(response) {
  if (response.status !== 200) return []
  try {
    const body = JSON.parse(response.body)
    const list = body.envelopes || body.items || body.notifications || []
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

/** The ids to acknowledge, named as the wallet names them. */
export function envelopeIds(envelopes) {
  return envelopes.map((e) => e.notificationId || e.id).filter(Boolean)
}

/** Drain pending arrival notifications. On the ACCOUNT tier. */
export function drainNotifications(customer, limit = 50) {
  return signed(
    ACCOUNT,
    '/api/v1/incoming-notifications/drain',
    'POST',
    { limit },
    customer,
    'drain notifications',
  )
}

/**
 * Acknowledge drained notifications, so they stop coming back.
 *
 * The field is `notificationIds`, matching `AckRequest` and what the wallet
 * itself sends from `incomingNotifications.ts`. It used to send `{ ids }`,
 * which binds to a null list: the controller answers 200 with
 * `acknowledged: 0`, so the call LOOKED like it worked and acknowledged
 * nothing. Never noticed because drain.js only ever ran against an empty queue,
 * so there was never anything to ack — found while writing receive.js, which is
 * the first scenario to put envelopes on the queue.
 */
export function ackNotifications(customer, notificationIds) {
  return signed(
    ACCOUNT,
    '/api/v1/incoming-notifications/ack',
    'POST',
    { notificationIds },
    customer,
    'ack notifications',
  )
}

/**
 * Resolve a recipient, which is unauthenticated and cheap.
 *
 * Useful as a warm-up: it proves the gateway is reachable and answering before
 * a ramp starts, without needing a signature.
 */
export function resolve(handle) {
  return timed(gateway_ms, () =>
    http.get(`${GATEWAY}/api/v1/resolve?q=${encodeURIComponent(handle)}`, {
      tags: { name: 'resolve' },
    }),
  )
}
