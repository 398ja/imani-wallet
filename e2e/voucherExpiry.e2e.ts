/**
 * #265 gate e2e: a customer is told a coupon is about to expire, and every screen says so.
 *
 * Grown from the investigation probe (`.wt/expiry-shots/probe-expiry-cue.mts`).
 *
 *  1. Merchant A registers, sets the stall's validity to Custom 7 days (E2E_VALIDITY_DAYS), and
 *     issues a €2.50 cashback.
 *  2. Customer C claims it by link: one coupon expiring in ~7 days (the signed expiry).
 *  3. The BROWSER clock is moved (Playwright `clock`), with SPA navigation only: a reload under a
 *     skewed clock fails the NAP handshake with 401, which the probe found. Three steps:
 *     6 days left (amber badge, the 7-day bell entry, the banner), 12 hours left (red badge, a
 *     second bell entry, the banner back, no duplicate after a real reload), and past expiry.
 *     E2E_VALIDITY_DAYS=1 reproduces the probe's 1-day coupon and skips the 6-day step.
 *  4. Asserts: badges (text, tone, aria-label) on the list, deck and merchant page; one bell
 *     entry per threshold with no duplicate after a reload; the banner and its dismissal; the
 *     Expired group; the fixed detail page (no "active", no QR, "Expired on …").
 *
 *   E2E_BASE=http://localhost:<edge> E2E_BUNDLE_DIR=<dist> E2E_CLAIM_HOST_VIA=http://localhost:<edge> \
 *   E2E_SHOTS=<dir> npx tsx e2e/voucherExpiry.e2e.ts
 *
 * Exits non-zero on the first failed check, after writing the screenshot it was looking at.
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { readFile, mkdir } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { registerCustomer, registerMerchant, TEST_PASSPHRASE } from './register.mts'
import { bypassCaptcha } from './captchaBypass.mts'

const BASE = (process.env.E2E_BASE ?? '').replace(/\/+$/, '')
const BUNDLE_DIR = process.env.E2E_BUNDLE_DIR
const CLAIM_HOST_VIA = process.env.E2E_CLAIM_HOST_VIA ?? ''
const SHOTS = process.env.E2E_SHOTS ?? 'e2e-artifacts/voucher-expiry'
const VALIDITY_DAYS = Number(process.env.E2E_VALIDITY_DAYS ?? 7)
if (!BASE || !CLAIM_HOST_VIA) throw new Error('E2E_BASE and E2E_CLAIM_HOST_VIA are required')

const HOUR = 3_600_000
const DAY = 24 * HOUR
const CT: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' }
let claimHost = ''
let passed = 0
const errors: string[] = []

function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passed += 1
    console.log(`  ok   ${name}`)
  } else {
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` :: ${JSON.stringify(detail).slice(0, 600)}`}`)
    errors.push(name)
  }
}
const text = async (p: Page) => (await p.locator('body').innerText()).replace(/\s+/g, ' ')

function viaEdge(path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  const via = new URL(CLAIM_HOST_VIA)
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: via.hostname, port: via.port || 80, path, method: 'GET', headers: { ...headers, host: claimHost } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const o: Record<string, string> = {}
        for (const [k, v] of Object.entries(res.headers)) if (typeof v === 'string') o[k] = v
        resolve({ status: res.statusCode ?? 0, headers: o, body: Buffer.concat(chunks) })
      })
    })
    req.on('error', reject)
    req.end()
  })
}

async function context(browser: Browser): Promise<BrowserContext> {
  const ctx = await browser.newContext({ locale: 'en-GB', timezoneId: 'Europe/London', viewport: { width: 420, height: 900 },
    serviceWorkers: BUNDLE_DIR ? 'block' : 'allow', ignoreHTTPSErrors: true })
  await bypassCaptcha(ctx)
  if (BUNDLE_DIR) {
    const root = normalize(BUNDLE_DIR)
    const shell = join(root, 'index.html')
    await ctx.route(`${BASE}/**`, async (route) => {
      const path = new URL(route.request().url()).pathname
      if (path.startsWith('/api/') || path.startsWith('/.well-known/') || path.startsWith('/fcaptcha/')) return route.fallback()
      const candidate = normalize(join(root, path))
      const file = candidate.startsWith(root) && extname(candidate) ? await readFile(candidate).then(() => candidate, () => shell) : shell
      return route.fulfill({ status: 200, body: await readFile(file), contentType: CT[extname(file)] ?? 'application/octet-stream' })
    })
  }
  if (claimHost) {
    await ctx.route(`https://${claimHost}/**`, async (route) => {
      const req = route.request(); const u = new URL(req.url()); const origin = req.headers()['origin']
      const res = await viaEdge(u.pathname + u.search, origin ? { origin } : {})
      return route.fulfill({ status: res.status, headers: res.headers, body: res.body })
    })
  }
  return ctx
}

async function unlockIfLocked(page: Page): Promise<void> {
  const lock = page.locator('input[placeholder="Passphrase"]')
  await lock.waitFor({ timeout: 8_000 }).catch(() => {})
  if (!(await lock.isVisible().catch(() => false))) return
  await lock.fill(TEST_PASSPHRASE)
  await page.getByRole('button', { name: /unlock/i }).first().click()
  await page.waitForTimeout(5000)
}

let SPA_NAV = false
async function go(page: Page, path: string): Promise<void> {
  if (SPA_NAV) {
    await page.evaluate((p) => { history.pushState({}, '', p); dispatchEvent(new PopStateEvent('popstate')) }, path)
    await page.waitForTimeout(2500)
    return
  }
  await page.goto(`${BASE}${path}`, { waitUntil: 'load' })
  await unlockIfLocked(page)
  if (!page.url().endsWith(path)) { await page.goto(`${BASE}${path}`, { waitUntil: 'load' }); await unlockIfLocked(page) }
  await page.waitForTimeout(3000)
}

async function setValidityDays(a: Page, days: number): Promise<void> {
  await go(a, '/settings/merchant')
  await a.getByRole('button', { name: /^Custom$/ }).first().click({ timeout: 30_000 })
  await a.locator('input[placeholder^="Days ("]').fill(String(days))
  await a.getByRole('button', { name: /^Save$/ }).click()
  await a.waitForTimeout(5000)
}

async function issueCashback(a: Page, amount: string): Promise<string | null> {
  const generated = a.waitForResponse((r) => r.url().endsWith('/api/v1/portal/cashback/generate') && r.request().method() === 'POST', { timeout: 90_000 })
  await go(a, '/sell/cashback')
  const input = a.locator('input[placeholder="0.00"]')
  for (let i = 0; i < 4 && !(await input.waitFor({ timeout: 30_000 }).then(() => true, () => false)); i++) {
    await a.context().clearCookies(); await go(a, '/'); await go(a, '/sell/cashback')
  }
  await input.fill(amount)
  await a.getByRole('button', { name: 'Create cashback code' }).click()
  const res = await generated.catch(() => null)
  if (!res || !res.ok()) return null
  const body = (await res.json()) as { claimUrl?: string; claimKey?: string }
  const ref = new URL(body.claimUrl!).pathname.split('/').pop()
  return `${BASE}/c/${ref}#k=${body.claimKey}`
}

const READ_VOUCHERS = `(async () => {
  for (const info of await indexedDB.databases()) {
    if (!info.name) continue
    const db = await new Promise((ok, ko) => { const r = indexedDB.open(info.name); r.onsuccess = () => ok(r.result); r.onerror = () => ko(r.error) })
    if (!Array.from(db.objectStoreNames).includes('wallet_vouchers')) { db.close(); continue }
    const rows = await new Promise((ok, ko) => { const r = db.transaction('wallet_vouchers').objectStore('wallet_vouchers').getAll(); r.onsuccess = () => ok(r.result); r.onerror = () => ko(r.error) })
    db.close()
    return rows.map((r) => ({ token_id: r.token_id, issuer_id: r.issuer_id, status: r.status, expires_at: r.expires_at }))
  }
  return []
})()`

/** The bell's stored entries for every account on this device. */
async function bellEntries(c: Page): Promise<Array<{ id: string; title: string; body: string; url: string }>> {
  return c.evaluate(() =>
    Object.keys(localStorage)
      .filter((k) => k.startsWith('imani-wallet:notifications:'))
      .flatMap((k) => JSON.parse(localStorage.getItem(k) ?? '[]')),
  )
}
const expiringEntries = async (c: Page) => (await bellEntries(c)).filter((e) => e.id.startsWith('coupon-expiring:'))

async function badge(c: Page): Promise<{ label: string | null; tone: string | null; text: string | null } | null> {
  const el = c.locator('[data-expiry-tone][role="img"]').first()
  if (!(await el.count())) return null
  return { label: await el.getAttribute('aria-label'), tone: await el.getAttribute('data-expiry-tone'), text: await el.innerText() }
}

async function shoot(c: Page, name: string): Promise<void> {
  await c.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true })
}

async function main() {
  await mkdir(SHOTS, { recursive: true })
  const browser = await chromium.launch({ args: (process.env.E2E_CHROMIUM_ARGS ?? '').split(/\s+/).filter(Boolean) })
  const config = (await (await fetch(`${BASE}/api/v1/config`)).json()) as { cashback_origins?: string[] }
  claimHost = config.cashback_origins?.[0] ?? ''

  console.log(`\n== merchant issues a ${VALIDITY_DAYS}-day cashback`)
  const actx = await context(browser); const a = await actx.newPage()
  await registerMerchant(a, BASE)
  await setValidityDays(a, VALIDITY_DAYS)
  await a.waitForTimeout(62_000) // the session's permission cache, as probe-spend-order waits
  await actx.clearCookies(); await go(a, '/')
  const link = await issueCashback(a, '2.50')
  check('cashback issued', link !== null)
  if (!link) throw new Error('issue failed')

  console.log('\n== customer claims it')
  const cctx = await context(browser); const c = await cctx.newPage()
  const pageErrors: string[] = []
  c.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 200)))
  const customerHandle = await registerCustomer(c, BASE)
  await c.goto('about:blank'); await c.goto(link, { waitUntil: 'load' })
  await unlockIfLocked(c)
  await c.waitForFunction(() => /Add to my wallet|Voucher unavailable/.test(document.body.innerText), undefined, { timeout: 60_000 }).catch(() => {})
  await c.getByRole('button', { name: 'Add to my wallet' }).click()
  await c.waitForFunction(() => /Voucher added|Voucher unavailable/.test(document.body.innerText), undefined, { timeout: 90_000 }).catch(() => {})
  await c.waitForTimeout(3000)
  const rows = (await c.evaluate(READ_VOUCHERS)) as Array<Record<string, unknown>>
  const row = rows[0]
  check('the customer holds the coupon', !!row, rows)
  if (!row) throw new Error('no voucher')
  const issuer = String(row.issuer_id); const tokenId = String(row.token_id)
  const exp = Number(row.expires_at); const expMs = exp < 1e12 ? exp * 1000 : exp
  console.log(`  coupon ${tokenId.slice(0, 12)}… expires ${new Date(expMs).toISOString()} (customer ${customerHandle})`)

  // Freeze-able browser clock from here. One reload to install it, then SPA navigation only.
  await cctx.clock.install({ time: new Date() })
  await c.reload({ waitUntil: 'load' }); await unlockIfLocked(c); await c.waitForTimeout(3000)
  SPA_NAV = true
  const at = async (msBefore: number) => {
    await cctx.clock.setSystemTime(new Date(expMs - msBefore))
    // Home is re-entered, not re-pushed: pushState to the route already shown does not remount it,
    // and the fake clock fires no interval. Leaving and coming back is what a customer's "open" is.
    await go(c, '/settings')
    await go(c, '/')
  }

  if (VALIDITY_DAYS >= 7) {
    console.log('\n== 6 days left: amber badge, the 7-day bell entry, the banner')
    await at(6 * DAY - HOUR)
    await shoot(c, '1-6d-home')
    const homeText = await text(c)
    check('banner: "1 voucher expires this week"', homeText.includes('1 voucher expires this week'), homeText.slice(0, 300))
    const deck = await badge(c)
    check('deck badge is amber, with text and a dated label', deck?.tone === 'soon' && /^Expires in 5 days$/.test(deck.text ?? '') && /^Expires in 5 days, on /.test(deck.label ?? ''), deck)
    const e7 = await expiringEntries(c)
    check('one 7-day bell entry, linking to the coupon', e7.length === 1 && e7[0]!.id.endsWith(':7d') && e7[0]!.url === `/coupon/${encodeURIComponent(tokenId)}`, e7)
    // Filed at the FIRST open inside the window (the real-time reload, ~6 d 23 h left), so it says
    // the days left at that moment.
    check('entry body names the value and stall', /^Your €2\.50 voucher from Test Stall expires in [56] days\.$/.test(e7[0]?.body ?? ''), e7[0]?.body)
    await go(c, `/merchants/${issuer}`)
    await shoot(c, '2-6d-merchant-page')
    check('merchant page badge', (await badge(c))?.tone === 'soon')
    await go(c, `/merchants/${issuer}/coupons`)
    await shoot(c, '3-6d-coupon-list')
    check('list badge', (await badge(c))?.tone === 'soon')
    await go(c, `/coupon/${encodeURIComponent(tokenId)}`)
    await shoot(c, '4-6d-coupon-detail')
    const detail = await text(c)
    check('detail: countdown and "Use it before"', /· in 5 days/.test(detail) && /Use it before /.test(detail), detail.slice(0, 600))
    // The bell, opened.
    await go(c, '/')
    const bell = c.locator('summary[aria-label^="Notifications"]').first()
    check('bell shows an unread entry', /unread/.test((await bell.getAttribute('aria-label')) ?? ''))
    await bell.click(); await c.waitForTimeout(800)
    await shoot(c, '5-6d-bell')
    await c.keyboard.press('Escape')
    // Dismiss the banner: gone until the next threshold.
    await c.getByRole('button', { name: 'Dismiss' }).click()
    await c.waitForTimeout(500)
    check('banner dismissed', !(await text(c)).includes('expires this week'))
  }

  console.log('\n== 12 hours left: red badge, a second bell entry, no duplicate on reload')
  await at(12 * HOUR)
  await shoot(c, '6-12h-home')
  const home12 = await text(c)
  check('banner back for the new threshold', home12.includes('1 voucher expires this week'), home12.slice(0, 300))
  const deck12 = await badge(c)
  // The fake clock runs on during navigation, and labels floor: 12 h at the jump reads 11 h a few
  // seconds later, which is the rounding rule working, not drift.
  check('deck badge is red: "Expires in 11/12 hours"', deck12?.tone === 'urgent' && /^Expires in 1[12] hours$/.test(deck12.text ?? ''), deck12)
  const e12 = await expiringEntries(c)
  const want = VALIDITY_DAYS >= 7 ? ['1d', '7d'] : ['1d']
  check(`bell has exactly ${want.join(' + ')} entries`, JSON.stringify(e12.map((e) => e.id.split(':').pop()).sort()) === JSON.stringify(want.sort()), e12.map((e) => e.id))
  check('1-day entry body', /^Your €2\.50 voucher from Test Stall expires in 1[12] hours\.$/.test(e12.find((e) => e.id.endsWith(':1d'))?.body ?? ''), e12)
  await go(c, `/merchants/${issuer}/coupons`)
  await shoot(c, '7-12h-coupon-list')
  check('list badge is red', (await badge(c))?.tone === 'urgent')
  await go(c, `/coupon/${encodeURIComponent(tokenId)}`)
  await shoot(c, '8-12h-coupon-detail')
  check('detail: red "Use it before"', (await c.locator('[role="status"][data-expiry-tone="urgent"]').count()) === 1)

  // A real reload: the bell must not grow. The skewed clock would 401 NAP, so the clock goes back
  // to real time for the reload (still inside the 1-day window only if the coupon is), and the
  // check is that nothing NEW was filed for thresholds already filed.
  const before = (await expiringEntries(c)).length
  await cctx.clock.setSystemTime(new Date())
  SPA_NAV = false
  await go(c, '/')
  SPA_NAV = true
  await at(12 * HOUR - 30 * 60_000)
  const after = (await expiringEntries(c)).length
  check('no duplicate entry after a reload and a second pass', after === before, { before, after })

  console.log('\n== after expiry: the Expired group, the balance note and the fixed detail page')
  await at(-HOUR)
  await shoot(c, '9-expired-home')
  const homeX = await text(c)
  check('balance note: "1 expired voucher is not counted."', homeX.includes('1 expired voucher is not counted.'), homeX.slice(0, 300))
  check('no banner once expired', !homeX.includes('expires this week'))
  await go(c, `/merchants/${issuer}/coupons`)
  const listX = await text(c)
  check('list: "No vouchers you can still use." and "Expired (1)"', listX.includes('No vouchers you can still use.') && listX.includes('Expired (1)'), listX.slice(0, 400))
  await c.getByText('Expired (1)').click(); await c.waitForTimeout(500)
  await shoot(c, '10-expired-coupon-list')
  check('the expired row says when', /Expired \d/.test(await text(c)))
  await go(c, `/coupon/${encodeURIComponent(tokenId)}`)
  await c.waitForTimeout(1000)
  await shoot(c, '11-expired-coupon-detail')
  const detailX = await text(c)
  check('detail: no "active"', !/\bStatus active\b/.test(detailX) && !/Status\s*active/.test(detailX), detailX.slice(0, 600))
  check('detail: "Expired on …" and why', /Expired on /.test(detailX) && /This voucher expired on .+\. It can no longer be spent\./.test(detailX))
  check('detail: no redemption QR', (await c.locator('img[alt^="Redemption code"]').count()) === 0)
  check('no page errors', pageErrors.length === 0, pageErrors)

  await browser.close()
  console.log(`\n${passed} passed, ${errors.length} failed`)
  if (errors.length) {
    console.log(errors.map((e) => `  - ${e}`).join('\n'))
    process.exit(1)
  }
}

main().catch((e) => { console.error('E2E ERROR', e); process.exit(1) })
