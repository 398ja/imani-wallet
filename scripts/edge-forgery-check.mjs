// Can a page grant itself `coupon:issue` by sending the header the portal trusts?
//
// Run against a live dev stack with Vite on 5199. Every line must print 403: the
// wallet holds a REAL customer session throughout, so a 201 anywhere below means
// the edge stopped stripping client-supplied headers and a customer can mint
// coupons. Pass any customer's secret key as the argument.
//
//   node scripts/edge-forgery-check.mjs <sk-hex>
//
// The production equivalent of the strip is in imani-deploy's
// nginx/conf.d/lua/nap_auth.lua — same three headers, same reason.
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools'
import { hexToBytes, bytesToHex } from '@noble/hashes/utils'
import { sha256 } from '@noble/hashes/sha2'

// Override both to point at a deployed environment, where the edge is nginx +
// nap_auth.lua rather than Vite's middleware. The assertion is identical:
//   CORE=https://wallet.staging.398ja.xyz EDGE=https://wallet.staging.398ja.xyz \
//     node scripts/edge-forgery-check.mjs <sk-hex>
const CORE = process.env.CORE ?? 'http://localhost:28081'
const VITE = process.env.EDGE ?? 'http://localhost:5199'
const priv = hexToBytes(process.argv[2])
const pubkey = getPublicKey(priv)

const challenge = await (await fetch(`${CORE}/api/v1/auth/init`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ npub: nip19.npubEncode(pubkey) }),
})).json()
const rawBody = new TextEncoder().encode(JSON.stringify({ challenge_id: challenge.challenge_id }))
const event = finalizeEvent({
  kind: 27235, created_at: Math.floor(Date.now() / 1000),
  tags: [['u', challenge.auth_url], ['method', challenge.auth_method],
    ['payload', bytesToHex(sha256(rawBody))],
    ['challenge', challenge.challenge], ['challenge_id', challenge.challenge_id]],
  content: '',
}, priv)
const complete = await fetch(`${CORE}/api/v1/auth/complete`, {
  method: 'POST',
  headers: { 'content-type': 'application/json',
    Authorization: `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}` },
  body: rawBody,
})
const cookie = (complete.headers.get('set-cookie') ?? '').split(';')[0]
const session = await complete.json()
console.log(`session permissions: ${JSON.stringify(session.permissions)}`)

const body = JSON.stringify({ face_value_minor: 100, currency: 'EUR', quantity: 1, expiry_days: 30 })
const shot = async (label, headers) => {
  const r = await fetch(`${VITE}/api/v1/portal/vouchers`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie, ...headers }, body,
  })
  console.log(`${label} → ${r.status} ${(await r.text()).slice(0, 70)}`)
}

await shot('honest (no headers sent)          ', {})
await shot('forging coupon:issue              ', { 'X-Auth-Permissions': 'coupon:issue' })
await shot('forging pubkey + permissions      ', {
  'X-Auth-Pubkey': 'f'.repeat(64), 'X-Auth-Permissions': 'coupon:issue',
})
await shot('forging the edge secret too       ', {
  'X-Auth-Permissions': 'coupon:issue', 'X-Edge-Auth': 'dev-edge-secret-local-only-32-plus-chars',
})

// The path where Connect's mount and Vite's proxy matcher used to disagree.
const bypass = await fetch(`${VITE}/api/v1/portalfoo`, {
  method: 'POST',
  headers: { cookie, 'X-Auth-Pubkey': 'f'.repeat(64), 'X-Auth-Permissions': 'coupon:issue' },
  body,
})
console.log(`prefix-bypass /api/v1/portalfoo   → ${bypass.status}`)

// --- merchant-service, the same question asked of a different service --------
//
// Added after `Connect to Stripe` answered 401 with a valid session. Two bugs
// met there, and only one of them was the visible one:
//
//   1. The proxy rule sent the request STRAIGHT to merchant-service, skipping
//      the middleware that turns a session cookie into X-Auth-Pubkey. A good
//      session arrived anonymous. That was the 401.
//   2. merchant-service ran its own NapProxyAuthFilter that believed
//      X-Auth-Pubkey with NO proof of origin. Fixing (1) alone would have made
//      the screen work while leaving anyone who could reach the pod able to act
//      as any merchant.
//
// So the honest line must now be non-401, and every forged line must be 401.
// Before the fix the fourth line — pubkey with no secret at all — reached the
// Stripe adapter and came back 502.
const stripeBody = JSON.stringify({
  return_url: 'http://localhost:5173/settings/payments?stripe=return',
  refresh_url: 'http://localhost:5173/settings/payments?stripe=refresh',
})
const merchantShot = async (label, headers) => {
  const r = await fetch(`${VITE}/api/v1/merchant/stripe/connect`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie, ...headers },
    body: stripeBody,
  })
  console.log(`${label} → ${r.status} ${(await r.text()).slice(0, 70)}`)
}

// READ THE SERVICE LOG, NOT JUST THESE STATUS CODES. The forged lines below
// answer the SAME code as the honest one, because the edge overwrites the
// forged header rather than rejecting the request — so the call succeeds, as
// the real session. `docker logs merchant-service-test | grep
// merchant_stripe_connect` prints the pubkey that actually acted, and every
// line must show the SESSION's pubkey, never the aaaa… one sent here. Verified:
// three forged attempts, three log lines reading ba5acafe (the session).
//
// On this dev stack the honest line is 502 with STRIPE_CONNECT_ENABLED unset —
// payment-adapter answers 503 CONNECT_DISABLED, which needs real Stripe keys.
// That is downstream of authentication and is exactly why the log matters more
// than the code here.
console.log('\n--- merchant-service (401 = refused; honest line must NOT be 401) ---')
await merchantShot('honest, through the dev edge      ', {})
await merchantShot('forging a victim pubkey           ', { 'X-Auth-Pubkey': 'a'.repeat(64) })
await merchantShot('forging pubkey + edge secret      ', {
  'X-Auth-Pubkey': 'a'.repeat(64), 'X-Edge-Auth': 'dev-edge-secret-local-only-32-plus-chars',
})

// Straight at the service, no proxy in the way — the SSRF / misrouted-ingress
// case, and the one that was wide open. 401 is the only acceptable answer.
const MERCHANT = process.env.MERCHANT ?? 'http://localhost:28088'
const direct = await fetch(`${MERCHANT}/api/v1/merchant/stripe/connect`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'X-Auth-Pubkey': 'a'.repeat(64) },
  body: stripeBody,
})
console.log(`direct to the pod, forged pubkey  → ${direct.status}`)
