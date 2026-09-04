/**
 * Does a valid witness make the SAME locked proof spendable?
 *
 * `probe-witness.mts` compares a locked proof against an unlocked one, so its
 * two arms differ in more than the lock — the refusal could in principle come
 * from anything about the locked SHAPE rather than from the missing signature.
 *
 * This holds the proof constant and varies only the witness: the same locked
 * proof is presented twice, once bare and once signed by the device key it was
 * minted for. Bare must be refused and signed must succeed. That is what makes
 * the lock's enforcement the only available explanation.
 */
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tokenProofs } from '../src/lib/voucherToken'
import { secp256k1, schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js'

const MINT = process.env.MINT_URL ?? 'http://localhost:27777'

function hashToCurve(message: Uint8Array): InstanceType<typeof secp256k1.Point> {
  const DOMAIN = new TextEncoder().encode('Secp256k1_HashToCurve_Cashu_')
  const msgHash = sha256(new Uint8Array([...DOMAIN, ...message]))
  for (let counter = 0; counter < 2 ** 16; counter++) {
    const c = new Uint8Array(4)
    new DataView(c.buffer).setUint32(0, counter, true)
    const hash = sha256(new Uint8Array([...msgHash, ...c]))
    try {
      return secp256k1.Point.fromHex(bytesToHex(new Uint8Array([0x02, ...hash])))
    } catch { /* next counter */ }
  }
  throw new Error('no valid point')
}

function blindedOutput(amount: number, keysetId: string) {
  const secret = bytesToHex(randomBytes(32))
  const r = secp256k1.utils.randomSecretKey()
  const Y = hashToCurve(new TextEncoder().encode(secret))
  const B_ = Y.add(secp256k1.Point.BASE.multiply(BigInt('0x' + bytesToHex(r))))
  return { amount, id: keysetId, 'B_': B_.toHex(true) }
}

// A device keypair we hold the SECRET for, so we can actually sign.
const sk = secp256k1.utils.randomSecretKey()
const pk = bytesToHex(schnorr.getPublicKey(sk))

const OUT = 'witness-positive.token'
execFileSync('node', [
  'scripts/mint-terminal-credential.mjs', '--stall-name', 'imani-terminals',
  '--device', pk, '--name', 'Witness positive', '--out', OUT,
], { stdio: 'pipe' })

const token = readFileSync(`src/lib/__tests__/fixtures/${OUT}`, 'utf8').trim()
const proofs = tokenProofs(token)

/** NUT-11: the witness signs the proof's secret STRING. */
const witnessFor = (secret: string, key: Uint8Array = sk) =>
  JSON.stringify({ signatures: [bytesToHex(schnorr.sign(sha256(new TextEncoder().encode(secret)), key))] })

async function spend(withWitness: boolean, label: string, signWith: Uint8Array = sk) {
  const r = await fetch(`${MINT}/v1/swap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      inputs: proofs.map((p) => ({
        amount: p.amount, id: p.id, secret: p.secret, C: p.C,
        ...(withWitness ? { witness: witnessFor(p.secret, signWith) } : {}),
      })),
      outputs: proofs.map((p) => blindedOutput(p.amount, p.id)),
    }),
  })
  const text = await r.text()
  console.log(`${label}\n  HTTP=${r.status}  ${text.slice(0, 140)}`)
  return { status: r.status, text }
}

// Bare FIRST: a rejected swap spends nothing, so the proof is still live for
// the signed attempt. The reverse order would consume it and prove nothing.
const bare = await spend(false, 'SAME proof, NO witness:')

/**
 * The sharpest control: a well-formed signature from the WRONG key.
 *
 * Without this, "signed succeeds" is consistent with a mint that accepts ANY
 * witness and never checks whose key it is — which would be a total bypass
 * wearing the appearance of enforcement.
 */
const wrong = await spend(true, 'SAME proof, WRONG key signature:', secp256k1.utils.randomSecretKey())

const signed = await spend(true, 'SAME proof, VALID witness:')

console.log()
const checks: Array<[boolean, string]> = [
  [bare.status >= 400, `bare spend REFUSED (was ${bare.status})`],
  [wrong.status >= 400, `a WRONG key's signature is REFUSED (was ${wrong.status})`],
  [signed.status === 200, `the same proof SUCCEEDS once signed (was ${signed.status})`],
]
let failed = 0
for (const [ok, what] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`)
  if (!ok) failed++
}
process.exit(failed === 0 ? 0 : 1)
