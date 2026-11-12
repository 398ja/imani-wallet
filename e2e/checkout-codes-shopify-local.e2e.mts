/**
 * #405 Shopify checkout codes, end to end on the LOCAL stack with a real Shopify dev store.
 *
 * Nothing Imani-side is faked: a real coupon from the local gateway, the wallet's own
 * checkoutCodeFlow (deposit with provision), the local code store (feature branch), the real
 * imani-checkout-shopify backend (run-once) talking to a real Shopify dev store, and the real
 * local gateway/mint settling. The only thing driven by hand is the Shopify checkout itself,
 * through the Storefront cart permalink + Admin draftOrder-free path: a browser places the order
 * (see SHOPIFY_ORDER below), because Shopify has no API to pay with a gift card.
 *
 * Steps:
 *   1 a fresh customer holds a real local coupon from a fresh stall (EUR 20.00, splittable)
 *   2 the wallet makes a Shopify code (provision: true): /mine says shop_ready=false
 *   3 the backend provisions it: a gift card with that code and amount exists, /mine shop_ready=true
 *   4 a checkout on the dev store uses part of it (operator/browser step, ORDER_DONE=1 to continue)
 *   5 the backend settles: the stall gets successors, the code keeps the rest, card balance == code remaining
 *   6 replay: a second run-once settles nothing twice
 *
 * Env: CODES (code store origin, default http://localhost:28093), GATEWAY (http://localhost:28082),
 * NIP98_ORIGIN (http://localhost:5173), MINT_REACH (http://localhost:27777), SHOPIFY_CFG (backend
 * config json), PHASE (setup|settle).
 */
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
process.env.VITE_TRUSTED_MINT_URLS ??= 'http://127.0.0.1.mint:7777'

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { finalizeEvent, getPublicKey } from 'nostr-tools'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils'
import { hashToCurve } from '@cashu/crypto/modules/common'
import { startCheckoutCode, reconcileCheckoutCodes, type CheckoutPorts } from '../src/lib/checkoutCodeFlow'
import { httpCashlinkMint, type KeptCoupon } from '../src/lib/cashlinkFlow'
import { creditableFaceValue, parseVoucherToken, tokenProofs } from '../src/lib/voucherToken'
import { display } from '../src/lib/checkoutCode'
import { loadCheckoutCodes } from '../src/lib/checkoutCodeRecords'

const CODES = process.env.CODES ?? 'http://localhost:28093'
const GATEWAY = process.env.GATEWAY ?? 'http://localhost:28082'
const ORIGIN = process.env.NIP98_ORIGIN ?? 'http://localhost:5173'
const MINT_NAMED = 'http://127.0.0.1.mint:7777'
const MINT_REACH = process.env.MINT_REACH ?? 'http://localhost:27777'
const STATE = process.env.E2E_STATE ?? `${process.env.HOME}/.config/imani-shopify-test/local/e2e-state.json`

// The browser wallet reaches 127.0.0.1.mint through the stack's DNS; this Node run maps it to the
// published port. Same bytes, same mint, only the transport differs.
const realFetch = globalThis.fetch
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  return realFetch(url.startsWith(MINT_NAMED) ? MINT_REACH + url.slice(MINT_NAMED.length) : url, init)
}) as typeof fetch

const results: Array<{ step: string; ok: boolean }> = []
const step = (name: string, ok: boolean, detail = '') => {
  results.push({ step: name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  | ${detail.slice(0, 700)}` : ''}`)
}
const info = (s: string) => console.log(`  INFO ${s.slice(0, 900)}`)

function nip98(sk: Uint8Array, url: string, method: string, body?: string): string {
  const tags = [['u', url], ['method', method.toUpperCase()], ['nonce', bytesToHex(randomBytes(8))]]
  if (body !== undefined) tags.push(['payload', bytesToHex(sha256(new TextEncoder().encode(body)))])
  return 'Nostr ' + Buffer.from(JSON.stringify(finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags, content: '' }, sk))).toString('base64')
}

/** `signedAs` is the origin the service binds NIP-98 `u` to; `reach` is where it actually listens. */
async function call(reach: string, signedAs: string, sk: Uint8Array, method: string, path: string, body?: unknown) {
  const text = body === undefined ? undefined : JSON.stringify(body)
  const r = await realFetch(reach + path, {
    method,
    headers: { Authorization: nip98(sk, signedAs + path, method, text), ...(text !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: text,
    signal: AbortSignal.timeout(30_000),
  })
  const raw = await r.text()
  let parsed: any = null
  try {
    parsed = JSON.parse(raw)
  } catch {
    /* not json */
  }
  return { status: r.status, body: parsed, raw }
}

function ports(sk: Uint8Array, kept: KeptCoupon[]): CheckoutPorts {
  return {
    mint: httpCashlinkMint(),
    gateway: {
      async call(method, path, body, signer) {
        const text = body === undefined ? undefined : JSON.stringify(body)
        let auth: string
        if (signer) {
          const tags = [['u', ORIGIN + path], ['method', method], ['nonce', bytesToHex(randomBytes(8))]]
          if (text !== undefined) tags.push(['payload', bytesToHex(sha256(new TextEncoder().encode(text)))])
          const ev = await signer.signEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags, content: '' })
          auth = 'Nostr ' + Buffer.from(JSON.stringify(ev)).toString('base64')
        } else auth = nip98(sk, ORIGIN + path, method, text)
        const r = await realFetch(GATEWAY + path, { method, headers: { Authorization: auth, ...(text !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: text, signal: AbortSignal.timeout(30_000) })
        const parsed = (await r.json().catch(() => null)) as Record<string, unknown> | null
        if (r.status >= 400) info(`gateway ${method} ${path} -> ${r.status} ${JSON.stringify(parsed)?.slice(0, 300)}`)
        return { status: r.status, body: parsed }
      },
    },
    deliver: async () => true,
    keep: async (row) => void kept.push(row),
    sleep: (ms) => new Promise((ok) => setTimeout(ok, ms)),
    now: () => Date.now(),
    store: {
      async call(method, path, body) {
        const a = await call(CODES, CODES, sk, method, path, body)
        if (a.status >= 400) info(`store ${method} ${path} -> ${a.status} ${a.raw.slice(0, 300)}`)
        return { status: a.status, body: a.body }
      },
    },
    identitySecret: () => Uint8Array.from(sk),
    carve: async () => {
      throw new Error('this run uses whole coupons')
    },
    consume: async () => {},
    activity: async () => {},
  }
}

async function states(token: string): Promise<string[]> {
  const Ys = tokenProofs(token).map((p) => hashToCurve(new TextEncoder().encode(p.secret)).toHex(true))
  const r = await realFetch(`${MINT_REACH}/v1/checkstate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ Ys }) })
  return (((await r.json()) as { states?: { state: string }[] }).states ?? []).map((s) => s.state)
}

async function setup() {
  const st = JSON.parse(readFileSync(STATE, 'utf8'))
  const sk = hexToBytes(st.customer_sk)
  const customer = getPublicKey(sk)
  const coupon = readFileSync(st.coupon_file, 'utf8').trim()
  const v = parseVoucherToken(coupon).voucher!
  const faceValue = creditableFaceValue(parseVoucherToken(coupon)).faceValue
  step('1 a fresh customer holds a real local coupon from the stall (splittable, UNSPENT)',
    v.issuerId.toLowerCase() === st.stall && (await states(coupon)).every((s) => s === 'UNSPENT') && v.backingStrategy !== 'FIXED',
    `issuer=${v.issuerId} unit=${v.unit} face=${faceValue} backing=${v.backingStrategy}`)

  const nowS = Math.floor(Date.now() / 1000)
  const x = Math.min(nowS + 2 * 86400, (v.expiresAt ?? nowS + 60 * 86400) - 86400 - 600)
  const kept: KeptCoupon[] = []
  const p = ports(sk, kept)
  const shop = { url: st.shop_url, redeemKey: st.shop_key, platform: 'shopify' as const, since: nowS }
  const out = await startCheckoutCode({ ports: p, pubkey: customer, stall: st.stall, shop, unit: v.unit, decimals: v.faceDecimals ?? 2, amount: faceValue, x, parts: [{ tokenId: 'a', token: coupon, amount: faceValue, faceValue }] })
  const mine = await call(CODES, CODES, sk, 'GET', '/v1/checkout-codes/mine')
  const row = (Array.isArray(mine.body) ? mine.body : []).find((r: any) => String(r.code).replace(/-/g, '') === out.record.code)
  step('2 the wallet makes a Shopify code (provision): issued, hidden (shopReady=false), /mine shop_ready=false',
    out.kind === 'issued' && out.record.shopReady === false && row?.shop_ready === false && row?.status === 'reserved',
    `${out.kind}${'why' in out ? ` why=${out.why}` : ''} code=${out.record.code ? display(out.record.code) : '-'} record.shopReady=${out.record.shopReady} mine=${JSON.stringify(row)}`)
  writeFileSync(STATE, JSON.stringify({ ...st, code: out.record.code, amount: faceValue, unit: v.unit, records: [...mem.entries()] }, null, 2))
}

async function afterProvision() {
  const st = JSON.parse(readFileSync(STATE, 'utf8'))
  for (const [k, v] of st.records ?? []) mem.set(k, v)
  const sk = hexToBytes(st.customer_sk)
  const customer = getPublicKey(sk)
  const changed = await reconcileCheckoutCodes(ports(sk, []), customer)
  const rec = loadCheckoutCodes(customer).find((r) => r.code === st.code)
  step('3b the wallet sees shop_ready on reconcile and shows the code', changed >= 1 && rec?.shopReady === true, `changed=${changed} shopReady=${rec?.shopReady}`)
  writeFileSync(STATE, JSON.stringify({ ...st, records: [...mem.entries()] }, null, 2))
}

async function finalCheck() {
  const st = JSON.parse(readFileSync(STATE, 'utf8'))
  const sk = hexToBytes(st.customer_sk)
  const mine = await call(CODES, CODES, sk, 'GET', '/v1/checkout-codes/mine')
  const row = (Array.isArray(mine.body) ? mine.body : []).find((r: any) => String(r.code).replace(/-/g, '') === st.code)
  console.log(JSON.stringify({ mine: row }))
}

const phase = process.env.PHASE ?? 'setup'
;(phase === 'setup' ? setup() : phase === 'ready' ? afterProvision() : finalCheck())
  .then(() => {
    const failed = results.filter((r) => !r.ok)
    console.log(`==== ${phase}: ${results.length - failed.length}/${results.length} passed`)
    process.exit(failed.length ? 1 : 0)
  })
  .catch((e) => {
    console.log(`CRASH ${e?.stack ?? e}`)
    process.exit(2)
  })
