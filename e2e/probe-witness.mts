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
import { execFileSync } from 'node:child_process'
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

/**
 * Mints BOTH arms fresh on every run.
 *
 * A swap SPENDS what it is given, so a committed token is single-use: a second
 * run of this probe reported "the same request SUCCEEDS unlocked — was 400"
 * purely because its own previous run had spent the control. Re-minting is what
 * lets this probe be run twice and mean the same thing both times.
 *
 * The unlocked arm needs an OFF-CURVE key, which trips the gateway's documented
 * fallback. That is the only way to get a genuinely unlocked credential from the
 * REAL gateway rather than fabricating one here — and a fabricated control would
 * not be evidence about the gateway at all.
 */
function mintArm(out: string, extra: string[] = []): void {
  execFileSync(
    'node',
    ['scripts/mint-terminal-credential.mjs', '--stall-name', 'imani-terminals',
     '--device', deviceKey(extra.includes('--allow-unlocked')), '--out', out, ...extra],
    { stdio: 'pipe' },
  )
}

/** A real x-only pubkey, or deliberately off-curve bytes for the unlocked arm. */
function deviceKey(offCurve: boolean): string {
  for (;;) {
    const k = bytesToHex(randomBytes(32))
    let onCurve = true
    try { secp256k1.Point.fromHex('02' + k) } catch { onCurve = false }
    if (onCurve !== offCurve) return k
  }
}


const LOCKED = 'src/lib/__tests__/fixtures/witness-test.token'
const CONTROL = 'src/lib/__tests__/fixtures/control-unlocked.token'
mintArm('witness-test.token')
mintArm('control-unlocked.token', ['--allow-unlocked'])

const locked = await attempt(LOCKED, 'LOCKED, no witness:')

/**
 * The control. The SAME request over an unlocked voucher must be ACCEPTED,
 * which is what shows the refusal above came from the lock rather than from
 * anything about the request's shape.
 */
const open = await attempt(CONTROL, 'UNLOCKED, same request:')

console.log()

/**
 * The claim is DIFFERENTIAL: the same request, sent the same way, must be
 * refused when the voucher is locked and accepted when it is not. Only the
 * pair proves the mint enforces the lock — a lone 400 could be a malformed
 * request, which is how an earlier version of this probe "passed" while the
 * mint was silently ignoring the lock entirely (SecretUtil could not parse
 * P2PK_VOUCHER, and every locked proof came back HTTP 200).
 */
const checks: Array<[boolean, string]> = [
  [locked.kind === 'P2PK_VOUCHER', `the locked token is P2PK_VOUCHER (was ${locked.kind})`],
  [open.kind === 'VOUCHER', `the control is genuinely UNLOCKED (was ${open.kind})`],
  [locked.status >= 400, `the mint REFUSED the witness-less locked spend (was ${locked.status})`],
  [open.status === 200, `the same request SUCCEEDS unlocked (was ${open.status})`],
  [
    /witness|signature|p2pk/i.test(locked.text),
    'and refused it FOR the missing witness, not for a malformed request',
  ],
]

let failed = 0
for (const [ok, what] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`)
  if (!ok) failed++
}
process.exit(failed === 0 ? 0 : 1)
