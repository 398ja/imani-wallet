/**
 * Can the redemption ceiling be computed by a service that stores nothing?
 *
 * Validates the "attest" shape proposed in .scratch/api-coverage/ASSESSMENT.md,
 * where a caller supplies the history it already holds and the API returns the
 * verdict. Everything else in the assessment reuses a pattern the codebase
 * already runs; this one is new, so it is the proposal most likely to be wrong.
 *
 * Two questions, and they are different:
 *
 *   1. Is the ceiling actually computable from caller-supplied rows? The app's
 *      `checkRedemption` reads `listTransactions()` itself, so it cannot be
 *      called by a stateless service at all. If the ARITHMETIC does not
 *      separate from the storage, the shape is dead.
 *
 *   2. Does the signed face value — the only bound that needs no history —
 *      come from the token rather than from the caller? A ceiling the caller
 *      chose is not a ceiling.
 *
 * The second is why this is a probe and not a unit test: it checks the bound
 * against a voucher a REAL gateway minted, which is where a caller-supplied
 * face value would show up as a divergence.
 *
 *   npx tsx e2e/probe-attest-redeem.mts
 */
import { finalizeEvent } from 'nostr-tools'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { secp256k1, schnorr } from '@noble/curves/secp256k1.js'

import { parseVoucherToken, verifyVoucher, creditableFaceValue } from '../src/lib/voucherToken'

const WALLET = process.env.WALLET_URL ?? 'http://localhost:28082'

let failures = 0
function check(what: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

/**
 * The proposed endpoint's whole body, written out.
 *
 * Deliberately a pure function of its arguments: no storage, no network, no
 * clock. That is the claim being tested — if this needed anything the caller
 * did not send, `/v1/redeem/check` could not be stateless and the assessment
 * would be wrong.
 *
 * Mirrors `redemptionLedger.checkRedemption`, but takes the prior redemptions
 * as an argument where the app reads them from IndexedDB.
 */
function redeemCheck(input: {
  signedFaceValue: number
  requested: number
  priorRedemptions: Array<{ amount: number; direction: 'in' | 'out' }>
}) {
  // Incoming only. A merchant ISSUING the voucher writes an outgoing row, and
  // counting it would consume the ceiling before anyone redeemed anything.
  const alreadyRedeemed = input.priorRedemptions
    .filter((r) => r.direction === 'in')
    .reduce((sum, r) => sum + (Number.isFinite(r.amount) ? r.amount : 0), 0)

  const remaining = Math.max(0, input.signedFaceValue - alreadyRedeemed)
  return {
    // A voucher with no signed face has no ceiling to enforce. Saying so beats
    // inventing a bound and refusing honest coupons.
    allowed:
      input.signedFaceValue <= 0 || alreadyRedeemed + input.requested <= input.signedFaceValue,
    alreadyRedeemed,
    remaining,
  }
}

const sk = secp256k1.utils.randomSecretKey()
const pk = bytesToHex(schnorr.getPublicKey(sk))

function authHeader(url: string, method: string, body?: string): string {
  const tags = [['u', url], ['method', method]]
  if (body !== undefined) tags.push(['payload', bytesToHex(sha256(new TextEncoder().encode(body)))])
  const event = finalizeEvent(
    { kind: 27235, created_at: Math.floor(Date.now() / 1000), tags, content: '' },
    sk,
  )
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`
}

console.log('Minting a real coupon to check a ceiling against')
const url = `${WALLET}/api/v1/wallet/vouchers`
const body = JSON.stringify({
  face_value: 1000,
  face_unit: 'EUR',
  face_decimals: 2,
  backing_strategy: 'PROPORTIONAL',
  issuer_id: pk,
  memo: 'attest shape probe',
  expires_in_days: 30,
})
const created = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: authHeader(url, 'POST', body) },
  body,
})
if (!created.ok) {
  console.log(`  FAIL  could not mint (HTTP ${created.status})`)
  process.exit(1)
}
const voucherId = ((await created.json()) as { voucher_id: string }).voucher_id

let token = ''
for (let i = 0; i < 30; i++) {
  const readUrl = `${WALLET}/api/v1/wallet/vouchers/${voucherId}`
  const r = await fetch(readUrl, { headers: { Authorization: authHeader(readUrl, 'GET') } })
  if (r.ok) {
    const v = (await r.json()) as { token?: string }
    if (v.token) { token = v.token; break }
  }
  await new Promise((res) => setTimeout(res, 2000))
}
if (!token) { console.log('  FAIL  no token'); process.exit(1) }

const parsed = parseVoucherToken(token)
check("the issuer's signature verifies", verifyVoucher(parsed.voucher).signatureValid)

/**
 * The ceiling comes from the SIGNED voucher, not from the caller.
 *
 * This is the half of the design that survives a lying caller: whatever
 * history they send, the bound is what the issuer signed.
 */
const signedFace = creditableFaceValue(parsed).faceValue
check('the signed face value is readable from the token alone', signedFace === 1000, String(signedFace))

console.log('\nThe ceiling, computed from caller-supplied history')

const fresh = redeemCheck({ signedFaceValue: signedFace, requested: 400, priorRedemptions: [] })
check('a first redemption inside the face is allowed', fresh.allowed)
check('and reports the whole face remaining', fresh.remaining === 1000, String(fresh.remaining))

const partial = redeemCheck({
  signedFaceValue: signedFace,
  requested: 400,
  priorRedemptions: [{ amount: 400, direction: 'in' }],
})
check('a second redemption still inside the face is allowed', partial.allowed)
check('and the remainder falls by what was taken', partial.remaining === 600, String(partial.remaining))

const overspend = redeemCheck({
  signedFaceValue: signedFace,
  requested: 400,
  priorRedemptions: [
    { amount: 400, direction: 'in' },
    { amount: 400, direction: 'in' },
  ],
})
// The whole point: the same £10 voucher presented until it exceeds what was
// issued. A signature cannot see this, and neither can a per-presentation cap.
check('REFUSED once the sum would exceed what was issued', !overspend.allowed)
check('and it reports nothing left to give', overspend.remaining === 200, String(overspend.remaining))

const issuedRow = redeemCheck({
  signedFaceValue: signedFace,
  requested: 1000,
  priorRedemptions: [{ amount: 1000, direction: 'out' }],
})
// The merchant's own ISSUED row is outgoing. Counting it would consume the
// ceiling before a customer redeemed anything.
check('an outgoing row does not consume the ceiling', issuedRow.allowed)

const legacy = redeemCheck({ signedFaceValue: 0, requested: 5000, priorRedemptions: [] })
check('a voucher with no signed face has no ceiling to enforce', legacy.allowed)

/**
 * Parity with the app's own `checkRedemption` is asserted in
 * `src/lib/__tests__/attestShapeParity.test.ts`, not here.
 *
 * It cannot run in this probe: `redemptionLedger` imports `wallet.ts`, which
 * imports `@imani/wallet-storage` and needs a browser. That coupling is itself
 * the finding — the app's ceiling check cannot be called by a stateless
 * service without extracting the arithmetic, which is exactly what the
 * proposed endpoint has to do.
 */
console.log(
  failures === 0
    ? '\nThe attest shape HOLDS: the ceiling is computable from supplied rows,\n' +
      'and the bound comes from the signed token.'
    : `\n${failures} check(s) failed.`,
)
process.exit(failures === 0 ? 0 : 1)
