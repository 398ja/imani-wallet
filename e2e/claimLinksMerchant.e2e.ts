/**
 * Claim links phase 2: the merchant's link and QR (docs/spec-claim-links.md, sections 4.1, 5.1 and
 * 7: CL-A, CL-RACE, CL-OWN), real browsers against a full stack: the local gate (imani-deploy
 * scripts/local-terminal-gate, E2E_SCRIPT=claimLinksMerchant.e2e.ts) or staging.
 *
 * Unlike claimLinks.e2e.ts, the link is taken from the MERCHANT'S SCREEN (its Share link button),
 * never from the generate response: that is the feature under test.
 *
 *   CL-A     A issues cashback; the screen shows the code, Show QR (a QR) and Share link. C, logged
 *            in, opens the shared link: prompt, Add, "Voucher added", C's balance goes up, and A's
 *            open screen flips to "Claimed just now" on its own.
 *   CL-RACE  Two logged-in customers tap Add within 50 ms: exactly one "Voucher added", one
 *            "already added"; the claim service holds one `claimed` row; the portal reads Claimed.
 *   CL-OWN   A opens its own link: refused, nothing spent, and gateway-customer recorded no
 *            redemption declaration for that voucher.
 *   QR-AGAIN After a reload, the record page's Show QR again rebuilds the identical link from the
 *            code (nothing stored on the device), and Cancel cashback revokes it.
 *
 * Pacing: the portal's public metadata and by-code share one per-address limiter (10 a minute,
 * then 429 for 300 s), and every browser here shares the harness's address. Each step that reads
 * it books its reads with `budget()` first. Status checks go to the databases, never to it.
 *
 *   E2E_BASE=http://localhost:<edge> E2E_BUNDLE_DIR=<dist> npx tsx e2e/claimLinksMerchant.e2e.ts
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { execSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { registerCustomer, registerMerchant, TEST_PASSPHRASE } from './register.mts'

const BASE = (process.env.E2E_BASE ?? 'http://localhost:5177').replace(/\/+$/, '')
const BUNDLE_DIR = process.env.E2E_BUNDLE_DIR
const IGNORE_HTTPS_ERRORS = process.env.E2E_IGNORE_HTTPS_ERRORS === '1'
/** Where the claim host is really served on a local stack (see claimLinks.e2e.ts). */
const CLAIM_HOST_VIA = process.env.E2E_CLAIM_HOST_VIA ?? ''
/** psql against the gate's gateway database, `-d imani_portal`; the other databases are derived. */
const PORTAL_SQL = process.env.E2E_PORTAL_SQL_CMD ?? ''

const failures: string[] = []
const errors: string[] = []
function check(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(name)
}
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms))
async function text(page: Page): Promise<string> {
  return (await page.locator('body').innerText()).replace(/\s+/g, ' ')
}

// ─── Pacing the public limiter ──────────────────────────────────────────────

const LIMIT_WINDOW_MS = 60_000
/** Below the portal's 10 a minute, with room for a retry. */
const LIMIT_BUDGET = 7
const limiterReads: number[] = []
/** Wait until `n` more public reads fit the window, then book them. */
async function budget(n: number, why: string) {
  for (;;) {
    const now = Date.now()
    while (limiterReads.length && now - limiterReads[0] > LIMIT_WINDOW_MS) limiterReads.shift()
    if (limiterReads.length + n <= LIMIT_BUDGET) break
    const wait = LIMIT_WINDOW_MS - (now - limiterReads[0]) + 1_000
    console.log(`  (pacing ${Math.ceil(wait / 1000)} s for the public limiter before ${why})`)
    await sleep(wait)
  }
  for (let i = 0; i < n; i++) limiterReads.push(Date.now())
}

// ─── Browsers ───────────────────────────────────────────────────────────────

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
}
let claimHost = ''

async function context(browser: Browser, name: string): Promise<BrowserContext> {
  const ctx = await browser.newContext({ locale: 'en-GB', serviceWorkers: BUNDLE_DIR ? 'block' : 'allow', ignoreHTTPSErrors: IGNORE_HTTPS_ERRORS })
  // The system share sheet, recorded: Share link hands the link here, and the harness reads it back.
  // A string, not a function: tsx would wrap a function in its `__name` helper, absent in the page.
  await ctx.addInitScript(
    `window.__shared = []; Object.defineProperty(navigator, 'share', { configurable: true, value: async (d) => { window.__shared.push(String((d && d.url) || '')) } })`,
  )
  if (BUNDLE_DIR) {
    const root = normalize(BUNDLE_DIR)
    const shell = join(root, 'index.html')
    await ctx.route(`${BASE}/**`, async (route) => {
      const path = new URL(route.request().url()).pathname
      if (path.startsWith('/api/') || path.startsWith('/.well-known/')) return route.continue()
      const candidate = normalize(join(root, path))
      const file = candidate.startsWith(root) && extname(candidate)
        ? await readFile(candidate).then(() => candidate, () => shell)
        : shell
      return route.fulfill({ status: 200, body: await readFile(file), contentType: CONTENT_TYPES[extname(file)] ?? 'application/octet-stream' })
    })
  }
  if (CLAIM_HOST_VIA && claimHost) {
    await ctx.route(`https://${claimHost}/**`, async (route) => {
      const req = route.request()
      const u = new URL(req.url())
      const origin = req.headers()['origin']
      const res = await viaEdge(u.pathname + u.search, origin ? { origin } : {})
      return route.fulfill({ status: res.status, headers: res.headers, body: res.body })
    })
  }
  ctx.on('page', (p) => p.on('pageerror', (e) => errors.push(`${name}: ${e.message}`)))
  return ctx
}

function viaEdge(path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  const via = new URL(CLAIM_HOST_VIA)
  return new Promise((resolve, reject) => {
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

// ─── The databases (the gate passes psql) ──────────────────────────────────

const SAFE = /^[A-Za-z0-9_-]{8,64}$/
function sql(db: 'imani_portal' | 'imani_cashback_claim' | 'imani_customer', q: string): string {
  if (!PORTAL_SQL) return 'no_sql'
  const cmd = PORTAL_SQL.replace('-d imani_portal', `-d ${db}`)
  try {
    return execSync(`${cmd} ${JSON.stringify(q)}`, { encoding: 'utf8' }).trim()
  } catch (e) {
    return `sql_error ${(e as Error).message.slice(0, 80)}`
  }
}
const portalStatus = (ref: string) => (SAFE.test(ref) ? sql('imani_portal', `select status from cashback_record where safebox_claim_ref='${ref}'`) || 'none' : 'bad_ref')
async function waitStatus(ref: string, want: string, ms = 30_000): Promise<string> {
  let last = ''
  for (const end = Date.now() + ms; Date.now() < end; await sleep(1_000)) {
    last = portalStatus(ref)
    if (last === want) return last
  }
  return last
}

// ─── Steps ──────────────────────────────────────────────────────────────────

interface Issued { ref: string; key: string; link: string; code: string; cashbackId: string }

/** A issues on /sell/cashback and takes the link from its own screen's Share link button. */
async function issueFromScreen(owner: Page, amount: string): Promise<Issued | null> {
  const generated = owner.waitForResponse((r) => r.url().endsWith('/api/v1/portal/cashback/generate') && r.request().method() === 'POST', { timeout: 90_000 })
  await owner.goto(`${BASE}/sell/cashback`, { waitUntil: 'load' })
  const input = owner.locator('input[placeholder="0.00"]')
  for (let attempt = 0; attempt < 4; attempt++) {
    if (await input.waitFor({ timeout: 30_000 }).then(() => true, () => false)) break
    await owner.context().clearCookies()
    await owner.goto(`${BASE}/`, { waitUntil: 'load' })
    const pass = owner.locator('input[placeholder="Passphrase"]')
    if (await pass.waitFor({ timeout: 30_000 }).then(() => true, () => false)) {
      await pass.fill(TEST_PASSPHRASE)
      await owner.getByRole('button', { name: /unlock/i }).first().click()
      await owner.waitForTimeout(6_000)
    }
    await owner.goto(`${BASE}/sell/cashback`, { waitUntil: 'load' })
  }
  await input.fill(amount)
  await owner.getByRole('button', { name: 'Create cashback code' }).click()
  const res = await generated.catch(() => null)
  const body = res?.ok() ? ((await res.json().catch(() => null)) as { cashbackId?: string; claimCode?: string } | null) : null
  if (!body?.cashbackId || !body.claimCode) return null
  const share = owner.getByRole('button', { name: /Share link/ })
  if (!(await share.waitFor({ timeout: 20_000 }).then(() => true, () => false))) return null
  await share.click()
  const link = await owner.waitForFunction(() => (window as unknown as { __shared: string[] }).__shared.at(-1) ?? '', undefined, { timeout: 10_000 })
    .then((h) => h.jsonValue() as Promise<string>, () => '')
  const m = /\/c\/([A-Za-z0-9_-]{8,64})#k=([A-Za-z0-9_-]{43})$/.exec(link)
  if (!m) return null
  return { ref: m[1], key: m[2], link, code: body.claimCode, cashbackId: body.cashbackId }
}

/** Open a claim link in an authed page and wait for the prompt or a closed state. */
async function openLink(page: Page, link: string): Promise<string> {
  await page.goto('about:blank')
  await page.goto(link, { waitUntil: 'load' })
  await page.waitForFunction(
    () => /Add to my wallet|Voucher unavailable|Your own cashback|Voucher waiting/.test(document.body.innerText),
    undefined, { timeout: 45_000 },
  ).catch(() => {})
  return text(page)
}

/** The "Total balance" line on a customer's home, as text. */
async function balance(page: Page): Promise<string> {
  await page.goto(`${BASE}/`, { waitUntil: 'load' })
  await page.getByText('Total balance').first().waitFor({ timeout: 30_000 }).catch(() => {})
  await page.waitForTimeout(3_000)
  return (await text(page)).match(/Total balance (\S+(?: \S+)?)/)?.[1] ?? '?'
}

async function main() {
  const browser = await chromium.launch({ args: (process.env.E2E_CHROMIUM_ARGS ?? '').split(/\s+/).filter(Boolean) })
  const config = (await (await fetch(`${BASE}/api/v1/config`)).json()) as { cashback_origins?: string[] }
  claimHost = config.cashback_origins?.[0] ?? ''
  check('the deployment names a claim host', claimHost !== '', JSON.stringify(config.cashback_origins))
  check('the harness can read the databases', PORTAL_SQL !== '')

  console.log('\nSetup: merchant A, customers C and D')
  const a = await (await context(browser, 'A')).newPage()
  await registerMerchant(a, BASE)
  const c = await (await context(browser, 'C')).newPage()
  await registerCustomer(c, BASE)
  const d = await (await context(browser, 'D')).newPage()
  await registerCustomer(d, BASE)

  // ── CL-A ──
  console.log('\nCL-A: the merchant shows the QR and shares the link; C claims it')
  const one = await issueFromScreen(a, '1.25')
  check('CL-A the merchant screen hands out a wallet-origin link with the key in the fragment', one !== null && one.link.startsWith(`${BASE}/c/`))
  if (!one) return finish(browser)
  const ta = await text(a)
  check('CL-A the code stays on screen beside the link (Q2)', ta.includes(one.code), ta.slice(0, 200))
  check('CL-A the bearer note is shown', /Anyone with this link or QR can claim it once\. It works until /.test(ta))
  check('CL-A the QR is hidden until asked for', !(await a.getByAltText(/QR code to claim/).isVisible().catch(() => false)))
  await a.getByRole('button', { name: /Show QR/ }).click()
  check('CL-A Show QR reveals a QR', await a.getByAltText(/QR code to claim/).waitFor({ timeout: 10_000 }).then(() => true, () => false))
  check('CL-A the merchant page never puts the key in its own address bar', !a.url().includes(one.key), a.url())
  check('CL-A a fresh cashback reads Unclaimed', portalStatus(one.ref) === 'Unclaimed')

  const before = await balance(c)
  await budget(2, 'CL-A (prompt + add)')
  const t1 = await openLink(c, one.link)
  check('CL-A C sees the prompt', /Add to my wallet/.test(t1), t1.slice(0, 300))
  await c.getByRole('button', { name: 'Add to my wallet' }).click()
  await c.waitForFunction(() => /Voucher added|Voucher unavailable/.test(document.body.innerText), undefined, { timeout: 90_000 }).catch(() => {})
  const t2 = await text(c)
  check('CL-A Add adds the voucher', /Voucher added/.test(t2), t2.slice(0, 300))
  check('CL-A the portal reads Claimed', (await waitStatus(one.ref, 'Claimed')) === 'Claimed')
  // A's screen was left open on the QR. It must flip by itself, within a few polls.
  const flipped = await a.getByText('Claimed just now').waitFor({ timeout: 30_000 }).then(() => true, () => false)
  check('CL-A the merchant screen flips to "Claimed just now" on its own', flipped, (await text(a)).slice(0, 300))
  check('CL-A the QR is gone once claimed', !(await a.getByAltText(/QR code to claim/).isVisible().catch(() => false)))
  const after = await balance(c)
  check("CL-A C's balance went up", after !== '?' && after !== before, `${before} -> ${after}`)

  // ── CL-RACE ──
  console.log('\nCL-RACE: two customers tap Add within 50 ms')
  const two = await issueFromScreen(a, '0.80')
  check('CL-RACE A issues a second cashback from the screen', two !== null)
  if (two) {
    await budget(4, 'CL-RACE (two prompts + two adds)')
    await openLink(c, two.link)
    await openLink(d, two.link)
    const addC = c.getByRole('button', { name: 'Add to my wallet' })
    const addD = d.getByRole('button', { name: 'Add to my wallet' })
    check('CL-RACE both see Add', (await addC.isVisible()) && (await addD.isVisible()))
    // Both taps are fired from inside the pages at one shared wall-clock instant: a Playwright click
    // carries 50 to 100 ms of its own latency, which would make this a sequence, not a race.
    const at = Date.now() + 1_500
    const tapAt = (p: Page) => p.evaluate((when) => new Promise<number>((done) => {
      setTimeout(() => {
        const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.trim() === 'Add to my wallet')
        b?.click()
        done(b ? Date.now() : -1)
      }, Math.max(0, when - Date.now()))
    }), at)
    const [stampC, stampD] = await Promise.all([tapAt(c), tapAt(d)])
    const t0 = at
    check('CL-RACE the two taps land within 50 ms', stampC > 0 && stampD > 0 && Math.abs(stampC - stampD) <= 50, `${stampC - t0} / ${stampD - t0} ms`)
    const settle = (p: Page) => p.waitForFunction(() => /Voucher added|Voucher unavailable/.test(document.body.innerText), undefined, { timeout: 90_000 }).catch(() => {})
    await Promise.all([settle(c), settle(d)])
    const [rc, rd] = [await text(c), await text(d)]
    const added = [rc, rd].filter((t) => /Voucher added/.test(t)).length
    const already = [rc, rd].filter((t) => /already added to a wallet/i.test(t)).length
    check('CL-RACE exactly one "Voucher added"', added === 1, `C: ${rc.slice(0, 120)} | D: ${rd.slice(0, 120)}`)
    check('CL-RACE exactly one "already added"', already === 1, `C: ${rc.slice(0, 120)} | D: ${rd.slice(0, 120)}`)
    check('CL-RACE the claim service holds one claimed row', sql('imani_cashback_claim', `select count(*) from claim_record where claim_ref='${two.ref}' and status='claimed'`) === '1')
    check('CL-RACE the portal reads Claimed', (await waitStatus(two.ref, 'Claimed')) === 'Claimed')
  }

  // ── CL-OWN ──
  console.log('\nCL-OWN: the merchant opens its own link')
  const three = await issueFromScreen(a, '0.60')
  check('CL-OWN A issues a third cashback from the screen', three !== null)
  if (three) {
    const voucherId = sql('imani_portal', `select voucher_id from cashback_record where safebox_claim_ref='${three.ref}'`)
    await budget(1, 'CL-OWN (prompt)')
    // In A's own signed-in tab: a NEW tab has no session (it lives in sessionStorage), so it would
    // take the logged-out path, park the claim and show Login, which is phase 0's walk, not CL-OWN.
    const page = a
    const t = await openLink(page, three.link)
    check("CL-OWN A is refused: its stall's own cashback", /your stall's own cashback/i.test(t), t.slice(0, 300))
    check('CL-OWN A gets no Add button', !(await page.getByRole('button', { name: 'Add to my wallet' }).isVisible().catch(() => false)))
    await page.waitForTimeout(3_000)
    check('CL-OWN it stays Unclaimed', portalStatus(three.ref) === 'Unclaimed')
    check('CL-OWN no claim was taken from the claim service', sql('imani_cashback_claim', `select status from claim_record where claim_ref='${three.ref}'`) === 'pending')
    check('CL-OWN gateway-customer recorded no redemption declaration for it',
      /^[A-Za-z0-9_-]+$/.test(voucherId) && sql('imani_customer', `select count(*) from voucher_redemption_receipt where voucher_id='${voucherId}'`) === '0',
      `voucher ${voucherId}`)

    // ── Show QR again, after a reload; then Cancel ──
    console.log('\nQR-AGAIN: the record page rebuilds the link after a reload, then Cancel')
    await a.goto(`${BASE}/transaction/${encodeURIComponent(`cashback:${three.cashbackId}`)}`, { waitUntil: 'load' })
    await a.reload({ waitUntil: 'load' })
    const again = a.getByRole('button', { name: 'Show QR again' })
    check('QR-AGAIN the record page offers Show QR again', await again.waitFor({ timeout: 30_000 }).then(() => true, () => false), (await text(a)).slice(0, 300))
    await budget(1, 'QR-AGAIN (by-code)')
    await again.click()
    check('QR-AGAIN a QR is shown', await a.getByAltText(/QR code to claim/).waitFor({ timeout: 20_000 }).then(() => true, () => false), (await text(a)).slice(0, 300))
    await a.evaluate(() => void ((window as unknown as { __shared: string[] }).__shared.length = 0))
    await a.getByRole('button', { name: /Share link/ }).click()
    const rebuilt = await a.evaluate(() => (window as unknown as { __shared: string[] }).__shared.at(-1) ?? '')
    check('QR-AGAIN it rebuilds the identical link', rebuilt === three.link)
    const stored = await a.evaluate((k) => {
      const all = [...Object.keys(localStorage).map((x) => localStorage.getItem(x)), ...Object.keys(sessionStorage).map((x) => sessionStorage.getItem(x))]
      return all.some((v) => v?.includes(k))
    }, three.key)
    check('QR-AGAIN the key is in no web storage on the merchant device', !stored)
    check('QR-AGAIN rebuilding spent nothing', portalStatus(three.ref) === 'Unclaimed')
    await a.getByRole('button', { name: 'Cancel cashback' }).click()
    check('QR-AGAIN Cancel asks first, saying nothing is refunded', /The value is not returned to you\./.test(await text(a)))
    await a.getByRole('button', { name: 'Yes, cancel it' }).click()
    check('QR-AGAIN the portal reads Revoked', (await waitStatus(three.ref, 'Revoked')) === 'Revoked')
    check('QR-AGAIN the page says it was cancelled', await a.getByText(/the code was cancelled/).waitFor({ timeout: 15_000 }).then(() => true, () => false))
  }

  return finish(browser)
}

async function finish(browser: Browser) {
  check('no uncaught errors', errors.length === 0, errors.join('; '))
  await browser.close()
  console.log(failures.length === 0 ? '\nAll checks passed.\n' : `\n${failures.length} FAILED: ${failures.join(', ')}\n`)
  process.exit(failures.length === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('E2E harness error:', e)
  process.exit(1)
})
