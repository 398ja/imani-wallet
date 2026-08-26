// Log in to a NAP gateway with a raw key, and print what the session says you may do.
//
// The browser is the only other thing that performs this flow, and it cannot be
// pointed at a spare port. This script exists to answer one question without a
// browser: does the ACL resolver actually grant `coupon:issue` to a merchant, and
// does `/auth/validate` hand that to the edge as `X-Auth-Permissions`?
//
// Usage: node scripts/nap-login.mjs <sk-hex> [base-url]
//        base-url defaults to http://localhost:28081 (account-app on the test stack)
//
// The `u` tag is taken from `auth_url` in the init response, NOT from the URL we
// post to: the server resolves the audience from its own config, so a gateway
// reached on any port still validates a proof signed for its configured address.
// That is what makes probing a second, temporary container possible at all.
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools'
import { hexToBytes, bytesToHex } from '@noble/hashes/utils'
import { sha256 } from '@noble/hashes/sha2'

const [sk, base = 'http://localhost:28081'] = process.argv.slice(2)
if (!sk) {
  console.error('usage: node scripts/nap-login.mjs <sk-hex> [base-url]')
  process.exit(1)
}

const priv = hexToBytes(sk)
const pubkey = getPublicKey(priv)

const init = await fetch(`${base}/api/v1/auth/init`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ npub: nip19.npubEncode(pubkey) }),
})
const challenge = await init.json()
if (!challenge.challenge_id) {
  console.error('init failed:', challenge)
  process.exit(1)
}

// The body is signed by hash, so it must be serialised once and sent byte for byte.
const rawBody = new TextEncoder().encode(JSON.stringify({ challenge_id: challenge.challenge_id }))
const event = finalizeEvent(
  {
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['u', challenge.auth_url],
      ['method', challenge.auth_method],
      ['payload', bytesToHex(sha256(rawBody))],
      ['challenge', challenge.challenge],
      ['challenge_id', challenge.challenge_id],
    ],
    content: '',
  },
  priv,
)

const complete = await fetch(`${base}/api/v1/auth/complete`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    Authorization: `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`,
  },
  body: rawBody,
})
const session = await complete.json()
console.log(`complete → ${complete.status}`)
console.log(JSON.stringify(session, null, 2))

const cookie = (complete.headers.get('set-cookie') ?? '').split(';')[0]
if (!cookie) process.exit(complete.ok ? 0 : 1)

// The edge's auth_request step, exactly as vite.config.ts's portal-edge-auth does it.
const validate = await fetch(`${base}/api/v1/auth/validate`, { headers: { cookie } })
console.log(`\nvalidate → ${validate.status}`)
console.log(`X-Auth-Pubkey:      ${validate.headers.get('x-auth-pubkey')}`)
console.log(`X-Auth-Permissions: "${validate.headers.get('x-auth-permissions')}"`)
