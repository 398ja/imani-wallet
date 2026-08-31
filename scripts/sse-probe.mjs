// Does the gateway's nostr SSE stream actually deliver a gift wrap that lands
// while the stream is open?
//
// "The coupon only arrives after a refresh" has exactly two shapes: the live
// stream never carries the event (SSE broken), or it carries it and the wallet
// drops it. This answers the first half without a browser: log in as a seed
// identity, open /api/v1/nostr/subscribe, publish a kind-1059 addressed to that
// identity straight to the relay, and see whether the open stream reports it.
//
// Usage: node scripts/sse-probe.mjs <sk-hex> [base-url] [relay-url]
import { finalizeEvent, getPublicKey, nip19, nip17 } from 'nostr-tools'
import { hexToBytes, bytesToHex } from '@noble/hashes/utils'
import { sha256 } from '@noble/hashes/sha2'
import WebSocket from 'ws'

const [sk, base = 'https://staging.398ja.xyz', relayUrl = 'wss://relay.staging.398ja.xyz'] =
  process.argv.slice(2)
if (!sk) {
  console.error('usage: node scripts/sse-probe.mjs <sk-hex> [base-url] [relay-url]')
  process.exit(1)
}

const priv = hexToBytes(sk)
const pubkey = getPublicKey(priv)

async function login() {
  const init = await fetch(`${base}/api/v1/auth/init`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ npub: nip19.npubEncode(pubkey) }),
  })
  const challenge = await init.json()
  if (!challenge.challenge_id) throw new Error(`init failed: ${JSON.stringify(challenge)}`)

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
  const cookie = (complete.headers.get('set-cookie') ?? '').split(';')[0]
  if (!cookie) throw new Error(`login failed: ${complete.status} ${await complete.text()}`)
  return cookie
}

// The wallet subscribes with these exact params (see src/lib/dmPoll.ts).
async function openStream(cookie, onEvent) {
  const url = `${base}/api/v1/nostr/subscribe?kinds=1059&pTags=${pubkey}`
  const res = await fetch(url, { headers: { cookie, accept: 'text/event-stream' } })
  console.log(`subscribe → ${res.status} ${res.headers.get('content-type')}`)
  if (!res.ok) {
    console.log(await res.text())
    process.exit(1)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) {
      console.log('stream closed by server')
      return
    }
    buffer += decoder.decode(value, { stream: true })
    const frames = buffer.split('\n\n')
    buffer = frames.pop() ?? ''
    for (const frame of frames) onEvent(frame.trim())
  }
}

function publishWrap() {
  return new Promise((resolve, reject) => {
    // A wrap the probe can decrypt itself: sender and recipient are the same
    // key, which is all the gateway's kind+pTag filter looks at.
    const wraps = nip17.wrapEvent(priv, { publicKey: pubkey }, JSON.stringify({ probe: Date.now() }))
    const wrap = Array.isArray(wraps) ? wraps[0] : wraps
    const ws = new WebSocket(relayUrl)
    ws.on('open', () => ws.send(JSON.stringify(['EVENT', wrap])))
    ws.on('message', (d) => {
      const m = JSON.parse(String(d))
      if (m[0] === 'OK') {
        ws.close()
        m[2] ? resolve(wrap.id) : reject(new Error(`relay rejected: ${m[3]}`))
      }
    })
    ws.on('error', reject)
  })
}

const cookie = await login()
console.log(`logged in as ${pubkey.slice(0, 12)}…`)

let published = null
const seen = []
void openStream(cookie, (frame) => {
  if (!frame) return
  const data = frame
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim())
    .join('')
  if (!data) return console.log('frame:', frame.replace(/\n/g, ' | '))
  try {
    const e = JSON.parse(data)
    seen.push(e.id)
    console.log(`  SSE event ${String(e.id).slice(0, 8)} kind=${e.kind}`)
  } catch {
    console.log('  SSE frame:', data.slice(0, 120))
  }
})

// Let the stream register before publishing; a wrap sent into a half-open
// stream would prove nothing.
await new Promise((r) => setTimeout(r, 3000))
published = await publishWrap()
console.log(`published wrap ${published.slice(0, 8)} to the relay`)

await new Promise((r) => setTimeout(r, 15000))
const delivered = seen.includes(published)
console.log(`\nlive delivery: ${delivered ? 'YES' : 'NO'} (${seen.length} SSE event(s) total)`)

// The catch-up path the wallet runs on start/refresh, for contrast.
const q = await fetch(`${base}/api/v1/nostr/query`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify({
    kinds: [1059],
    pTags: [pubkey],
    since: Math.floor(Date.now() / 1000) - 7 * 24 * 3600,
    limit: 50,
  }),
})
const body = await q.json()
const ids = (body.events ?? []).map((e) => e.id)
console.log(`query on refresh: ${ids.includes(published) ? 'YES' : 'NO'} (${ids.length} event(s))`)
process.exit(0)
