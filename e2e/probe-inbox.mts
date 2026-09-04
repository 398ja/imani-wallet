/**
 * Receiving and registering, end to end against the live gateway.
 *
 * API tickets 06 and 10. Both were marked "locate the service first", and both
 * turned out to be reachable — on a HOST the ticket named wrongly. So the arms
 * that matter here are the ones that follow the courier's instructions all the
 * way to the gateway and require it to answer.
 *
 *   npx tsx e2e/probe-inbox.mts
 */
import { finalizeEvent } from 'nostr-tools'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { secp256k1, schnorr } from '@noble/curves/secp256k1.js'

const API = process.env.API_URL ?? 'http://localhost:8788'

let failures = 0
function check(what: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const sk = secp256k1.utils.randomSecretKey()
const pubkey = bytesToHex(schnorr.getPublicKey(sk))

function header(url: string, method: string, body?: string): string {
  const tags = [['u', url], ['method', method]]
  if (body !== undefined) tags.push(['payload', bytesToHex(sha256(new TextEncoder().encode(body)))])
  const event = finalizeEvent(
    { kind: 27235, created_at: Math.floor(Date.now() / 1000), tags, content: '' },
    sk,
  )
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`
}

async function ask(path: string, payload: unknown) {
  const url = `${API}${path}`
  const body = JSON.stringify(payload)
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: header(url, 'POST', body) },
    body,
  })
  return { status: r.status, body: (await r.json()) as Record<string, never> }
}

/** Follow the courier's instructions exactly, signing what it returned. */
async function forward(i: { url: string; method: string; body: string }) {
  const r = await fetch(i.url, {
    method: i.method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: header(i.url, i.method, i.body),
    },
    body: i.body,
  })
  return { status: r.status, text: await r.text() }
}

console.log(`A caller holding only a key: ${pubkey.slice(0, 12)}…`)

console.log('\nAsking what to sign to collect arrivals')
const drain = await ask('/v1/inbox/drain', { limit: 10 })
check('the courier answers', drain.status === 200, `HTTP ${drain.status}`)
check(
  'pointing at gateway-core, where the endpoint actually lives',
  String(drain.body.url).endsWith('/api/v1/incoming-notifications/drain'),
  String(drain.body.url),
)
check('and says the caller decrypts for itself', Boolean((drain.body.then as unknown as { decrypt: string })?.decrypt))

console.log('\nThe caller signs it and drains its own inbox')
const drained = await forward(drain.body as unknown as { url: string; method: string; body: string })
check('the gateway accepts the signature over OUR body', drained.status === 200, `HTTP ${drained.status} ${drained.text.slice(0, 120)}`)

const envelopes = drained.status === 200 ? (JSON.parse(drained.text) as { envelopes?: unknown[] }).envelopes : undefined
check('and answers with an envelope list', Array.isArray(envelopes), JSON.stringify(envelopes)?.slice(0, 60))
// A fresh key has been sent nothing. Empty is the correct answer, not a
// failure — and it must not read as one.
check('which is empty for a key nobody has paid', envelopes?.length === 0)

console.log('\nAcknowledging')
const ack = await ask('/v1/inbox/ack', { ids: ['not-a-real-envelope'] })
check('the courier answers', ack.status === 200, `HTTP ${ack.status}`)
const acked = await forward(ack.body as unknown as { url: string; method: string; body: string })
check('the gateway accepts that signature too', acked.status === 200, `HTTP ${acked.status} ${acked.text.slice(0, 100)}`)

console.log('\nAcknowledging nothing is refused')
// A loop that built an empty list would otherwise drain the same envelopes
// forever while believing it had acknowledged them.
const empty = await ask('/v1/inbox/ack', { ids: [] })
check('as a request error, naming the field', empty.status === 400 && empty.body.field === 'ids')

console.log('\nClaiming a handle')
const handle = `probe${Math.floor(Math.random() * 100_000)}`
const claim = await ask('/v1/stalls/claim-handle', { username: handle })
check('the courier answers', claim.status === 200, `HTTP ${claim.status}`)
check(
  'pointing at /api/v1/nip05, not the bottin endpoint that wants Basic auth',
  String(claim.body.url).endsWith('/api/v1/nip05'),
  String(claim.body.url),
)
check('and claims it for the SIGNING key', JSON.parse(String(claim.body.body)).pubkey === pubkey)

console.log('\nThe caller signs it and the handle is claimed')
const claimed = await forward(claim.body as unknown as { url: string; method: string; body: string })
check('the gateway accepts it', claimed.status === 201, `HTTP ${claimed.status} ${claimed.text.slice(0, 140)}`)
if (claimed.status === 201) {
  const registered = JSON.parse(claimed.text) as { username: string; hex_pubkey: string }
  check('under the handle asked for', registered.username === handle, registered.username)
  check('bound to the caller\u2019s key', registered.hex_pubkey?.toLowerCase() === pubkey.toLowerCase())
}

console.log('\nA caller cannot claim a handle for somebody else')
// The one thing this endpoint must not be usable for: pointing a name at a key
// its owner did not ask for.
const hijack = await ask('/v1/stalls/claim-handle', { username: 'someone', pubkey: 'b'.repeat(64) })
check('REFUSED, naming the field', hijack.status === 400 && hijack.body.field === 'pubkey', `HTTP ${hijack.status}`)

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
