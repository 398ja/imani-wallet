/**
 * Does NUT-07 checkstate spend a real credential?
 *
 * Ticket 10 says verification must never spend. That is asserted against a
 * mock in credentialRevocation.test.ts, which proves our code does not CALL
 * receive — but not that the mint's checkstate is itself non-destructive.
 * Only the real mint can answer that.
 */
import { readFileSync } from 'node:fs'
import { bytesToHex } from '@noble/hashes/utils.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { proofSecrets } from '../src/lib/voucherToken'

const MINT = process.env.MINT_URL ?? 'http://localhost:7777'
const FIXTURE = process.env.PROBE_TOKEN ?? 'src/lib/__tests__/fixtures/live-terminal-credential.token'
const token = readFileSync(FIXTURE, 'utf8').trim()

const secrets = proofSecrets(token)
console.log('proofs:', secrets.length)

/** NUT-07 Y = hash_to_curve(secret). */
function toY(secret: string): string {
  const DOMAIN = new TextEncoder().encode('Secp256k1_HashToCurve_Cashu_')
  const msgHash = sha256(new Uint8Array([...DOMAIN, ...new TextEncoder().encode(secret)]))
  for (let counter = 0; counter < 2 ** 16; counter++) {
    const c = new Uint8Array(4)
    new DataView(c.buffer).setUint32(0, counter, true)
    const hash = sha256(new Uint8Array([...msgHash, ...c]))
    try {
      // noble v2 renamed ProjectivePoint to Point.
      return secp256k1.Point.fromHex(bytesToHex(new Uint8Array([0x02, ...hash]))).toHex(true)
    } catch { /* not on curve; try the next counter, per NUT-00 */ }
  }
  throw new Error('no valid point')
}

const Ys = secrets.map((s) => toY(s))

async function check(label: string): Promise<string[]> {
  const r = await fetch(`${MINT}/v1/checkstate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Ys }),
  })
  const body = (await r.json()) as { states?: Array<{ state: string }> }
  const states = (body.states ?? []).map((s) => s.state)
  console.log(`${label}: HTTP ${r.status} ${JSON.stringify(states)}`)
  return states
}

const first = await check('check 1')
const second = await check('check 2')
const third = await check('check 3')

const stable =
  JSON.stringify(first) === JSON.stringify(second) &&
  JSON.stringify(second) === JSON.stringify(third)

/**
 * STABLE is the claim; UNSPENT is a precondition.
 *
 * Reporting "checking changed the state" for an already-spent fixture was
 * wrong and cost real time chasing a regression that did not exist — the
 * fixture had been spent by another probe's control arm. Three identical
 * SPENT reads prove checking is non-destructive just as well as three
 * UNSPENT ones; what they cannot do is prove it on a LIVE proof, which is
 * why that is called out rather than silently passing.
 */
const neverSpent = stable && first.every((s) => s === 'UNSPENT')
if (stable && !neverSpent) {
  console.log(`INCONCLUSIVE  the fixture is already ${first[0]} — checking did not change it,`)
  console.log('              but this cannot show non-destructiveness on a LIVE proof.')
  console.log('              Re-mint the fixture to make this meaningful.')
} else {
  console.log(neverSpent ? 'PASS  checking never spends' : 'FAIL  checking changed the state')
}

/**
 * The other half: revoking DOES spend.
 *
 * "Checking never spends" is only meaningful if something else does. Without
 * this, a mint that ignored us entirely would pass the check above.
 *
 * Spending goes through the gateway's receive, which is what `revokeCredential`
 * calls — swapping the proof for new ones the owner holds, leaving the original
 * spent and the terminal finished everywhere.
 */
const WALLET = process.env.WALLET_URL ?? 'http://localhost:28082'
const spendable = process.env.PROBE_SPEND === '1'

if (!spendable) {
  console.log('SKIP  revocation spend (set PROBE_SPEND=1 — it destroys the fixture)')
  process.exit(stable ? 0 : 1)
}

const { finalizeEvent } = await import('nostr-tools')
const { hexToBytes } = await import('@noble/hashes/utils.js')
const keys = JSON.parse(readFileSync('.seed-keys.json', 'utf8'))
const stall = { sk: hexToBytes(keys['imani-terminals'].sk), pk: keys['imani-terminals'].pk }

function nip98(url: string, method: string, body?: string): string {
  const tags: string[][] = [['u', url], ['method', method]]
  if (body) tags.push(['payload', bytesToHex(sha256(new TextEncoder().encode(body)))])
  const ev = finalizeEvent(
    { kind: 27235, created_at: Math.floor(Date.now() / 1000), tags, content: '' },
    stall.sk,
  )
  return `Nostr ${Buffer.from(JSON.stringify(ev)).toString('base64')}`
}

const url = `${WALLET}/api/v1/wallet/receive`
const body = JSON.stringify({ token })
const r = await fetch(url, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: nip98(url, 'POST', body),
    'X-Auth-Pubkey': stall.pk,
    'X-Edge-Auth': process.env.EDGE_SECRET ?? 'dev-edge-secret-local-only',
  },
  body,
})
console.log('receive:', r.status, (await r.text()).slice(0, 200))

const after = await check('check after spend')
const spent = after.every((s) => s === 'SPENT')
console.log(spent ? 'PASS  revoking spent the credential' : `FAIL  still ${after[0]}`)
process.exit(stable && spent ? 0 : 1)
