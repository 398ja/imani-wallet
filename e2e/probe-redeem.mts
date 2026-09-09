/**
 * Redeeming a coupon, against real artefacts.
 *
 * API ticket 02. Mints a REAL coupon through the live gateway, then asks the
 * running wallet API to verify it, bound it, and say what to sign to accept it.
 *
 * A fixture would prove the parser reads what the parser writes. What this
 * establishes is that the API agrees with a gateway it does not control about
 * whether a customer's money is genuine — and that the checks a merchant leans
 * on refuse the cases that would cost them.
 *
 *   npx tsx e2e/probe-redeem.mts
 */
import { finalizeEvent } from 'nostr-tools'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { secp256k1, schnorr } from '@noble/curves/secp256k1.js'

const API = process.env.API_URL ?? 'http://localhost:8788'
const WALLET = process.env.WALLET_URL ?? 'http://localhost:28082'

let failures = 0
function check(what: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

/** The stall: it issues the coupon, and later takes it back. */
const stallSk = secp256k1.utils.randomSecretKey()
const stallPk = bytesToHex(schnorr.getPublicKey(stallSk))

/** A different stall, for the cross-stall refusal. */
const otherSk = secp256k1.utils.randomSecretKey()

function header(sk: Uint8Array, url: string, method: string, body?: string): string {
  const tags = [['u', url], ['method', method]]
  if (body !== undefined) tags.push(['payload', bytesToHex(sha256(new TextEncoder().encode(body)))])
  const event = finalizeEvent(
    { kind: 27235, created_at: Math.floor(Date.now() / 1000), tags, content: '' },
    sk,
  )
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`
}

async function api(sk: Uint8Array, path: string, payload: unknown) {
  const url = `${API}${path}`
  const body = JSON.stringify(payload)
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: header(sk, url, 'POST', body) },
    body,
  })
  return { status: r.status, body: (await r.json()) as Record<string, never> }
}

console.log('Minting a real coupon through the gateway')
const mintUrl = `${WALLET}/api/v1/wallet/vouchers`
const mintBody = JSON.stringify({
  face_value: 1000,
  face_unit: 'EUR',
  face_decimals: 2,
  backing_strategy: 'PROPORTIONAL',
  issuer_id: stallPk,
  memo: 'redeem probe',
  expires_in_days: 30,
})
const created = await fetch(mintUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: header(stallSk, mintUrl, 'POST', mintBody) },
  body: mintBody,
})
if (!created.ok) {
  console.log(`  FAIL  could not mint (HTTP ${created.status})`)
  process.exit(1)
}
const voucherId = ((await created.json()) as { voucher_id: string }).voucher_id

let token = ''
for (let i = 0; i < 30; i++) {
  const readUrl = `${WALLET}/api/v1/wallet/vouchers/${voucherId}`
  const r = await fetch(readUrl, { headers: { Authorization: header(stallSk, readUrl, 'GET') } })
  if (r.ok) {
    const v = (await r.json()) as { token?: string }
    if (v.token) { token = v.token; break }
  }
  await new Promise((res) => setTimeout(res, 2000))
}
if (!token) { console.log('  FAIL  no token'); process.exit(1) }
console.log(`  minted ${voucherId.slice(0, 8)}… for the stall ${stallPk.slice(0, 12)}…`)

console.log('\nVerifying it')
const verified = await api(stallSk, '/v1/redeem/verify', { token })
check('the endpoint answers', verified.status === 200, `HTTP ${verified.status}`)
check('the coupon is accepted as genuine', verified.body.ok === true, JSON.stringify(verified.body.refusal ?? ''))

const voucher = verified.body.voucher as unknown as { signedFaceValue: number; issuerId: string; unit: string }
check('it reads the signed face value from the token', voucher?.signedFaceValue === 1000, String(voucher?.signedFaceValue))
check('and names the issuing stall', voucher?.issuerId === stallPk)

console.log('\nA coupon from another stall')
// The refusal that stops money simply stopping: a stall cannot honour what it
// did not issue, so taking it would leave the customer paid and the taker
// holding something unredeemable.
const foreign = await api(otherSk, '/v1/redeem/verify', { token })
check('is REFUSED', foreign.body.ok === false)
check('and says which problem it is', foreign.body.refusal === 'another-stall', String(foreign.body.refusal))

console.log('\nA tampered coupon')
// One character changed in the middle of the token. The signature is over the
// canonical bytes, so this must not verify.
const tampered = token.slice(0, 60) + (token[60] === 'a' ? 'b' : 'a') + token.slice(61)
const bad = await api(stallSk, '/v1/redeem/verify', { token: tampered })
check('is REFUSED', bad.body.ok === false)
check('as unreadable or unsigned, not as genuine', bad.body.refusal === 'bad-signature' || bad.body.refusal === 'not-a-voucher', String(bad.body.refusal))

console.log('\nThe ceiling, across presentations')
const first = await api(stallSk, '/v1/redeem/check', { token, requested: 400, priorRedemptions: [] })
check('a first redemption inside the face is allowed', (first.body.ceiling as unknown as { allowed: boolean })?.allowed === true)

const second = await api(stallSk, '/v1/redeem/check', {
  token,
  requested: 400,
  priorRedemptions: [{ amount: 400, direction: 'in' }],
})
check('a second that still fits is allowed', (second.body.ceiling as unknown as { allowed: boolean })?.allowed === true)

const over = await api(stallSk, '/v1/redeem/check', {
  token,
  requested: 400,
  priorRedemptions: [{ amount: 400, direction: 'in' }, { amount: 400, direction: 'in' }],
})
// The whole point: the same coupon presented until it exceeds what was issued.
check('one that would exceed the face is REFUSED', (over.body.ceiling as unknown as { allowed: boolean })?.allowed === false)
check('and it reports what is left', (over.body.ceiling as unknown as { remaining: number })?.remaining === 200)

console.log('\nA caller cannot lift its own ceiling')
// The bound is read from the VERIFIED voucher, so a face value in the body is
// ignored rather than believed.
const lying = await api(stallSk, '/v1/redeem/check', {
  token,
  requested: 5000,
  signedFaceValue: 100_000,
  priorRedemptions: [],
})
check('an inflated signedFaceValue in the body changes nothing', (lying.body.ceiling as unknown as { signedFaceValue: number })?.signedFaceValue === 1000, String((lying.body.ceiling as unknown as { signedFaceValue: number })?.signedFaceValue))
check('so an over-face request is still refused', (lying.body.ceiling as unknown as { allowed: boolean })?.allowed === false)

console.log('\nWhat to sign to accept it')
const prepared = await api(stallSk, '/v1/redeem/prepare', { token })
check('the courier answers', prepared.status === 200 && prepared.body.ok === true)
check('with the receive URL', String(prepared.body.url).endsWith('/api/v1/wallet/receive'), String(prepared.body.url))
check('and a body carrying the token', String(prepared.body.body).includes(token.slice(0, 20)))

/**
 * The signed body is USABLE, which is the only way to know the courier is
 * telling the truth. Signs exactly what it returned and sends it to the
 * gateway: a mismatch would come back as a payload error rather than a
 * redemption.
 */
console.log('\nThe caller signs it, and the gateway accepts the signature')
const url = String(prepared.body.url)
const signedBody = String(prepared.body.body)
const accepted = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: header(stallSk, url, 'POST', signedBody) },
  body: signedBody,
})
const acceptedText = await accepted.text()
check(
  'the gateway did not reject the SIGNATURE',
  !/payload|signature|unauthor/i.test(acceptedText),
  `HTTP ${accepted.status} ${acceptedText.slice(0, 120)}`,
)

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
