#!/usr/bin/env -S npx vite-node
/**
 * GENERATION: stalls' customers making checkout codes at a ramped rate (imani-wallet#402).
 *
 *   node loadtest/signer.mjs &                        # not used here, but the k6 half needs it
 *   node loadtest/stalls.mjs --count 2 --verify       # the stalls must hold coupon:issue
 *   npx vite-node loadtest/checkout-codes-make.mts -- --stalls 2 --codes 3 --rate-start 1 --rate-end 1
 *
 * ## Why this is not a k6 script
 *
 * Making a code is the wallet's work, not one request: burn each coupon proof at the mint, have the
 * gateway sign the S-locked successor (`/api/v1/wallet/vouchers/cashlink/lock`), and deposit the
 * locked parts at the store (`POST /v1/checkout-codes`). The lock step is cashu blinding and P2PK
 * secrets, which k6's runtime cannot do, and reimplementing it would measure a path no customer
 * takes. So this drives the wallet's own `startCheckoutCode` (src/lib/checkoutCodeFlow.ts) with Node
 * ports, exactly as e2e/checkout-codes-staging.e2e.mts does, and times each stage itself.
 *
 * ## One code, end to end
 *
 * 1. the stall issues a coupon on its NAP session (`POST /api/v1/portal/vouchers`), as market-day.js;
 * 2. polls `/api/v1/wallet/vouchers/{id}` until `ISSUED` with a token (2s, 30 attempts, the wallet's);
 * 3. a pool customer holds that bearer token and makes a code for the stall's shop key `S`.
 *
 * The coupon goes from stall to customer as a bare token in memory rather than a DM: delivery is
 * market-day.js's measurement, and it is not under test here.
 *
 * ## Output
 *
 * `.loadtest-codes.json` (git ignores it): the codes, the shop keys, and the previous file's codes
 * under `previous`, which is how `checkout-codes.js` finds EXPIRED ones: a code made with the
 * shortest `x` the gateway will lock (now + 1h05m) has expired by the next run an hour later.
 * Summary JSON goes to loadtest/results/checkout-codes-make-summary.json.
 *
 * Exit 0 when the thresholds hold, 1 when one is crossed, 107 when setup fails.
 */
// The flow keeps its records in localStorage. Installed before any import that could touch it.
process.env.VITE_TRUSTED_MINT_URLS ??= 'https://mint.staging.398ja.xyz'
const mem = new Map<string, string>()
;(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
  key: (i: number) => [...mem.keys()][i] ?? null,
  get length() {
    return mem.size
  },
}

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { finalizeEvent, getPublicKey } from 'nostr-tools'
import { Relay } from 'nostr-tools/relay'
import WebSocket from 'ws'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils'

import { startCheckoutCode, type CheckoutPorts } from '../src/lib/checkoutCodeFlow'
import { httpCashlinkMint } from '../src/lib/cashlinkFlow'
import { creditableFaceValue, parseVoucherToken } from '../src/lib/voucherToken'
import { latestLockX } from '../src/lib/cashlinkLock'
import { warrantSaleDigest } from '../src/lib/issuanceWarrant'
import { currencyDecimals } from '../src/lib/format'
import { parseOnlineShop } from '../src/lib/onlineShop'
import { schnorr } from '@noble/curves/secp256k1.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const POOL_FILE = join(ROOT, '.loadtest-pool.json')
const CODES_FILE = join(ROOT, '.loadtest-codes.json')
const SUMMARY_FILE = join(HERE, 'results', 'checkout-codes-make-summary.json')

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(`--${flag}`)
  return i === -1 ? fallback : process.argv[i + 1]
}

const GATEWAY = (process.env.GATEWAY_URL ?? 'https://wallet.staging.398ja.xyz').replace(/\/$/, '')
const PORTAL = (process.env.PORTAL_URL ?? GATEWAY).replace(/\/$/, '')
const CODES = (process.env.CODES_URL ?? GATEWAY).replace(/\/$/, '')
const STALLS = Number(arg('stalls', '2'))
/** Comma-separated pool indices to use as the stalls instead of the first --stalls. */
const STALL_INDEXES = arg('stall-index', '').split(',').filter((v) => v.trim() !== '').map(Number)
/** `derived` (default): a test shop key per stall. `published`: the stall's own advertised shop. */
const SHOP_MODE = arg('shops', 'derived')
const RELAY_URL = process.env.RELAY_URL ?? 'wss://relay.staging.398ja.xyz'
// nostr-tools' Relay expects a browser WebSocket; Node 20 has none.
if (typeof globalThis.WebSocket === 'undefined') (globalThis as { WebSocket?: unknown }).WebSocket = WebSocket
const TOTAL = Number(arg('codes', '3'))
/** Codes per minute at the start and end of the ramp, linear between them. */
const RATE_START = Number(arg('rate-start', '1'))
const RATE_END = Number(arg('rate-end', String(RATE_START)))
/** Codes in flight at once; a slow stage must not let the ramp pile up unbounded. */
const CONCURRENCY = Number(arg('concurrency', '4'))
const FACE_MINOR = Number(arg('face', '100'))
const CURRENCY = process.env.CURRENCY ?? 'EUR'
/** `short` (default): the earliest x the gateway locks, so leftovers expire within ~70 minutes. */
const X_MODE = arg('x', 'short')
const APPEND = process.argv.includes('--append')
const MINT_POLL_MS = 2000
const MINT_POLL_ATTEMPTS = 30

/**
 * Thresholds, in the k6 shape so the two halves read alike. Chosen from the CLIENT's budgets, since
 * no baseline existed (README, "Choosing the thresholds"):
 * - deposit: the wallet gives the store 15s (`STORE_TIMEOUT_MS`) and the deposit does a NUT-07 mint
 *   check per part. p99 5s keeps a third of that budget spare; p95 3s. Smoke, 2026-11-05: p95 2.1s.
 * - a whole code: the wallet waits up to 60s for the mint (30 polls x 2s), so a code past ~75s means
 *   a customer whose screen has given up. Smoke, 2026-11-05: p95 38s, of which the mint wait was 21s.
 */
const THRESHOLDS = {
  deposit_ms: { p95: 3000, p99: 5000 },
  make_ms: { p95: 45_000, p99: 75_000 },
  made_rate: 0.9,
}

type Identity = { index: number; privHex: string; pubHex: string; npub: string }

// --- NIP-98 and the NAP session --------------------------------------------------------------

function nip98(privHex: string, url: string, method: string, body?: string): string {
  const tags = [['u', url], ['method', method.toUpperCase()], ['nonce', bytesToHex(randomBytes(8))]]
  if (body !== undefined) tags.push(['payload', bytesToHex(sha256(new TextEncoder().encode(body)))])
  const ev = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags, content: '' }, hexToBytes(privHex))
  return 'Nostr ' + Buffer.from(JSON.stringify(ev)).toString('base64')
}

async function signedCall(origin: string, privHex: string, method: 'GET' | 'POST', path: string, body?: unknown) {
  const url = origin + path
  const text = body === undefined ? undefined : JSON.stringify(body)
  const r = await fetch(url, {
    method,
    headers: { Authorization: nip98(privHex, url, method, text), ...(text !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: text,
    signal: AbortSignal.timeout(30_000),
  })
  return { status: r.status, body: (await r.json().catch(() => null)) as Record<string, unknown> | null }
}

/** The wallet's own login without a browser, as stalls.mjs and signed-request.js `napLogin`. */
async function napSession(identity: Identity): Promise<{ cookie: string; permissions: string[] } | { error: string }> {
  const init = await fetch(`${GATEWAY}/api/v1/auth/init`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ npub: identity.npub }),
  })
  if (!init.ok) return { error: `auth/init ${init.status}` }
  const challenge = (await init.json()) as Record<string, string>
  const body = JSON.stringify({ challenge_id: challenge.challenge_id })
  const ev = finalizeEvent(
    {
      kind: 27235,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['u', challenge.auth_url],
        ['method', challenge.auth_method],
        ['payload', bytesToHex(sha256(new TextEncoder().encode(body)))],
        ['challenge', challenge.challenge],
        ['challenge_id', challenge.challenge_id],
      ],
      content: '',
    },
    hexToBytes(identity.privHex),
  )
  // auth_url names a host that does not resolve from outside; every tier answers on GATEWAY by path.
  const url = challenge.auth_url.replace(/^https?:\/\/[^/]+/, GATEWAY)
  const complete = await fetch(url, {
    method: challenge.auth_method,
    headers: { 'content-type': 'application/json', authorization: `Nostr ${Buffer.from(JSON.stringify(ev)).toString('base64')}` },
    body,
  })
  if (!complete.ok) return { error: `auth/complete ${complete.status}` }
  const cookie = (complete.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')
  const validate = await fetch(`${GATEWAY}/api/v1/auth/validate`, { headers: { cookie } })
  const permissions = (validate.headers.get('x-auth-permissions') ?? '').split(',').map((p) => p.trim()).filter(Boolean)
  return { cookie, permissions }
}

// --- The customer's ports (as e2e/checkout-codes-staging.e2e.mts) -----------------------------

function customerPorts(customer: Identity, depositTimes: number[]): CheckoutPorts {
  return {
    mint: httpCashlinkMint(),
    gateway: {
      async call(method, path, body, signer) {
        const url = GATEWAY + path
        const text = body === undefined ? undefined : JSON.stringify(body)
        let auth: string
        if (signer) {
          const tags = [['u', url], ['method', method], ['nonce', bytesToHex(randomBytes(8))]]
          if (text !== undefined) tags.push(['payload', bytesToHex(sha256(new TextEncoder().encode(text)))])
          const ev = await signer.signEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags, content: '' })
          auth = 'Nostr ' + Buffer.from(JSON.stringify(ev)).toString('base64')
        } else auth = nip98(customer.privHex, url, method, text)
        const r = await fetch(url, {
          method,
          headers: { Authorization: auth, ...(text !== undefined ? { 'Content-Type': 'application/json' } : {}) },
          body: text,
          signal: AbortSignal.timeout(30_000),
        })
        return { status: r.status, body: (await r.json().catch(() => null)) as Record<string, unknown> | null }
      },
    },
    deliver: async () => true,
    keep: async () => {},
    sleep: (ms) => new Promise((ok) => setTimeout(ok, ms)),
    now: () => Date.now(),
    store: {
      async call(method, path, body) {
        const started = performance.now()
        const a = await signedCall(CODES, customer.privHex, method, path, body)
        if (method === 'POST' && path === '/v1/checkout-codes') depositTimes.push(performance.now() - started)
        return a
      },
    },
    identitySecret: () => hexToBytes(customer.privHex),
    carve: async () => {
      throw new Error('this run uses whole coupons')
    },
    consume: async () => {},
    activity: async () => {},
  }
}

// --- One code -----------------------------------------------------------------------------------

type Stage = 'issue' | 'mint_wait' | 'lock_and_deposit'
type Made = { ok: true; code: string; amount: number; unit: string; x: number; ms: Record<Stage, number> }
type NotMade = { ok: false; stage: Stage | 'rate_limited'; why: string; ms: Partial<Record<Stage, number>> }

/**
 * The stall's `merchant` issuance warrant for one sale, signed as the wallet's Sell does
 * (src/lib/warrantSigner.ts `buildIssuanceWarrant`). The portal still ACCEPTS a sale with no warrant
 * (migration policy, IssuanceWarrantGate), but a coupon without one is refused by every receiving
 * wallet and shows up as `voucher_issuance_warrant_total{outcome="absent"}`. The 2026-11-05 smoke of
 * this script minted three such coupons before this was added. A load test must issue what a real
 * stall issues.
 */
function merchantWarrant(stall: Identity, saleTotalMinor: number, unit: string): string {
  const faceDecimals = currencyDecimals(unit)
  const nonce = bytesToHex(randomBytes(16))
  const digest = warrantSaleDigest(stall.pubHex, saleTotalMinor, faceDecimals, unit, nonce)
  const sig = bytesToHex(schnorr.sign(digest, hexToBytes(stall.privHex)))
  return JSON.stringify({ form: 'merchant', sale_total: saleTotalMinor, face_decimals: faceDecimals, unit, nonce, sig })
}

async function makeOne(stall: Identity, cookie: string, customer: Identity, shopKey: string, shopUrl: string, depositTimes: number[]): Promise<Made | NotMade> {
  const ms: Partial<Record<Stage, number>> = {}
  let t = performance.now()
  const created = await fetch(`${PORTAL}/api/v1/portal/vouchers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      face_value_minor: FACE_MINOR,
      currency: CURRENCY,
      quantity: 1,
      expiry_days: 90,
      memo: 'checkout-codes load test',
      // quantity is 1, so the sale total is the one coupon's face value.
      issuance_warrant: merchantWarrant(stall, FACE_MINOR, CURRENCY),
    }),
    signal: AbortSignal.timeout(30_000),
  })
  ms.issue = performance.now() - t
  const raw = await created.text()
  // gateway-portal re-emits the customer gateway's 429 as a bare 500 (#37); same inference as issuance.js.
  if (created.status === 429 || (created.status >= 500 && !raw.includes('voucher_id'))) return { ok: false, stage: 'rate_limited', why: `issue ${created.status}`, ms }
  let voucherId: string | undefined
  try {
    voucherId = JSON.parse(raw).items?.[0]?.voucher_id
  } catch {
    /* below */
  }
  if (!voucherId) return { ok: false, stage: 'issue', why: `issue ${created.status} ${raw.slice(0, 160)}`, ms }

  t = performance.now()
  let token: string | undefined
  for (let i = 0; i < MINT_POLL_ATTEMPTS && !token; i++) {
    const read = await signedCall(GATEWAY, stall.privHex, 'GET', `/api/v1/wallet/vouchers/${voucherId}`)
    if (read.status === 200 && read.body?.status === 'ISSUED' && typeof read.body.token === 'string') token = read.body.token
    else await new Promise((ok) => setTimeout(ok, MINT_POLL_MS))
  }
  ms.mint_wait = performance.now() - t
  if (!token) return { ok: false, stage: 'mint_wait', why: `not ISSUED after ${MINT_POLL_ATTEMPTS} polls`, ms }

  const parsed = parseVoucherToken(token)
  const face = creditableFaceValue(parsed).faceValue
  const nowS = Math.floor(Date.now() / 1000)
  const latest = latestLockX(parsed.voucher.expiresAt, nowS)
  if (latest === null) return { ok: false, stage: 'lock_and_deposit', why: 'no x the gateway would lock', ms }
  // The earliest x lockWindowProblem accepts (1h + 5 min slack), plus a minute for the run itself.
  const x = X_MODE === 'short' ? Math.min(latest, nowS + 3600 + 300 + 60) : latest

  t = performance.now()
  const out = await startCheckoutCode({
    ports: customerPorts(customer, depositTimes),
    pubkey: customer.pubHex,
    stall: stall.pubHex,
    shop: { url: shopUrl, redeemKey: shopKey, platform: 'woocommerce', since: nowS },
    unit: parsed.voucher.unit,
    decimals: parsed.voucher.faceDecimals ?? 2,
    amount: face,
    x,
    parts: [{ tokenId: voucherId, token, amount: face, faceValue: face }],
  })
  ms.lock_and_deposit = performance.now() - t
  if (out.kind !== 'issued' || !out.record.code) {
    const why = 'why' in out ? out.why : out.kind
    return { ok: false, stage: /429|RATE_LIMITED/.test(why) ? 'rate_limited' : 'lock_and_deposit', why: `${out.kind}: ${why}`, ms }
  }
  return { ok: true, code: out.record.code, amount: face, unit: parsed.voucher.unit.toLowerCase(), x, ms: ms as Record<Stage, number> }
}

// --- The ramp -----------------------------------------------------------------------------------

const pct = (xs: number[], p: number) => {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]
}
const stats = (xs: number[]) => ({ count: xs.length, avg: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0, p95: pct(xs, 95), p99: pct(xs, 99), max: xs.length ? Math.max(...xs) : 0 })

/**
 * A deterministic shop key per stall, so a re-run talks to the same shop.
 *
 * Derived from the stall's PRIVATE key. A derivation from its public key would let anyone who
 * reads the stall's profile recompute S and redeem the run's codes, which hold real (if test) value.
 */
type Shop = { privHex?: string; pubHex: string; stall: string; url: string; published: boolean }

function shopFor(stall: Identity): Shop {
  const privHex = bytesToHex(sha256(new TextEncoder().encode(`imani-loadtest-shop/v2/${stall.privHex}`)))
  return { privHex, pubHex: getPublicKey(hexToBytes(privHex)), stall: stall.pubHex, url: 'https://shop.loadtest.example', published: false }
}

/**
 * `--shops published`: the shop a stall really advertises, read from its own `imani:merchant`
 * record (`online_shop.redeem_key`), so the codes land at that stall's real online shop.
 *
 * The run never holds S's secret (the shop's plugin does), so `privHex` is absent: the k6 half and
 * `--cleanup` cannot sign as this shop, and say so. A stall that advertises no shop is skipped.
 */
async function publishedShopFor(stall: Identity): Promise<Shop | null> {
  const relay = await Relay.connect(RELAY_URL)
  const events: Array<{ created_at: number; content: string }> = []
  try {
    await new Promise<void>((ok) => {
      const sub = relay.subscribe([{ kinds: [30078], authors: [stall.pubHex], '#d': ['imani:merchant'] }], {
        onevent: (e) => { events.push(e) },
        oneose: () => { sub.close(); ok() },
      })
    })
  } finally {
    relay.close()
  }
  events.sort((a, b) => b.created_at - a.created_at)
  if (events.length === 0) return null
  let field: unknown
  try {
    field = (JSON.parse(events[0].content) as Record<string, unknown>).online_shop
  } catch {
    return null
  }
  const shop = parseOnlineShop(field)
  return shop ? { pubHex: shop.redeemKey, stall: stall.pubHex, url: shop.url, published: true } : null
}

/**
 * `--cleanup`: what a run leaves behind, put right as far as the store allows.
 *
 * A maker cannot cancel a code (#472, `409 NOT_CANCELLABLE`), so a reserved code stays until its x,
 * when the store expires it and the parts come back through the refund key. That is why generation
 * defaults to the earliest x (~65 minutes). What CAN be undone is a hold an interrupted race left:
 * released here by the order that holds it (`held_by`), so no code sits held for the 30 minute TTL.
 * Codes that are redeemed, expired or 404 are dropped from the file; the rest are kept.
 */
async function cleanup() {
  if (!existsSync(CODES_FILE)) return console.log(`no ${CODES_FILE}; nothing to clean up`)
  const file = JSON.parse(readFileSync(CODES_FILE, 'utf8'))
  const all = [...(file.codes ?? []), ...(file.previous ?? [])] as Array<{ code: string; shop: number }>
  const counts: Record<string, number> = {}
  const keep = new Set<string>()
  for (const c of all) {
    const shop = file.shops[c.shop]
    if (!shop.privHex) {
      // A stall's real shop: only its plugin can sign as S, so look at the public balance instead.
      const pub = await fetch(`${CODES}/v1/code-check/${c.code}`)
      const status = pub.ok ? `public ${pub.status}` : `public http ${pub.status}`
      counts[status] = (counts[status] ?? 0) + 1
      keep.add(c.code)
      await new Promise((ok) => setTimeout(ok, 6500)) // under the public check's 10/min zone
      continue
    }
    const look = await signedCall(CODES, shop.privHex, 'GET', `/v1/checkout-codes/${c.code}`)
    const status = look.status === 200 ? String(look.body?.status) : `http ${look.status}`
    if (status === 'held' && typeof look.body?.held_by === 'string') {
      const rel = await signedCall(CODES, shop.privHex, 'POST', `/v1/checkout-codes/${c.code}/release`, { order_ref: look.body.held_by })
      counts[`released (${rel.status})`] = (counts[`released (${rel.status})`] ?? 0) + 1
    } else counts[status] = (counts[status] ?? 0) + 1
    if (['reserved', 'held', 'settling', 'http 429'].includes(status)) keep.add(c.code)
    await new Promise((ok) => setTimeout(ok, 2500)) // under the edge's 30/min lookup zone
  }
  file.codes = (file.codes ?? []).filter((c: { code: string }) => keep.has(c.code))
  file.previous = (file.previous ?? []).filter((c: { code: string }) => keep.has(c.code))
  writeFileSync(CODES_FILE, JSON.stringify(file, null, 2) + '\n')
  console.log(`checked ${all.length} codes: ${JSON.stringify(counts)}`)
  console.log(`${keep.size} still reserved or held stay in ${CODES_FILE}; they expire at their x by design`)
}

async function main() {
  if (process.argv.includes('--cleanup')) return cleanup()
  if (!existsSync(POOL_FILE)) throw new Error(`no ${POOL_FILE}; run \`node loadtest/pool.mjs --size 20\``)
  const identities = (Object.values(JSON.parse(readFileSync(POOL_FILE, 'utf8'))) as Identity[]).sort((a, b) => a.index - b.index)
  // Stalls from the top, customers below them, as market-day.js and stalls.mjs split the pool.
  // --stall-index picks specific stalls (e.g. one with a real shop) and keeps them out of the customers.
  const picked = STALL_INDEXES.length > 0
    ? STALL_INDEXES.map((i) => {
        const found = identities.find((x) => x.index === i)
        if (!found) throw new Error(`no pool identity at index ${i}`)
        return found
      })
    : identities.slice(0, STALLS)
  const stalls = picked
  const reservedStalls = Math.max(STALLS, ...STALL_INDEXES.map((i) => i + 1))
  const customers = identities.filter((x) => x.index >= reservedStalls)
  if (customers.length === 0) throw new Error(`the pool needs more than ${STALLS} identities; run \`node loadtest/pool.mjs --size ${STALLS + 10}\``)

  const info = await fetch(`${CODES}/v1/checkout-codes/info`).catch(() => null)
  if (!info?.ok) throw new Error(`the code store did not answer at ${CODES}/v1/checkout-codes/info (${info?.status ?? 'unreachable'})`)

  const sessions: string[] = []
  for (const stall of stalls) {
    const s = await napSession(stall)
    if ('error' in s) throw new Error(`stall #${stall.index}: ${s.error}`)
    if (!s.permissions.includes('coupon:issue')) {
      throw new Error(`stall #${stall.index} holds no coupon:issue (${s.permissions.join(',')}).\n  Run: node loadtest/stalls.mjs --count ${STALLS} --verify`)
    }
    sessions.push(s.cookie)
  }
  const shops: Shop[] = []
  if (SHOP_MODE === 'published') {
    for (const stall of stalls) {
      const shop = await publishedShopFor(stall)
      if (shop === null) throw new Error(`stall #${stall.index} advertises no online shop (no online_shop in its imani:merchant record); --shops published needs one`)
      shops.push(shop)
    }
  } else {
    for (const stall of stalls) shops.push(shopFor(stall))
  }
  for (const [i, shop] of shops.entries()) {
    console.log(`shop     #${stalls[i].index} ${shop.published ? 'published' : 'derived'} ${shop.url} S=${shop.pubHex.slice(0, 12)}...`)
  }
  // A refund key R is derived from the customer's key and a per-wallet index. This process starts
  // with an empty localStorage, so without a run-specific base every run would reuse R0, R1... for
  // the same pool customer. Harmless on a test deployment, but the wallet never does it, so neither
  // does this: start each customer's counter at the run's epoch second.
  for (const c of customers) mem.set(`imani-wallet:checkout-refund-next:${c.pubHex}`, String(Math.floor(Date.now() / 1000)))

  console.log(`gateway  ${GATEWAY}`)
  console.log(`store    ${CODES}`)
  console.log(`stalls   ${STALLS}, customers ${customers.length}`)
  console.log(`ramp     ${TOTAL} codes, ${RATE_START} -> ${RATE_END} per minute, ${CONCURRENCY} in flight, ${FACE_MINOR} minor ${CURRENCY} each, x=${X_MODE}`)

  const depositTimes: number[] = []
  const results: Array<Made | NotMade> = []
  const made: Array<Record<string, unknown>> = []
  const inFlight = new Set<Promise<void>>()
  const startedAt = Date.now()

  for (let n = 0; n < TOTAL; n++) {
    // Linear ramp in rate: the gap before code n is 60 / rate(n) seconds.
    const rate = TOTAL > 1 ? RATE_START + ((RATE_END - RATE_START) * n) / (TOTAL - 1) : RATE_START
    if (n > 0) await new Promise((ok) => setTimeout(ok, 60_000 / Math.max(rate, 0.001)))
    while (inFlight.size >= CONCURRENCY) await Promise.race(inFlight)
    const s = n % stalls.length
    const customer = customers[n % customers.length]
    const p = makeOne(stalls[s], sessions[s], customer, shops[s].pubHex, shops[s].url, depositTimes)
      .then((r) => {
        results.push(r)
        const tag = r.ok === true ? `made ${r.code}` : `NOT made at ${(r as NotMade).stage}: ${(r as NotMade).why}`
        console.log(`  #${String(n).padStart(4, '0')} stall ${s} ${tag}  ${Object.entries(r.ms).map(([k, v]) => `${k}=${Math.round(v ?? 0)}ms`).join(' ')}`)
        if (r.ok) made.push({ code: r.code, stall: stalls[s].pubHex, shop: s, customer: customer.pubHex, amount: r.amount, unit: r.unit, expires_at: r.x, made_at: Math.floor(Date.now() / 1000) })
      })
      .catch((e) => {
        results.push({ ok: false, stage: 'lock_and_deposit', why: String(e), ms: {} })
        console.log(`  #${String(n).padStart(4, '0')} stall ${s} THREW ${String(e).slice(0, 200)}`)
      })
      .finally(() => inFlight.delete(p))
    inFlight.add(p)
  }
  await Promise.all(inFlight)

  // Keep what the last run made as `previous`: the k6 half finds its EXPIRED cases there.
  const prior = existsSync(CODES_FILE) ? JSON.parse(readFileSync(CODES_FILE, 'utf8')) : { codes: [], previous: [] }
  const keepPrevious = [...(prior.previous ?? []), ...(APPEND ? [] : prior.codes ?? [])].filter((c: { expires_at: number }) => c.expires_at > Date.now() / 1000 - 7 * 86_400)
  writeFileSync(
    CODES_FILE,
    JSON.stringify({ gateway: GATEWAY, store: CODES, written_at: new Date().toISOString(), shops, codes: [...(APPEND ? prior.codes ?? [] : []), ...made], previous: keepPrevious }, null, 2) + '\n',
  )

  const ok = results.filter((r): r is Made => r.ok)
  const notMade = results.filter((r): r is NotMade => !r.ok)
  const limited = notMade.filter((r) => r.stage === 'rate_limited').length
  // A throttled code is the deployment defending itself, as in issuance.js: not counted against it.
  const attempted = results.length - limited
  const madeRate = attempted ? ok.length / attempted : 0
  const summary = {
    attempted: results.length,
    made: ok.length,
    rate_limited: limited,
    failed: notMade.length - limited,
    failures_by_stage: Object.fromEntries(['issue', 'mint_wait', 'lock_and_deposit'].map((st) => [st, notMade.filter((r) => r.stage === st).length])),
    wall_seconds: (Date.now() - startedAt) / 1000,
    issue_ms: stats(ok.map((r) => r.ms.issue)),
    mint_wait_ms: stats(ok.map((r) => r.ms.mint_wait)),
    lock_and_deposit_ms: stats(ok.map((r) => r.ms.lock_and_deposit)),
    deposit_ms: stats(depositTimes),
    make_ms: stats(ok.map((r) => r.ms.issue + r.ms.mint_wait + r.ms.lock_and_deposit)),
  }
  const crossed: string[] = []
  if (attempted === 0) crossed.push('no code was attempted outside the rate limit: this run measured nothing')
  if (madeRate < THRESHOLDS.made_rate) crossed.push(`made_rate ${(madeRate * 100).toFixed(0)}% < ${THRESHOLDS.made_rate * 100}%`)
  for (const k of ['deposit_ms', 'make_ms'] as const) {
    if (summary[k].count === 0) continue
    if (summary[k].p95 > THRESHOLDS[k].p95) crossed.push(`${k} p95 ${summary[k].p95.toFixed(0)}ms > ${THRESHOLDS[k].p95}ms`)
    if (summary[k].p99 > THRESHOLDS[k].p99) crossed.push(`${k} p99 ${summary[k].p99.toFixed(0)}ms > ${THRESHOLDS[k].p99}ms`)
  }

  const line = (name: string, s: ReturnType<typeof stats>) =>
    `    ${name.padEnd(17)} avg ${s.avg.toFixed(0)}ms  p95 ${s.p95.toFixed(0)}ms  p99 ${s.p99.toFixed(0)}ms  (${s.count})`
  console.log(
    [
      '',
      '  Checkout code generation',
      `    made              ${ok.length} of ${results.length}`,
      `    rate limited      ${limited}`,
      `    failed            ${summary.failed}  ${JSON.stringify(summary.failures_by_stage)}`,
      line('issue', summary.issue_ms),
      line('mint wait', summary.mint_wait_ms),
      line('lock + deposit', summary.lock_and_deposit_ms),
      line('deposit (store)', summary.deposit_ms),
      line('whole code', summary.make_ms),
      '',
      `    codes written to ${CODES_FILE}`,
      '    Issuance is rate limited per client IP (README, "The first finding"), so from one host',
      '    generation is bounded by issuance long before the store. A limited code is reported, not failed.',
      '',
      crossed.length ? `  THRESHOLDS CROSSED:\n${crossed.map((c) => `    - ${c}`).join('\n')}` : '  thresholds held',
      '',
    ].join('\n'),
  )
  mkdirSync(dirname(SUMMARY_FILE), { recursive: true })
  writeFileSync(SUMMARY_FILE, JSON.stringify({ thresholds: THRESHOLDS, crossed, ...summary }, null, 2) + '\n')
  process.exitCode = crossed.length ? 1 : 0
}

main().catch((e) => {
  console.error(String(e instanceof Error ? e.message : e))
  process.exit(107)
})
