/**
 * Payment requests, against the running service.
 *
 * API ticket 05. The rules are unit-tested; what this establishes is that they
 * survive the round trip, and that the ONE property worth being absolute about
 * holds over HTTP: a request names the signing key as recipient and nothing a
 * caller sends can change it.
 *
 * That matters because takings are gift-wrapped to whoever the request names.
 * A request pointing elsewhere sends a customer's money to a key its owner
 * cannot decrypt — stranded rather than misrouted, and invisible until someone
 * goes looking.
 *
 *   npx tsx e2e/probe-payment-requests.mts
 */
import { finalizeEvent } from 'nostr-tools'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { secp256k1, schnorr } from '@noble/curves/secp256k1.js'

import { nut18v } from '../services/wallet-api/nut18v.js'

const API = process.env.API_URL ?? 'http://localhost:8788'

let failures = 0
function check(what: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const sk = secp256k1.utils.randomSecretKey()
const pubkey = bytesToHex(schnorr.getPublicKey(sk))

function authHeader(url: string, method: string, body: string): string {
  const event = finalizeEvent(
    {
      kind: 27235,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['u', url], ['method', method], ['payload', bytesToHex(sha256(new TextEncoder().encode(body)))]],
      content: '',
    },
    sk,
  )
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`
}

async function post(path: string, payload: unknown) {
  const url = `${API}${path}`
  const body = JSON.stringify(payload)
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: authHeader(url, 'POST', body) },
    body,
  })
  return { status: r.status, body: (await r.json()) as Record<string, never> }
}

console.log('Asking to be paid')
const created = await post('/v1/requests/create', { amount: 250, unit: 'EUR', description: 'Two coffees' })
check('the endpoint answers', created.status === 200, `HTTP ${created.status}`)

const request = created.body.request as unknown as {
  paymentId: string
  requestString: string
  clickableUri: string
  amount: number
  expiresAt: number
  createdAt: number
  status: string
}
check('it is a vreqA string', request.requestString?.startsWith('vreqA'), request.requestString?.slice(0, 12))
check('with a scannable cashu: uri', request.clickableUri?.startsWith('cashu:vreqA'))

/**
 * Decoded with the SAME encoder, which is the point: the app and this service
 * load one `shared/nut18v.js`, so a request built here is a request the app
 * could have built.
 */
const decoded = nut18v().parse(request.requestString) as Record<string, unknown>
check('the ENCODED request names the caller as issuer', decoded.issuerId === pubkey, String(decoded.issuerId).slice(0, 16))
check('and carries the amount asked for', decoded.amount === 250 && decoded.unit === 'EUR')
check('and is single-use', decoded.singleUse === true)

console.log('\nA caller cannot point takings at another key')
for (const field of ['issuerId', 'recipientPubkey', 'stallPubkey']) {
  const evil = await post('/v1/requests/create', { amount: 250, unit: 'EUR', [field]: 'b'.repeat(64) })
  check(`\`${field}\` is REFUSED, not ignored`, evil.status === 400 && evil.body.field === field, `HTTP ${evil.status} field=${String(evil.body.field)}`)
}

console.log('\nWorking out what arrived')
const settled = await post('/v1/requests/reconcile', {
  requests: [request],
  transactions: [
    { id: 'tx-1', type: 'received', at: request.createdAt + 60_000, amount: 250, unit: 'EUR', decimals: 2, paymentId: request.paymentId },
  ],
})
check('an exact payment settles the request', (settled.body.settlements as unknown as unknown[])?.length === 1)
check('and it is marked fulfilled', (settled.body.requests as unknown as Array<{ status: string }>)?.[0]?.status === 'fulfilled')

const short = await post('/v1/requests/reconcile', {
  requests: [request],
  transactions: [
    { id: 'tx-2', type: 'received', at: request.createdAt + 60_000, amount: 100, unit: 'EUR', decimals: 2, paymentId: request.paymentId },
  ],
})
// The case that costs a merchant real money if it goes the other way: handing
// over goods against a payment that fell short.
check('a payment that falls short does NOT settle it', (short.body.settlements as unknown as unknown[])?.length === 0)
check('and the shortfall is reported rather than a bare "unpaid"', (short.body.outstanding as unknown as Array<{ received: number }>)?.[0]?.received === 100)

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
