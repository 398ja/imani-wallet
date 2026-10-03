/**
 * A receive whose response never reached the wallet (imani-gateway-customer#173).
 *
 * The gateway swaps the recipient's token for fresh proofs and returns them as a
 * new token. If that response is lost (a dropped connection, a proxy timeout), the
 * wallet retries under the SAME Idempotency-Key. Before the fix the retry was a 200
 * with `token: null` and the gateway had already erased everything that could
 * rebuild the proofs, so the money was gone. After the fix:
 *
 *  - the retry hands back the identical fresh token, and it is spendable;
 *  - once the wallet acknowledges, a retry carries no token, so the gateway's
 *    sealed copy is gone.
 *
 *   npx tsx e2e/probe-receive-lost-response.mts
 */
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { bytesToHex } from '@noble/hashes/utils'
import { sha256 } from '@noble/hashes/sha2.js'
import { schnorr } from '@noble/curves/secp256k1.js'
import { proofSecrets } from '../src/lib/voucherToken'

const GW = process.env.GW ?? 'http://localhost:28082'
// The URL the gateway believes it serves. The imani-test stack trusts only the wallet dev
// origin, so a NIP-98 event must name it even when the request goes straight to the port.
const SIGNED_ORIGIN = process.env.SIGNED_ORIGIN ?? 'http://localhost:5177'
const MINT = process.env.MINT ?? 'https://mint-tls:7443'
const sk = generateSecretKey()
const pk = getPublicKey(sk)
let failures = 0

function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${label}${detail ? ` (${detail})` : ''}`)
  if (!ok) failures++
}

function auth(url: string, method: string, body?: string) {
  // The nonce keeps every event id distinct. The gateway refuses a reused id as a replay, and a
  // retry of the same request in the same second would otherwise sign a byte-identical event.
  const tags = [['u', url], ['method', method], ['nonce', bytesToHex(generateSecretKey())]]
  if (body) tags.push(['payload', bytesToHex(sha256(new TextEncoder().encode(body)))])
  const event = finalizeEvent(
    { kind: 27235, created_at: Math.floor(Date.now() / 1000), tags, content: '' }, sk)
  return 'Nostr ' + Buffer.from(JSON.stringify(event)).toString('base64')
}

async function call(path: string, method: string, payload?: unknown, extra: Record<string, string> = {}) {
  const body = payload ? JSON.stringify(payload) : undefined
  const res = await fetch(GW + path, { method, body, headers: {
    'Content-Type': 'application/json',
    Authorization: auth(SIGNED_ORIGIN + path, method, body), ...extra } })
  return { status: res.status, text: await res.text() }
}

function witnessesFor(token: string): string {
  const witnesses: Record<string, string[]> = {}
  for (const secret of proofSecrets(token)) {
    if (JSON.parse(secret)[0] !== 'P2PK_VOUCHER') continue
    witnesses[secret] = [bytesToHex(schnorr.sign(sha256(new TextEncoder().encode(secret)), sk))]
  }
  return JSON.stringify(witnesses)
}

async function issueVoucher(): Promise<string> {
  const created = await call('/api/v1/wallet/vouchers', 'POST', {
    face_value: 21, face_unit: 'sat', face_decimals: 0, mint_url: MINT,
    backing_strategy: 'FIXED', recipient_pubkey: pk, backing_sats: 21 })
  const voucherId = JSON.parse(created.text).voucher_id
  let token: string | undefined = JSON.parse(created.text).token
  for (let i = 0; !token && i < 10; i++) {
    await new Promise(r => setTimeout(r, 3000))
    try { token = JSON.parse((await call(`/api/v1/wallet/vouchers/${voucherId}`, 'GET')).text).token } catch {}
  }
  if (!token) throw new Error(`no voucher token (create answered ${created.status})`)
  return token
}

const voucher = await issueVoucher()
const key = `probe-lost-${Date.now()}`
const headers = { 'Idempotency-Key': key, 'X-Cashu-Witnesses': witnessesFor(voucher) }

// The first receive. Its response is the one the wallet "never got".
const first = await call('/api/v1/wallet/receive', 'POST', { token: voucher }, headers)
check('first receive succeeds', first.status === 200, String(first.status))
const lost = JSON.parse(first.text)
check('first receive carries a fresh token', typeof lost.token === 'string' && lost.token.length > 0)

// The wallet retries under the same key, as tokenRedemption.js does after a network error.
const retry = await call('/api/v1/wallet/receive', 'POST', { token: voucher }, headers)
check('a retry under the same key is a 200', retry.status === 200, String(retry.status))
const retried = JSON.parse(retry.text)
check('the retry re-delivers the identical fresh token', retried.token === lost.token,
  retried.token == null ? 'token was null: the proofs are lost' : 'token differs')
check('the retry names the same receive', retried.receive_id === lost.receive_id)

// The re-delivered token must be spendable: receiving it again swaps it at the mint.
if (typeof retried.token === 'string') {
  const spend = await call('/api/v1/wallet/receive', 'POST', { token: retried.token },
    { 'Idempotency-Key': `${key}-spend` })
  check('the re-delivered token is spendable', spend.status === 200, `${spend.status} ${spend.text.slice(0, 120)}`)
}

// After the wallet acknowledges, the gateway must no longer hold a copy.
const ack = await call(`/api/v1/wallet/receive/${lost.receive_id}/ack`, 'POST', {})
check('the wallet can acknowledge the receive', ack.status === 200, String(ack.status))
const afterAck = await call('/api/v1/wallet/receive', 'POST', { token: voucher }, headers)
check('a retry after the acknowledgement is still a 200', afterAck.status === 200, String(afterAck.status))
check('a retry after the acknowledgement carries no token', JSON.parse(afterAck.text).token == null)

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
