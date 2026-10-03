/**
 * imani-gateway-portal#56, end to end on the LOCAL imani-test stack.
 *
 * A cashback-claim restore from backup loses claims created after the backup, so cashback-claim
 * answers 404 CLAIM_NOT_FOUND for a claim the portal really deposited. Before #56 the expiry path
 * burned on that answer. After #56 it parks the record as ManualAttention/claim_missing and never
 * calls the wallet.
 *
 * Simulates the restore by deleting ONE claim row this probe created, on the local test DB only,
 * then lapses the record and asks the portal for its status (the same path the sweep takes).
 *
 *   PORTAL_URL=http://localhost:28084 npx tsx e2e/probe-cashback-claim-missing.mts
 */
import { finalizeEvent } from 'nostr-tools'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { schnorr } from '@noble/curves/secp256k1.js'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const PORTAL = process.env.PORTAL_URL ?? 'http://localhost:28084'
const DB_CONTAINER = process.env.DB_CONTAINER ?? 'imani-gateway-db-test'
const PORTAL_CONTAINER = process.env.PORTAL_CONTAINER ?? 'gateway-portal-test'

if (!/-test$/.test(DB_CONTAINER)) {
  console.log(`  FAIL  refusing to write to ${DB_CONTAINER}: this probe only runs against a *-test database`)
  process.exit(1)
}

let failures = 0
function check(what: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const seeds = JSON.parse(readFileSync(process.env.SEED_KEYS ?? '.seed-keys.json', 'utf8')) as Record<string, { sk?: string }>
const sk = hexToBytes(process.env.PROBE_MERCHANT_SK ?? seeds['imani-terminals']!.sk!)

function nip98(url: string, method: string, body?: string): string {
  const tags = [['u', url], ['method', method]]
  if (body !== undefined) tags.push(['payload', bytesToHex(sha256(new TextEncoder().encode(body)))])
  const event = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags, content: '' }, sk)
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`
}

async function portal(method: 'GET' | 'POST', path: string, payload?: unknown) {
  const url = `${PORTAL}${path}`
  const body = payload === undefined ? undefined : JSON.stringify(payload)
  const r = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: nip98(url, method, body) },
    body,
  })
  const text = await r.text()
  let json: Record<string, unknown> = {}
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: r.status, json, text }
}

function sql(db: string, statement: string): string {
  const user = execFileSync('docker', ['exec', DB_CONTAINER, 'printenv', 'POSTGRES_USER']).toString().trim()
  return execFileSync('docker', ['exec', '-i', DB_CONTAINER, 'psql', '-U', user, '-d', db, '-A', '-t', '-c', statement])
    .toString().trim()
}

const uuid = /^[0-9a-f-]{36}$/

console.log('Generating a cashback')
const gen = await portal('POST', '/api/v1/portal/cashback/generate', {
  amountMinor: 123, unit: 'EUR', idempotencyKey: randomUUID(), voucherValidityDays: 30,
})
const cashbackId = String(gen.json.cashbackId ?? '')
check('the portal generates it', gen.status === 200 && uuid.test(cashbackId), `HTTP ${gen.status}`)
if (!uuid.test(cashbackId)) process.exit(1)

const claimRef = sql('imani_portal', `select safebox_claim_ref from cashback_record where cashback_id='${cashbackId}'`)
check('it carries a claim ref', claimRef.length > 0)
check('cashback-claim holds that claim', sql('imani_cashback_claim', `select count(*) from claim_record where claim_ref='${claimRef}'`) === '1')

console.log('\nSimulating a cashback-claim restore that predates this claim')
sql('imani_cashback_claim', `delete from claim_record where claim_ref='${claimRef}' and cashback_id='${cashbackId}'`)
check('the claim is gone at cashback-claim', sql('imani_cashback_claim', `select count(*) from claim_record where claim_ref='${claimRef}'`) === '0')

console.log('\nLapsing the claim window and asking for the status (the sweep takes the same path)')
const since = new Date().toISOString()
sql('imani_portal', `update cashback_record set expires_at = now() - interval '1 minute' where cashback_id='${cashbackId}'`)
const status = await portal('GET', `/api/v1/portal/cashback/${cashbackId}/status`)
check('the status call answers', status.status === 200, `HTTP ${status.status} ${status.text.slice(0, 160)}`)

const row = sql('imani_portal', `select status || '|' || coalesce(compensation_state,'') from cashback_record where cashback_id='${cashbackId}'`)
check('#56 the record is parked, not expired', row === 'ManualAttention|claim_missing', row)

const logs = execFileSync('docker', ['logs', '--since', since, PORTAL_CONTAINER], { stdio: ['ignore', 'pipe', 'pipe'] })
const all = logs.toString()
check('#56 no burn was attempted', !/walletPort\.revokeVoucher|cashback\.expire walletPort/.test(all))
check('#56 the park was logged', /claim_missing/.test(all))

const metrics = await fetch(`${process.env.PORTAL_METRICS_URL ?? 'http://localhost:29084'}/actuator/prometheus`).then((r) => r.text()).catch(() => '')
if (metrics) {
  const m = metrics.match(/^cashback_claim_missing_total(?:\{[^}]*\})?\s+([0-9.]+)/m)
  check('#56 cashback_claim_missing_total counted it', !!m && Number(m[1]) >= 1, m ? m[0] : 'metric absent')
} else {
  console.log('  INFO  actuator not reachable from the host; metric checked by the unit tests')
}

const again = await portal('GET', `/api/v1/portal/cashback/${cashbackId}/status`)
const row2 = sql('imani_portal', `select status || '|' || coalesce(compensation_state,'') from cashback_record where cashback_id='${cashbackId}'`)
check('a second status call is a no-op', again.status === 200 && row2 === row, row2)

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
