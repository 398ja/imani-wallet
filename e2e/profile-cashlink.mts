/**
 * Profile Cashlink creation on staging (#540). Not a test: a measurement.
 *
 *   E2E_BASE=https://wallet.staging.398ja.xyz PROFILE_LINKS=6 npx tsx e2e/profile-cashlink.mts
 *
 * A merchant sells the customer PROFILE_SALES coupons, then the customer makes PROFILE_LINKS
 * Cashlinks in a row. For each one it records, from the browser:
 * - every request (start, duration, status, path) during the creation;
 * - the phase times: open Send-by-link to the amount screen, Continue to confirm, Make Cashlink to
 *   "Cashlink ready", and "ready" to the link row being armed.
 * The JSON goes to $PROFILE_OUT (default /tmp/cashlink-profile.json).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { chromium, type BrowserContext, type Page } from 'playwright'
import { registerCustomer, registerMerchant } from './register.mts'

const BASE = (process.env.E2E_BASE ?? 'https://wallet.staging.398ja.xyz').replace(/\/+$/, '')
const LINKS = Number(process.env.PROFILE_LINKS ?? 4)
const SALES = Number(process.env.PROFILE_SALES ?? 3)
/** The Cashlink amount. 0.50 of a 3.00 coupon needs a bearer split; 3.00 sends a whole coupon (#543). */
const AMOUNT = process.env.PROFILE_AMOUNT ?? '0.50'
const OUT = process.env.PROFILE_OUT ?? '/tmp/cashlink-profile.json'
/**
 * A local `vite build` to profile instead of the deployed bundle. Its static files are served on the
 * staging origin (so NIP-98 URLs and the API are staging's); `/api`, `/v1` and every other host go
 * to staging as usual. For a branch not yet deployed.
 */
const BUNDLE_DIR = process.env.PROFILE_BUNDLE_DIR
const TYPES: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2' }

async function serveBundle(context: BrowserContext): Promise<void> {
  if (!BUNDLE_DIR) return
  await context.route(`${BASE}/**`, (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.startsWith('/api/') || path.startsWith('/v1/') || path.startsWith('/download/')) return route.continue()
    const file = join(BUNDLE_DIR, path)
    const hit = path !== '/' && existsSync(file) ? file : join(BUNDLE_DIR, 'index.html')
    return route.fulfill({ status: 200, body: readFileSync(hit), headers: { 'content-type': TYPES[extname(hit)] ?? 'application/octet-stream' } })
  })
}

type Req = { t: number; ms: number; status: number; method: string; path: string; bytes: number; filter?: string; signer?: string }

/** The NIP-98 signer of a request, first 8 hex. */
function signerOf(auth: string | undefined): string | undefined {
  if (!auth?.startsWith('Nostr ')) return undefined
  try {
    return (JSON.parse(Buffer.from(auth.slice(6), 'base64').toString()) as { pubkey: string }).pubkey.slice(0, 8)
  } catch {
    return undefined
  }
}

const text = (p: Page) => p.evaluate(() => document.body.innerText)

async function sell(m: Page, to: string, amount: string): Promise<void> {
  await m.goto(`${BASE}/sell`, { waitUntil: 'load' })
  await m.locator('input[placeholder="name"]').fill(to, { timeout: 30_000 })
  await m.getByRole('button', { name: /^Continue$/ }).click()
  await m.locator('input[placeholder="0.00"]').fill(amount, { timeout: 30_000 })
  await m.getByRole('button', { name: /Send voucher/i }).click()
  await m.waitForFunction(() => /It is in their wallet now|failed|error/i.test(document.body.innerText), undefined, { timeout: 180_000 })
}

async function linkArm(p: Page): Promise<{ count: number; arm?: string }> {
  return p.evaluate(async () => {
    const dbs = await indexedDB.databases()
    const name = dbs.map((d) => d.name ?? '').find((n) => n.startsWith('imani-wallet-'))
    if (!name) return { count: 0 }
    const db = await new Promise<IDBDatabase>((ok, ko) => {
      const r = indexedDB.open(name)
      r.onsuccess = () => ok(r.result)
      r.onerror = () => ko(r.error)
    })
    const stores = [...db.objectStoreNames]
    const store = stores.find((s) => /transaction/i.test(s)) ?? stores[0]
    const rows = await new Promise<Array<Record<string, unknown>>>((ok, ko) => {
      const r = db.transaction(store, 'readonly').objectStore(store).getAll()
      r.onsuccess = () => ok(r.result as Array<Record<string, unknown>>)
      r.onerror = () => ko(r.error)
    })
    const links = rows.filter((r) => r.type === 'sent' && r.link && typeof r.link === 'object')
    links.sort((a, b) => Number(a.timestamp ?? 0) - Number(b.timestamp ?? 0))
    const last = links.at(-1)?.link as { arm?: { s?: string } } | undefined
    return { count: new Set(links.map((l) => (l.link as { k: string }).k)).size, arm: last?.arm?.s }
  })
}

async function main(): Promise<void> {
  const browser = await chromium.launch()
  const mc = await browser.newContext({ serviceWorkers: 'block' })
  const cc = await browser.newContext({ serviceWorkers: 'block' })
  await serveBundle(mc)
  await serveBundle(cc)
  const m = await mc.newPage()
  const c = await cc.newPage()
  await registerMerchant(m, BASE)
  const to = await registerCustomer(c, BASE)
  console.log('customer', to)
  for (let i = 0; i < SALES; i++) {
    await sell(m, to, '3.00').catch(async (e) => {
      console.log(`sale ${i} did not finish: ${(await text(m)).slice(0, 300).replace(/\s+/g, ' ')}`)
      throw e
    })
    console.log(`sale ${i} done`)
  }
  await c.goto(`${BASE}/`, { waitUntil: 'load' })
  await c.waitForTimeout(15_000)

  let reqs: Req[] = []
  const started = new Map<object, number>()
  c.on('request', (r) => started.set(r, Date.now()))
  c.on('requestfinished', async (r) => {
    const s = started.get(r)
    if (s === undefined) return
    const u = new URL(r.url())
    if (!u.pathname.startsWith('/api') && !u.pathname.startsWith('/v1')) return
    const resp = await r.response()
    const sizes = await r.sizes().catch(() => ({ responseBodySize: 0 }))
    const body = r.postData() ?? ''
    const filter = u.pathname.endsWith('/nostr/query') ? body.replace(/[0-9a-f]{64}/g, (h) => h.slice(0, 8)).slice(0, 200) : undefined
    reqs.push({ t: s, ms: Date.now() - s, status: resp?.status() ?? 0, method: r.method(), path: u.pathname, bytes: sizes.responseBodySize, filter, signer: signerOf(r.headers()['authorization']) })
  })

  const runs = []
  for (let n = 0; n < LINKS; n++) {
    reqs = []
    const t0 = Date.now()
    await c.goto(`${BASE}/send`, { waitUntil: 'load' })
    await c.getByRole('button', { name: /Anyone, as a Cashlink/ }).click({ timeout: 60_000 })
    await c.waitForFunction(() => /Which voucher\?|How much\?/.test(document.body.innerText), undefined, { timeout: 120_000 })
    const tAmount = Date.now()
    if (/Which voucher\?/.test(await text(c))) await c.locator('main button, button').filter({ hasText: /€/ }).first().click()
    await c.locator('input[placeholder="0.00"]').fill(AMOUNT)
    await c.getByRole('button', { name: 'Continue' }).click()
    await c.getByRole('button', { name: 'Make Cashlink' }).waitFor({ timeout: 60_000 })
    const tConfirm = Date.now()
    await c.getByRole('button', { name: 'Make Cashlink' }).click()
    await c.waitForFunction(() => /Cashlink ready|failed|could not|refused/i.test(document.body.innerText), undefined, { timeout: 300_000 })
    const tReady = Date.now()
    let arm = await linkArm(c)
    for (let end = Date.now() + 120_000; (arm.arm === undefined || arm.arm === 'arming') && Date.now() < end; arm = await linkArm(c)) {
      await c.waitForTimeout(500)
    }
    const tArmed = Date.now()
    const inWindow = (a: number, b: number) => reqs.filter((r) => r.t >= a && r.t < b).map((r) => ({ ...r, t: r.t - t0 }))
    const run = {
      n,
      linksBefore: arm.count - 1,
      arm: arm.arm,
      ok: /Cashlink ready/.test(await text(c)),
      openToAmountMs: tAmount - t0,
      continueToConfirmMs: tConfirm - tAmount,
      makeToReadyMs: tReady - tConfirm,
      readyToArmedMs: tArmed - tReady,
      totalMs: tArmed - t0,
      requests: { open: inWindow(t0, tAmount), make: inWindow(tConfirm, tReady), arm: inWindow(tReady, tArmed) },
    }
    runs.push(run)
    console.log(JSON.stringify({ n, linksBefore: run.linksBefore, ok: run.ok, arm: run.arm, openToAmountMs: run.openToAmountMs, makeToReadyMs: run.makeToReadyMs, readyToArmedMs: run.readyToArmedMs, totalMs: run.totalMs, reqOpen: run.requests.open.length, reqMake: run.requests.make.length, reqArm: run.requests.arm.length }))
  }
  writeFileSync(OUT, JSON.stringify(runs, null, 1))
  await browser.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
