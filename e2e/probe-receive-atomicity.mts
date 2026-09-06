/**
 * The receive path under contention, and on repeat.
 *
 * Two properties that only a live gateway can show, and that no unit test in
 * this repo covers:
 *
 *  - Six concurrent receives of one token credit EXACTLY once. The original
 *    incident was a 120 sat send credited twice, from six concurrent calls of
 *    which two completed a full mint swap.
 *  - A repeat after settlement replays the original outcome rather than
 *    conflicting. The merchant burn sweep reuses a stable key, so a 409 there
 *    told the caller their coupon had not burnt when it had.
 *
 *   npx tsx e2e/probe-receive-atomicity.mts
 */
import { readFileSync } from 'node:fs'
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import { hexToBytes, bytesToHex } from '@noble/hashes/utils'
import { sha256 } from '@noble/hashes/sha2.js'
import { schnorr } from '@noble/curves/secp256k1.js'
import { proofSecrets } from '../src/lib/voucherToken'

const GW = 'http://localhost:28082'
const MINT = 'http://127.0.0.1.mint:7777'
const sk = hexToBytes(JSON.parse(readFileSync('/tmp/lockkey.json', 'utf8')).sk)
const pk = getPublicKey(sk)

function auth(url: string, method: string, body?: string) {
  const tags = [['u', url], ['method', method]]
  if (body) tags.push(['payload', bytesToHex(sha256(new TextEncoder().encode(body)))])
  return 'Nostr ' + Buffer.from(JSON.stringify(finalizeEvent(
    { kind: 27235, created_at: Math.floor(Date.now() / 1000), tags, content: '' }, sk))).toString('base64')
}
async function call(path: string, method: string, payload?: unknown, extra: Record<string,string> = {}) {
  const url = GW + path
  const body = payload ? JSON.stringify(payload) : undefined
  const res = await fetch(url, { method, headers: {
    'Content-Type': 'application/json', Authorization: auth(url, method, body), ...extra }, body })
  return { status: res.status, text: await res.text() }
}

const created = await call('/api/v1/wallet/vouchers', 'POST', {
  face_value: 30, face_unit: 'sat', face_decimals: 0, mint_url: MINT,
  backing_strategy: 'FIXED', recipient_pubkey: '02' + pk })
const vid = JSON.parse(created.text).voucher_id
let token: string | undefined = JSON.parse(created.text).token
for (let i = 0; !token && i < 8; i++) {
  await new Promise(r => setTimeout(r, 3000))
  try { token = JSON.parse((await call(`/api/v1/wallet/vouchers/${vid}`, 'GET')).text).token } catch {}
}
if (!token) { console.error('FAIL: no token'); process.exit(1) }

const witnesses: Record<string, string[]> = {}
for (const s of proofSecrets(token)) {
  const p = JSON.parse(s)
  if (p[0] !== 'P2PK_VOUCHER') continue
  witnesses[s] = [bytesToHex(schnorr.sign(sha256(new TextEncoder().encode(s)), sk))]
}
const header = JSON.stringify(witnesses)

// One idempotency key, six concurrent callers: the double-credit shape.
//
// Each request gets its OWN NIP-98 event. Sharing one would have the auth
// filter reject five as replays (401) before the escrow claim is ever
// reached, and the probe would pass while testing nothing — the exact
// false green this arm exists to avoid.
const key = `probe-conc-${Date.now()}`
const url = GW + '/api/v1/wallet/receive'
const body = JSON.stringify({ token })
const requests = Array.from({ length: 6 }, (_, i) => ({
  // A distinct created_at per caller. The filter keys on event id, and two
  // callers sharing a second produce byte-identical events and therefore the
  // same id — so the offset must be per-caller, not per-run.
  headers: {
    'Content-Type': 'application/json',
    Authorization: 'Nostr ' + Buffer.from(JSON.stringify(finalizeEvent({
      kind: 27235, created_at: Math.floor(Date.now() / 1000) - (i * 3),
      tags: [['u', url], ['method', 'POST'],
             ['payload', bytesToHex(sha256(new TextEncoder().encode(body)))]],
      content: '',
    }, sk))).toString('base64'),
    'Idempotency-Key': key,
    'X-Cashu-Witnesses': header,
  },
}))
const results = await Promise.all(requests.map(r =>
  fetch(url, { method: 'POST', headers: r.headers, body })
    .then(async res => ({ status: res.status, text: await res.text() }))))

const codes = results.map(r => r.status).sort()
console.log('statuses:', JSON.stringify(codes))

// Anything that never reached the claim makes this arm meaningless, so it is
// reported rather than tolerated. 401 means the auth filter rejected a
// replayed event; 429 means the rate limiter shed the request — both would
// leave a green result that tested nothing.
const preempted = codes.filter(c => c === 401 || c === 429).length
if (preempted > 0) {
  console.error(`FAIL: ${preempted} request(s) never reached the escrow claim `
    + `(${JSON.stringify(codes)}). The gateway limits receive to 10/min per caller, `
    + `so give it a minute between runs rather than trusting this result.`)
  process.exit(1)
}
const ok = codes.filter(c => c === 200).length
if (ok !== 1) { console.error(`FAIL: ${ok} callers credited, expected exactly 1`); process.exit(1) }
const refused = codes.filter(c => c === 409).length
if (refused !== 5) {
  console.error(`FAIL: expected 5 conflicts from the escrow claim, saw ${refused}`)
  process.exit(1)
}
console.log('PASS: exactly one caller credited, five refused by the claim (409).')

// A repeat AFTER settlement must replay the original outcome, not conflict.
//
// This is the merchant burn-sweep shape: a stable idempotency key reused on a
// receive that has already completed. It returned 409 before, which told the
// caller their coupon had not burnt when it had.
await new Promise(r => setTimeout(r, 1500))
const replay = await call('/api/v1/wallet/receive', 'POST', { token },
  { 'Idempotency-Key': key, 'X-Cashu-Witnesses': header })
if (replay.status !== 200) {
  console.error(`FAIL: a settled receive replayed as ${replay.status}, expected 200`)
  process.exit(1)
}
const replayed = JSON.parse(replay.text)
// unit was silently dropped from the replay; token cannot be replayed at all
// because the gateway deliberately no longer stores a bearer instrument.
if (replayed.unit !== 'sat') {
  console.error(`FAIL: replay lost the unit (got ${JSON.stringify(replayed.unit)})`)
  process.exit(1)
}
if (!replayed.receive_id) {
  console.error('FAIL: replay carried no receive_id, so the caller cannot correlate it')
  process.exit(1)
}
console.log(`PASS: a settled receive replays 200 with unit=${replayed.unit}, token=${JSON.stringify(replayed.token ?? null)}.`)
