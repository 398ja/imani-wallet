/**
 * Do the API's reports agree with the app's, over the same rows?
 *
 * API ticket 07. The endpoints call `@imani/reports`, which is the same module
 * the merchant dashboard renders from — so the interesting question is not
 * whether the arithmetic is right (that is unit-tested in the package) but
 * whether it survives the round trip: JSON, a signature, a parser that derives
 * `direction` for itself, and back.
 *
 * A divergence here would mean two dashboards disagreeing about takings, which
 * from a merchant's chair is indistinguishable from money going missing.
 *
 *   npx tsx e2e/probe-reports.mts
 */
import { finalizeEvent } from 'nostr-tools'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { secp256k1, schnorr } from '@noble/curves/secp256k1.js'

import { merchantStats, outstandingLiability, type ReportTransaction } from '@imani/reports'

const API = process.env.API_URL ?? 'http://localhost:8788'

let failures = 0
function check(what: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const sk = secp256k1.utils.randomSecretKey()
const pubkey = bytesToHex(schnorr.getPublicKey(sk))

function authHeader(url: string, method: string, body?: string): string {
  const tags = [['u', url], ['method', method]]
  if (body !== undefined) tags.push(['payload', bytesToHex(sha256(new TextEncoder().encode(body)))])
  const event = finalizeEvent(
    { kind: 27235, created_at: Math.floor(Date.now() / 1000), tags, content: '' },
    sk,
  )
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`
}

const now = Date.now()
const day = 86_400_000

/**
 * A history with the cases that actually catch things: a part-redeemed coupon,
 * a coupon in another currency, one expiring inside the week, and one already
 * expired.
 */
const rows: ReportTransaction[] = [
  { id: 'a', type: 'issued', direction: 'out', at: now - 3 * day, amount: 1000, unit: 'EUR', decimals: 2, voucherId: 'v1', expiresAt: now + 3 * day },
  { id: 'b', type: 'redeemed', direction: 'in', at: now - day, amount: 400, unit: 'EUR', decimals: 2, voucherId: 'v1', merchantId: pubkey },
  { id: 'c', type: 'issued', direction: 'out', at: now - 5 * day, amount: 2500, unit: 'XAF', decimals: 0, voucherId: 'v2' },
  { id: 'd', type: 'issued', direction: 'out', at: now - 9 * day, amount: 700, unit: 'EUR', decimals: 2, voucherId: 'v3', expiresAt: now - day },
]

const opts = { pubkey, unit: 'EUR', decimals: 2, from: now - 30 * day, now }

/** What the app would show, computed locally from the same rows. */
const expected = merchantStats(rows, opts)
const expectedOutstanding = outstandingLiability(rows, { pubkey, unit: 'EUR', now })

const body = JSON.stringify({ transactions: rows, ...opts })

console.log('Asking the API for the same figures')
const url = `${API}/v1/reports/dashboard`
const r = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: authHeader(url, 'POST', body) },
  body,
})
check('the dashboard endpoint answers', r.status === 200, `HTTP ${r.status}`)
const got = (await r.json()) as { stats: typeof expected }

check('issued count matches the app', got.stats.issuedCount === expected.issuedCount, `${got.stats.issuedCount} vs ${expected.issuedCount}`)
check('issued value matches', got.stats.issuedValue === expected.issuedValue, `${got.stats.issuedValue} vs ${expected.issuedValue}`)
check('redeemed value matches', got.stats.redeemedValue === expected.redeemedValue, `${got.stats.redeemedValue} vs ${expected.redeemedValue}`)
check('redemption rate matches', got.stats.redemptionRate === expected.redemptionRate, `${got.stats.redemptionRate} vs ${expected.redemptionRate}`)
check('expired count matches', got.stats.expired === expected.expired, `${got.stats.expired} vs ${expected.expired}`)

// Counted, never silently dropped: a merchant must be told a row was left out
// rather than quietly shown a smaller number.
check('the other-currency row is COUNTED, not dropped', got.stats.otherCurrencyCount === 1, String(got.stats.otherCurrencyCount))
check('and is excluded from the EUR figures', got.stats.issuedValue === 1700)

const url2 = `${API}/v1/reports/records`
const r2 = await fetch(url2, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: authHeader(url2, 'POST', body) },
  body,
})
const got2 = (await r2.json()) as { outstanding: number; unit: string; expiringSoon: unknown[] }
check('the records endpoint answers', r2.status === 200, `HTTP ${r2.status}`)
check('outstanding matches the app', got2.outstanding === expectedOutstanding, `${got2.outstanding} vs ${expectedOutstanding}`)
check('amounts carry their currency, so rendering stays the caller\u2019s decision', got2.unit === 'EUR')
check('the coupon expiring this week is listed, and the expired one is not', got2.expiringSoon.length === 1, String(got2.expiringSoon.length))

/**
 * The control. A caller claiming its own issuance is incoming must not thereby
 * inflate its takings — `direction` is derived from `type` by the parser and
 * never read off the row.
 */
console.log('\nA caller cannot relabel its own issuance as income')
const lying = JSON.stringify({
  transactions: rows.map((t) => ({ ...t, direction: 'in' })),
  ...opts,
})
const r3 = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: authHeader(url, 'POST', lying) },
  body: lying,
})
const got3 = (await r3.json()) as { stats: typeof expected }
check('the figures are unchanged', got3.stats.redeemedValue === expected.redeemedValue, `${got3.stats.redeemedValue} vs ${expected.redeemedValue}`)

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
