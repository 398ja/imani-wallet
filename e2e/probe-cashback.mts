/**
 * Cashback, end to end against the live portal.
 *
 * API ticket 08. The ticket recorded this as blocked on an API-key auth model
 * that ADR 0001 forbids. That was wrong: the endpoint probed was gateway-core's
 * `/api/v1/cashback/generate`, not the portal's
 * `/api/v1/portal/cashback/generate`, and the portal has protected its prefix
 * with NIP-98 all along.
 *
 * So the arm that matters is the first one: a signed request, no API key, and
 * the portal answers.
 *
 *   npx tsx e2e/probe-cashback.mts
 */
import { finalizeEvent } from 'nostr-tools'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { secp256k1, schnorr } from '@noble/curves/secp256k1.js'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

const API = process.env.API_URL ?? 'http://localhost:8788'

let failures = 0
function check(what: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

/**
 * A REGISTERED merchant, not a fresh key.
 *
 * Cashback sits behind `@PreAuthorize(MERCHANT_ONLY)`, which wants
 * `coupon:issue` — the permission only a merchant holds. A random key
 * authenticates fine and is then refused 403, which would make every check
 * below pass for the wrong reason.
 */
const seedPath = process.env.SEED_KEYS ?? '.seed-keys.json'
const seeds = JSON.parse(readFileSync(seedPath, 'utf8')) as Record<string, { sk?: string }>
const merchantSk = process.env.PROBE_MERCHANT_SK ?? seeds['imani-terminals']?.sk
if (!merchantSk) {
  console.log('  FAIL  no merchant key — set PROBE_MERCHANT_SK')
  process.exit(1)
}
const sk = hexToBytes(merchantSk)
const pubkey = bytesToHex(schnorr.getPublicKey(sk))

function header(url: string, method: string, body?: string): string {
  const tags = [['u', url], ['method', method]]
  if (body !== undefined) tags.push(['payload', bytesToHex(sha256(new TextEncoder().encode(body)))])
  const event = finalizeEvent(
    { kind: 27235, created_at: Math.floor(Date.now() / 1000), tags, content: '' },
    sk,
  )
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`
}

async function ask(path: string, payload: unknown) {
  const url = `${API}${path}`
  const body = JSON.stringify(payload)
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: header(url, 'POST', body) },
    body,
  })
  return { status: r.status, body: (await r.json()) as Record<string, never> }
}

async function forward(i: { url: string; method: string; body: string }) {
  const r = await fetch(i.url, {
    method: i.method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: header(i.url, i.method, i.body),
    },
    body: i.body,
  })
  return { status: r.status, text: await r.text() }
}

console.log(`A registered merchant: ${pubkey.slice(0, 12)}…`)

console.log('\nAsking what to sign to generate cashback')
const idempotencyKey = randomUUID()
const plan = await ask('/v1/cashback/generate', {
  amountMinor: 500,
  unit: 'EUR',
  memo: 'probe',
  idempotencyKey,
})
check('the courier answers', plan.status === 200, `HTTP ${plan.status}`)
check(
  'pointing at the PORTAL path, not gateway-core\u2019s API-key one',
  String(plan.body.url).endsWith('/api/v1/portal/cashback/generate'),
  String(plan.body.url),
)

console.log('\nThe caller signs it — no API key anywhere')
const generated = await forward(plan.body as unknown as { url: string; method: string; body: string })

/**
 * The finding this ticket turned on.
 *
 * A 401 would mean the API-key filter; anything else means NIP-98 was accepted.
 * 403 is the merchant permission, which is a grant to arrange rather than an
 * auth model to change — so it is reported distinctly rather than as a pass.
 */
check(
  'the portal does NOT demand an API key',
  generated.status !== 401,
  `HTTP ${generated.status} ${generated.text.slice(0, 120)}`,
)
if (generated.status === 403) {
  /**
   * This used to be the expected outcome, and it is now a real failure.
   *
   * `Nip98AuthFilter` granted exactly one authority, `ROLE_NOSTR_USER`, and
   * never `coupon:issue` — that came only from `NapProxyAuthFilter` and a NAP
   * session — so a NIP-98 caller could authenticate perfectly and never
   * satisfy `@PreAuthorize(MERCHANT_ONLY)`. imani-security #7 added a
   * permission resolver, gateway-core exposes
   * `/internal/v1/merchants/{pubkey}/permissions`, and gateway-portal now asks
   * it. A signed merchant gets `coupon:issue`.
   *
   * So a 403 here means something is BROKEN rather than unbuilt. In order of
   * likelihood:
   *
   *   - the merchant has no open stall. Merchant status comes from a kind-30078
   *     `d=imani:merchant` record with `{"active":true}`; publishing one is what
   *     makes someone a merchant. Run `node scripts/open-stall.mjs`.
   *   - the portal cannot reach gateway-core, or its service token is missing.
   *     It fails CLOSED, so that looks exactly like "not a merchant". Check the
   *     portal log for `merchant_permissions_lookup_failed`.
   *   - the resolver's 60s cache still holds a pre-stall answer. Wait, or
   *     restart the portal.
   */
  check('and generates the cashback', false,
    `HTTP 403 — a signed merchant should now hold coupon:issue. ` +
    `Check: stall published? gateway-core reachable? service token set?`)
} else {
  check('and generates the cashback', generated.status < 400, `HTTP ${generated.status} ${generated.text.slice(0, 140)}`)
}

let claimRef = ''
if (generated.status < 400) {
  const record = JSON.parse(generated.text) as { claimRef?: string; claimCode?: string; idempotencyKey?: string }
  claimRef = record.claimRef ?? ''
  check('echoing the idempotency key we chose', record.idempotencyKey === idempotencyKey, String(record.idempotencyKey))
  check('and carrying a claim reference', Boolean(claimRef || record.claimCode))

  console.log('\nRepeating the SAME request')
  // What the idempotency key is for: a retry after an uncertain response must
  // not generate a second cashback.
  const again = await forward(plan.body as unknown as { url: string; method: string; body: string })
  if (again.status < 400) {
    const second = JSON.parse(again.text) as { cashbackId?: string }
    const first = JSON.parse(generated.text) as { cashbackId?: string }
    check('returns the same cashback rather than a second one', second.cashbackId === first.cashbackId)
  }
}

console.log('\nLooking a code up needs no signature')
const lookup = await ask('/v1/cashback/lookup', { code: 'CB-ABCD-EF' })
check('the courier answers', lookup.status === 200, `HTTP ${lookup.status}`)
check('with a by-code URL', String(lookup.body.url).includes('/api/v1/portal/cashback/by-code/'))
// The portal exempts this read deliberately: a customer redeeming a code off a
// printed receipt holds no key of ours.
check('marked as unauthenticated', lookup.body.authenticated === false)
check(
  'and warns that the claim key lives in the URL fragment',
  JSON.stringify(lookup.body.then ?? {}).includes('fragment'),
)

console.log('\nWhat the courier refuses')
const badUuid = await ask('/v1/cashback/generate', { amountMinor: 500, unit: 'EUR', idempotencyKey: 'not-a-uuid' })
// Refused here rather than at the portal, which answers a 500 stack trace about
// UUID string length from a host the caller never addressed.
check('a non-UUID idempotency key, before the portal 500s on it', badUuid.status === 400 && badUuid.body.field === 'idempotencyKey')

const noKey = await ask('/v1/cashback/generate', { amountMinor: 500, unit: 'EUR' })
check('a missing idempotency key', noKey.status === 400 && noKey.body.field === 'idempotencyKey')

const zero = await ask('/v1/cashback/generate', { amountMinor: 0, unit: 'EUR', idempotencyKey: randomUUID() })
check('an amount of zero', zero.status === 400 && zero.body.field === 'amountMinor')

/**
 * The read path's own answers, straight from the portal.
 *
 * Worth checking directly rather than only through the courier: these are the
 * distinctions a caller acts on, and the courier cannot invent them.
 */
console.log('\nWhat the portal says about a code')
const unknown = await fetch(String(lookup.body.url).replace(/by-code\/.*$/, 'by-code/CB-ZZZZ-99'))
const unknownBody = (await unknown.json().catch(() => ({}))) as { code?: string }
check('an unknown code is 404 not_found', unknown.status === 404 && unknownBody.code === 'not_found', `HTTP ${unknown.status} ${JSON.stringify(unknownBody)}`)

// 410 carries `claimed` | `expired` | `revoked`, which is how a caller tells a
// spent code from a lapsed one. Not reachable here without generating and
// consuming a code, which needs the write path.
console.log('  INFO  claimed / expired / revoked arrive as 410 with a `code`;')
console.log("        reaching them needs a code generated first.")

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
