/**
 * Checkout codes (#402) end to end against STAGING, through the real HTTP APIs with real keys.
 *
 * Nothing here is mocked. The pieces are the production code of each side:
 * - the customer: this wallet's own `checkoutCodeFlow.ts` (startCheckoutCode, cancelCheckoutCode,
 *   unlockReturned), with Node ports that sign NIP-98 with a key this run generates;
 * - the shop: imani-coupon-core (feat/redeemer) `CodeStoreClient`, `CheckoutValidation`, `Redeemer`
 *   and `StallHandoff`, run in php:8.5-cli by `checkout-codes-shop.php`, as imani-checkout-woo does;
 * - the stall: a merchant registered through the staging wallet UI, which issues the coupon (a
 *   cashback Cashlink) and later receives the shop's NIP-17 hand-off.
 *
 * Steps (one PASS/FAIL line each, plus detail lines):
 *   1 a fresh customer holds a real coupon from a staging stall
 *   2 the customer creates a checkout code for a shop key (deposit, all or nothing)
 *   3 the shop looks it up, holds it, redeems: settle burns the S-locked parts, the stall gets successors
 *   4 a second code is cancelled, the shop gives it back, the customer unlocks it
 *   5 negatives: an unknown code and a wrong shop key are refused (same 404 bytes, R2)
 *   6 (E2E_BALANCE=on only, #472) a balance order: the shop uses part of code C and keeps the rest on
 *     it; the customer reads `/parts`, adopts and re-arms the successor; `/mine` says what is left.
 *     Off by default: it needs a store, gateway and imani-coupon-core with #472, and must NOT be
 *     pointed at staging until those are deployed there.
 *
 *   npx vite-node e2e/checkout-codes-staging.e2e.mts      (vite-node: the wallet's import aliases)
 *
 * Env: E2E_BASE (wallet origin), E2E_CODES (code store origin), COUPON_CORE (imani-coupon-core path).
 */
// The flow keeps its records in localStorage. Installed before any import that could touch it.
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

import { spawnSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Page } from 'playwright'
import { finalizeEvent, generateSecretKey, getPublicKey, nip17 } from 'nostr-tools'
import { Relay, useWebSocketImplementation } from 'nostr-tools/relay'
import WebSocket from 'ws'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, randomBytes } from '@noble/hashes/utils'
import { hashToCurve } from '@cashu/crypto/modules/common'

import { registerMerchant } from './register.mts'
import { startCheckoutCode, cancelCheckoutCode, unlockReturned, codeHashOf, syncBalance, type CheckoutPorts } from '../src/lib/checkoutCodeFlow'
import { httpCashlinkMint, type KeptCoupon } from '../src/lib/cashlinkFlow'
import { creditableFaceValue, exactFaceValue, parseVoucherToken, tokenProofs } from '../src/lib/voucherToken'
import { checkSymbol, CHECKOUT_ALPHABET, display } from '../src/lib/checkoutCode'

useWebSocketImplementation(WebSocket)

const BASE = (process.env.E2E_BASE ?? 'https://wallet.staging.398ja.xyz').replace(/\/+$/, '')
const CODES = (process.env.E2E_CODES ?? 'https://codes.staging.398ja.xyz').replace(/\/+$/, '')
const CORE = process.env.COUPON_CORE ?? '/home/eric/IdeaProjects/imani-coupon-core'
const LOG = process.env.E2E_LOG ?? join(homedir(), '.jcode/scratch/402-e2e.log')
const HERE = dirname(fileURLToPath(import.meta.url))
const DAY = 86_400

function log(line: string) {
  const l = `${new Date().toISOString()} ${line}`
  console.log(l)
  appendFileSync(LOG, l + '\n')
}
const results: Array<{ step: string; ok: boolean }> = []
function step(name: string, ok: boolean, detail = '') {
  results.push({ step: name, ok })
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  | ${detail.slice(0, 900)}` : ''}`)
}
const info = (s: string) => log(`  INFO ${s.slice(0, 1500)}`)

// --- NIP-98 from Node ---------------------------------------------------------------------------

function nip98(sk: Uint8Array, url: string, method: string, body?: string): string {
  const tags = [['u', url], ['method', method.toUpperCase()], ['nonce', bytesToHex(randomBytes(8))]]
  if (body !== undefined) tags.push(['payload', bytesToHex(sha256(new TextEncoder().encode(body)))])
  const ev = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags, content: '' }, sk)
  return 'Nostr ' + Buffer.from(JSON.stringify(ev)).toString('base64')
}

async function signedCall(origin: string, sk: Uint8Array, method: 'GET' | 'POST', path: string, body?: unknown) {
  const url = origin + path
  const text = body === undefined ? undefined : JSON.stringify(body)
  const r = await fetch(url, {
    method,
    headers: { Authorization: nip98(sk, url, method, text), ...(text !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: text,
    signal: AbortSignal.timeout(30_000),
  })
  const raw = await r.text()
  let parsed: Record<string, unknown> | null = null
  try {
    parsed = JSON.parse(raw)
  } catch {
    /* not JSON */
  }
  return { status: r.status, body: parsed, raw }
}

// --- Mint helpers -------------------------------------------------------------------------------

async function states(mintUrl: string, token: string): Promise<string[]> {
  const Ys = tokenProofs(token).map((p) => hashToCurve(new TextEncoder().encode(p.secret)).toHex(true))
  const r = await fetch(`${mintUrl}/v1/checkstate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ Ys }) })
  return (((await r.json()) as { states?: { state: string }[] }).states ?? []).map((s) => s.state)
}
const lockKeyOf = (secret: string): string | null => {
  try {
    const [kind, b] = JSON.parse(secret) as [string, { data?: string }]
    return kind === 'P2PK_VOUCHER' ? (b.data ?? null) : null
  } catch {
    return null
  }
}
const hasTag = (secret: string, tag: string) => {
  try {
    return ((JSON.parse(secret)[1].tags ?? []) as string[][]).some((t) => t[0] === tag)
  } catch {
    return false
  }
}
const face = (token: string) => creditableFaceValue(parseVoucherToken(token)).faceValue
/** Unrounded, for sums over many one-proof rows. */
const exact = (tokens: string[]) => tokens.reduce((n, t) => n + exactFaceValue(parseVoucherToken(t)), 0)

// --- The shop (PHP coupon-core in Docker) -------------------------------------------------------

function shop(req: Record<string, unknown>): Record<string, any> {
  const p = spawnSync('docker', ['run', '--rm', '-i', '-v', `${CORE}:/core:ro`, '-v', `${HERE}:/e2e:ro`, 'php:8.5-cli', 'php', '/e2e/checkout-codes-shop.php'], {
    input: JSON.stringify({ store: CODES, gateway: BASE, ...req }),
    encoding: 'utf8',
    timeout: 300_000,
  })
  try {
    return JSON.parse(p.stdout)
  } catch {
    return { error: `php: ${p.status} ${p.stdout.slice(0, 400)} ${p.stderr.slice(0, 800)}` }
  }
}

// --- The customer's ports -----------------------------------------------------------------------

function customerPorts(sk: Uint8Array, kept: KeptCoupon[]): CheckoutPorts {
  return {
    mint: httpCashlinkMint(),
    gateway: {
      async call(method, path, body, signer) {
        const url = BASE + path
        const text = body === undefined ? undefined : JSON.stringify(body)
        let auth: string
        if (signer) {
          const tags = [['u', url], ['method', method], ['nonce', bytesToHex(randomBytes(8))]]
          if (text !== undefined) tags.push(['payload', bytesToHex(sha256(new TextEncoder().encode(text)))])
          const ev = await signer.signEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags, content: '' })
          auth = 'Nostr ' + Buffer.from(JSON.stringify(ev)).toString('base64')
        } else auth = nip98(sk, url, method, text)
        const r = await fetch(url, { method, headers: { Authorization: auth, ...(text !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: text, signal: AbortSignal.timeout(30_000) })
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
        const a = await signedCall(CODES, sk, method, path, body)
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

// --- The stall's coupons (a cashback Cashlink, claimed over HTTP) -------------------------------

async function issueCashback(m: Page, amount: string): Promise<{ ref: string; key: string }> {
  const generated = m.waitForResponse((r) => r.url().endsWith('/api/v1/portal/cashback/generate') && r.request().method() === 'POST', { timeout: 90_000 })
  await m.goto(`${BASE}/sell/cashback`, { waitUntil: 'load' })
  const input = m.locator('input[placeholder="0.00"]')
  for (let i = 0; i < 4; i++) {
    if (await input.waitFor({ timeout: 30_000 }).then(() => true, () => false)) break
    await m.goto(`${BASE}/sell/cashback`, { waitUntil: 'load' })
  }
  await input.fill(amount)
  await m.getByRole('button', { name: 'Create Cashlink' }).click()
  const res = await generated
  const gen = (await res.json()) as { claimUrl: string; claimKey: string }
  if (res.status() >= 300 || !gen.claimUrl) throw new Error(`cashback generate ${res.status()} ${JSON.stringify(gen).slice(0, 300)}`)
  return { ref: new URL(gen.claimUrl).pathname.split('/').pop()!, key: gen.claimKey }
}

async function claimCashback(claim: { ref: string; key: string }): Promise<string> {
  const config = (await (await fetch(`${BASE}/api/v1/config`)).json()) as { cashback_origins: string[] }
  const r = await fetch(`https://${config.cashback_origins[0]}/c/${claim.ref}/ciphertext`, { headers: { Accept: 'application/json', Origin: BASE } })
  if (r.status !== 200) throw new Error(`ciphertext ${r.status} ${(await r.text()).slice(0, 200)}`)
  const body = (await r.json()) as { ciphertext: string; iv: string }
  const b = (s: string) => Uint8Array.from(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'))
  const key = await crypto.subtle.importKey('raw', b(claim.key), { name: 'AES-GCM' }, false, ['decrypt'])
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b(body.iv) }, key, b(body.ciphertext)))
}

/** The merchant page's own count of transactions with this stall, as postdeploy-staging reads it. */
async function stallTxCount(m: Page, stall: string): Promise<number> {
  await m.goto(`${BASE}/merchants/${stall}/transactions`, { waitUntil: 'load' })
  const subtitle = m.getByText(/^(\d+) entr(y|ies)$|^Nothing yet\.$/).first()
  if (!(await subtitle.waitFor({ timeout: 30_000 }).then(() => true, () => false))) return -1
  await m.waitForTimeout(4000)
  return Number(/^(\d+)/.exec(await subtitle.innerText())?.[1] ?? '0')
}
async function homeText(m: Page): Promise<string> {
  await m.goto(`${BASE}/`, { waitUntil: 'load' })
  await m.waitForTimeout(6000)
  return (await m.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 600)
}

async function publishWrap(wrap: Record<string, unknown>, sk: Uint8Array): Promise<string> {
  const outcomes: string[] = []
  try {
    const relay = await Relay.connect('wss://relay.staging.398ja.xyz')
    await relay.publish(wrap as never)
    relay.close()
    outcomes.push('relay OK')
  } catch (e) {
    outcomes.push(`relay ${String(e).slice(0, 120)}`)
  }
  const m = await signedCall(BASE, sk, 'POST', '/api/v1/nostr/events', {
    id: wrap.id, pubkey: wrap.pubkey, createdAt: wrap.created_at, kind: wrap.kind, tags: wrap.tags, content: wrap.content, sig: wrap.sig,
  })
  outcomes.push(`mirror ${m.status}`)
  return outcomes.join(', ')
}

/** A well-formed code nobody made. */
function randomCode(): string {
  let data = ''
  for (let i = 0; i < 11; i++) data += CHECKOUT_ALPHABET[randomBytes(1)[0] % 32]
  return `IMANI${data}${checkSymbol(data)}`
}

// --- The run ------------------------------------------------------------------------------------

async function main() {
  log(`==== checkout-codes staging e2e  base=${BASE} codes=${CODES}`)
  const customerSk = generateSecretKey()
  const customer = getPublicKey(customerSk)
  const shopSk = bytesToHex(generateSecretKey())
  const shopKey = getPublicKey(Uint8Array.from(Buffer.from(shopSk, 'hex')))
  const wrongShopSk = bytesToHex(generateSecretKey())
  info(`customer=${customer} shop S=${shopKey}`)
  const storeInfo = (await (await fetch(`${CODES}/v1/checkout-codes/info`)).json()) as { nostr_pubkey?: string }
  info(`store nostr_pubkey=${storeInfo.nostr_pubkey}`)

  // 1. A stall, two coupons from it, held by a fresh customer.
  const browser = await chromium.launch()
  const mCtx = await browser.newContext({ locale: 'en-GB', serviceWorkers: 'block' })
  const m = await mCtx.newPage()
  const stallConsole: string[] = []
  m.on('console', (c) => stallConsole.push(`[${c.type()}] ${c.text().slice(0, 400)}`))
  m.on('pageerror', (e) => stallConsole.push(`[PAGEERROR] ${e.message.slice(0, 300)}`))
  const stallCalls: string[] = []
  m.on('response', (r) => {
    const u = new URL(r.url())
    if (/\/api\/v1\/(wallet\/(receive|redeem)|nostr\/query)/.test(u.pathname)) stallCalls.push(`${r.status()} ${r.request().method()} ${u.pathname}`)
  })
  const handle = await registerMerchant(m, BASE)
  const stall = await m.evaluate(() => {
    for (let i = 0; i < localStorage.length; i++) {
      const k = /^imani-wallet:profile:([0-9a-f]{64})$/.exec(localStorage.key(i) ?? '')
      if (k) return k[1]
    }
    return ''
  })
  info(`stall ${handle} ${stall}`)
  let couponA = '', couponB = '', couponC = ''
  try {
    couponA = await claimCashback(await issueCashback(m, '2.00'))
    couponB = await claimCashback(await issueCashback(m, '1.00'))
    if (process.env.E2E_BALANCE === 'on') couponC = await claimCashback(await issueCashback(m, '1.00'))
  } catch (e) {
    info(`coupon issue/claim: ${e}`)
  }
  const mintUrl = couponA ? parseVoucherToken(couponA).mintUrl.replace(/\/+$/, '') : ''
  const vA = couponA ? parseVoucherToken(couponA).voucher : null
  const okCoupons = !!couponA && !!couponB && vA?.issuerId.toLowerCase() === stall && face(couponA) === 200 && face(couponB) === 100 &&
    (await states(mintUrl, couponA)).every((s) => s === 'UNSPENT') && (await states(mintUrl, couponB)).every((s) => s === 'UNSPENT')
  step('1 fresh customer holds real coupons from a staging stall (EUR 2.00 + EUR 1.00, UNSPENT, issuer = stall)', okCoupons,
    couponA ? `issuer=${vA?.issuerId} unit=${vA?.unit} faces=${face(couponA)},${couponB ? face(couponB) : '-'} proofs=${tokenProofs(couponA).length} expires=${vA?.expiresAt}` : 'no coupon')
  if (!okCoupons) return finish(browser)
  const unit = vA!.unit
  const decimals = vA!.faceDecimals ?? 2
  const nowS = Math.floor(Date.now() / 1000)
  const x = Math.min(nowS + 2 * DAY, (vA!.expiresAt ?? nowS + 60 * DAY) - DAY - 600)
  const kept: KeptCoupon[] = []
  const ports = customerPorts(customerSk, kept)
  const onlineShop = { url: 'https://shop.e2e.example', redeemKey: shopKey, platform: 'woocommerce' as const, since: nowS }

  // 2. Code A.
  const outA = await startCheckoutCode({ ports, pubkey: customer, stall, shop: onlineShop, unit, decimals, amount: 200, x, parts: [{ tokenId: 'a', token: couponA, amount: 200, faceValue: 200 }] })
  const codeA = outA.record.code ?? ''
  const mine = await signedCall(CODES, customerSk, 'GET', '/v1/checkout-codes/mine')
  const listed = Array.isArray(mine.body) ? (mine.body as Array<Record<string, unknown>>) : []
  step('2 customer creates a checkout code for shop key S (deposit, all or nothing)',
    outA.kind === 'issued' && /^IMANI-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(display(codeA)) && (await states(mintUrl, couponA)).every((s) => s === 'SPENT') &&
      listed.some((r) => r.status === 'reserved' && String(r.code).replace(/-/g, '') === codeA),
    `${outA.kind}${'why' in outA ? ` why=${outA.why}` : ''} code=${codeA ? display(codeA) : '-'} parts=${outA.record.parts.map((p) => p.state).join(',')} mine=${mine.status} ${JSON.stringify(listed).slice(0, 300)}`)
  info(`record A: ${JSON.stringify({ ...outA.record, parts: outA.record.parts.map((p) => ({ ...p, lockedToken: p.lockedToken ? `${p.lockedToken.slice(0, 20)}…` : undefined })) })}`)
  if (codeA) {
    const locked = tokenProofs(outA.record.parts[0].lockedToken!)
    info(`A locked proofs: ${locked.length}, lock=${lockKeyOf(locked[0].secret)} SIG_ALL=${locked[0].secret.includes('SIG_ALL')} refund=${hasTag(locked[0].secret, 'refund')}`)
  }

  // 3. Shop: lookup, hold, redeem (with change if the part is splittable).
  if (codeA) {
    const order = `e2e-order-${Date.now()}`
    const total = 150
    const look = shop({ op: 'lookup', shop_sk: shopSk, code: display(codeA), stall, currency: unit, order_total: total })
    info(`lookup: ${JSON.stringify(look)}`)
    const hold = shop({ op: 'hold', shop_sk: shopSk, code: codeA, order_ref: order })
    const relook = shop({ op: 'lookup', shop_sk: shopSk, code: codeA, stall, currency: unit, order_total: total, order_ref: order })
    step('3a shop looks the code up (NIP-98 as S) and holds it',
      look.outcome === 'ok' && look.info?.status === 'reserved' && look.info?.amount === 200 && look.info?.stall_pubkey === stall && look.decision?.apply === true &&
        hold.outcome === 'ok' && relook.info?.status === 'held' && relook.info?.held_by === order,
      `lookup=${look.outcome}/${look.info?.status}/${look.info?.amount} decision=${JSON.stringify(look.decision)} hold=${JSON.stringify(hold)} after=${relook.info?.status} held_by=${relook.info?.held_by}`)

    const txBefore = await stallTxCount(m, stall)
    const homeBefore = await homeText(m)
    const red = shop({ op: 'redeem', shop_sk: shopSk, code: codeA, stall, currency: unit, order_total: total, order_ref: order })
    info(`redeem: ${JSON.stringify({ ...red, stall_tokens: red.stall_tokens ? Object.keys(red.stall_tokens) : undefined, customer_tokens: red.customer_tokens?.length, wraps: red.wraps?.length })}`)
    const stallTokens = Object.values((red.stall_tokens ?? {}) as Record<string, string>)
    let stallFace = 0, stallLockedOk = stallTokens.length > 0, stallUnspent = true
    for (const t of stallTokens) {
      stallFace += face(t)
      for (const p of tokenProofs(t)) if (lockKeyOf(p.secret) !== `02${stall}` || hasTag(p.secret, 'locktime') || hasTag(p.secret, 'refund')) stallLockedOk = false
      if (!(await states(mintUrl, t)).every((s) => s === 'UNSPENT')) stallUnspent = false
    }
    const locked = outA.record.parts[0].lockedToken!
    const lockedSpent = (await states(mintUrl, locked)).every((s) => s === 'SPENT')
    const custTokens = (red.customer_tokens ?? []) as string[]
    const changeFace = custTokens.reduce((n, t) => n + face(t), 0)
    info(`change tokens: ${custTokens.map((t) => `${tokenProofs(t).length} proofs, ${t.length} chars`).join('; ')} (store MAX_TOKEN_CHARS 16384)`)
    step('3b+ change reaches the store: POST /change accepted (the customer is notified with the R-locked change)', red.change?.outcome === 'ok' || custTokens.length === 0, JSON.stringify(red.change))
    step('3b redeem: gateway settle burns the S-locked parts, the stall gets successors for the applied amount',
      !red.error && red.redeem?.outcome === 'ok' && lockedSpent && stallLockedOk && stallUnspent && Math.abs(stallFace - red.deduction) <= 1 && red.redeemed_total === 200,
      `error=${red.error ?? '-'} deduction=${red.deduction} stall face=${stallFace} (locked 02‖stall, no locktime/refund: ${stallLockedOk}, UNSPENT: ${stallUnspent}) S-parts SPENT=${lockedSpent} change face=${changeFace} change->store=${JSON.stringify(red.change)}`)

    // The change (R-locked, no locktime) back to an ordinary coupon, as the wallet does on the `change` notice.
    if (custTokens.length > 0) {
      const before = kept.length
      const un = await unlockReturned(ports, customer, custTokens)
      const back = kept.slice(before)
      const backFace = back.reduce((n, k) => n + face(k.token), 0)
      const plain = back.every((k) => tokenProofs(k.token).every((p) => p.secret.startsWith('["VOUCHER"')))
      step('3c change: customer unlocks the R-locked change into ordinary coupons (checkout/unlock)',
        un.kind === 'kept' && back.length > 0 && plain && !back.some((k) => k.satsToken) && Math.abs(exact(back.map((k) => k.token)) - changeFace) <= 1,
        `${JSON.stringify(un)} kept=${back.length} exact face=${exact(back.map((k) => k.token)).toFixed(3)} rows as booked=${backFace} unlocked VOUCHER=${plain} sats-only=${back.filter((k) => k.satsToken).length}`)
    }

    // Deliver to the stall the way StallHandoff does it (sealed by S), then read the stall's own wallet.
    const wraps = (red.wraps ?? []) as Record<string, unknown>[]
    stallConsole.length = 0
    stallCalls.length = 0
    for (const w of wraps) info(`stall wrap ${String(w.id).slice(0, 12)}: ${await publishWrap(w, Uint8Array.from(Buffer.from(shopSk, 'hex')))}`)
    let txAfter = txBefore, homeAfter = homeBefore
    for (let i = 0; i < 12 && txAfter <= txBefore; i++) {
      await m.waitForTimeout(10_000)
      txAfter = await stallTxCount(m, stall)
    }
    homeAfter = await homeText(m)
    step('3d the stall\'s wallet records the shop hand-off (transaction count moves)', wraps.length === stallTokens.length && txAfter > txBefore,
      `wraps=${wraps.length} tx ${txBefore} -> ${txAfter} | home before: ${homeBefore.slice(0, 200)} | after: ${homeAfter.slice(0, 200)}`)
    info(`stall calls after hand-off: ${[...new Set(stallCalls)].join(' | ')}`)
    info(`stall console (filtered): ${stallConsole.filter((l) => /token|redeem|receive|dm|voucher|locked|error|warn/i.test(l)).slice(-25).join(' || ')}`)
    // The successors themselves after the hand-off: UNSPENT means the stall has not swapped them (yet).
    for (const t of stallTokens) info(`stall successor states after hand-off: ${(await states(mintUrl, t)).join(',')}`)

    // Replay of the same redeem (R4) and a second redeem attempt.
    const replay = shop({ op: 'raw', shop_sk: shopSk, method: 'POST', path: `/v1/checkout-codes/${codeA}/redeem`, body: JSON.stringify({ order_ref: order }) })
    const other = shop({ op: 'raw', shop_sk: shopSk, method: 'POST', path: `/v1/checkout-codes/${codeA}/hold`, body: JSON.stringify({ order_ref: 'another-order' }) })
    info(`redeem replay same order_ref -> ${replay.http}; hold by another order after redeem -> ${other.http} ${other.body}`)
  }

  // 4. Code B: cancel, shop gives it back, customer unlocks.
  const outB = await startCheckoutCode({ ports, pubkey: customer, stall, shop: onlineShop, unit, decimals, amount: 100, x, parts: [{ tokenId: 'b', token: couponB, amount: 100, faceValue: 100 }] })
  const codeB = outB.record.code ?? ''
  info(`code B: ${outB.kind} ${codeB ? display(codeB) : ''}${'why' in outB ? ` why=${outB.why}` : ''}`)
  if (codeB) {
    const cancel = await cancelCheckoutCode(ports, customer, outB.record.id)
    const feed = shop({ op: 'cancel_feed', shop_sk: shopSk })
    const back = shop({ op: 'cancel', shop_sk: shopSk, code: codeB, stall })
    info(`cancel=${JSON.stringify(cancel)} feed=${JSON.stringify(feed)} shop cancel=${JSON.stringify({ ...back, customer_tokens: back.customer_tokens?.length })}`)
    const before = kept.length
    const un = back.customer_tokens?.length ? await unlockReturned(ports, customer, back.customer_tokens) : { kind: 'none' }
    const got = kept.slice(before)
    const gotFace = got.reduce((n, k) => n + face(k.token), 0)
    const retFace = (back.customer_tokens ?? []).reduce((n: number, t: string) => n + face(t), 0)
    info(`cancel: returned token face (whole)=${retFace}; kept rows=${got.length} per-row faces=${got.map((k) => `${face(k.token)}${k.faceValue !== undefined ? `/fv${k.faceValue}` : ''}`).join(',')} sum=${gotFace}`)
    const unspent = (await Promise.all(got.map((k) => states(mintUrl, k.token)))).flat().every((s) => s === 'UNSPENT')
    const mineB = await signedCall(CODES, customerSk, 'GET', '/v1/checkout-codes/mine')
    const statusB = (Array.isArray(mineB.body) ? (mineB.body as Array<Record<string, unknown>>) : []).find((r) => String(r.code).replace(/-/g, '') === codeB)?.status
    step('4 second code cancelled and released: shop returns it, customer unlocks the value back',
      cancel.ok && (feed.codes ?? []).includes(codeB) && !back.error && back.cancelled?.outcome === 'ok' && un.kind === 'kept' && got.length > 0 && Math.round(exact(got.map((k) => k.token))) === 100 && unspent &&
        got.every((k) => !k.satsToken && tokenProofs(k.token).every((p) => p.secret.startsWith('["VOUCHER"'))) && statusB === 'cancelled',
      `cancel=${JSON.stringify(cancel)} in feed=${(feed.codes ?? []).includes(codeB)} return=${JSON.stringify(back.return)} error=${back.error ?? '-'} cancelled=${JSON.stringify(back.cancelled)} unlock=${JSON.stringify(un)} kept=${got.length} exact face=${exact(got.map((k) => k.token)).toFixed(3)} rows as the wallet books them=${gotFace} UNSPENT=${unspent} store status=${statusB}`)
  } else {
    step('4 second code cancelled and released: shop returns it, customer unlocks the value back', false, `code B not issued: ${outB.kind}`)
  }

  // 6. #472, behind a flag: a balance order. The shop op `redeem_balance` is imani-coupon-core's
  // `mode: balance` redeem plus `/rebalance` (checkout-codes-shop.php grows it with coupon-core #472).
  if (process.env.E2E_BALANCE === 'on') {
    const outC = await startCheckoutCode({ ports, pubkey: customer, stall, shop: onlineShop, unit, decimals, amount: 100, x, parts: [{ tokenId: 'c', token: couponC, amount: 100, faceValue: 100 }] })
    const codeC = outC.record.code ?? ''
    if (codeC) {
      const order = `e2e-balance-${Date.now()}`
      const used = 40
      shop({ op: 'hold', shop_sk: shopSk, code: codeC, order_ref: order })
      const red = shop({ op: 'redeem_balance', shop_sk: shopSk, code: codeC, stall, currency: unit, order_total: used, order_ref: order })
      const sync = await syncBalance(ports, customer, outC.record.id)
      const rec = (await import('../src/lib/checkoutCodeRecords')).loadCheckoutCodes(customer).find((r) => r.id === outC.record.id)
      const mineC = await signedCall(CODES, customerSk, 'GET', '/v1/checkout-codes/mine')
      const row = (Array.isArray(mineC.body) ? (mineC.body as Array<Record<string, unknown>>) : []).find((r) => String(r.code).replace(/-/g, '') === codeC)
      step('6 balance order: part of the code used, the rest stays on it, re-armed by R',
        !red.error && sync === 'handled' && rec?.remaining === 100 - used && rec.status === 'reserved' && rec.parts.every((p) => p.state !== 'locked' || p.armed) && row?.remaining === rec.remaining,
        `redeem=${JSON.stringify(red).slice(0, 300)} sync=${sync} remaining=${rec?.remaining} status=${rec?.status} armed=${rec?.parts.map((p) => p.armed).join(',')} mine=${JSON.stringify(row)}`)
    } else step('6 balance order: part of the code used, the rest stays on it, re-armed by R', false, `code C not issued: ${outC.kind}`)
  }

  // 5. Negatives.
  const unknown = randomCode()
  const u = shop({ op: 'raw', shop_sk: shopSk, method: 'GET', path: `/v1/checkout-codes/${unknown}` })
  const target = codeB || codeA
  const wrongLook = shop({ op: 'raw', shop_sk: wrongShopSk, method: 'GET', path: `/v1/checkout-codes/${target}` })
  const wrongRedeem = shop({ op: 'raw', shop_sk: wrongShopSk, method: 'POST', path: `/v1/checkout-codes/${target}/redeem`, body: JSON.stringify({ order_ref: 'x' }) })
  const wrongHold = shop({ op: 'raw', shop_sk: wrongShopSk, method: 'POST', path: `/v1/checkout-codes/${target}/hold`, body: JSON.stringify({ order_ref: 'x' }) })
  step('5a lookup of an unknown code is refused 404 NOT_FOUND', u.http === 404 && /NOT_FOUND/.test(u.body), `${u.http} ${u.body}`)
  step('5b another shop key cannot look up, hold or redeem the code (same 404 bytes, R2)',
    [wrongLook, wrongRedeem, wrongHold].every((r) => r.http === 404 && r.body === u.body),
    `lookup ${wrongLook.http} ${wrongLook.body} | redeem ${wrongRedeem.http} ${wrongRedeem.body} | hold ${wrongHold.http} ${wrongHold.body}`)
  // And at the gateway: a settle authorised by the wrong key, over code A's (spent) S-locked part.
  if (codeA) {
    const p = tokenProofs(outA.record.parts[0].lockedToken!)[0]
    const g = await signedCall(BASE, customerSk, 'POST', '/api/v1/wallet/vouchers/checkout/settle', {
      predecessor_secret: p.secret, proposed_secrets: [p.secret], authorization: '00'.repeat(64), predecessor_proof: { amount: p.amount, id: p.id, C: p.C, ...(p.dleq ? { dleq: p.dleq } : {}) }, burn_outputs: [],
    })
    step('5c gateway settle refuses an authorization not by S', g.status === 422 || g.status === 400 || g.status === 403, `${g.status} ${g.raw.slice(0, 200)}`)
  }
  info(`code hashes: A=${codeA ? codeHashOf(codeA).slice(0, 12) : '-'} B=${codeB ? codeHashOf(codeB).slice(0, 12) : '-'}`)
  return finish(browser)
}

async function finish(browser: { close(): Promise<void> }) {
  await browser.close().catch(() => {})
  const failed = results.filter((r) => !r.ok)
  log(`==== SUMMARY ${results.length - failed.length}/${results.length} passed${failed.length ? `; failed: ${failed.map((f) => f.step.split(' ')[0]).join(', ')}` : ''}`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => {
  log(`CRASH ${e?.stack ?? e}`)
  process.exit(2)
})
