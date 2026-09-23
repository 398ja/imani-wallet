// Signing a request the way the wallet signs it.
//
// A NAP session authenticates a *session*; NIP-98 authenticates one *request*
// with a signature binding the caller's key to that exact URL, method and body.
// The gateway wants the second on its write endpoints.
//
// This mirrors `src/lib/nip98.ts` closely, because a load test that signs
// differently from the wallet measures a path no customer takes. Two details
// are load-bearing:
//
//   * A nonce tag, which the wallet does NOT send. This is the one deliberate
//     divergence, and it took a failing smoke run to justify. The event id is
//     a hash over the tags and a second-granularity timestamp, so two
//     identical requests in the same second produce the same id, and the
//     gateway rejects the second as a replay:
//
//       nip98_eventid_replay_detected ... reason=Event ID already used
//
//     The wallet never hits this because it never repeats a request within a
//     second (it drains every ten). A load run does so constantly. imani-apps
//     carried a nonce for exactly this reason; removing it on the principle of
//     "match the wallet exactly" was wrong, and the smoke run caught it.
//
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
    // Unique per request, so concurrent iterations do not collide into one
    // event id and get rejected as replays. See the note at the top.
    ['nonce', `${Date.now()}-${crypto.sha256(String(Math.random()), 'hex').slice(0, 16)}`],
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

/**
 * Open a NAP session, and return the cookie plus what it may do.
 *
 * A NIP-98 signature authorises ONE REQUEST. Issuance is not guarded that way:
 * `coupon:issue` is granted only on the NAP session path
 * (`NapProxyAuthFilter`), so no amount of per-request signing reaches it. This
 * is the session login the wallet itself performs, done without a browser.
 *
 * `loadtest/README.md` used to say a script could never obtain a session
 * cookie. That was wrong, and it kept the acquiring half of the market day
 * unmeasured: `/auth/init` returns a challenge, a kind-27235 event signs it,
 * and `/auth/complete` sets the cookie. Verified against staging.
 *
 * The session is opened ONCE PER VU and reused, because logging in per
 * iteration would measure the login rather than the issuance, and a NAP
 * session lasts hours.
 */
export function napLogin(base, identity) {
  const init = http.post(
    `${base}/api/v1/auth/init`,
    JSON.stringify({ npub: identity.npub }),
    { headers: { 'Content-Type': 'application/json' }, tags: { name: 'auth init' } },
  )
  if (init.status !== 200) return { error: `auth/init ${init.status}` }

  const challenge = JSON.parse(init.body)
  const body = JSON.stringify({ challenge_id: challenge.challenge_id })

  const event = {
    pubkey: identity.pubHex,
    created_at: Math.floor(Date.now() / 1000),
    kind: 27235,
    tags: [
      ['u', challenge.auth_url],
      ['method', challenge.auth_method],
      ['payload', crypto.sha256(body, 'hex')],
      ['challenge', challenge.challenge],
      ['challenge_id', challenge.challenge_id],
    ],
    content: '',
  }
  event.id = eventId(event)

  const signed = timed(signing_ms, () =>
    http.post(
      `${SIGNER_URL}/sign`,
      JSON.stringify({ privHex: identity.privHex, msgHex: event.id }),
      { headers: { 'Content-Type': 'application/json' }, tags: { name: 'signer' } },
    ),
  )
  if (signed.status !== 200) {
    throw new Error(`the signer refused to sign a NAP challenge (${signed.status})`)
  }
  event.sig = JSON.parse(signed.body).sigHex

  // `auth_url` names the account tier's own host, which on staging does not
  // resolve from outside (account.staging.398ja.xyz is NXDOMAIN). Every tier
  // answers on the one host by path, so keep the path and take the origin
  // from the base that is known to be reachable.
  const url = challenge.auth_url.replace(/^https?:\/\/[^/]+/, base)
  const complete = http.post(url, body, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Nostr ${encoding.b64encode(JSON.stringify(event))}`,
    },
    tags: { name: 'auth complete' },
  })
  if (complete.status !== 200) return { error: `auth/complete ${complete.status}` }

  // k6 keeps its own cookie jar per VU, so the session rides along on later
  // requests automatically. The header is returned as well for the calls that
  // set one explicitly.
  const setCookie = complete.headers['Set-Cookie'] ?? ''
  const cookie = String(setCookie).split(';')[0]

  const validate = http.get(`${base}/api/v1/auth/validate`, {
    headers: cookie ? { Cookie: cookie } : {},
    tags: { name: 'auth validate' },
  })
  const permissions = String(validate.headers['X-Auth-Permissions'] ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)

  return { cookie, permissions }
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
