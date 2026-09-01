// Signing a request the way the wallet signs it.
//
// A NAP session authenticates a *session*; NIP-98 authenticates one *request*
// with a signature binding the caller's key to that exact URL, method and body.
// The gateway wants the second on its write endpoints.
//
// This mirrors `src/lib/nip98.ts`, deliberately and closely, because a load
// test that signs differently from the wallet is measuring a path no customer
// takes. Two details are load-bearing:
//
//   * No nonce tag. The retired imani-apps version added one; this wallet does
//     not, and the signature must match what the wallet actually sends.
//   * The `u` tag is the URL the gateway rebuilds from the Host header. If they
//     disagree the call fails 401 AUTH_002 "URL mismatch", which reads as a
//     credential problem and is not one.
//
// The id is hashed here and only the hash goes to the signer, so a customer's
// key crosses the loopback boundary but the request body never does.

import http from 'k6/http'
import crypto from 'k6/crypto'
import encoding from 'k6/encoding'

import { signing_ms, timed } from './metrics.js'

const SIGNER_URL = __ENV.SIGNER_URL || 'http://127.0.0.1:8765'

/** NIP-01 canonical id: sha256 over [0, pubkey, created_at, kind, tags, content]. */
function eventId(event) {
  return crypto.sha256(
    JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]),
    'hex',
  )
}

/**
 * Build one `Authorization: Nostr …` header.
 *
 * @param url     the absolute URL the gateway will see
 * @param method  HTTP verb
 * @param body    the exact serialised body being sent, or undefined
 * @param customer  { pubHex, privHex }
 */
export function nip98Header(url, method, body, customer) {
  const tags = [
    ['u', url],
    ['method', method.toUpperCase()],
  ]

  // Hash the body exactly as serialised. Re-serialising with a different key
  // order produces a different hash and fails verification, which is why the
  // caller passes the string rather than the object.
  if (body !== undefined && body !== null) {
    tags.push(['payload', crypto.sha256(body, 'hex')])
  }

  const event = {
    pubkey: customer.pubHex,
    created_at: Math.floor(Date.now() / 1000),
    kind: 27235,
    tags,
    content: '',
  }
  event.id = eventId(event)

  // Timed, because this is load-generator cost rather than gateway cost, and
  // a run needs to know when the two have swapped places.
  const signed = timed(signing_ms, () =>
    http.post(
      `${SIGNER_URL}/sign`,
      JSON.stringify({ privHex: customer.privHex, msgHex: event.id }),
      { headers: { 'Content-Type': 'application/json' }, tags: { name: 'signer' } },
    ),
  )

  if (signed.status !== 200) {
    throw new Error(`the signer refused to sign (${signed.status}): ${signed.body}`)
  }

  event.sig = JSON.parse(signed.body).sigHex
  return `Nostr ${encoding.b64encode(JSON.stringify(event))}`
}

/** Derive a public key, for a customer known only by their private key. */
export function derivePub(privHex) {
  const res = http.post(`${SIGNER_URL}/derivePub`, JSON.stringify({ privHex }), {
    headers: { 'Content-Type': 'application/json' },
    tags: { name: 'signer' },
  })
  if (res.status !== 200) throw new Error(`derivePub failed (${res.status}): ${res.body}`)
  return JSON.parse(res.body).pubHex
}

/** Fail early and clearly, rather than one confusing 401 per iteration. */
export function requireSigner() {
  const res = http.get(`${SIGNER_URL}/health`, { tags: { name: 'signer' } })
  if (res.status !== 200) {
    throw new Error(
      `No signer on ${SIGNER_URL}. Start it first:\n\n  node loadtest/signer.mjs\n`,
    )
  }
}
