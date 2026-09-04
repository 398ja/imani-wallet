/**
 * Issuing and delivering a coupon, entirely through the courier.
 *
 * API tickets 03 and 04. A caller holding nothing but a key asks the wallet API
 * what to sign, signs it, and sends it to the gateway itself. The service never
 * holds a credential, never mints, and never delivers — it says what the bytes
 * are and forwards nothing.
 *
 * The arm that matters is the last one in each phase: the gateway ACCEPTS the
 * signature over the body this service produced. Anything less proves only that
 * we returned a plausible-looking URL.
 *
 *   npx tsx e2e/probe-issue.mts
 */
import { finalizeEvent } from 'nostr-tools'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { secp256k1, schnorr } from '@noble/curves/secp256k1.js'

import { parseVoucherToken, verifyVoucher } from '../src/lib/voucherToken.js'

const API = process.env.API_URL ?? 'http://localhost:8788'

let failures = 0
function check(what: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

/** A stall that exists only here: never registered, no session, no cookie. */
const stallSk = secp256k1.utils.randomSecretKey()
const stallPk = bytesToHex(schnorr.getPublicKey(stallSk))

/** The customer who will be handed the coupon. */
const customerPk = bytesToHex(schnorr.getPublicKey(secp256k1.utils.randomSecretKey()))

function header(sk: Uint8Array, url: string, method: string, body?: string): string {
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
    headers: { 'Content-Type': 'application/json', Authorization: header(stallSk, url, 'POST', body) },
    body,
  })
  return { status: r.status, body: (await r.json()) as Record<string, never> }
}

/** Send exactly what the courier returned, signed byte for byte. */
async function forward(instruction: { url: string; method: string; body: string }) {
  const r = await fetch(instruction.url, {
    method: instruction.method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: header(stallSk, instruction.url, instruction.method, instruction.body),
    },
    body: instruction.body,
  })
  return { status: r.status, text: await r.text() }
}

console.log(`A stall holding only a key: ${stallPk.slice(0, 12)}…`)

console.log('\nAsking what to sign to mint')
const plan = await ask('/v1/issue/gateway-request', {
  faceValue: 1500,
  faceUnit: 'EUR',
  faceDecimals: 2,
  memo: 'issue probe',
})
check('the courier answers', plan.status === 200, `HTTP ${plan.status}`)
check(
  'it points at the WALLET path, not the portal one a headless caller cannot use',
  String(plan.body.url).endsWith('/api/v1/wallet/vouchers'),
  String(plan.body.url),
)
check('and says the caller must poll for the token', Boolean((plan.body.then as unknown as { poll: string })?.poll))

console.log('\nThe caller signs it and mints for itself')
const minted = await forward(plan.body as unknown as { url: string; method: string; body: string })
check('the gateway accepts the signature over OUR body', minted.status < 400, `HTTP ${minted.status} ${minted.text.slice(0, 100)}`)
if (minted.status >= 400) { console.log('\nCannot continue.'); process.exit(1) }

const voucherId = (JSON.parse(minted.text) as { voucher_id: string }).voucher_id
check('a voucher id comes back, which is how an undelivered coupon is found', Boolean(voucherId), voucherId)

console.log('\nPolling, as the courier said to')
let token = ''
for (let i = 0; i < 30; i++) {
  const readUrl = `${String(plan.body.url)}/${voucherId}`
  const r = await fetch(readUrl, { headers: { Authorization: header(stallSk, readUrl, 'GET') } })
  if (r.ok) {
    const v = (await r.json()) as { token?: string }
    if (v.token) { token = v.token; console.log(`  token arrived after ~${i * 2}s`); break }
  }
  await new Promise((res) => setTimeout(res, 2000))
}
check('the coupon eventually carries a real token', token.length > 0)

const parsed = parseVoucherToken(token)
check('it names the CALLER as issuer', parsed.voucher.issuerId === stallPk, parsed.voucher.issuerId.slice(0, 16))
check("the issuer's signature verifies", verifyVoucher(parsed.voucher).signatureValid)
check('and it carries the face value asked for', parsed.voucher.faceValue === 1500, String(parsed.voucher.faceValue))

console.log('\nA caller cannot mint in another stall\u2019s name')
for (const field of ['issuerId', 'issuer_id', 'stallPubkey']) {
  const evil = await ask('/v1/issue/gateway-request', {
    faceValue: 100,
    faceUnit: 'EUR',
    [field]: 'b'.repeat(64),
  })
  check(`\`${field}\` is REFUSED, not ignored`, evil.status === 400 && evil.body.field === field, `HTTP ${evil.status}`)
}

console.log('\nAsking what to sign to deliver it')
const delivery = await ask('/v1/issue/deliver-request', {
  recipientPubkey: customerPk,
  token,
  voucherId,
  faceValue: 1500,
  faceUnit: 'EUR',
  faceDecimals: 2,
  memo: 'issue probe',
})
check('the courier answers', delivery.status === 200, `HTTP ${delivery.status}`)
check('pointing at the DM endpoint', String(delivery.body.url).endsWith('/api/v1/dm/tokens/send'))

const deliverPayload = JSON.parse(String(delivery.body.body)) as Record<string, unknown>
// A customer must hold a coupon from a stall they can look up, not from a till
// that may not exist next week.
check('the coupon names the STALL as sender and issuer', deliverPayload.issuer_id === stallPk && deliverPayload.sender_pubkey === stallPk)
check('and is addressed to the customer', deliverPayload.recipient_pubkey === customerPk)

console.log('\nThe caller signs that too, and the gateway delivers')
const delivered = await forward(delivery.body as unknown as { url: string; method: string; body: string })
check(
  'the gateway accepts the signature over OUR delivery body',
  delivered.status < 400,
  `HTTP ${delivered.status} ${delivered.text.slice(0, 140)}`,
)

console.log('\nDelivery is a SEPARATE call, so a failure there is recoverable')
// The seam these two tickets exist to keep open: the coupon is minted and the
// caller holds its id, so an undelivered coupon can be found and retried
// rather than being silently lost inside a single "sell" call.
check('the voucher id survives independently of delivery', Boolean(voucherId))

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
