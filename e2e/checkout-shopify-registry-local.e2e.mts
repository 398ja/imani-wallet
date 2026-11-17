/**
 * imani-wallet#405, the merchant connect flow end to end on the LOCAL stack, in a real browser.
 *
 * Nothing is faked: a fresh merchant on the local wallet, the imani-checkout-shopify connect page
 * (registry mode, merged master) checking a real Shopify dev store app, and the wallet's own
 * Settings > Online shop minting a credential to the shop over NIP-17.
 *
 *   R1  the connect link opens the form
 *   R2  a wrong client secret is refused with the credentials message, and the secret is not echoed
 *   R3  the real app passes the connection check and the status page shows an enrolment code
 *   R4p the stall pays Pro on the local subscription site (Stripe test mode): online shops are Pro
 *   R4  the wallet reads that code as this online shop, redeem-only, and issues the credential
 *   R5  registry passes take the credential (trust on first use) and mark the shop in_service
 *       with this stall
 *   R6  the stall's Online shop page shows the shop Connected
 *   R7  the connect page now says in service, names the stall, and refuses a reconnect
 *
 * Env: INVITE_URL (from `imani-shopify invite`), SHOP (dev store domain), CLIENT_ID,
 * CLIENT_SECRET_FILE, RUN_ONCE (a shell command running one registry pass), SHOPS (a shell
 * command printing `imani-shopify shops`), E2E_BASE (wallet, default http://localhost:5173).
 * Run:  TSX_TSCONFIG_PATH=tsconfig.app.json npx tsx e2e/checkout-shopify-registry-local.e2e.mts
 */
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { chromium, type Browser, type Page } from 'playwright'
import { registerMerchant } from './register.mts'

const BASE = (process.env.E2E_BASE ?? 'http://localhost:5173').replace(/\/+$/, '')
const INVITE = process.env.INVITE_URL ?? ''
const SHOP = process.env.SHOP ?? ''
const CLIENT_ID = process.env.CLIENT_ID ?? ''
const CLIENT_SECRET = process.env.CLIENT_SECRET_FILE ? readFileSync(process.env.CLIENT_SECRET_FILE, 'utf8').trim() : ''
const RUN_ONCE = process.env.RUN_ONCE ?? ''
const SHOPS = process.env.SHOPS ?? ''
for (const [k, v] of Object.entries({ INVITE_URL: INVITE, SHOP, CLIENT_ID, CLIENT_SECRET_FILE: CLIENT_SECRET, RUN_ONCE, SHOPS })) {
  if (!v) throw new Error(`${k} is required`)
}

const failures: string[] = []
const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`)
const info = (s: string) => log(`  INFO ${s}`)
function step(name: string, ok: boolean, detail = '') {
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  | ${detail}` : ''}`)
  if (!ok) failures.push(name)
}
const text = async (p: Page) => (await p.locator('body').innerText()).replace(/\s+/g, ' ')
// Never print the secret, even inside a failure detail.
const clean = (s: string) => (CLIENT_SECRET ? s.split(CLIENT_SECRET).join('<secret>') : s)
const sh = (cmd: string) => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

async function finish(browser: Browser) {
  await browser.close()
  log(failures.length ? `==== FAILED: ${failures.join('; ')}` : '==== ALL PASS')
  process.exit(failures.length ? 1 : 0)
}

async function connectForm(p: Page, secret: string) {
  await p.goto(INVITE, { waitUntil: 'domcontentloaded' })
  await p.fill('input[name="shop"]', SHOP)
  await p.fill('input[name="client_id"]', CLIENT_ID)
  await p.fill('input[name="client_secret"]', secret)
  await Promise.all([p.waitForLoadState('domcontentloaded'), p.locator('form [type="submit"]').click()])
}

async function payStripe(page: Page, email: string) {
  await page.waitForURL(/checkout\.stripe\.com/, { timeout: 30_000 })
  // Stripe Checkout now renders its fields inside a Payment Element iframe.
  const el = page.frameLocator('iframe[src*="elements-inner"]').first()
  await el.locator('#payment-numberInput').waitFor({ timeout: 60_000 })
  if (await el.locator('#linkAuthentication-emailInput').isVisible().catch(() => false)) await el.locator('#linkAuthentication-emailInput').fill(email)
  await el.locator('#payment-numberInput').fill('4242424242424242')
  await el.locator('#payment-expiryInput').fill('12 / 34')
  await el.locator('#payment-cvcInput').fill('123')
  await el.locator('#payment-nameInput').fill('Shop Test Stall')
  if (await el.locator('#payment-countryInput').count()) await el.locator('#payment-countryInput').selectOption('GB')
  const postal = el.locator('#payment-postalCodeInput')
  if (await postal.isVisible().catch(() => false)) await postal.fill('SW1A 1AA')
  const pay = /Pay and subscribe|^Subscribe$/
  const btn = (await el.getByRole('button', { name: pay }).count()) ? el.getByRole('button', { name: pay }) : page.locator('button[type=submit], .SubmitButton, [data-testid="hosted-payment-submit-button"]')
  await btn.first().click({ timeout: 30_000 })
}

async function main() {
  log(`==== #405 connect flow, registry mode  wallet=${BASE} shop=${SHOP}`)
  const browser = await chromium.launch()
  const page = async () => (await browser.newContext({ locale: 'en-GB', serviceWorkers: 'block' })).newPage()

  // R1, R2
  const merchant = await page()
  await merchant.goto(INVITE, { waitUntil: 'domcontentloaded' })
  step('R1 the connect link opens the form', (await merchant.locator('input[name="client_secret"]').count()) === 1, clean((await text(merchant)).slice(0, 200)))
  const wrong = 'shpss_' + 'x'.repeat(32)
  await connectForm(merchant, wrong)
  const refused = await text(merchant)
  const html = await merchant.content()
  step('R2 a wrong secret is refused with the credentials message, not echoed',
    /client (ID|secret)|credentials/i.test(refused) && !html.includes(wrong) && !/shops?$/.test(merchant.url()),
    clean(refused.slice(0, 240)))

  // R3
  await connectForm(merchant, CLIENT_SECRET)
  const enrol = (await merchant.content()).match(/imani-shop-enrol:1:[^\s<"]+/)?.[0] ?? ''
  step('R3 the real app passes the check and the page shows the enrolment code', !!enrol, enrol ? enrol.slice(0, 80) : clean((await text(merchant)).slice(0, 300)))
  if (!enrol) return finish(browser)
  step('R3b the page never shows the client secret', !(await merchant.content()).includes(CLIENT_SECRET))

  // R4
  const owner = await (await browser.newContext({ locale: 'en-GB', serviceWorkers: 'block', viewport: { width: 420, height: 900 } })).newPage()
  const handle = await registerMerchant(owner, BASE)
  const stall = await owner.evaluate(() => {
    for (let i = 0; i < localStorage.length; i++) {
      const k = /^imani-wallet:profile:([0-9a-f]{64})$/.exec(localStorage.key(i) ?? '')
      if (k) return k[1]
    }
    return ''
  })
  info(`stall ${handle} ${stall}`)
  // Online shops are a Pro feature (#407): pay Pro on the local subscription site, Stripe test mode.
  await owner.goto(`${BASE}/settings/subscription`, { waitUntil: 'load' })
  const upgrade = owner.getByRole('link', { name: 'Upgrade my plan' })
  await upgrade.waitFor({ timeout: 20_000 })
  const [site] = await Promise.all([owner.context().waitForEvent('page'), upgrade.click()])
  await site.getByRole('button', { name: 'Choose Pro' }).click({ timeout: 30_000 })
  await payStripe(site, `${handle}@example.com`)
  await site.waitForURL(/\/done/, { timeout: 90_000 })
  let plan = ''
  for (let i = 0; i < 24 && !/Plan Pro/.test(plan); i++) {
    await owner.goto(`${BASE}/settings/subscription`, { waitUntil: 'load' })
    await owner.waitForTimeout(5000)
    plan = await text(owner)
  }
  step('R4p the stall is on Pro (real Stripe test Checkout, local gateway mint)', /Plan Pro/.test(plan), plan.slice(0, 200))
  if (!/Plan Pro/.test(plan)) return finish(browser)
  // The stall connects the shop on Settings > Online shop (the page the issue's flow uses now).
  await owner.goto(`${BASE}/settings/online-shop`, { waitUntil: 'load' })
  await owner.getByRole('radio', { name: /Shopify/ }).click({ timeout: 30_000 }).catch(() => {})
  await owner.getByPlaceholder('imani-shop-enrol:1:…').fill(enrol, { timeout: 30_000 })
  await owner.getByRole('button', { name: 'Continue', exact: true }).click()
  const host = SHOP.replace(/^https?:\/\//, '')
  const confirm = await owner.getByTestId('online-shop-confirm').waitFor({ timeout: 20_000 }).then(() => true, () => false)
  const confirmText = confirm ? await owner.getByTestId('online-shop-confirm').innerText() : ''
  step('R4a the wallet reads the code as this Shopify shop', confirm && confirmText.includes(host) && /Shopify/.test(confirmText), confirm ? confirmText.replace(/\s+/g, ' ').slice(0, 160) : (await text(owner)).slice(-300))
  if (!confirm) return finish(browser)
  await owner.getByTestId('online-shop-confirm').getByRole('button', { name: 'Connect', exact: true }).click()
  const pending = await owner.getByTestId('online-shop-connected').waitFor({ timeout: 120_000 }).then(() => true, () => false)
  const pendingText = pending ? (await owner.getByTestId('online-shop-connected').innerText()).replace(/\s+/g, ' ') : ''
  step('R4b the stall issues the shop its credential and waits for it', pending && /Waiting for the shop|Being set up|Not received/.test(pendingText), pendingText.slice(0, 200) || (await text(owner)).slice(-300))
  if (!pending) return finish(browser)

  // R5: registry passes, as the daemon would run them.
  let state = ''
  for (let i = 0; i < 12; i++) {
    const pass = sh(RUN_ONCE)
    info(`pass ${i + 1}: ${pass.replace(/\s+/g, ' ').slice(0, 160)}`)
    state = sh(SHOPS)
    if (state.includes('in_service')) break
    await new Promise((r) => setTimeout(r, 5_000))
  }
  step('R5 the registry marks the shop in_service with this stall',
    state.includes('in_service') && state.toLowerCase().includes(stall.slice(0, 12)),
    state.replace(/\s+/g, ' ').slice(0, 240))

  // R6
  let connected = ''
  for (let i = 0; i < 12 && !/Connected/.test(connected); i++) {
    await owner.goto(`${BASE}/settings/online-shop`, { waitUntil: 'load' })
    await owner.waitForTimeout(5000)
    connected = await owner.getByTestId('online-shop-connected').innerText().then((t) => t.replace(/\s+/g, ' '), () => '')
  }
  step('R6 the stall\'s Online shop page shows the shop Connected', /Connected/.test(connected) && !/Waiting for the shop/.test(connected), connected.slice(0, 240))

  // R7
  await merchant.goto(INVITE, { waitUntil: 'domcontentloaded' })
  const status = await text(merchant)
  step('R7a the connect page says in service and names the stall', /in service/i.test(status) && status.includes(stall.slice(0, 8)), clean(status.slice(0, 300)))
  await merchant.request.post(INVITE, { form: { shop: SHOP, client_id: CLIENT_ID, client_secret: 'shpss_' + 'y'.repeat(32) } }).then(async (r) => {
    const body = await r.text()
    step('R7b a reconnect of an in-service shop is refused', /already connected and in service/i.test(body), `${r.status()} ${clean(body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 160))}`)
  })
  return finish(browser)
}

main().catch((e) => {
  console.error(clean(String(e?.stack ?? e)))
  process.exit(1)
})
