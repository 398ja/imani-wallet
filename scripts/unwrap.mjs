import WebSocket from 'ws'
import { nip17, nip19 } from 'nostr-tools'
import { hexToBytes } from '@noble/hashes/utils'

const [,, relay, nsec, ...ids] = process.argv
const sk = nip19.decode(nsec).data
const ws = new WebSocket(relay)
ws.on('open', () => ws.send(JSON.stringify(['REQ','u',{ ids }])))
ws.on('message', d => {
  const m = JSON.parse(String(d))
  if (m[0] === 'EVENT') {
    try {
      const rumor = nip17.unwrapEvent(m[2], sk instanceof Uint8Array ? sk : hexToBytes(sk))
      console.log('=== wrap', m[2].id.slice(0,8), 'rumor from', rumor.pubkey.slice(0,8))
      { const p = JSON.parse(rumor.content); delete p.token; console.log(JSON.stringify(p, null, 1)) }
    } catch (e) { console.log('=== wrap', m[2].id.slice(0,8), 'unwrap failed:', e.message) }
  }
  if (m[0] === 'EOSE') process.exit(0)
})
setTimeout(()=>process.exit(0), 10000)
