// Read events straight off the relay, bypassing the app and the gateway cache.
//
// The wallet publishes kind-0 directly to strfry (see src/lib/relay.ts), so this
// is the only way to confirm a profile save actually landed rather than trusting
// the "published to n/n relays" toast.
//
// Usage: node scripts/query-relay.mjs <pubkey-hex> [kind]
import WebSocket from 'ws'

const [pubkey, kind = '0'] = process.argv.slice(2)
if (!pubkey) {
  console.error('usage: node scripts/query-relay.mjs <pubkey-hex> [kind]')
  process.exit(1)
}

const url = process.env.RELAY_URL ?? 'ws://localhost:27778'
const ws = new WebSocket(url)
const events = []

ws.on('open', () => {
  ws.send(JSON.stringify(['REQ', 'probe', { kinds: [Number(kind)], authors: [pubkey], limit: 10 }]))
})

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString())
  if (msg[0] === 'EVENT') events.push(msg[2])
  if (msg[0] === 'EOSE') {
    console.log(`${events.length} event(s) of kind ${kind} for ${pubkey.slice(0, 12)}…`)
    for (const e of events.sort((a, b) => b.created_at - a.created_at)) {
      console.log(`  created_at=${e.created_at} id=${e.id.slice(0, 12)}…`)
      console.log(`  content=${e.content}`)
    }
    ws.close()
    process.exit(0)
  }
})

ws.on('error', (e) => {
  console.error('relay error:', e.message)
  process.exit(1)
})

setTimeout(() => {
  console.error('timed out waiting for EOSE')
  process.exit(1)
}, 8000)
