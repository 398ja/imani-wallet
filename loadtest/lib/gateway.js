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
import { nip98Header } from './signed-request.js'
import { gateway_ms, timed } from './metrics.js'

export const GATEWAY = (__ENV.GATEWAY_URL || 'https://customer.staging.398ja.xyz').replace(/\/$/, '')
export const PORTAL = (__ENV.PORTAL_URL || GATEWAY).replace(/\/$/, '')

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

/** Read a coupon back, to confirm issuance actually produced one. */
export function readCoupon(customer, couponId) {
  return signed(GATEWAY, `/api/v1/wallet/vouchers/${couponId}`, 'GET', undefined, customer, 'read coupon')
}

/** Send a coupon to another customer as a gift-wrapped DM. */
export function sendCoupon(customer, payload) {
  return signed(GATEWAY, '/api/v1/dm/tokens/send', 'POST', payload, customer, 'send coupon')
}

/** Split a coupon into a spent part and a returned remainder. */
export function splitCoupon(customer, payload) {
  return signed(GATEWAY, '/api/v1/wallet/vouchers/split', 'POST', payload, customer, 'split coupon')
}

/** Drain pending arrival notifications. */
export function drainNotifications(customer, limit = 50) {
  return signed(
    GATEWAY,
    '/api/v1/incoming-notifications/drain',
    'POST',
    { limit },
    customer,
    'drain notifications',
  )
}

/** Acknowledge drained notifications, so they stop coming back. */
export function ackNotifications(customer, ids) {
  return signed(
    GATEWAY,
    '/api/v1/incoming-notifications/ack',
    'POST',
    { ids },
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
