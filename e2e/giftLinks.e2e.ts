/**
 * Claim links phase 4: gifts by link (docs/spec-claim-links.md 3.3, 4.2, 4.3, 5.3, 5.4, section 7),
 * real browsers against a full stack (the local gate: imani-deploy scripts/local-terminal-gate,
 * E2E_SCRIPT=giftLinks.e2e.ts). Two or more browser contexts throughout.
 *
 * Setup: merchant A issues 2.00 cashback; customer S adds it (the phase 1-3 path).
 *
 *   CL-C   S sends 0.50 by link (Send, "Anyone, by link"). No ADR 0014 transfer signature reaches
 *          the link key (Q7). A FRESH context with no account opens the link: lands on onboarding
 *          with the gift banner, the fragment scrubbed, nothing spent; registers; the prompt shows
 *          the token-verified gift; Add; "Voucher added". S's history then reads Claimed. No request
 *          from the recipient's browser carried the secret.
 *   CL-D   S sends 0.30 by link; a LOGGED-IN context opens it, goes straight to the prompt, Adds.
 *          S's history reads Claimed.
 *   CL-EXP S sends 0.20 by link. The recipient opens it with `x` in the past: refused with the
 *          expired copy, nothing spent. S's link passes its expiry (its stored `x` set back): S's
 *          next start reclaims it (Taken back), and the original link now reads already added.
 *          Plus Q4: S sends 0.10 and taps Take it back; the recipient then reads already added.
 *
 *   E2E_BASE E2E_BUNDLE_DIR E2E_CLAIM_HOST_VIA E2E_MINT_URL npx tsx e2e/giftLinks.e2e.ts
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { readFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { finalizeEvent, getPublicKey, nip17 } from 'nostr-tools'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'
import { hashToCurve } from '@cashu/crypto/modules/common'
import { registerCustomer, registerMerchant, TEST_PASSPHRASE } from './register.mts'
import { tokenProofs } from '../src/lib/voucherToken'

const BASE = (process.env.E2E_BASE ?? '').replace(/\/+$/, '')
const BUNDLE_DIR = process.env.E2E_BUNDLE_DIR
const CLAIM_HOST_VIA = process.env.E2E_CLAIM_HOST_VIA ?? ''
const MINT = (process.env.E2E_MINT_URL ?? '').replace(/\/+$/, '')
// The gate's mint is TLS with a throwaway CA; the harness's own NUT-07 reads accept it.
if (MINT) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
if (!BASE || !CLAIM_HOST_VIA) throw new Error('E2E_BASE and E2E_CLAIM_HOST_VIA are required (never the real claim host)')

const failures: string[] = []
const errors: string[] = []
function check(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(name)
}
const text = async (p: Page) => (await p.locator('body').innerText()).replace(/\s+/g, ' ')
const CT: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' }

let claimHost = ''
function viaEdge(path: string, headers: Record<string, string>) {
  const via = new URL(CLAIM_HOST_VIA)
  return new Promise<{ status: number; headers: Record<string, string>; body: Buffer }>((resolve, reject) => {
    const req = httpRequest({ host: via.hostname, port: via.port || 80, path, method: 'GET', headers: { ...headers, host: claimHost } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const out: Record<string, string> = {}
        for (const [k, v] of Object.entries(res.headers)) if (typeof v === 'string') out[k] = v
        resolve({ status: res.statusCode ?? 0, headers: out, body: Buffer.concat(chunks) })
      })
    })
    req.on('error', reject)
    req.end()
  })
}

/** Every request URL and Referer each context sends, to prove the secret never leaves in one. */
const seen: Array<{ who: string; url: string; referer: string }> = []
const consoleLines: string[] = []
const consoleOf = (who: string, re: RegExp) => consoleLines.filter((l) => l.startsWith(`${who}:`) && re.test(l)).slice(-8).join(' | ')

async function context(browser: Browser, who: string): Promise<BrowserContext> {
  const ctx = await browser.newContext({ locale: 'en-GB', serviceWorkers: 'block', ignoreHTTPSErrors: true })
  if (BUNDLE_DIR) {
    const root = normalize(BUNDLE_DIR)
    const shell = join(root, 'index.html')
    await ctx.route(`${BASE}/**`, async (route) => {
      const path = new URL(route.request().url()).pathname
      if (path.startsWith('/api/') || path.startsWith('/.well-known/')) return route.continue()
      const cand = normalize(join(root, path))
      const file = cand.startsWith(root) && extname(cand) ? await readFile(cand).then(() => cand, () => shell) : shell
      return route.fulfill({ status: 200, body: await readFile(file), contentType: CT[extname(file)] ?? 'application/octet-stream' })
    })
  }
  // Every request to the claim host goes to the GATE's edge, never the real host.
  await ctx.route(`https://${claimHost}/**`, async (route) => {
    const u = new URL(route.request().url())
    const origin = route.request().headers()['origin']
    const res = await viaEdge(u.pathname + u.search, origin ? { origin } : {})
    return route.fulfill({ status: res.status, headers: res.headers, body: res.body })
  })
  // Navigations the harness itself makes carry the link by design (that is the tap); everything the
  // APP requests, and every Referer, must not.
  ctx.on('request', (r) => {
    if (r.isNavigationRequest() && r.frame() === r.frame().page().mainFrame()) {
      seen.push({ who, url: '', referer: r.headers()['referer'] ?? '' })
    } else {
      seen.push({ who, url: r.url(), referer: r.headers()['referer'] ?? '' })
    }
  })
  ctx.on('page', (p) => {
    p.on('pageerror', (e) => errors.push(`${who}: ${e.message}`))
    // Kept for a failure's diagnosis; never printed with a link in it (see `consoleOf`).
    p.on('console', (m) => consoleLines.push(`${who}: ${m.text()}`))
  })
  return ctx
}

// ── The link key's view, from outside the browsers ─────────────────────────────────────────

function nip98(sk: Uint8Array, url: string, method: string, body: string): string {
  const tags = [['u', url], ['method', method], ['payload', bytesToHex(sha256(new TextEncoder().encode(body)))]]
  const ev = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags, content: '' }, sk)
  return 'Nostr ' + Buffer.from(JSON.stringify(ev)).toString('base64')
}
/** `k` (base64url, 32 bytes) as the secret. Local, so this harness imports no aliased package. */
function secretFromText(k: string): Uint8Array {
  return Uint8Array.from(Buffer.from(k.replace(/-/g, '+').replace(/_/g, '/'), 'base64'))
}

/** The rumor types in every wrap addressed to the link, read with its secret (no `since`). */
async function rumorsFor(k: string): Promise<{ types: string[]; tokens: string[] }> {
  const sk = secretFromText(k)
  const url = `${BASE}/api/v1/nostr/query`
  const body = JSON.stringify({ kinds: [1059], pTags: [getPublicKey(sk)], limit: 50 })
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: nip98(sk, url, 'POST', body) }, body })
  const events = res.ok ? (((await res.json()) as { events?: Parameters<typeof nip17.unwrapEvent>[0][] }).events ?? []) : []
  const types: string[] = []
  const tokens: string[] = []
  for (const ev of events) {
    try {
      const c = JSON.parse(nip17.unwrapEvent(ev, sk).content)
      types.push(String(c.type))
      if (c.type === 'cashu_token_transfer') tokens.push(c.token)
    } catch {
      types.push('unreadable')
    }
  }
  return { types, tokens }
}
async function checkstate(token: string): Promise<string[]> {
  if (!MINT) return []
  const Ys = tokenProofs(token).map((p) => hashToCurve(new TextEncoder().encode(p.secret)).toHex(true))
  const res = await fetch(`${MINT}/v1/checkstate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ Ys }) })
  return (((await res.json()) as { states?: { state: string }[] }).states ?? []).map((s) => s.state)
}

// ── The sender's side ──────────────────────────────────────────────────────────────────────

interface Sent { k: string; x: number; link: string; rowId: string }

/** Send by link through the UI, then read the link off the new `sent` row. */
async function sendByLink(s: Page, amount: string, days = '7 days'): Promise<Sent | null> {
  await s.goto(`${BASE}/send`, { waitUntil: 'load' })
  await s.getByRole('button', { name: /Anyone, by link/ }).click({ timeout: 30_000 })
  await s.waitForFunction(() => /Which voucher\?|How much\?/.test(document.body.innerText), undefined, { timeout: 30_000 })
  if (/Which voucher\?/.test(await text(s))) await s.locator('main button, button').filter({ hasText: /€/ }).first().click()
  await s.locator('input[placeholder="0.00"]').fill(amount)
  await s.getByRole('radio', { name: days }).click()
  await s.getByRole('button', { name: 'Continue' }).click()
  const confirm = await text(s)
  check(`send ${amount}: confirm says "Anyone with the link can claim …"`, /Anyone with the link can claim .*You can take it back until it is claimed/.test(confirm), confirm.slice(0, 300))
  check(`send ${amount}: confirm suggests a direct send (spec 5.4)`, /If you know their handle, send to them directly/.test(confirm))
  await s.getByRole('button', { name: 'Make link' }).click()
  await s.waitForFunction(() => /Link ready|did not complete|could not|refused/i.test(document.body.innerText), undefined, { timeout: 120_000 }).catch(() => {})
  const done = await text(s)
  check(`send ${amount}: "Link ready" with Show QR, and Share or Copy link`, /Link ready/.test(done) && /Show QR/.test(done) && /(Share|Copy) link/.test(done), done.slice(0, 300))
  if (!/Link ready/.test(done)) return null
  const row = await s.evaluate(async () => {
    const dbs = await indexedDB.databases()
    const name = dbs.map((d) => d.name ?? '').find((n) => n.startsWith('imani-wallet-'))
    if (!name) return null
    const db = await new Promise<IDBDatabase>((ok, ko) => {
      const r = indexedDB.open(name)
      r.onsuccess = () => ok(r.result)
      r.onerror = () => ko(r.error)
    })
    type Row = { id: string; timestamp: number; link?: { k: string; x: number } }
    const rows = await new Promise<Row[]>((ok) => {
      const r = db.transaction('wallet_transactions').objectStore('wallet_transactions').getAll()
      r.onsuccess = () => ok(r.result)
    })
    db.close()
    const linked = rows.filter((r) => r.link?.k).sort((a, b) => b.timestamp - a.timestamp)
    return linked[0]?.link ? { k: linked[0].link.k, x: linked[0].link.x, rowId: linked[0].id } : null
  })
  if (!row) return null
  return { ...row, link: `${BASE}/g#v=1&k=${row.k}&x=${row.x}` }
}

/** The sender's own row, as History shows it. */
async function rowStatus(s: Page, rowId: string, want: RegExp, ms = 60_000): Promise<string> {
  let t = ''
  for (const end = Date.now() + ms; Date.now() < end;) {
    await s.goto(`${BASE}/transaction/${encodeURIComponent(rowId)}`, { waitUntil: 'load' })
    await s.waitForTimeout(3_000)
    t = await text(s)
    if (want.test(t)) return t
    await s.waitForTimeout(4_000)
  }
  return t
}

async function openGift(page: Page, link: string): Promise<string> {
  await page.goto('about:blank')
  await page.goto(link, { waitUntil: 'load' })
  await page.waitForFunction(
    () => /Add to my wallet|Voucher unavailable|Voucher waiting|Create an account|Register|Unlock/.test(document.body.innerText),
    undefined, { timeout: 60_000 },
  ).catch(() => {})
  return text(page)
}

async function unlockIfAsked(p: Page) {
  const pass = p.locator('input[placeholder="Passphrase"]')
  // Wait for the screen to decide: a locked session shows Unlock a moment after load.
  if (await pass.waitFor({ timeout: 20_000 }).then(() => true, () => false)) {
    await pass.fill(TEST_PASSPHRASE)
    await p.getByRole('button', { name: /unlock/i }).first().click()
    await p.waitForTimeout(6_000)
  }
}

async function main() {
  const browser = await chromium.launch({ args: (process.env.E2E_CHROMIUM_ARGS ?? '').split(/\s+/).filter(Boolean) })
  const config = (await (await fetch(`${BASE}/api/v1/config`)).json()) as { cashback_origins?: string[] }
  claimHost = config.cashback_origins?.[0] ?? ''
  console.log('claim host (routed to the gate edge):', claimHost, '->', CLAIM_HOST_VIA)

  // ── Setup: A issues 2.00 cashback, S adds it ──
  console.log('\nsetup')
  const a = await (await context(browser, 'A')).newPage()
  await registerMerchant(a, BASE)
  const sCtx = await context(browser, 'S')
  const s = await sCtx.newPage()
  const sPub = await registerCustomer(s, BASE)
  const generated = a.waitForResponse((r) => r.url().endsWith('/api/v1/portal/cashback/generate') && r.request().method() === 'POST', { timeout: 90_000 })
  await a.goto(`${BASE}/sell/cashback`, { waitUntil: 'load' })
  const input = a.locator('input[placeholder="0.00"]')
  for (let i = 0; i < 4; i++) {
    if (await input.waitFor({ timeout: 30_000 }).then(() => true, () => false)) break
    await a.context().clearCookies()
    await a.goto(`${BASE}/`, { waitUntil: 'load' })
    await unlockIfAsked(a)
    await a.goto(`${BASE}/sell/cashback`, { waitUntil: 'load' })
  }
  await input.fill('2.00')
  await a.getByRole('button', { name: 'Create cashback code' }).click()
  const gen = (await (await generated).json()) as { claimUrl: string; claimKey: string }
  const ref = new URL(gen.claimUrl).pathname.split('/').pop()
  await s.goto(`${BASE}/c/${ref}#k=${gen.claimKey}`, { waitUntil: 'load' })
  await s.getByRole('button', { name: 'Add to my wallet' }).click({ timeout: 60_000 })
  await s.waitForFunction(() => /Voucher added|Voucher unavailable/.test(document.body.innerText), undefined, { timeout: 90_000 }).catch(() => {})
  check('setup: S holds 2.00 from A', /Voucher added/.test(await text(s)))

  // ── CL-C ──
  console.log('\nCL-C: gift to someone with no account (journey C)')
  const c = await sendByLink(s, '0.50')
  check('CL-C a link was made', c !== null)
  if (c) {
    // The signature, if any, is sent after the settle and not awaited: give it time to land.
    await new Promise((ok) => setTimeout(ok, 15_000))
    const before = await rumorsFor(c.k)
    check('CL-C the link key holds the coupon', before.types.includes('cashu_token_transfer'), before.types.join(','))
    check('CL-C NO ADR 0014 transfer signature to the link key (Q7, build item 1)', !before.types.includes('imani_transfer_signature'), before.types.join(','))
    const r = await (await context(browser, 'R')).newPage()
    const t1 = await openGift(r, c.link)
    check('CL-C a visitor with no account lands on onboarding', /\/onboarding/.test(r.url()), r.url())
    check('CL-C the fragment is scrubbed', !r.url().includes(c.k), r.url())
    await r.waitForFunction(() => /sent you a voucher from/.test(document.body.innerText), undefined, { timeout: 30_000 }).catch(() => {})
    const banner = await text(r)
    check('CL-C the banner says who sent it and the stall (spec 5.3 step 4)', /sent you a voucher from .*Create an account to add it to your wallet/.test(banner), banner.slice(0, 300) || t1.slice(0, 200))
    check('CL-C nothing spent on the way', (await checkstate(before.tokens[0])).every((x) => x === 'UNSPENT'))
    {
      // Claim-driven registration is customer-only: the merchant switch is not there.
      await r.getByRole('button', { name: /^Register$/ }).first().click()
      await r.locator('input[placeholder="your-handle"]').waitFor({ timeout: 20_000 }).catch(() => {})
      const acct = await text(r)
      check('CL-C the merchant switch is absent', !(await r.getByText('I am a merchant').count()) && acct.includes("You're redeeming a voucher, so this is a customer account."), acct.slice(0, 300))
      // Back to the start step: registerCustomer's goto to this same URL is a reload in Chromium, and a
      // reload keeps history.state (the account step), so its Register button would never show.
      await r.getByRole('button', { name: /^Back$/ }).first().click()
      await r.getByRole('button', { name: /^Register$/ }).first().waitFor({ timeout: 20_000 }).catch(() => {})
    }
    await registerCustomer(r, BASE)
    await r.waitForFunction(() => /Add to my wallet|Voucher unavailable/.test(document.body.innerText), undefined, { timeout: 60_000 }).catch(() => {})
    const prompt = await text(r)
    check('CL-C after registering, the prompt shows the token-verified gift', /✓ verified stall/.test(prompt) && /0\.50/.test(prompt) && /via link/.test(prompt), prompt.slice(0, 300))
    check('CL-C still unspent while the prompt waits', (await checkstate(before.tokens[0])).every((x) => x === 'UNSPENT'))
    await r.getByRole('button', { name: 'Add to my wallet' }).click()
    await r.waitForFunction(() => /Voucher added|Voucher unavailable|Voucher waiting/.test(document.body.innerText), undefined, { timeout: 90_000 }).catch(() => {})
    const added = await text(r)
    check('CL-C "Voucher added"', /Voucher added/.test(added), added.slice(0, 200))
    check('CL-C the gift proofs are now SPENT', (await checkstate(before.tokens[0])).every((x) => x === 'SPENT'))
    const st = await rowStatus(s, c.rowId, /Claimed/)
    check('CL-C S sees Claimed (NUT-07)', /Status Claimed/.test(st), st.slice(0, 300))
    const issuerOfRow = await s.evaluate(async (rowId) => {
      const name = (await indexedDB.databases()).map((d) => d.name ?? '').find((n) => n.startsWith('imani-wallet-'))!
      const db = await new Promise<IDBDatabase>((ok) => {
        const r = indexedDB.open(name)
        r.onsuccess = () => ok(r.result)
      })
      const row = await new Promise<{ merchantId?: string } | undefined>((ok) => {
        const r = db.transaction('wallet_transactions').objectStore('wallet_transactions').get(rowId)
        r.onsuccess = () => ok(r.result)
      })
      db.close()
      return String(row?.merchantId ?? '')
    }, c.rowId)
    await s.goto(`${BASE}/merchants/${issuerOfRow}/transactions`, { waitUntil: 'load' })
    await s.waitForTimeout(3_000)
    const list = await text(s)
    check('CL-C History lists it with the "By link" badge and its status', /By link/.test(list) && /Claimed/.test(list), list.slice(0, 300))
  }

  // ── CL-D ──
  console.log('\nCL-D: gift to someone logged in (journey D)')
  const d = await sendByLink(s, '0.30')
  check('CL-D a link was made', d !== null)
  if (d) {
    const dPage = await (await context(browser, 'D')).newPage()
    await registerCustomer(dPage, BASE)
    const t = await openGift(dPage, d.link)
    check('CL-D a logged-in visitor goes straight to the prompt', /Add to my wallet/.test(t) && /via link/.test(t), t.slice(0, 300))
    check('CL-D the fragment is scrubbed', !dPage.url().includes(d.k), dPage.url())
    const { tokens } = await rumorsFor(d.k)
    check('CL-D opening spent nothing', (await checkstate(tokens[0])).every((x) => x === 'UNSPENT'))
    // Two quick taps: one spend.
    const add = dPage.getByRole('button', { name: 'Add to my wallet' })
    await add.dblclick().catch(() => add.click())
    await dPage.waitForFunction(() => /Voucher added|Voucher unavailable/.test(document.body.innerText), undefined, { timeout: 90_000 }).catch(() => {})
    check('CL-D "Voucher added"', /Voucher added/.test(await text(dPage)), (await text(dPage)).slice(0, 200))
    const st = await rowStatus(s, d.rowId, /Claimed/)
    check('CL-D S sees Claimed', /Status Claimed/.test(st), st.slice(0, 300))
  }

  // ── CL-MERCHANT (owner rule 2026-10-13) ──
  console.log("\nCL-MERCHANT: a merchant account is refused another stall's gift, by the prompt and by the server")
  const gm = await sendByLink(s, '0.05')
  check('CL-MERCHANT a link was made', gm !== null)
  if (gm) {
    const mPage = await (await context(browser, 'M')).newPage()
    await registerMerchant(mPage, BASE)
    const t = await openGift(mPage, gm.link)
    check("CL-MERCHANT the prompt refuses with the rule's copy, no Add",
      /Merchant accounts can only take their own stall's vouchers/.test(t) && !/Add to my wallet/.test(t), t.slice(0, 300))
    const { tokens } = await rumorsFor(gm.k)
    check('CL-MERCHANT the refusal spent nothing', tokens.length > 0 && (await checkstate(tokens[0])).every((x) => x === 'UNSPENT'))
    // Bypass the wallet's own check: receive the token straight through the legacy redeem, which
    // goes to gateway-customer's wallet/receive signed as the merchant. The server must refuse.
    await mPage.goto(`${BASE}/`, { waitUntil: 'load' })
    await mPage.waitForFunction(() => !!(window as unknown as { TokenRedemption?: unknown }).TokenRedemption, undefined, { timeout: 60_000 }).catch(() => {})
    const direct = await mPage.evaluate(async (token) => {
      const r = (window as unknown as { TokenRedemption?: { redeem(t: string, o: unknown): Promise<unknown> } }).TokenRedemption
      if (!r) return 'no TokenRedemption'
      try {
        await r.redeem(token, { source: 'gift_link' })
        return 'received'
      } catch (e) {
        const err = e as { message?: string; code?: string; status?: number }
        return `${err.status ?? ''} ${err.code ?? ''} ${err.message ?? ''}`
      }
    }, tokens[0] ?? '')
    check('CL-MERCHANT the server refuses a direct receive: 403 FOREIGN_VOUCHER_FOR_MERCHANT', /FOREIGN_VOUCHER_FOR_MERCHANT/.test(direct), direct.slice(0, 300))
    check('CL-MERCHANT and the proofs are still UNSPENT', (await checkstate(tokens[0])).every((x) => x === 'UNSPENT'))
    // A customer still takes it.
    const cPage = await (await context(browser, 'MC')).newPage()
    await registerCustomer(cPage, BASE)
    const tc = await openGift(cPage, gm.link)
    check('CL-MERCHANT a customer is offered it', /Add to my wallet/.test(tc), tc.slice(0, 300))
    await cPage.getByRole('button', { name: 'Add to my wallet' }).click()
    await cPage.waitForFunction(() => /Voucher added|Voucher unavailable/.test(document.body.innerText), undefined, { timeout: 90_000 }).catch(() => {})
    check('CL-MERCHANT the customer adds it', /Voucher added/.test(await text(cPage)), (await text(cPage)).slice(0, 200))
    await mPage.context().close()
    await cPage.context().close()
  }

  // ── CL-EXP ──
  console.log('\nCL-EXP: past x is refused, and the sender reclaims')
  const e = await sendByLink(s, '0.20', '1 day')
  check('CL-EXP a link was made', e !== null)
  if (e) {
    const ePage = await (await context(browser, 'E')).newPage()
    await registerCustomer(ePage, BASE)
    const pastX = Math.floor(Date.now() / 1000) - 60
    const t = await openGift(ePage, `${BASE}/g#v=1&k=${e.k}&x=${pastX}`)
    check('CL-EXP a link past x is refused with the expired copy, no Add', /expired on .*send it again/.test(t) && !/Add to my wallet/.test(t), t.slice(0, 300))
    const { tokens } = await rumorsFor(e.k)
    check('CL-EXP nothing spent by the refusal', (await checkstate(tokens[0])).every((x) => x === 'UNSPENT'))
    // The link passes its expiry on S's device: the stored x set back, then a fresh start.
    await s.evaluate(async (rowId) => {
      const dbs = await indexedDB.databases()
      const name = dbs.map((d) => d.name ?? '').find((n) => n.startsWith('imani-wallet-'))!
      const db = await new Promise<IDBDatabase>((ok) => {
        const r = indexedDB.open(name)
        r.onsuccess = () => ok(r.result)
      })
      await new Promise<void>((ok) => {
        const tx = db.transaction('wallet_transactions', 'readwrite')
        const store = tx.objectStore('wallet_transactions')
        const g = store.get(rowId)
        g.onsuccess = () => {
          const row = g.result
          row.link = { ...row.link, x: Math.floor(Date.now() / 1000) - 60 }
          store.put(row)
        }
        tx.oncomplete = () => ok()
      })
      db.close()
    }, e.rowId)
    // Opening History runs the same check as start-up (spec 3.3). In-app navigation, no reload: a
    // reload restores the row from the relay backup, which still holds the real x.
    await s.evaluate((path) => {
      window.history.pushState({}, '', path)
      window.dispatchEvent(new PopStateEvent('popstate'))
    }, `/transaction/${encodeURIComponent(e.rowId)}`)
    await s.waitForFunction(() => /Status Taken back|Status Claimed/.test(document.body.innerText), undefined, { timeout: 90_000 }).catch(() => {})
    const st = await text(s)
    check('CL-EXP S reclaims after x when it opens History: Taken back', /Status Taken back/.test(st), st.slice(0, 300))
    check('CL-EXP the gift proofs are SPENT (by the reclaim)', (await checkstate(tokens[0])).every((x) => x === 'SPENT'))
    const t2 = await openGift(ePage, e.link)
    check('CL-EXP the original link now reads already added', /already added to a wallet/.test(t2) && !/Add to my wallet/.test(t2), t2.slice(0, 300))
  }

  console.log('\nQ4: Take it back before x')
  const f = await sendByLink(s, '0.10')
  if (f) {
    await s.goto(`${BASE}/transaction/${encodeURIComponent(f.rowId)}`, { waitUntil: 'load' })
    await s.getByRole('button', { name: 'Take it back' }).click({ timeout: 30_000 })
    await s.getByRole('button', { name: 'Take it back' }).click({ timeout: 10_000 })
    await s.waitForFunction(() => !/Taking it back/.test(document.body.innerText), undefined, { timeout: 90_000 }).catch(() => {})
    console.log('  INFO  after Take it back:', (await text(s)).slice(0, 700))
    const st = await rowStatus(s, f.rowId, /Taken back/)
    check('Q4 Take it back: Taken back', /Status Taken back/.test(st), `${st.slice(0, 600)} :: ${consoleOf('S', /^(?!.*DmPollService).*(gift|tokenRedemption|receive|error|refus)/i)}`)
    const fPage = await (await context(browser, 'F')).newPage()
    await registerCustomer(fPage, BASE)
    const t = await openGift(fPage, f.link)
    check('Q4 the taken-back link reads already added (spec 5.3)', /already added to a wallet/.test(t), t.slice(0, 300))
  }

  await s.goto(`${BASE}/`, { waitUntil: 'load' })
  await s.waitForTimeout(4_000)
  const home = await text(s)
  check('S holds 1.15 after three claims (one the CL-MERCHANT gift) and two take-backs', /1\.15/.test(home), home.slice(0, 300))

  // ── Fragment hygiene across every context (spec 2.4) ──
  const secrets = [c, d, gm, e, f].filter(Boolean).map((x) => x!.k)
  const leaks = seen.filter((r) => secrets.some((k) => r.url.includes(k) || r.referer.includes(k)))
  check('no request URL or Referer, from any browser, ever carried a link secret', leaks.length === 0, JSON.stringify(leaks.slice(0, 3)))
  check('no uncaught page errors', errors.length === 0, errors.slice(0, 3).join(' | '))

  await browser.close()
  console.log(`\n${failures.length === 0 ? 'ALL PASS' : `${failures.length} FAILED: ${failures.join('; ')}`}`)
  console.log(`sender ${sPub}`)
  process.exit(failures.length ? 1 : 0)
}
main().catch((e) => {
  console.error(e)
  process.exit(2)
})
