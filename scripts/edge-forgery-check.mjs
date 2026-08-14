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

const CORE = 'http://localhost:28081'
const VITE = 'http://localhost:5199'
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
  'X-Auth-Permissions': 'coupon:issue', 'X-Edge-Auth': 'dev-edge-secret-local-only',
})

// The path where Connect's mount and Vite's proxy matcher used to disagree.
const bypass = await fetch(`${VITE}/api/v1/portalfoo`, {
  method: 'POST',
  headers: { cookie, 'X-Auth-Pubkey': 'f'.repeat(64), 'X-Auth-Permissions': 'coupon:issue' },
  body,
})
console.log(`prefix-bypass /api/v1/portalfoo   → ${bypass.status}`)
