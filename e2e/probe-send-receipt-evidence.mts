/**
 * Spec 049 against the live imani-test stack: does a COMPLETED atomic send hand
 * the payer the evidence a verifiable receipt needs, and does that evidence
 * make a receipt that verifies?
 *
 *   npx tsx --tsconfig tsconfig.app.json e2e/probe-send-receipt-evidence.mts
 *
 * Needs the imani-test stack up with gateway-core carrying spec 049
 * (imani-gateway-core:v2-receipts) and the mint's NUT-07 witness fix.
 *
 * Steps and what each proves:
 *  1. issue a coupon to a fresh payer key (gateway-customer)
 *  2. atomic-send part of it to a fresh payee key (gateway-core)
 *  3. COMPLETED status carries send_evidence: sent proofs only, each with DLEQ;
 *     a different key reading the same send gets no evidence (sender only)
 *  4. FR-003: before the payee claims, the proofs are UNSPENT, so no receipt yet
 *  5. the payee claims the token from the gateway DM-less path
 *     (POST /wallet/receive with the sent proofs, as the payee)
 *  6. now every proof is SPENT at the mint: the payer builds and signs the receipt
 *     with @imani/receipts, and it verifies offline (payer signature, evidence
 *     digest, amount); the QR payload round-trips
 *  6b. the wallet's verifier (src/lib/receipts/verify.ts) checks it against the real
 *     mint: DLEQ against the mint's keyset, NUT-07 spent, presenter; unacknowledged
 *     without a countersignature, verified with one
 *  7. ack-send-evidence erases it: the next status says send_evidence_state=acknowledged
 *  8. the gateway metrics moved: returned and acknowledged counted
 *
 * Nothing here logs a secret, C or DLEQ value: only counts and booleans.
 */
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { bytesToHex } from '@noble/hashes/utils'
import { sha256 } from '@noble/hashes/sha2.js'
import {
  buildPayerReceipt,
  decodeQr,
  encodeQr,
  hashToCurveY,
  secretKeySigner,
  verifySummary,
  checkEvidenceOffline,
  encryptEvidence,
  makeLocator,
  newEvidenceKey,
  signCountersignature,
  signPresenterProof,
  withCountersignature,
  type SendEvidence,
} from '../packages/receipts/src/index'
import { encodePlainTokenV4 } from '../src/lib/plainToken'

const CUSTOMER = process.env.CUSTOMER ?? 'http://localhost:28082'
const CORE = process.env.CORE ?? 'http://localhost:28081'
const MINT = process.env.MINT ?? 'http://127.0.0.1.mint:7777'
// The mint as reachable from this host, for the NUT-07 state check.
const MINT_HOST = process.env.MINT_HOST ?? 'http://localhost:27777'

let failures = 0
function check(ok: boolean, what: string) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`)
  if (!ok) failures++
}

function auth(sk: Uint8Array, u: string, m: string, b?: string) {
  const t = [['u', u], ['method', m]]
  if (b) t.push(['payload', bytesToHex(sha256(new TextEncoder().encode(b)))])
  const ev = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags: t, content: '' }, sk)
  return 'Nostr ' + Buffer.from(JSON.stringify(ev)).toString('base64')
}

// NIP-98 `u` is checked against the services' public base URL (the wallet origin), not the
// host port the probe connects to.
const SIGNED_ORIGIN = process.env.SIGNED_ORIGIN ?? 'http://localhost:5173'

async function call(sk: Uint8Array, base: string, p: string, m: string, pl?: unknown, ex: Record<string, string> = {}) {
  const u = base + p
  const b = pl === undefined ? undefined : JSON.stringify(pl)
  const r = await fetch(u, {
    method: m,
    headers: { 'Content-Type': 'application/json', Authorization: auth(sk, SIGNED_ORIGIN + p, m, b), ...ex },
    body: b,
  })
  return { status: r.status, text: await r.text() }
}

async function states(ys: string[]): Promise<string[]> {
  const r = await fetch(`${MINT_HOST}/v1/checkstate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Ys: ys }),
  })
  const j = (await r.json()) as { states: { state: string }[] }
  return j.states.map((s) => s.state)
}

async function metric(container: string, name: string): Promise<Record<string, number>> {
  const { execFileSync } = await import('node:child_process')
  const out = execFileSync('docker', ['exec', container, 'curl', '-s', 'http://localhost:9000/actuator/prometheus'], {
    encoding: 'utf8',
  })
  const res: Record<string, number> = {}
  for (const line of out.split('\n')) {
    if (!line.startsWith(name + '{')) continue
    const outcome = /outcome="([^"]+)"/.exec(line)?.[1] ?? ''
    res[outcome] = Number(line.trim().split(' ').pop())
  }
  return res
}

const payerSk = generateSecretKey()
const payer = getPublicKey(payerSk)
const payeeSk = generateSecretKey()
const payee = getPublicKey(payeeSk)
const strangerSk = generateSecretKey()

const before = await metric('gateway-core-test', 'atomic_send_receipt_evidence_total')

// 1. Issue a coupon to the payer.
// EUR, as a stall sells: the Free plan's SAT allowance is 0 locally. PROPORTIONAL backing gives
// the coupon enough sats to split, so the send leaves change and the evidence must exclude it.
const c = await call(payerSk, CUSTOMER, '/api/v1/wallet/vouchers', 'POST', {
  face_value: 1000, face_unit: 'EUR', face_decimals: 2, backing_strategy: 'PROPORTIONAL', description: 'spec 049 probe',
})
if (c.status !== 201) {
  console.error('issue failed', c.status, c.text.slice(0, 200))
  process.exit(1)
}
const vid = JSON.parse(c.text).voucher_id
let token: string | undefined = JSON.parse(c.text).token
for (let i = 0; !token && i < 10; i++) {
  await new Promise((r) => setTimeout(r, 3000))
  try {
    token = JSON.parse((await call(payerSk, CUSTOMER, `/api/v1/wallet/vouchers/${vid}`, 'GET')).text).token
  } catch {
    /* retry */
  }
}
check(!!token, '1. coupon issued to the payer')
if (!token) process.exit(1)
{
  // Informational: whether issued coupons carry NUT-12 DLEQ decides whether a send that skips
  // the swap (proofs already partition to the amount, e.g. a whole-coupon send) can get a receipt.
  const { tokenProofs: tp } = await import('../src/lib/voucherToken')
  const issued = tp(token)
  const withDleq = issued.filter((p) => (p as { dleq?: { e?: string } }).dleq?.e).length
  console.log(`INFO  issued coupon: ${issued.length} proofs, ${withDleq} with DLEQ`)
}

// 2. Atomic send 60 of the 100 to the payee.
const send = await call(payerSk, CORE, '/api/v1/atomic-send', 'POST', {
  token, amount: 60, recipient_pubkey: payee, face_value: 60, face_unit: 'sat',
}, { 'Idempotency-Key': `rcpt-${Date.now()}` })
check(send.status === 202, `2. atomic send accepted (${send.status})`)
if (send.status !== 202) {
  console.error(send.text.slice(0, 300))
  process.exit(1)
}
const sendId: string = JSON.parse(send.text).send_id

let status: Record<string, unknown> = {}
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 1500))
  const st = await call(payerSk, CORE, `/api/v1/atomic-send/${sendId}`, 'GET')
  try {
    status = JSON.parse(st.text)
  } catch {
    continue
  }
  if (['COMPLETED', 'FAILED', 'EXPIRED', 'RECLAIMED', 'CANCELLED'].includes(String(status.status))) break
}
check(status.status === 'COMPLETED', `2. saga COMPLETED (${status.status})`)

// 3. Evidence: sender only, sent proofs only, with DLEQ.
const ev = status.send_evidence as SendEvidence | undefined
check(!!ev && Array.isArray(ev.proofs) && ev.proofs.length > 0, `3. send_evidence present (${ev?.proofs.length ?? 0} proofs)`)
if (!ev) {
  console.error('state:', status.send_evidence_state)
  process.exit(1)
}
const sentTotal = ev.proofs.reduce((n, p) => n + Number(p.amount), 0)
// The send is 60 face units (EUR cents), which is what status.amount reports. The signed amount is
// the sats the split sent. The change must not be in the evidence: sent + keep = the coupon's
// sats, and the keep token is a separate set of proofs from the evidence.
const { tokenProofs } = await import('../src/lib/voucherToken')
const couponSats = tokenProofs(token).reduce((n, p) => n + p.amount, 0)
const keep = typeof status.keep_token === 'string' ? tokenProofs(status.keep_token) : []
const keepSats = keep.reduce((n, p) => n + p.amount, 0)
const keepSecrets = new Set(keep.map((p) => p.secret))
check(keep.length > 0 && sentTotal + keepSats === couponSats && ev.proofs.every((p) => !keepSecrets.has(p.secret)),
  `3. evidence is the sent part only: ${sentTotal} sent + ${keepSats} change = ${couponSats}, no change proof in it`)
check(ev.proofs.every((p) => p.dleq && p.dleq.e && p.dleq.s && p.dleq.r), '3. every sent proof carries e, s and r')
check(ev.unit === 'sat', `3. unit is the mint unit (${ev.unit})`)
const stranger = await call(strangerSk, CORE, `/api/v1/atomic-send/${sendId}`, 'GET')
check(stranger.status === 404 || stranger.status === 403 || !stranger.text.includes('send_evidence'),
  `3. another key never sees the evidence (${stranger.status})`)

// 4. FR-003: unspent until the payee claims.
const ys = ev.proofs.map((p) => hashToCurveY(p.secret))
const s0 = await states(ys)
check(s0.every((s) => s === 'UNSPENT'), `4. before the claim every proof is UNSPENT (${[...new Set(s0)]})`)

// 5. The payee claims through the mint directly (swap), as its wallet would after the DM.
//    The payee wallet's real path is the DM; for the probe the evidence proofs ARE the token.
const tokenV4 = encodePlainTokenV4(
  ev.mint,
  ev.unit,
  ev.proofs.map((p) => ({ id: p.id, amount: Number(p.amount), secret: p.secret, C: p.C })) as never,
)
const recv = await call(payeeSk, CUSTOMER, '/api/v1/wallet/receive', 'POST', { token: tokenV4 },
  { 'Idempotency-Key': `rcv-${Date.now()}` })
check(recv.status >= 200 && recv.status < 300, `5. payee claimed the payment (${recv.status})`)
let s1: string[] = []
for (let i = 0; i < 20; i++) {
  s1 = await states(ys)
  if (s1.every((s) => s === 'SPENT')) break
  await new Promise((r) => setTimeout(r, 1500))
}
check(s1.every((s) => s === 'SPENT'), `6. after the claim every proof is SPENT (${[...new Set(s1)]})`)

// 6. Build, sign and verify the receipt.
const built = await buildPayerReceipt(ev, payee, 'order 42', Math.floor(Date.now() / 1000), secretKeySigner(payerSk))
check(built.summary.amount === sentTotal, `6. receipt amount is the signed sats (${built.summary.amount})`)
const report = verifySummary(built.receipt)
check(report.checks.PAYER_SIGNATURE?.outcome === 'PASS', '6. payer signature verifies')
const off = checkEvidenceOffline(built.summary, built.evidence)
check(off.digest.outcome === 'PASS' && off.amount.outcome === 'PASS', '6. evidence digest and amount verify offline')
const qr = encodeQr({ receipt: built.receipt, presenter: null, evidence: null, evidenceKey: null } as never)
const back = decodeQr(qr)
check(qr.startsWith('imrc1:') && bytesToHex(back.receipt.summaryBytes) === bytesToHex(built.receipt.summaryBytes),
  `6. QR payload round-trips (${qr.length} chars)`)

// 6b. The wallet's own verifier, against the REAL mint: DLEQ (keyset from the mint) and NUT-07
//     spent state, evidence fetched from a stand-in cache holding the encrypted blob.
{
  const { verifyScannedWith } = await import('../src/lib/receipts/verify')
  const key = newEvidenceKey()
  const blob = await encryptEvidence(key, built.evidenceBytes, built.summary.evidenceDigest)
  const presenter = await signPresenterProof(built.summary.paymentId, Math.floor(Date.now() / 1000), secretKeySigner(payerSk))
  const shown = encodeQr({ receipt: built.receipt, presenter, evidence: makeLocator('ab'.repeat(32), null), evidenceKey: key })
  // The mint URL in the evidence is the gateway's name for the mint; this host reaches it here.
  const reach = (m: string) => (m === MINT ? MINT_HOST : m)
  const res = await verifyScannedWith({
    publicKey: () => payee,
    keyset: async (m, id) => {
      const rr = await fetch(`${reach(m)}/v1/keys/${id}`)
      if (!rr.ok) return null
      const k = ((await rr.json()) as { keysets: { id: string; unit: string; keys: Record<string, string> }[] }).keysets[0]
      return k && k.id === id ? { unit: k.unit, keys: k.keys } : null
    },
    checkState: async (m, ys) => {
      const rr = await fetch(`${reach(m)}/v1/checkstate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ Ys: ys }) })
      const j = (await rr.json()) as { states: { state: 'UNSPENT' | 'SPENT' | 'PENDING'; witness?: string | null }[] }
      return j.states.map((x) => ({ state: x.state, witness: x.witness ?? null }))
    },
    fetchEvidence: async () => blob,
    ownRecord: async () => ({ face: { value: 60, unit: 'EUR', decimals: 2 } }),
    mintAllowed: (m) => m === MINT,
    count: () => {},
    now: () => Math.floor(Date.now() / 1000),
  }, shown)
  const ok = (c: string) => res.checks.find((x) => x.check === c)?.ok
  check(ok('MINT_SIGNATURE_DLEQ') === true, `6b. real DLEQ verifies against the mint's keyset (${JSON.stringify(res.checks.find((x) => x.check === 'MINT_SIGNATURE_DLEQ'))})`)
  check(ok('SPENT_STATE') === true && res.mint === 'confirmed', `6b. NUT-07 confirms spent (${res.mint})`)
  check(ok('EVIDENCE_DIGEST') === true && ok('AMOUNT') === true, '6b. digest and amount')
  check(res.presenter === 'PRESENTER_IS_PAYER', `6b. presenter is the payer (${res.presenter})`)
  // Not countersigned and not locked: the honest verdict is unacknowledged (FR-041).
  check(res.verdict === 'unacknowledged', `6b. verdict without a countersignature: ${res.verdict}`)
  const cs = await signCountersignature(built.summary, Math.floor(Date.now() / 1000), true, secretKeySigner(payeeSk))
  const acked = encodeQr({ receipt: withCountersignature(built.receipt, cs), presenter, evidence: makeLocator('ab'.repeat(32), null), evidenceKey: key })
  const res2 = await verifyScannedWith({
    publicKey: () => payee,
    keyset: async (m, id) => {
      const rr = await fetch(`${reach(m)}/v1/keys/${id}`)
      const k = ((await rr.json()) as { keysets: { id: string; unit: string; keys: Record<string, string> }[] }).keysets[0]
      return { unit: k.unit, keys: k.keys }
    },
    checkState: async (m, ys) => {
      const rr = await fetch(`${reach(m)}/v1/checkstate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ Ys: ys }) })
      return ((await rr.json()) as { states: { state: 'SPENT'; witness?: string | null }[] }).states.map((x) => ({ state: x.state, witness: x.witness ?? null }))
    },
    fetchEvidence: async () => blob,
    ownRecord: async () => ({ face: { value: 60, unit: 'EUR', decimals: 2 } }),
    mintAllowed: (m) => m === MINT,
    count: () => {},
    now: () => Math.floor(Date.now() / 1000),
  }, acked)
  check(res2.verdict === 'verified' && res2.mine === 'payee' && res2.records === 'found_in_records',
    `6b. countersigned: ${res2.verdict}, ${res2.mine}, ${res2.records}`)
}

// 7. Ack erases it.
const ack = await call(payerSk, CORE, `/api/v1/atomic-send/${sendId}/ack-send-evidence`, 'POST', {})
check(ack.status === 204, `7. ack-send-evidence 204 (${ack.status})`)
// A second ack must be a NEW NIP-98 event: the gateway rejects a reused event id as a replay, and
// two events signed in the same second with the same tags have the same id.
await new Promise((r) => setTimeout(r, 1100))
const ack2 = await call(payerSk, CORE, `/api/v1/atomic-send/${sendId}/ack-send-evidence`, 'POST', {})
check(ack2.status === 204, `7. ack is idempotent (${ack2.status})`)
const after = JSON.parse((await call(payerSk, CORE, `/api/v1/atomic-send/${sendId}`, 'GET')).text)
check(!after.send_evidence && after.send_evidence_state === 'acknowledged',
  `7. evidence erased, state=${after.send_evidence_state}`)
const strangerAck = await call(strangerSk, CORE, `/api/v1/atomic-send/${sendId}/ack-send-evidence`, 'POST', {})
check(strangerAck.status === 404, `7. another key cannot ack (${strangerAck.status})`)

// 8. Metrics.
const now = await metric('gateway-core-test', 'atomic_send_receipt_evidence_total')
const d = (k: string) => (now[k] ?? 0) - (before[k] ?? 0)
check(d('returned') >= 1, `8. metric returned +${d('returned')}`)
check(d('acknowledged') >= 1, `8. metric acknowledged +${d('acknowledged')}`)
check(d('capture_failed') === 0 && d('no_dleq') === 0, '8. no capture_failed or no_dleq')

console.log(failures === 0 ? '\nRESULT SUCCESS' : `\nRESULT FAILURE (${failures})`)
process.exit(failures === 0 ? 0 : 1)
