// One stall, one login, full detail. Diagnostic only, not part of a run.
//
// `stalls.mjs --verify` can only say a stall does or does not hold
// `coupon:issue`. When the answer is "no", the useful question is which of the
// three inputs to MerchantAclService.decide() disagrees: the relay (is the
// kind-30078 record actually there and active?), the ACL table (is the pubkey
// suspended?), or the registry (did the role resolve to permissions?). This
// asks the relay itself and the gateway separately so the two can be compared.
import { getPublicKey } from 'nostr-tools/pure'
import { Relay, useWebSocketImplementation } from 'nostr-tools/relay'
import { bytesToHex, utf8ToBytes, hexToBytes } from '@noble/hashes/utils.js'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

useWebSocketImplementation(WebSocket)

const GATEWAY = (process.env.GATEWAY_URL ?? 'http://localhost:28081').replace(/\/$/, '')
const INDEX = Number(process.env.STALL_INDEX ?? 0)

// The SAME pool file stalls.mjs reads. These identities are generated once and
// persisted, not derived from a seed, so re-deriving them here would probe a
// different pubkey than the one that failed and prove nothing about it.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const POOL_FILE = join(ROOT, '.loadtest-pool.json')
const pool = JSON.parse(readFileSync(POOL_FILE, 'utf8'))
const identity = Object.values(pool)
  .sort((a, b) => a.index - b.index)
  .find((i) => i.index === INDEX)
if (!identity) throw new Error(`no pool identity at index ${INDEX}`)
if (identity.pubHex !== getPublicKey(hexToBytes(identity.privHex))) {
  throw new Error(`pool identity ${INDEX} pubHex does not match its privHex`)
}
console.log(`stall   #${String(INDEX).padStart(4, '0')}`)
console.log(`pubkey  ${identity.pubHex}`)

// 1. What does the relay hold? This is hasLiveStall()'s only input.
const cfg = await (await fetch(`${GATEWAY}/api/v1/config`)).json()
console.log(`relay   ${cfg.relay_url}`)
const relay = await Relay.connect(cfg.relay_url)
const events = await new Promise((resolve) => {
  const found = []
  const sub = relay.subscribe([{ kinds: [30078], authors: [identity.pubHex], limit: 10 }], {
    onevent: (e) => found.push(e),
    oneose: () => {
      sub.close()
      resolve(found)
    },
  })
  setTimeout(() => {
    sub.close()
    resolve(found)
  }, 8000)
})
relay.close()

console.log(`\nkind-30078 events on the relay: ${events.length}`)
for (const e of events) {
  const d = e.tags.find((t) => t[0] === 'd')?.[1] ?? '(no d tag)'
  let active = '(unparseable)'
  try {
    active = String(JSON.parse(e.content).active)
  } catch {
    // content is not the JSON the resolver expects, which is itself the finding
  }
  const age = Math.floor(Date.now() / 1000) - e.created_at
  console.log(`  d=${d} active=${active} age=${age}s id=${e.id.slice(0, 8)}`)
}
if (events.length === 0) {
  console.log('  NOTHING. hasLiveStall() returns false, so customer permissions are correct.')
}

// 2. What does the gateway say, through the same login the load test uses?
const init = await fetch(`${GATEWAY}/api/v1/auth/init`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ pubkey: identity.pubHex }),
})
if (!init.ok) {
  console.log(`\nauth/init ${init.status} — cannot continue`)
  process.exit(1)
}
const challenge = await init.json()

// Byte-for-byte the event stalls.mjs signs. An approximation here is worse
// than useless: a 400 from a NIP-98 event this probe built wrong looks exactly
// like a 400 from a broken gateway, and the first version of this probe did
// send a wrong one and blamed the server for rejecting it.
const body = JSON.stringify({ challenge_id: challenge.challenge_id })
const event = {
  pubkey: identity.pubHex,
  created_at: Math.floor(Date.now() / 1000),
  kind: 27235,
  tags: [
    ['u', challenge.auth_url],
    ['method', challenge.auth_method],
    ['payload', bytesToHex(sha256(utf8ToBytes(body)))],
    ['challenge', challenge.challenge],
    ['challenge_id', challenge.challenge_id],
  ],
  content: '',
}
const serial = JSON.stringify([
  0,
  event.pubkey,
  event.created_at,
  event.kind,
  event.tags,
  event.content,
])
event.id = bytesToHex(sha256(utf8ToBytes(serial)))
event.sig = bytesToHex(schnorr.sign(hexToBytes(event.id), hexToBytes(identity.privHex)))

const url = challenge.auth_url.replace(/^https?:\/\/[^/]+/, GATEWAY)
const complete = await fetch(url, {
  method: challenge.auth_method,
  headers: {
    'content-type': 'application/json',
    authorization: `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`,
  },
  body,
})
console.log(`\nauth/complete ${complete.status}`)
if (!complete.ok) console.log(`  body: ${(await complete.clone().text()).slice(0, 400)}`)
const setCookies = complete.headers.getSetCookie?.() ?? []
console.log(`  Set-Cookie count: ${setCookies.length}`)
for (const c of setCookies) console.log(`    ${c.slice(0, 160)}`)
const cookie = setCookies.map((c) => c.split(';')[0]).join('; ')
console.log(`  cookie sent back: "${cookie.slice(0, 120)}"`)

const validate = await fetch(`${GATEWAY}/api/v1/auth/validate`, { headers: { cookie } })
console.log(`auth/validate ${validate.status}`)
console.log(`  X-Auth-Pubkey:      ${validate.headers.get('x-auth-pubkey') ?? '(absent)'}`)
console.log(`  X-Auth-Permissions: "${validate.headers.get('x-auth-permissions') ?? '(absent)'}"`)
console.log(`  X-Auth-Reason:      ${validate.headers.get('x-auth-reason') ?? '(absent)'}`)
console.log(`  body: ${(await validate.text()).slice(0, 300)}`)
