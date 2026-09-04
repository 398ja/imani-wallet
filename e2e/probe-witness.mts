/**
 * Does the mint REFUSE a locked proof presented without a witness?
 *
 * The claim the entire P2PK change rests on. Everything else shows the mint
 * RECEIVES a proof it ought to enforce; only this asks whether it does.
 *
 * Presents the proof to /v1/swap with no `witness`, which is exactly what a
 * thief holding the token would send. A 4xx is the pass.
 */
import { readFileSync } from 'node:fs'
import { tokenProofs, proofSecrets } from '../src/lib/voucherToken'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js'

const MINT = process.env.MINT_URL ?? 'http://localhost:27777'

/** NUT-00 hash_to_curve, so a blinded output is a real point. */
function hashToCurve(message: Uint8Array): InstanceType<typeof secp256k1.Point> {
  const DOMAIN = new TextEncoder().encode('Secp256k1_HashToCurve_Cashu_')
  const msgHash = sha256(new Uint8Array([...DOMAIN, ...message]))
  for (let counter = 0; counter < 2 ** 16; counter++) {
    const c = new Uint8Array(4)
    new DataView(c.buffer).setUint32(0, counter, true)
    const hash = sha256(new Uint8Array([...msgHash, ...c]))
    try {
      return secp256k1.Point.fromHex(bytesToHex(new Uint8Array([0x02, ...hash])))
    } catch { /* not on curve; next counter */ }
  }
  throw new Error('no valid point')
}

/**
 * A blinded message for `amount`, so the request BALANCES.
 *
 * Without this the mint rejects on amounts before it ever evaluates the
 * spending condition, and "it refused" would prove nothing about the lock.
 */
function blindedOutput(amount: number, keysetId: string) {
  const secret = bytesToHex(randomBytes(32))
  const r = secp256k1.utils.randomSecretKey()
  const Y = hashToCurve(new TextEncoder().encode(secret))
  const B_ = Y.add(secp256k1.Point.BASE.multiply(BigInt('0x' + bytesToHex(r))))
  return { amount, id: keysetId, 'B_': B_.toHex(true) }
}

async function attempt(file: string, label: string) {
  const token = readFileSync(file, 'utf8').trim()
  const kind = JSON.parse(proofSecrets(token)[0])[0]
  const proofs = tokenProofs(token)

  const r = await fetch(`${MINT}/v1/swap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      inputs: proofs.map((p) => ({ amount: p.amount, id: p.id, secret: p.secret, C: p.C })),
      // Balanced, so the mint gets past its amount checks and actually
      // evaluates the spending condition.
      outputs: proofs.map((p) => blindedOutput(p.amount, p.id)),
    }),
  })
  const text = await r.text()
  console.log(`${label}\n  kind=${kind} HTTP=${r.status}\n  ${text.slice(0, 180)}`)
  return { status: r.status, text, kind }
}

const locked = await attempt('src/lib/__tests__/fixtures/witness-test.token', 'LOCKED, no witness:')

/**
 * The control. An UNLOCKED voucher sent the same way must fail for a DIFFERENT
 * reason — empty outputs — not for a missing witness. Without this, "the mint
 * refused" proves nothing: it refuses this malformed request either way.
 */
const open = await attempt('src/lib/__tests__/fixtures/live-terminal-credential.token', 'UNLOCKED, same request:')

console.log()
const lockedMentionsWitness = /witness|signature|p2pk/i.test(locked.text)
const openMentionsWitness = /witness|signature|p2pk/i.test(open.text)

console.log(locked.kind === 'P2PK_VOUCHER' ? 'PASS  the locked token really is P2PK_VOUCHER' : `FAIL  kind was ${locked.kind}`)
console.log(locked.status >= 400 ? 'PASS  the mint refused the witness-less spend' : 'FAIL  the mint accepted it')
console.log(
  lockedMentionsWitness && !openMentionsWitness
    ? 'PASS  and refused it FOR the missing witness, not for the malformed request'
    : `INFO  locked=${locked.status} open=${open.status} — reasons: see bodies above`,
)
