/**
 * Does a locked coupon survive the WHOLE gateway round trip?
 *
 * `probe-witness-positive.mts` talks to the mint directly, which proves the
 * mint enforces a lock but says nothing about whether the gateway can issue one
 * or spend one. Issue #58 broke in four separate places between those two ends,
 * and every one of them returned a cheerful 2xx while doing the wrong thing:
 *
 *   - the controller rebuilt the request and dropped recipient_pubkey
 *   - the adapter routed a locked request down a path that discards metadata
 *   - the app's CBOR reader could not decode a cashuB token at all
 *   - no client ever sent the X-Cashu-Witnesses header
 *
 * None of those was visible from either end alone. So this drives the real
 * gateway over HTTP with NIP-98 auth and checks the property that actually
 * matters: the coupon is locked to the customer, the mint REFUSES it unsigned,
 * and the customer's own signature is what makes it spendable.
 *
 *   npx tsx e2e/probe-gateway-locked-redeem.mts
 *
 * Needs the imani-test stack up, and a funded gateway wallet.
 */
import { readFileSync } from 'node:fs'
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import { hexToBytes, bytesToHex } from '@noble/hashes/utils'
import { sha256 } from '@noble/hashes/sha2.js'
import { schnorr } from '@noble/curves/secp256k1.js'

import { proofSecrets } from '../src/lib/voucherToken'

const GATEWAY = process.env.GATEWAY_URL ?? 'http://localhost:28082'
const MINT = process.env.MINT_URL ?? 'http://127.0.0.1.mint:7777'
const KEY_FILE = process.env.LOCK_KEY_FILE ?? '/tmp/lockkey.json'

const secretKey = hexToBytes(JSON.parse(readFileSync(KEY_FILE, 'utf8')).sk)
const pubkey = getPublicKey(secretKey)

/** NIP-98: the gateway signs every customer request, so the probe must too. */
function authHeader(url: string, method: string, body?: string): string {
  const tags = [['u', url], ['method', method]]
  if (body) tags.push(['payload', bytesToHex(sha256(new TextEncoder().encode(body)))])
  const event = finalizeEvent(
    { kind: 27235, created_at: Math.floor(Date.now() / 1000), tags, content: '' }, secretKey)
  return 'Nostr ' + Buffer.from(JSON.stringify(event)).toString('base64')
}

async function call(path: string, method: string, payload?: unknown,
                    extra: Record<string, string> = {}) {
  const url = GATEWAY + path
  const body = payload ? JSON.stringify(payload) : undefined
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: authHeader(url, method, body), ...extra },
    body,
  })
  return { status: res.status, text: await res.text() }
}

function fail(message: string): never {
  console.error(`FAIL: ${message}`)
  process.exit(1)
}

// 1. Issue a coupon locked to the customer's key.
// FACE_VALUE=120 makes the mint split the token into 64+32+16+8, which is
// the case that matters: four outputs cannot share a nonce, so each needs its
// own AND each needs a valid issuer signature. A single-proof voucher passes
// even when the multi-output path is broken, so the default is the split.
const faceValue = Number(process.env.FACE_VALUE ?? 120)
const created = await call('/api/v1/wallet/vouchers', 'POST', {
  face_value: faceValue, face_unit: 'sat', face_decimals: 0,
  mint_url: MINT, backing_strategy: 'FIXED',
  recipient_pubkey: '02' + pubkey,
  // Drives token_amount, and therefore how many proofs the token carries.
  backing_sats: faceValue,
})
if (created.status !== 201) fail(`issuance returned ${created.status}: ${created.text.slice(0, 200)}`)

// Quote-funded issuance finalises asynchronously, so poll for the token.
const voucherId = JSON.parse(created.text).voucher_id
let token: string | undefined = JSON.parse(created.text).token
for (let i = 0; !token && i < 8; i++) {
  await new Promise((r) => setTimeout(r, 3_000))
  const polled = await call(`/api/v1/wallet/vouchers/${voucherId}`, 'GET')
  try { token = JSON.parse(polled.text).token } catch { /* still pending */ }
}
if (!token) fail(`voucher ${voucherId} never produced a token`)
console.log('1. issued a locked coupon')

// 2. Read its secrets with the app's OWN reader, not a second decoder.
const secrets = proofSecrets(token)
const kinds = secrets.map((s) => JSON.parse(s)[0])
if (!kinds.includes('P2PK_VOUCHER')) {
  // The failure this catches: recipient_pubkey silently dropped somewhere
  // between the controller and the signed secret, yielding a bearer coupon
  // that anyone can spend. It returns 201 either way.
  fail(`coupon is not locked — kinds were ${JSON.stringify(kinds)}`)
}
if (new Set(secrets).size !== secrets.length) {
  // Identical secrets share a Y, so the mint treats them as one proof: a
  // 120 sat voucher would be worth 64.
  fail(`the ${secrets.length} issued proof(s) are not all distinct`)
}
console.log(`2. decoded ${secrets.length} distinct secret(s), locked as P2PK_VOUCHER`)

// 3. Sign, exactly as the browser does.
const xOnly = (hex: string) => (hex.length === 66 ? hex.slice(2) : hex)
const witnesses: Record<string, string[]> = {}
for (const secret of secrets) {
  const parsed = JSON.parse(secret)
  if (parsed[0] !== 'P2PK_VOUCHER') continue
  if (xOnly(parsed[1].data) !== pubkey) continue
  // A BARE hex signature over sha256(secret): the gateway parses
  // Map<String, List<String>> and builds the NUT-11 witness itself.
  witnesses[secret] = [bytesToHex(schnorr.sign(sha256(new TextEncoder().encode(secret)), secretKey))]
}
if (Object.keys(witnesses).length === 0) fail('nothing was signed — is the coupon locked to us?')
const header = JSON.stringify(witnesses)
console.log('3. signed every locked secret')

// 4a. Unsigned must be REFUSED. Without this arm a permissive mint would let
//     the whole probe pass while enforcing nothing.
const bare = await call('/api/v1/wallet/receive', 'POST', { token },
  { 'Idempotency-Key': `probe-bare-${Date.now()}` })
if (bare.status === 200) fail('an unsigned locked coupon was ACCEPTED — the lock is not enforced')
console.log(`4a. unsigned redemption refused (${bare.status})`)

// The auth filter rejects a repeated event id, and created_at has 1s
// resolution, so the next request needs a distinct second.
await new Promise((r) => setTimeout(r, 1_500))

// 4b. Signed must SUCCEED.
const signed = await call('/api/v1/wallet/receive', 'POST', { token },
  { 'Idempotency-Key': `probe-signed-${Date.now()}`, 'X-Cashu-Witnesses': header })
if (signed.status !== 200) {
  fail(`a correctly signed coupon was refused (${signed.status}): ${signed.text.slice(0, 300)}`)
}
console.log(`4b. signed redemption succeeded (${signed.status})`)

// 5. The proofs receive MINTED must not be born spent.
//
// A 200 on the receive is not enough. If the swap gives an output the same
// secret as its input, the two share a Y — and the input is spent by that very
// swap, so the "fresh" proof is already marked spent at the mint. The receive
// looks perfect and the coupon is destroyed. That shipped once: an attempt to
// preserve the issuer signature by keeping the nonce did exactly this, and
// only a respend revealed it.
const fresh = JSON.parse(signed.text).token
if (fresh) {
  const freshSecrets = proofSecrets(fresh)
  const reused = freshSecrets.filter((s) => secrets.includes(s))
  if (reused.length > 0) {
    fail(`${reused.length} minted proof(s) reuse an input secret — they share a Y `
      + `with a proof this swap just spent, so they are already spent at the mint`)
  }
  console.log(`5. the ${freshSecrets.length} minted proof(s) all carry fresh secrets`)

  // 6. And they must actually be SPENDABLE.
  //
  // Fresh secrets are necessary but not sufficient. The nonce that makes them
  // distinct lives inside the bytes the issuer signed, so unless the issuer
  // re-signs, the mint refuses them with voucher_signature_invalid (90019) —
  // received fine, dead on the next spend. Only a real second spend shows it.
  await new Promise((r) => setTimeout(r, 1_600))
  const freshWitnesses: Record<string, string[]> = {}
  for (const secret of freshSecrets) {
    let parsed
    try { parsed = JSON.parse(secret) } catch { continue }
    if (parsed[0] !== 'P2PK_VOUCHER') continue
    if (xOnly(parsed[1].data) !== pubkey) continue
    freshWitnesses[secret] =
      [bytesToHex(schnorr.sign(sha256(new TextEncoder().encode(secret)), secretKey))]
  }
  const respend = await call('/api/v1/wallet/receive', 'POST', { token: fresh },
    { 'Idempotency-Key': `probe-respend-${Date.now()}`,
      'X-Cashu-Witnesses': JSON.stringify(freshWitnesses) })
  if (respend.status !== 200) {
    fail(`the proofs receive minted could not be spent (${respend.status}): `
      + `${respend.text.slice(0, 300)}`)
  }
  console.log(`6. those minted proof(s) spend again cleanly (${respend.status})`)
}

console.log('\nPASS: the coupon is the customer\'s, and only their signature spends it.')
