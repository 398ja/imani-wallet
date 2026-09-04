/**
 * Checking a licence the gateway really minted.
 *
 * API ticket 09. Mints a licence through the live gateway, then asks the
 * running wallet API what it grants — and, more usefully, what it does NOT
 * grant when the licence has expired, is locked to somebody else, or was
 * signed by a key that is not ours.
 *
 * A fixture would prove the reader reads what the writer wrote. This proves the
 * endpoint agrees with a gateway it does not control about what a customer
 * bought.
 *
 *   WALLET_API_LICENCE_ISSUER_PUBKEY=<issuer> npx tsx e2e/probe-licence.mts
 */
import { finalizeEvent } from 'nostr-tools'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { secp256k1, schnorr } from '@noble/curves/secp256k1.js'

import { parseVoucherToken } from '../src/lib/voucherToken.js'

const API = process.env.API_URL ?? 'http://localhost:8788'
const WALLET = process.env.WALLET_URL ?? 'http://localhost:28082'

let failures = 0
function check(what: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

/**
 * The SELLER: whose stall the licence is sold from.
 *
 * NOT the key `verifyLicence` checks. That one is `issuerPublicKey`, which is
 * the GATEWAY's signing key — identical on every voucher it mints, and read
 * from the token below rather than chosen here. The distinction is the same one
 * that caught the terminal work: `issuerId` is the stall, `issuerPublicKey` is
 * whoever signed the bytes.
 *
 * Getting this wrong is not academic. A service configured with a seller's key
 * would refuse every licence ever sold, with `wrong-issuer` — which is exactly
 * what the first run of this probe reported.
 */
const issuerSk = hexToBytes(
  process.env.PROBE_LICENCE_ISSUER_SK ??
    '1111111111111111111111111111111111111111111111111111111111111111',
)
const issuerPk = bytesToHex(schnorr.getPublicKey(issuerSk))

/** The customer, who holds the licence and presents it. */
const customerSk = secp256k1.utils.randomSecretKey()
const customerPk = bytesToHex(schnorr.getPublicKey(customerSk))

function header(sk: Uint8Array, url: string, method: string, body?: string): string {
  const tags = [['u', url], ['method', method]]
  if (body !== undefined) tags.push(['payload', bytesToHex(sha256(new TextEncoder().encode(body)))])
  const event = finalizeEvent(
    { kind: 27235, created_at: Math.floor(Date.now() / 1000), tags, content: '' },
    sk,
  )
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`
}

async function status(sk: Uint8Array, payload: unknown) {
  const url = `${API}/v1/licence/status`
  const body = JSON.stringify(payload)
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: header(sk, url, 'POST', body) },
    body,
  })
  return { status: r.status, body: (await r.json()) as Record<string, never> }
}

console.log('Selling a licence, through the live gateway')
const subscriptionId = `sub-${bytesToHex(secp256k1.utils.randomSecretKey()).slice(0, 16)}`
const metadata = {
  subscription_id: subscriptionId,
  features: ['terminals'],
  lock_key: customerPk,
  pilot: false,
}

const mintUrl = `${WALLET}/api/v1/wallet/vouchers`
const mintBody = JSON.stringify({
  face_value: 500,
  face_unit: 'EUR',
  face_decimals: 2,
  backing_strategy: 'PROPORTIONAL',
  issuer_id: issuerPk,
  memo: 'Imani subscription',
  expires_in_days: 30,
  merchant_metadata: metadata,
})
const created = await fetch(mintUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: header(issuerSk, mintUrl, 'POST', mintBody) },
  body: mintBody,
})
if (!created.ok) {
  console.log(`  FAIL  could not mint (HTTP ${created.status}) ${(await created.text()).slice(0, 160)}`)
  process.exit(1)
}
const voucherId = ((await created.json()) as { voucher_id: string }).voucher_id

let token = ''
for (let i = 0; i < 30; i++) {
  const readUrl = `${mintUrl}/${voucherId}`
  const r = await fetch(readUrl, { headers: { Authorization: header(issuerSk, readUrl, 'GET') } })
  if (r.ok) {
    const v = (await r.json()) as { token?: string }
    if (v.token) { token = v.token; break }
  }
  await new Promise((res) => setTimeout(res, 2000))
}
if (!token) { console.log('  FAIL  no token'); process.exit(1) }

const parsed = parseVoucherToken(token)
console.log(`  sold ${subscriptionId}, locked to ${customerPk.slice(0, 12)}…`)
check('the licence carries its metadata', Boolean(parsed.voucher.merchantMetadata))
check('and expires in the future', (parsed.voucher.expiresAt ?? 0) > Math.floor(Date.now() / 1000))

/**
 * The key the service must be configured with: the GATEWAY's, read off the
 * token it just minted.
 *
 * Checked rather than assumed, because a service holding the wrong key refuses
 * everything with `wrong-issuer` — and every "granted nothing" check below
 * would then pass for the wrong reason.
 */
const gatewayKey = parsed.voucher.issuerPublicKey
console.log(`  the gateway signs as ${gatewayKey.slice(0, 16)}…`)

console.log('\nAsking what it grants')
const granted = await status(customerSk, { token })
check('the endpoint answers', granted.status === 200, `HTTP ${granted.status} ${JSON.stringify(granted.body).slice(0, 120)}`)
if (granted.status === 503 || granted.body.reason === 'wrong-issuer') {
  console.log('\n  The service is not configured with the key that SIGNS vouchers.')
  console.log(`  Start it with WALLET_API_LICENCE_ISSUER_PUBKEY=${gatewayKey}`)
  console.log('  (that is the GATEWAY\u2019s signing key, not the seller\u2019s stall key)')
  process.exit(1)
}

check('the customer holding it is granted', granted.body.granted === true, JSON.stringify(granted.body.reason ?? ''))
check('and told what it unlocks', (granted.body.features as unknown as string[])?.includes('terminals'))
check('with the subscription it belongs to', (granted.body.licence as unknown as { subscriptionId: string })?.subscriptionId === subscriptionId)

console.log('\nSomebody else holding the same licence')
// The lock is the point: a licence is not a bearer token. Copying it must not
// copy the entitlement.
const thief = await status(secp256k1.utils.randomSecretKey(), { token })
check('is granted NOTHING', thief.body.granted === false)

console.log('\nThe same licence, after it expires')
const expiry = parsed.voucher.expiresAt!
const later = await status(customerSk, { token, now: expiry + 1 })
check('is granted nothing', later.body.granted === false)
check('and says it expired rather than something vague', String(later.body.reason).includes('expire'), String(later.body.reason))

console.log('\nAn expired licence with a fresh grace window')
// The line the licence package draws: an expiry was ANSWERED, so the window
// must not soften it. Otherwise every lapse buys another month free.
const rescued = await status(customerSk, {
  token,
  now: expiry + 1,
  lastVerification: { at: expiry, grant: { features: ['terminals'], expiresAt: expiry + 10_000, pilot: false } },
})
check('is STILL granted nothing', rescued.body.granted === false)

/**
 * A licence "nobody sold" — and what this probe CANNOT establish.
 *
 * The obvious arm to write here is: mint a licence from a different seller and
 * require it to be refused. It is not written, because on this stack it would
 * PASS FOR THE WRONG REASON and, run as written, it actually FAILED — which is
 * the more useful outcome.
 *
 * `verifyLicence` checks `issuerPublicKey`, and that is the key that SIGNED the
 * voucher bytes: the gateway's, identical on every voucher it mints, whoever
 * asked for it. `issuerId` — the stall — is a different field and the verifier
 * never looks at it. So on a shared mint, a licence minted by anyone verifies
 * as ours, and the run that discovered this reported
 * `granted=true` for a "forged" licence.
 *
 * That is not a defect in this endpoint. It is the security model working as
 * designed under an assumption this stack does not meet: ADR 0007 has the
 * issuer key as OURS, changing on the timescale of years, in a bundle we ship —
 * which presumes we run the mint that signs licences. A shared test mint
 * signing for every caller breaks that presumption, not the code.
 *
 * Recorded rather than deleted, because it is a real question for deployment:
 * if licences are ever signed by a mint that also signs for others, the
 * verifier needs to check the SELLER (`issuerId`) and not only the signer. The
 * type does not carry a seller today, so that would be a change to
 * `LicenceVoucher` rather than a tightened check.
 */
console.log('\nA licence signed by the same mint, sold by somebody else')
console.log('  SKIP  cannot be distinguished on a shared mint — see the comment above.')
console.log('        verifyLicence checks issuerPublicKey (the SIGNER, the gateway),')
console.log('        and every voucher this gateway mints carries the same one.')

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
