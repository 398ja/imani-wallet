/**
 * cashu-mint#527: a voucher signed by a key the mint does not trust cannot be swapped into
 * ordinary proofs when issuer-binding=enforce, and is only logged when issuer-binding=log.
 *
 * The forgery: mint ordinary sats, but give one output a P2PK_VOUCHER secret that names a
 * merchant as issuer and is signed by an attacker key carried in issuer_pubkey. Then try to swap
 * that proof for plain outputs, which is how a forged coupon is laundered.
 *
 *   EXPECT=refused|accepted npx tsx e2e/probe-mint-forged-voucher.mts
 */
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, randomBytes } from '@noble/hashes/utils'
import { blindMessage, constructProofFromPromise, serializeProof } from '@cashu/crypto/modules/client'
import { pointFromHex } from '@cashu/crypto/modules/common'

const MINT = process.env.MINT_HTTP ?? 'http://localhost:27777'
const EXPECT = process.env.EXPECT ?? 'refused'
const MERCHANT = process.env.MERCHANT ?? '0b013e0fad1a9d01087395551c08d82721a43eb8f9dba43f666b29438156ed1a'
const AMOUNT = 16

async function mint<T>(path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await fetch(MINT + path, {
    method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined,
    headers: { 'Content-Type': 'application/json' } })
  return { status: res.status, json: await res.json() as T }
}

/**
 * A P2PK_VOUCHER secret naming a merchant as issuer. Signed (the way VoucherCanonicalBytes expects)
 * by a key we chose, or, with UNSIGNED=1, carrying no signature at all: the stripped-signature
 * bypass, which enforce must refuse too.
 */
function forgedVoucherSecret(holderKey: Uint8Array, attackerKey: Uint8Array): string {
  const holder = '02' + bytesToHex(schnorr.getPublicKey(holderKey))
  const nonce = bytesToHex(randomBytes(32))
  const rows = [['n_sigs', '1'], ['sigflag', 'SIG_INPUTS'], ['issuer', MERCHANT], ['unit', 'sat'],
    ['face_value', '1000000'], ['backing_strategy', 'FIXED'], ['voucher_id', crypto.randomUUID()]]
  if (process.env.UNSIGNED === '1') return JSON.stringify(['P2PK_VOUCHER', { nonce, data: holder, tags: rows }])
  const NUMERIC = ['face_value', 'expires_at', 'face_decimals', 'issuance_ratio']
  const rendered = rows.map(([k, v]) => `["${k}",${NUMERIC.includes(k) ? v : `"${v}"`}]`).join(',')
  const canonical = new TextEncoder().encode(`["P2PK_VOUCHER","${holder}","${nonce}",[${rendered}]]`)
  const signature = bytesToHex(schnorr.sign(sha256(canonical), attackerKey))
  const tags = [...rows, ['issuer_sig', signature], ['issuer_pubkey', bytesToHex(schnorr.getPublicKey(attackerKey))]]
  return JSON.stringify(['P2PK_VOUCHER', { nonce, data: holder, tags }])
}

const keysets = (await mint<{ keysets: { id: string; unit: string; active: boolean }[] }>('/v1/keysets')).json
const keysetId = keysets.keysets.find(k => k.unit === 'sat' && k.active)!.id
const keys = (await mint<{ keysets: { keys: Record<string, string> }[] }>(`/v1/keys/${keysetId}`)).json.keysets[0].keys

const holderKey = randomBytes(32)
const attackerKey = randomBytes(32)
const secret = forgedVoucherSecret(holderKey, attackerKey)
const secretBytes = new TextEncoder().encode(secret)
const blinded = blindMessage(secretBytes)

const quote = (await mint<{ quote: string }>('/v1/mint/quote/bolt11', { amount: AMOUNT, unit: 'sat' })).json.quote
for (let i = 0; i < 10; i++) {
  if ((await mint<{ state: string }>(`/v1/mint/quote/bolt11/${quote}`)).json.state === 'PAID') break
  await new Promise(r => setTimeout(r, 1000))
}
const minted = await mint<{ signatures: { id: string; amount: number; C_: string }[] }>('/v1/mint/bolt11', {
  quote, outputs: [{ amount: AMOUNT, id: keysetId, B_: blinded.B_.toHex(true) }] })
if (minted.status !== 200) throw new Error(`minting the forged voucher output failed: ${JSON.stringify(minted.json)}`)
const signature = minted.json.signatures[0]
const proof = serializeProof(constructProofFromPromise(
  { id: signature.id, amount: signature.amount, C_: pointFromHex(signature.C_) },
  blinded.r, secretBytes, pointFromHex(keys[String(AMOUNT)])))
const witness = JSON.stringify({ signatures: [bytesToHex(schnorr.sign(sha256(secretBytes), holderKey))] })

// The laundering step: swap the forged voucher proof for plain outputs.
const plain = blindMessage(randomBytes(32))
const swap = await mint<{ detail?: string; code?: number }>('/v1/swap', {
  inputs: [{ ...proof, witness }], outputs: [{ amount: AMOUNT, id: keysetId, B_: plain.B_.toHex(true) }] })
const refused = swap.status !== 200
console.log(`swap answered ${swap.status} ${JSON.stringify(swap.json).slice(0, 160)}`)
const pass = EXPECT === "refused" ? refused && /signature|issuer|signed/i.test(JSON.stringify(swap.json)) : !refused
console.log(`${pass ? 'PASS' : 'FAIL'}: a self-signed voucher swap was ${refused ? 'refused' : 'accepted'} (expected ${EXPECT})`)
process.exit(pass ? 0 : 1)
