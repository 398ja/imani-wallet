/**
 * Can a headless caller ISSUE a coupon with nothing but a key?
 *
 * Validates the "courier" shape proposed for issuance in
 * .scratch/api-coverage/ASSESSMENT.md. The proposal is only sound if the
 * gateway will accept a NIP-98 signature from an arbitrary caller — because
 * ADR 0001 forbids the wallet API from holding a credential of its own, so
 * forwarding the CALLER's signature is the only move available.
 *
 * The doubt is specific. `src/lib/issue.ts` issues through
 * `/api/v1/portal/vouchers`, whose comment says the portal's NIP-98 filter
 * "does not authenticate on this image", and Vite's `portal-edge-auth`
 * middleware authorises it from a SESSION COOKIE validated against account-app,
 * attaching a shared secret the browser never sees. A cookie and a dev-server
 * secret are exactly what a headless caller does not have.
 *
 * So this asks the question directly, against the live gateway:
 *
 *   1. a fresh keypair, never registered, signs NIP-98 itself
 *   2. mint a coupon through /api/v1/wallet/vouchers
 *   3. poll until it carries a real Cashu token
 *   4. verify the issuer signature over the token the gateway returned
 *
 * A pass means issuance can be couriered. A failure names which of the two
 * paths is the blocker, which is the thing the assessment cannot assert
 * without running it.
 *
 *   npx tsx e2e/probe-courier-issue.mts
 */
import { finalizeEvent } from 'nostr-tools'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { secp256k1, schnorr } from '@noble/curves/secp256k1.js'

import { parseVoucherToken, verifyVoucher } from '../src/lib/voucherToken'

const WALLET = process.env.WALLET_URL ?? 'http://localhost:28082'

let failures = 0
function check(what: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

/** A caller that exists only here: no registration, no session, no cookie. */
const sk = secp256k1.utils.randomSecretKey()
const pk = bytesToHex(schnorr.getPublicKey(sk))

/** NIP-98, signed by the caller itself — the whole point of the courier shape. */
function authHeader(url: string, method: string, body?: string): string {
  const tags = [
    ['u', url],
    ['method', method],
  ]
  if (body !== undefined) tags.push(['payload', bytesToHex(sha256(new TextEncoder().encode(body)))])
  const event = finalizeEvent(
    { kind: 27235, created_at: Math.floor(Date.now() / 1000), tags, content: '' },
    sk,
  )
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`
}

console.log(`A caller with only a key: ${pk.slice(0, 12)}…`)

const url = `${WALLET}/api/v1/wallet/vouchers`
const body = JSON.stringify({
  face_value: 250,
  face_unit: 'EUR',
  face_decimals: 2,
  backing_strategy: 'PROPORTIONAL',
  issuer_id: pk,
  memo: 'courier shape probe',
  expires_in_days: 30,
})

const created = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: authHeader(url, 'POST', body) },
  body,
})
const createdText = await created.text()
check(
  'the gateway accepts a NIP-98 signature from an UNREGISTERED caller',
  created.status < 400,
  `HTTP ${created.status} ${createdText.slice(0, 160)}`,
)
if (created.status >= 400) {
  console.log('\nThe courier shape does NOT hold for issuance on this path.')
  process.exit(1)
}

const voucherId = (JSON.parse(createdText) as { voucher_id?: string }).voucher_id!
check('it returns a voucher id', Boolean(voucherId), voucherId)

/**
 * Poll for the token rather than expecting it inline.
 *
 * Issuance returns PENDING behind a bolt11 top-up and only later carries a
 * token. This is the loop the assessment argued a CALLER should own rather
 * than the API holding a connection open for ~10s — running it here is what
 * makes that recommendation more than a preference.
 */
let token = ''
for (let i = 0; i < 30; i++) {
  const readUrl = `${WALLET}/api/v1/wallet/vouchers/${voucherId}`
  const r = await fetch(readUrl, { headers: { Authorization: authHeader(readUrl, 'GET') } })
  if (r.ok) {
    const v = (await r.json()) as { token?: string }
    if (v.token) { token = v.token; console.log(`  token arrived after ~${i * 2}s`); break }
  }
  await new Promise((r) => setTimeout(r, 2000))
}

check('the coupon eventually carries a real Cashu token', token.length > 0)
if (token) {
  const parsed = parseVoucherToken(token)
  check('the token parses as a voucher', Boolean(parsed.voucher.voucherId))
  check('it names the CALLER as issuer', parsed.voucher.issuerId === pk, parsed.voucher.issuerId)
  check("the issuer's signature verifies", verifyVoucher(parsed.voucher).signatureValid)
  check('it carries the face value asked for', parsed.voucher.faceValue === 250, String(parsed.voucher.faceValue))
}

console.log(
  failures === 0
    ? '\nThe courier shape HOLDS for issuance via /api/v1/wallet/vouchers.'
    : `\n${failures} check(s) failed.`,
)
process.exit(failures === 0 ? 0 : 1)
