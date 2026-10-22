/**
 * Claim links, phases 0, 1 and 3 (imani-docs/wallet/spec-claim-links.md, section 7, CL-BOT, CL-OWN, CL-RACE, CL-B, CL-B2, CL-SWITCH and the
 * closed states), real browsers against a full stack: the local gate (imani-deploy
 * scripts/local-terminal-gate, E2E_SCRIPT=claimLinks.e2e.ts) or staging.
 *
 * A merchant A issues cashback on /sell/cashback. The harness reads the link from the portal's own
 * generate response (claimUrl + "#k=" + claimKey, the exact link phase 2 will show as a QR) and:
 *
 *   L1  CL-BOT: fetches the link headless with no session (curl-style), and loads the wallet route
 *       in a fresh browser with JavaScript on: the portal still reads Unclaimed.
 *   L2  An authed customer C opens the link: the prompt names the stall, the face value and the
 *       expiry, and redeems NOTHING while it sits there. The key is gone from the address bar.
 *   L3  C taps Decline: still Unclaimed.
 *   L4  C opens it again and taps Accept twice: one redeem, "Voucher added", the portal reads Claimed.
 *   L5  A different account D opens the same (now claimed) link: "already added to a wallet", no Add.
 *   L6  A opens its OWN fresh cashback link: refused, still Unclaimed.
 *   L7  A different account D opens a fresh link and is offered it as its own (Add present).
 *   L8  A revokes that cashback: D's prompt reads cancelled, no Add.
 *   L9  A returning device (a stored key, no session) that opens a link lands on Login, not
 *       registration (phase 0), and the parked claim waits behind the prompt after unlock.
 *   L11 CL-B (phase 3): a fresh context opens TWO links logged out, sees the stall-named banner on
 *       onboarding, both stay parked (F4-1), registers, backs up, gets the prompt, adds both.
 *   L12 CL-B2: a device with a stored key lands on Login WITH the banner, unlocks, gets the prompt.
 *   L13 CL-SWITCH: D sees the prompt, taps Switch account (logout), and the claim survives it while
 *       nothing else of D does; a new account registers and is offered and adds it.
 *   L10 The hosted claim page (cashback-claim, through the gate's cashback host when published) is
 *       no-store and no-referrer, and hands off to this wallet.
 *
 *   E2E_BASE=http://localhost:<edge> E2E_BUNDLE_DIR=<dist> npx tsx e2e/claimLinks.e2e.ts
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { readFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { registerCustomer, registerMerchant, TEST_PASSPHRASE, TEST_STALL_NAME } from './register.mts'

const BASE = (process.env.E2E_BASE ?? 'http://localhost:5177').replace(/\/+$/, '')
const BUNDLE_DIR = process.env.E2E_BUNDLE_DIR
const IGNORE_HTTPS_ERRORS = process.env.E2E_IGNORE_HTTPS_ERRORS === '1'
/**
 * Where the claim host (cashback_origins[0]) is really served, for a LOCAL stack: the gate's edge
 * serves cashback.staging.398ja.xyz from api.staging.conf on its own port, so every request the
 * browser makes to https://<claim host>/ is answered by the gate's cashback-claim through that edge,
 * with the Host kept. Without it a local run's redeem would reach the real staging host. Unset on a
 * run against staging itself.
 */
const CLAIM_HOST_VIA = process.env.E2E_CLAIM_HOST_VIA ?? ''

const failures: string[] = []
const errors: string[] = []
function check(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(name)
}
async function text(page: Page): Promise<string> {
  return (await page.locator('body').innerText()).replace(/\s+/g, ' ')
}
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
}

async function context(browser: Browser, name: string): Promise<BrowserContext> {
  const ctx = await browser.newContext({ locale: 'en-GB', serviceWorkers: BUNDLE_DIR ? 'block' : 'allow', ignoreHTTPSErrors: IGNORE_HTTPS_ERRORS })
  if (BUNDLE_DIR) {
    const root = normalize(BUNDLE_DIR)
    const shell = join(root, 'index.html')
    await ctx.route(`${BASE}/**`, async (route) => {
      const path = new URL(route.request().url()).pathname
      if (path.startsWith('/api/') || path.startsWith('/.well-known/') || path.startsWith('/fcaptcha/')) return route.continue()
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

/** The claim host this deployment trusts, from /api/v1/config. */
let claimHost = ''

/** GET an https://<claim host>/ path from CLAIM_HOST_VIA, keeping the Host header. */
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

interface Issued { cashbackId: string; ref: string; key: string; link: string }

/** A issues a cashback on /sell/cashback; the link is read from the portal's generate response. */
async function issueCashback(owner: Page, amount: string): Promise<Issued | null> {
  const generated = owner.waitForResponse((r) => r.url().endsWith('/api/v1/portal/cashback/generate') && r.request().method() === 'POST', { timeout: 90_000 })
  await owner.goto(`${BASE}/sell/cashback`, { waitUntil: 'load' })
  const input = owner.locator('input[placeholder="0.00"]')
  for (let attempt = 0; attempt < 4; attempt++) {
    if (await input.waitFor({ timeout: 30_000 }).then(() => true, () => false)) break
    // A new stall's session can predate coupon:issue (#114): log in again, as terminalSetup does.
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
  await owner.getByRole('button', { name: 'Create Cashlink' }).click()
  const res = await generated.catch(() => null)
  if (!res || !res.ok()) return null
  const body = (await res.json().catch(() => null)) as { cashbackId?: string; claimUrl?: string; claimKey?: string } | null
  if (!body?.claimUrl || !body.claimKey || !body.cashbackId) return null
  const ref = new URL(body.claimUrl).pathname.split('/').pop() ?? ''
  return { cashbackId: body.cashbackId, ref, key: body.claimKey, link: `${BASE}/c/${ref}#k=${body.claimKey}` }
}

/** How to query the portal's database, when the harness can (the local gate passes it). */
const PORTAL_SQL = process.env.E2E_PORTAL_SQL_CMD ?? ''

/**
 * The portal's status for a cashback. From its database when the harness has it: the public
 * metadata endpoint is rate limited per address (10 a minute), and the harness shares the browsers'
 * address, so polling it would throttle the very prompt under test. Otherwise the public endpoint,
 * waiting out a 429.
 */
async function portalStatus(ref: string): Promise<string> {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(ref)) return 'bad_ref'
  if (PORTAL_SQL) {
    const { execSync } = await import('node:child_process')
    const q = `select status from cashback_record where safebox_claim_ref='${ref}'`
    try {
      return execSync(`${PORTAL_SQL} ${JSON.stringify(q)}`, { encoding: 'utf8' }).trim() || 'none'
    } catch (e) {
      return `sql_error ${(e as Error).message.slice(0, 80)}`
    }
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(`${BASE}/api/v1/portal/cashback/public/${ref}`).catch(() => null)
    if (res?.status === 429) {
      await new Promise((ok) => setTimeout(ok, 1_000 * Number(res.headers.get('retry-after') ?? 10)))
      continue
    }
    if (!res || !res.ok) return `http_${res?.status ?? 0}`
    return ((await res.json()) as { status?: string }).status ?? '?'
  }
  return 'throttled'
}

async function waitStatus(ref: string, want: string, ms = 30_000): Promise<string> {
  let last = ''
  for (const end = Date.now() + ms; Date.now() < end;) {
    last = await portalStatus(ref)
    if (last === want) return last
    await new Promise((ok) => setTimeout(ok, 1_000))
  }
  return last
}

/** Open a claim link in an authed page and wait for the prompt or a closed state. */
async function openLink(page: Page, link: string): Promise<string> {
  // A fresh document every time, as a tapped link is: going to the URL the page is already on would
  // be a same-document fragment change, and the old prompt would stay on screen.
  await page.goto('about:blank')
  await page.goto(link, { waitUntil: 'load' })
  await page.waitForFunction(
    () => /Add to my wallet|Voucher unavailable|Your own Cashlink|Voucher waiting/.test(document.body.innerText),
    undefined, { timeout: 45_000 },
  ).catch(() => {})
  return text(page)
}

/**
 * Wait out the portal's public-metadata limiter (10 a minute per address). Every browser in this
 * harness shares one address, so the banner and prompt reads of several "people" in a row would be
 * throttled together; a real visitor is one address. Phase 3 sections start from a fresh window.
 */
async function freshMetadataWindow(): Promise<void> {
  await new Promise((ok) => setTimeout(ok, 61_000))
}

/** Click, recording a failed check rather than aborting the remaining sections. */
async function tap(page: Page, name: string, label: string): Promise<boolean> {
  const ok = await page.getByRole('button', { name }).first().click({ timeout: 20_000 }).then(() => true, () => false)
  if (!ok) check(`${label}: "${name}" was there to tap`, false, (await text(page)).slice(0, 300))
  return ok
}

async function main() {
  const args = (process.env.E2E_CHROMIUM_ARGS ?? '').split(/\s+/).filter(Boolean)
  const browser = await chromium.launch({ args })
  const config = (await (await fetch(`${BASE}/api/v1/config`)).json()) as { cashback_origins?: string[] }
  claimHost = config.cashback_origins?.[0] ?? ''
  check('the deployment names a claim host', claimHost !== '', JSON.stringify(config.cashback_origins))

  console.log('\nSetup: merchant A, customers C and D')
  const a = await (await context(browser, 'A')).newPage()
  await registerMerchant(a, BASE)
  const c = await (await context(browser, 'C')).newPage()
  await registerCustomer(c, BASE)
  const d = await (await context(browser, 'D')).newPage()
  const dPubkey = await registerCustomer(d, BASE)

  const one = await issueCashback(a, '1.25')
  check('A issues a cashback and the portal returns its link', one !== null)
  if (!one) return finish(browser)
  check('the link carries the key in the fragment, never the query', !new URL(one.link).search && new URL(one.link).hash.length > 40)
  check('a fresh cashback reads Unclaimed', (await portalStatus(one.ref)) === 'Unclaimed')

  console.log('\nL1 CL-BOT: opening the link never redeems')
  // Whatever serves the path (the SPA on staging; nothing in the gate, which serves the bundle through
  // the browser), a plain GET of the link carries no fragment to the server and spends nothing.
  await fetch(one.link).catch(() => null)
  await fetch(one.link, { headers: { Purpose: 'prefetch', 'Sec-Purpose': 'prefetch' } }).catch(() => null)
  check('L1 a headless GET (and a prefetch) of the link spends nothing', (await portalStatus(one.ref)) === 'Unclaimed')
  const bot = await (await context(browser, 'bot')).newPage()
  await bot.goto(one.link, { waitUntil: 'networkidle' }).catch(() => {})
  await bot.waitForTimeout(3_000)
  check('L1 a headless browser with JS and no session lands on sign-up, not a spend', /onboarding|login/.test(bot.url()), bot.url())
  check('L1 after the bot visits the voucher still reads Unclaimed', (await portalStatus(one.ref)) === 'Unclaimed')

  console.log('\nL2 the prompt')
  let t2 = await openLink(c, one.link)
  check('L2 C sees the confirm prompt', /Add to my wallet/.test(t2), t2.slice(0, 300))
  // The stall's name arrives from its profile a moment after the prompt.
  await c.waitForFunction((n) => document.body.innerText.includes(n), TEST_STALL_NAME, { timeout: 45_000 }).catch(() => {})
  t2 = await text(c)
  check('L2 the stall reads verified', /verified stall/.test(t2), t2.slice(0, 300))
  check('L2 the prompt names the stall', t2.includes(TEST_STALL_NAME), t2.slice(0, 300))
  check('L2 the prompt shows the face value', /1\.25/.test(t2), t2.slice(0, 300))
  check('L2 the prompt shows the claim-by date', /Claim by /.test(t2), t2.slice(0, 300))
  check('L2 the key is gone from the address bar', !c.url().includes(one.key), c.url())
  await c.waitForTimeout(5_000)
  check('L2 an open prompt redeems nothing', (await portalStatus(one.ref)) === 'Unclaimed')

  console.log('\nL3 Decline')
  await c.getByRole('button', { name: 'Decline' }).click()
  await c.waitForTimeout(1_500)
  check('L3 Decline leaves it Unclaimed', (await portalStatus(one.ref)) === 'Unclaimed')

  console.log('\nL4 Accept, twice')
  await openLink(c, one.link)
  const add = c.getByRole('button', { name: 'Add to my wallet' })
  await add.click()
  await add.click({ timeout: 1_000 }).catch(() => {})
  await c.waitForFunction(() => /Voucher added|Voucher unavailable/.test(document.body.innerText), undefined, { timeout: 90_000 }).catch(() => {})
  const t4 = await text(c)
  check('L4 Accept adds the voucher', /Voucher added/.test(t4), t4.slice(0, 300))
  check('L4 the portal reads Claimed', (await waitStatus(one.ref, 'Claimed')) === 'Claimed')

  console.log('\nL5 an already-claimed link')
  const t5 = await openLink(d, one.link)
  check('L5 D is told it was already added to a wallet', /already added to a wallet/i.test(t5), t5.slice(0, 300))
  check('L5 D gets no Add button', !(await d.getByRole('button', { name: 'Add to my wallet' }).isVisible().catch(() => false)))

  console.log('\nL6 CL-OWN: the merchant opens its own link')
  const two = await issueCashback(a, '0.75')
  check('A issues a second cashback', two !== null)
  if (two) {
    const t6 = await openLink(a, two.link)
    check("L6 A is refused: its stall's own Cashlink", /your stall's own Cashlink/i.test(t6), t6.slice(0, 300))
    check('L6 A gets no Add button', !(await a.getByRole('button', { name: 'Add to my wallet' }).isVisible().catch(() => false)))
    check('L6 it stays Unclaimed', (await portalStatus(two.ref)) === 'Unclaimed')

    console.log('\nL7 a different account sees the prompt for itself')
    const t7 = await openLink(d, two.link)
    check('L7 D is offered it (Add present)', /Add to my wallet/.test(t7), t7.slice(0, 300))
    check('L7 the prompt adds it to D\'s own wallet', /Adding to (@cust\d+|your wallet)/.test(t7), t7.slice(0, 300))

    console.log('\nL8 a revoked link')
    // A revokes through its own session, as the merchant screen will (phase 2).
    const revoked = await a.evaluate(async (id) => {
      const r = await fetch(`/api/v1/portal/cashback/${id}/revoke`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      return r.status
    }, two.cashbackId)
    check('L8 A revokes the cashback', revoked >= 200 && revoked < 300, String(revoked))
    check('L8 the portal reads Revoked', (await waitStatus(two.ref, 'Revoked')) === 'Revoked')
    const t8 = await openLink(d, two.link)
    check('L8 D is told the stall cancelled it', /cancelled this voucher/i.test(t8), t8.slice(0, 300))
    check('L8 D gets no Add button', !(await d.getByRole('button', { name: 'Add to my wallet' }).isVisible().catch(() => false)))
  }

  console.log('\nL9 a returning device with no session')
  const three = await issueCashback(a, '0.50')
  check('A issues a third cashback', three !== null)
  if (three) {
    // C's device keeps its key; dropping the session cookie and the resume slot ends the session.
    await c.context().clearCookies()
    await c.evaluate(() => sessionStorage.clear())
    await c.goto(three.link, { waitUntil: 'load' })
    await c.waitForURL(/\/(login|onboarding)/, { timeout: 30_000 }).catch(() => {})
    check('L9 a device with a stored key lands on Login, not registration', /\/login/.test(c.url()), c.url())
    // Owner report 2026-10-14: Login told a returning user to CREATE an account.
    await c.waitForFunction(() => /Log in to redeem/.test(document.body.innerText), undefined, { timeout: 45_000 }).catch(() => {})
    const t9b = await text(c)
    check('L9 the Login banner says "Log in to redeem", not "Create an account"', /Log in to redeem/.test(t9b) && !/Create an account/.test(t9b), t9b.slice(0, 300))
    check('L9 nothing is spent on the way', (await portalStatus(three.ref)) === 'Unclaimed')
    const pass = c.locator('input[placeholder="Passphrase"]')
    if (await pass.waitFor({ timeout: 20_000 }).then(() => true, () => false)) {
      await pass.fill(TEST_PASSPHRASE)
      await c.getByRole('button', { name: /unlock/i }).first().click()
    }
    await c.waitForFunction(() => /Add to my wallet|Voucher unavailable/.test(document.body.innerText), undefined, { timeout: 60_000 }).catch(() => {})
    const t9 = await text(c)
    check('L9 after unlock the parked claim waits behind the prompt', /Add to my wallet/.test(t9), t9.slice(0, 300))
    check('L9 and is still Unclaimed', (await portalStatus(three.ref)) === 'Unclaimed')
  }

  await freshMetadataWindow()
  console.log('\nL11 CL-B: no account, two links, register, prompt, Add (phase 3)')
  const b1 = await issueCashback(a, '0.40')
  const b2 = await issueCashback(a, '0.60')
  check('A issues two cashbacks for a stranger', b1 !== null && b2 !== null)
  if (b1 && b2) {
    const e = await (await context(browser, 'E')).newPage()
    // Two links opened logged out before finishing either (F4-1, O4): neither may be lost.
    await e.goto(b1.link, { waitUntil: 'load' })
    await e.waitForURL(/\/onboarding/, { timeout: 30_000 }).catch(() => {})
    await e.goto('about:blank')
    await e.goto(b2.link, { waitUntil: 'load' })
    await e.waitForURL(/\/onboarding/, { timeout: 30_000 }).catch(() => {})
    check('L11 a device with no key lands on onboarding', /\/onboarding/.test(e.url()), e.url())
    check('L11 the key is gone from the address bar', !e.url().includes(b2.key), e.url())
    const banner = `Create an account to redeem the voucher from ${TEST_STALL_NAME}`
    await e.waitForFunction((s) => document.body.innerText.includes(s), banner, { timeout: 45_000 }).catch(() => {})
    const t11 = await text(e)
    check('L11 the banner names the stall, in the spec words', t11.includes(banner), t11.slice(0, 300))
    check('L11 the banner shows the face value and the claim-by date', /0\.60/.test(t11) && /Claim by /.test(t11), t11.slice(0, 300))
    check('L11 Register is offered under it', await e.getByRole('button', { name: /^Register$/ }).isVisible().catch(() => false))
    const parked = await e.evaluate(() => JSON.parse(localStorage.getItem('imani-wallet:pending-claim') ?? '[]') as { ref: string }[])
    check('L11 both links are parked, keyed by ref', [b1.ref, b2.ref].every((r) => parked.some((p) => p.ref === r)), JSON.stringify(parked.map((p) => p.ref)))
    check('L11 nothing spent on the way', (await portalStatus(b1.ref)) === 'Unclaimed' && (await portalStatus(b2.ref)) === 'Unclaimed')

    {
      // Claim-driven registration is customer-only: the merchant switch is not there.
      await e.getByRole('button', { name: /^Register$/ }).first().click()
      await e.locator('input[placeholder="your_handle"]').waitFor({ timeout: 20_000 }).catch(() => {})
      const acct = await text(e)
      check('L11 (CL-B) the merchant switch is absent', !(await e.getByText('I am a merchant').count()) && acct.includes("You're redeeming a voucher, so this is a customer account."), acct.slice(0, 300))
      // Back to the start step: registerCustomer's goto to this same URL is a reload in Chromium, and a
      // reload keeps history.state (the account step), so its Register button would never show.
      await e.getByRole('button', { name: /^Back$/ }).first().click()
      await e.getByRole('button', { name: /^Register$/ }).first().waitFor({ timeout: 20_000 }).catch(() => {})
    }
    await freshMetadataWindow()
    await registerCustomer(e, BASE)
    await e.waitForFunction(() => /Add to my wallet|Voucher unavailable/.test(document.body.innerText), undefined, { timeout: 60_000 }).catch(() => {})
    let t = await text(e)
    check('L11 after register and backup the newest claim waits behind the prompt', /Add to my wallet/.test(t) && /0\.60/.test(t), t.slice(0, 300))
    check('L11 still Unclaimed at the prompt', (await portalStatus(b2.ref)) === 'Unclaimed')
    await tap(e, 'Add to my wallet', 'L11')
    await e.waitForFunction(() => /Voucher added|Voucher unavailable/.test(document.body.innerText), undefined, { timeout: 90_000 }).catch(() => {})
    t = await text(e)
    check('L11 Add adds it', /Voucher added/.test(t), t.slice(0, 300))
    check('L11 the portal reads Claimed', (await waitStatus(b2.ref, 'Claimed')) === 'Claimed')

    // Then home resumes the other one: it was not lost to the second link.
    await tap(e, 'Open my wallet', 'L11')
    await e.waitForFunction(() => /Add to my wallet|Voucher unavailable/.test(document.body.innerText), undefined, { timeout: 60_000 }).catch(() => {})
    t = await text(e)
    check('L11 the first link is resumed next (O4)', /Add to my wallet/.test(t) && /0\.40/.test(t), t.slice(0, 300))
    await tap(e, 'Add to my wallet', 'L11')
    await e.waitForFunction(() => /Voucher added|Voucher unavailable/.test(document.body.innerText), undefined, { timeout: 90_000 }).catch(() => {})
    check('L11 and is added too', (await waitStatus(b1.ref, 'Claimed')) === 'Claimed')
    const left = await e.evaluate(() => localStorage.getItem('imani-wallet:pending-claim'))
    check('L11 nothing is left parked', left === null, String(left))
    await e.context().close()
  }

  await freshMetadataWindow()
  console.log('\nL12 CL-B2: a stored key, no session: Login with the banner')
  const b3 = await issueCashback(a, '0.30')
  check('A issues a cashback for a returning customer', b3 !== null)
  if (b3) {
    await c.context().clearCookies()
    await c.evaluate(() => sessionStorage.clear())
    await c.goto('about:blank')
    await c.goto(b3.link, { waitUntil: 'load' })
    await c.waitForURL(/\/(login|onboarding)/, { timeout: 30_000 }).catch(() => {})
    check('L12 lands on Login', /\/login/.test(c.url()), c.url())
    const banner = `Log in to redeem the voucher from ${TEST_STALL_NAME}`
    await c.waitForFunction((s) => document.body.innerText.includes(s), banner, { timeout: 45_000 }).catch(() => {})
    const t12 = await text(c)
    check('L12 Login shows the Log in banner (spec 4.4)', t12.includes(banner) && /0\.30/.test(t12), t12.slice(0, 300))
    check('L12 (CL-B2) Login offers no merchant switch', !(await c.getByText('I am a merchant').count()))
    check('L12 Unlock is offered', await c.getByRole('button', { name: /unlock/i }).first().isVisible().catch(() => false))
    const pass = c.locator('input[placeholder="Passphrase"]')
    if (await pass.waitFor({ timeout: 20_000 }).then(() => true, () => false)) {
      await pass.fill(TEST_PASSPHRASE)
      await c.getByRole('button', { name: /unlock/i }).first().click()
    }
    await c.waitForFunction(() => /Add to my wallet|Voucher unavailable/.test(document.body.innerText), undefined, { timeout: 60_000 }).catch(() => {})
    const t = await text(c)
    check('L12 after unlock the prompt shows', /Add to my wallet/.test(t), t.slice(0, 300))
    check('L12 still Unclaimed', (await portalStatus(b3.ref)) === 'Unclaimed')
    await c.getByRole('button', { name: 'Decline' }).click().catch(() => {})
  }

  await freshMetadataWindow()
  console.log('\nL13 CL-SWITCH: X sees the prompt, Switch account, Y resumes it')
  const b4 = await issueCashback(a, '0.20')
  check('A issues a cashback for the switch', b4 !== null)
  if (b4) {
    const t13 = await openLink(d, b4.link)
    check('L13 X (D) sees the prompt', /Add to my wallet/.test(t13), t13.slice(0, 300))
    d.once('dialog', (dlg) => void dlg.accept())
    await tap(d, 'Switch account', 'L13')
    await d.waitForURL(/\/(onboarding|login)/, { timeout: 60_000 }).catch(() => {})
    // Logout reloads the document (`/`), and Entry then routes it: let that settle before reading.
    await d.waitForLoadState('load').catch(() => {})
    await d.waitForURL(/\/onboarding/, { timeout: 30_000 }).catch(() => {})
    await d.waitForLoadState('load').catch(() => {})
    await d.waitForTimeout(1_000)
    check('L13 the logout ran (X is gone)', /\/onboarding/.test(d.url()), d.url())
    const parked = await d.evaluate(() => localStorage.getItem('imani-wallet:pending-claim') ?? '')
    check('L13 the claim survived the logout', parked.includes(b4.ref))
    // Nothing of X: no key naming X's pubkey and no value carrying it. (The banner caches the STALL's
    // public profile after the reload, `identity:<issuer>`, which is not X's.)
    const leftovers = await d.evaluate((x) => Object.keys(localStorage).filter((k) => k.startsWith('imani-wallet:')
      && k !== 'imani-wallet:pending-claim' && (k.includes(x) || (localStorage.getItem(k) ?? '').includes(x))), dPubkey)
    check('L13 nothing else of X survived it', dPubkey.length === 64 && leftovers.length === 0, JSON.stringify(leftovers))
    const parkedOnly = await d.evaluate(() => JSON.parse(localStorage.getItem('imani-wallet:pending-claim') ?? '[]') as Record<string, unknown>[])
    check('L13 the parked entry holds only kind, ref, key and age', parkedOnly.every((e) => Object.keys(e).sort().join() === 'at,key,kind,ref'), JSON.stringify(parkedOnly.map((e) => Object.keys(e))))
    const banner = `Create an account to redeem the voucher from ${TEST_STALL_NAME}`
    await d.waitForFunction((s) => document.body.innerText.includes(s), banner, { timeout: 45_000 }).catch(() => {})
    check('L13 onboarding shows the banner', (await text(d)).includes(banner))
    await freshMetadataWindow()
    await registerCustomer(d, BASE)
    await d.waitForFunction(() => /Add to my wallet|Voucher unavailable/.test(document.body.innerText), undefined, { timeout: 60_000 }).catch(() => {})
    let t = await text(d)
    check('L13 Y is offered the claim', /Add to my wallet/.test(t) && /0\.20/.test(t), t.slice(0, 300))
    check('L13 still Unclaimed', (await portalStatus(b4.ref)) === 'Unclaimed')
    await tap(d, 'Add to my wallet', 'L13')
    await d.waitForFunction(() => /Voucher added|Voucher unavailable/.test(document.body.innerText), undefined, { timeout: 90_000 }).catch(() => {})
    t = await text(d)
    check('L13 Y adds it', /Voucher added/.test(t), t.slice(0, 300))
    check('L13 the portal reads Claimed', (await waitStatus(b4.ref, 'Claimed')) === 'Claimed')
  }

  await freshMetadataWindow()
  console.log("\nL14 CL-MERCHANT: another stall's account is refused A's cashback (owner rule 2026-10-13)")
  const m1 = await issueCashback(a, '0.15')
  check('A issues a cashback another merchant will open', m1 !== null)
  if (m1) {
    const m = await (await context(browser, 'M')).newPage()
    await registerMerchant(m, BASE)
    const t14 = await openLink(m, m1.link)
    check('L14 the merchant account is refused with the rule\'s copy',
      /Merchant accounts can only take their own stall's vouchers/.test(t14) && /use a customer account/.test(t14), t14.slice(0, 300))
    check('L14 it gets no Add button', !(await m.getByRole('button', { name: 'Add to my wallet' }).isVisible().catch(() => false)))
    check('L14 it is offered Switch account', await m.getByRole('button', { name: 'Switch account' }).isVisible().catch(() => false))
    check('L14 nothing is spent: still Unclaimed', (await portalStatus(m1.ref)) === 'Unclaimed')
    // A customer account still takes it: the refusal moved nothing.
    const t14c = await openLink(d, m1.link)
    check('L14 a customer is still offered it', /Add to my wallet/.test(t14c), t14c.slice(0, 300))
    await tap(d, 'Add to my wallet', 'L14')
    await d.waitForFunction(() => /Voucher added|Voucher unavailable/.test(document.body.innerText), undefined, { timeout: 90_000 }).catch(() => {})
    check('L14 the customer adds it', (await waitStatus(m1.ref, 'Claimed')) === 'Claimed')
    await m.context().close()
  }

  if (CLAIM_HOST_VIA && one) {
    console.log('\nL10 the hosted claim page')
    const page = await viaEdge(`/c/${one.ref}`).catch(() => null)
    check('L10 the hosted page answers', page?.status === 200, String(page?.status))
    check('L10 Cache-Control: no-store', page?.headers['cache-control'] === 'no-store', String(page?.headers['cache-control']))
    check('L10 Referrer-Policy: no-referrer', page?.headers['referrer-policy'] === 'no-referrer', String(page?.headers['referrer-policy']))
    const html = page?.body.toString('utf8') ?? ''
    check('L10 no placeholder store link', html !== '' && !/id000000000|apps\.apple\.com|play\.google\.com/.test(html))
    check('L10 it hands off to this wallet', html.includes(`const walletOrigin = ${JSON.stringify(BASE)};`), html.match(/walletOrigin = ([^;]+);/)?.[1] ?? '')
    const gone = await viaEdge(`/c/${one.ref}/ciphertext`).catch(() => null)
    check('L10 a claimed ciphertext answers 410, no-store', gone?.status === 410 && gone.headers['cache-control'] === 'no-store', `${gone?.status} ${gone?.headers['cache-control']}`)
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
