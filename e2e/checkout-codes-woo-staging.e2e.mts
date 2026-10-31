/**
 * #402 against the REAL staging WooCommerce shop (shop.staging.398ja.xyz), in real browsers.
 * checkout-codes-staging.e2e.mts plays the shop with coupon-core from PHP; this one uses the
 * deployed WordPress + WooCommerce + imani-checkout-codes plugin, through their own pages.
 *
 *   W0  the plugin's settings page shows the shop's enrolment code
 *   W1  a fresh staging stall enrols the shop (Settings > Terminals > Add, redeem-only), its setup
 *       code goes into the plugin's settings, and "Check for the credential" finds the credential
 *   W2  a customer claims the stall's cashback, opens Use online for the stall (the shop is on the
 *       stall's profile now), and gets a checkout code
 *   W3  a buyer puts the code in the shop's coupon field on a real cart: the total drops
 *   W4  the order is placed (cash on delivery) and set to Processing; the plugin redeems the code
 *       and the wallet shows the code as used
 *
 * The shop is SHARED staging state: every run re-enrols it with the run's own fresh stall, which
 * replaces the previous enrolment (one stall per shop).
 *
 * Env: E2E_SHOP_ADMIN_PASSWORD (required: wp user shopadmin, in ~/woocommerce-staging/.env on the
 * host), E2E_BASE (wallet, default staging), E2E_SHOP (default https://shop.staging.398ja.xyz).
 * Run:  TSX_TSCONFIG_PATH=tsconfig.app.json npx tsx e2e/checkout-codes-woo-staging.e2e.mts
 */
import { chromium, type Browser, type Page } from 'playwright'
import { registerCustomer, registerMerchant } from './register.mts'

const BASE = (process.env.E2E_BASE ?? 'https://wallet.staging.398ja.xyz').replace(/\/+$/, '')
const SHOP = (process.env.E2E_SHOP ?? 'https://shop.staging.398ja.xyz').replace(/\/+$/, '')
const ADMIN_PW = process.env.E2E_SHOP_ADMIN_PASSWORD ?? ''
if (!ADMIN_PW) throw new Error('E2E_SHOP_ADMIN_PASSWORD is required (wp user shopadmin)')
const PRODUCT_ID = Number(process.env.E2E_SHOP_PRODUCT ?? 32) // Pour-over Kit, EUR 39.00 in the seed
const CODE_RE = /IMANI-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}/

const failures: string[] = []
const t0 = Date.now()
const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`)
const info = (s: string) => log(`  INFO ${s}`)
function step(name: string, ok: boolean, detail = '') {
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  | ${detail}` : ''}`)
  if (!ok) failures.push(name)
}
const text = async (p: Page) => (await p.locator('body').innerText()).replace(/\s+/g, ' ')
const msgOf = (p: Page) => decodeURIComponent(new URL(p.url()).searchParams.get('imani_msg') ?? '')

async function wpLogin(p: Page) {
  await p.goto(`${SHOP}/wp-login.php`, { waitUntil: 'domcontentloaded' })
  await p.fill('#user_login', 'shopadmin')
  await p.fill('#user_pass', ADMIN_PW)
  await Promise.all([p.waitForURL(/wp-admin/, { timeout: 60_000 }), p.click('#wp-submit')])
}
const settingsUrl = `${SHOP}/wp-admin/options-general.php?page=imani-checkout`

async function main() {
  log(`==== #402 on the real staging shop  wallet=${BASE} shop=${SHOP}`)
  const browser = await chromium.launch()
  const page = async () => (await browser.newContext({ locale: 'en-GB', serviceWorkers: 'block' })).newPage()

  const relayFrames: string[] = []
  const owner = await page()
  // Trace the stall's profile writes: localStorage merchant record changes, as they happen.
  await owner.addInitScript(() => {
    const W = window.WebSocket
    class Traced extends W {
      constructor(url: string | URL, p?: string | string[]) {
        super(url, p)
        const stack = (new Error().stack ?? '').split('\n').slice(2, 5).map((l) => l.trim().replace(/https?:\/\/[^/]+\/assets\//, '')).join(' < ')
        console.log(`[trace] ws new ${String(url)} from ${stack.slice(0, 260)}`)
        this.addEventListener('close', (e) => console.log(`[trace] ws close code=${(e as CloseEvent).code}`))
      }
      send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        const s = String(data)
        if (s.startsWith('["EVENT"')) console.log(`[trace] ws send EVENT state=${this.readyState} online_shop=${s.includes('online_shop')}`)
        return super.send(data)
      }
      close(code?: number, reason?: string) {
        const stack = (new Error().stack ?? '').split('\n').slice(2, 4).map((l) => l.trim().replace(/https?:\/\/[^/]+\/assets\//, '')).join(' < ')
        console.log(`[trace] ws close() state=${this.readyState} from ${stack.slice(0, 200)}`)
        return super.close(code, reason)
      }
    }
    ;(window as unknown as { WebSocket: typeof WebSocket }).WebSocket = Traced as unknown as typeof WebSocket
  })
  await owner.addInitScript(() => {
    const orig = Storage.prototype.setItem
    Storage.prototype.setItem = function (k: string, v: string) {
      if (k.startsWith('imani-wallet:merchant:') || k.startsWith('imani-wallet:online-shop-published:')) {
        console.log(`[trace] setItem ${k.split(':')[1]} online_shop=${v.includes('"onlineShop"') || v.includes('|')} eventAt=${(v.match(/"eventAt":(\d+)/) ?? [])[1] ?? '-'}`)
      }
      return orig.call(this, k, v)
    }
  })
  owner.on('console', (c) => { if (c.text().startsWith('[trace]') || c.text().startsWith('[online-shop]')) relayFrames.push(`${new Date().toISOString().slice(11, 19)} ${c.text()}`) })
  owner.on('websocket', (ws) => {
    const t = () => new Date().toISOString().slice(11, 19)
    relayFrames.push(`${t()} open ${ws.url()}`)
    ws.on('close', () => relayFrames.push(`${t()} close`))
    ws.on('socketerror', (e) => relayFrames.push(`${t()} error ${ws.url()} ${e}`))
    ws.on('framesent', (f) => {
      const s = String(f.payload)
      relayFrames.push(`${t()} sent ${s.slice(0, 40)} len=${s.length} merchant=${s.includes('imani:merchant')} online_shop=${s.includes('online_shop')}`)
    })
    ws.on('framereceived', (f) => {
      const s = String(f.payload)
      if (s.startsWith('["OK"')) relayFrames.push(`recv ${s.slice(0, 160)}`)
    })
  })
  owner.on('console', (c) => { if (/online.?shop|profile|publish/i.test(c.text())) relayFrames.push(`console ${c.text().slice(0, 200)}`) })
  owner.on('requestfinished', async (r) => {
    if (!r.url().includes('/api/v1/nostr/events') || r.method() !== 'POST') return
    const body = r.postData() ?? ''
    const res = await r.response()
    relayFrames.push(`mirror ${res?.status()} kind=${(body.match(/"kind":(\d+)/) ?? [])[1]} merchant=${body.includes('imani:merchant')} online_shop=${body.includes('online_shop')}`)
  })
  owner.on('pageerror', (e) => relayFrames.push(`pageerror ${e.message.slice(0, 200)}`))
  const handle = await registerMerchant(owner, BASE)
  const stall = await owner.evaluate(() => {
    for (let i = 0; i < localStorage.length; i++) {
      const k = /^imani-wallet:profile:([0-9a-f]{64})$/.exec(localStorage.key(i) ?? '')
      if (k) return k[1]
    }
    return ''
  })
  info(`stall ${handle} ${stall}`)

  // W0
  const admin = await page()
  await wpLogin(admin)
  await admin.goto(settingsUrl, { waitUntil: 'domcontentloaded' })
  // A readonly textarea: its value, not the page text.
  const enrol = ((await admin.locator('textarea[readonly]').first().inputValue().catch(() => '')).match(/imani-shop-enrol:1:\S+/)?.[0]) ?? ''
  step('W0 the plugin shows the shop\'s enrolment code', !!enrol, enrol.slice(0, 90))
  if (!enrol) return finish(browser)

  // W1
  await owner.goto(`${BASE}/settings/terminals/add`, { waitUntil: 'networkidle' })
  await owner.getByRole('button', { name: 'Add terminal' }).waitFor({ timeout: 30_000 })
  await owner.getByLabel('Name').fill('Staging shop')
  await owner.getByLabel(/Or enter the device's/).fill(enrol)
  await owner.getByRole('button', { name: 'Continue' }).click()
  const shopLine = await owner.getByText(/Online shop at shop\.staging\.398ja\.xyz/).waitFor({ timeout: 20_000 }).then(() => true, () => false)
  step('W1a the wallet reads the code as this online shop, redeem-only', shopLine, shopLine ? '' : (await text(owner)).slice(-300))
  if (!shopLine) return finish(browser)
  await owner.getByRole('button', { name: 'Add terminal' }).click()
  const setup = await owner.getByTestId('setup-code').innerText({ timeout: 120_000 }).then((s) => s.trim(), () => '')
  step('W1b the stall issues the shop its credential and a setup code', /^imani-terminal:1:[0-9a-f]{64}:/.test(setup), setup ? setup.slice(0, 60) : (await text(owner)).slice(-300))
  if (!setup) return finish(browser)

  await admin.goto(settingsUrl, { waitUntil: 'domcontentloaded' })
  await admin.fill('#expected', setup)
  await Promise.all([admin.waitForURL(/imani_msg=/, { timeout: 60_000 }), admin.getByRole('button', { name: 'Save', exact: true }).click()])
  info(`save: ${msgOf(admin)}`)
  let polled = ''
  for (let i = 0; i < 12; i++) {
    await admin.goto(settingsUrl, { waitUntil: 'domcontentloaded' })
    await Promise.all([admin.waitForURL(/imani_msg=/, { timeout: 60_000 }), admin.getByRole('button', { name: 'Check for the credential' }).click()])
    polled = msgOf(admin)
    info(`poll ${i + 1}: ${polled}`)
    if (/enrol|ready|received|stored/i.test(polled) && !/no credential|not yet|nothing/i.test(polled)) break
    await admin.waitForTimeout(10_000)
  }
  await admin.goto(settingsUrl, { waitUntil: 'domcontentloaded' })
  const enrolledPage = await text(admin)
  const enrolled = enrolledPage.includes(stall) || enrolledPage.includes(stall.slice(0, 16))
  step('W1c the plugin finds the credential and names the stall', enrolled, `${polled} | ${enrolledPage.slice(0, 300)}`)
  if (!enrolled) return finish(browser)

  // The plugin's "enrolled" notice turns the stall's row In service on the owner's Terminals page,
  // and that list republishes the profile with online_shop (onlineShopProfile.ts). As an owner would:
  // open Terminals and watch the row.
  let inService = false
  for (let i = 0; i < 12 && !inService; i++) {
    await owner.goto(`${BASE}/settings/terminals`, { waitUntil: 'networkidle' })
    // Rows sit under status headings ("In service", then the rows); a Waiting row says "Waiting for the device".
    inService = await owner.waitForFunction(() => {
      const t = document.body.innerText
      return /Staging shop/.test(t) && /In service/.test(t) && !/Staging shop[\s\S]{0,120}Waiting for the device/.test(t)
    }, undefined, { timeout: 15_000 }).then(() => true, () => false)
  }
  step('W1d the stall\'s Terminals list shows the shop In service (and advertises it)', inService, inService ? '' : (await text(owner)).slice(0, 300))
  if (!inService) return finish(browser)
  await owner.waitForTimeout(5_000) // the profile republish is fire-and-forget from that render
  const local = await owner.evaluate((s) => {
    const m = JSON.parse(localStorage.getItem(`imani-wallet:merchant:${s}`) ?? 'null') as { onlineShop?: unknown; eventAt?: number } | null
    return { hasMerchant: !!m, onlineShop: m?.onlineShop ?? null, eventAt: m?.eventAt ?? null, publishedMark: localStorage.getItem(`imani-wallet:online-shop-published:${s}`) }
  }, stall)
  info(`stall local record: ${JSON.stringify(local)}`)
  info(`stall relay frames: ${relayFrames.join(' || ') || 'none'}`)
  if (process.env.E2E_PROBE_PUBLISH) {
    const probe = await owner.evaluate(async () => {
      const ws = new WebSocket('wss://relay.staging.398ja.xyz')
      const opened = await new Promise<string>((ok) => { ws.onopen = () => ok('open'); ws.onerror = () => ok('error'); setTimeout(() => ok('timeout'), 5000) })
      if (opened !== 'open') return opened
      // A hand-made event with a deliberately bad sig: the relay must answer OK false. Proves EVENTs can leave this page.
      const reply = await new Promise<string>((ok) => {
        ws.onmessage = (m) => ok(String(m.data).slice(0, 120))
        ws.send(JSON.stringify(['EVENT', { id: '0'.repeat(64), pubkey: '1'.repeat(64), created_at: 1, kind: 1, tags: [], content: '', sig: '2'.repeat(128) }]))
        setTimeout(() => ok('no reply'), 5000)
      })
      ws.close()
      return `${opened} ${reply}`
    })
    info(`probe raw websocket from stall page: ${probe}`)
  }

  // W2: cashback from the stall to a fresh customer, claimed in the customer's own browser.
  const cust = await page()
  await registerCustomer(cust, BASE)
  const generated = owner.waitForResponse((r) => r.url().endsWith('/api/v1/portal/cashback/generate') && r.request().method() === 'POST', { timeout: 90_000 })
  await owner.goto(`${BASE}/sell/cashback`, { waitUntil: 'load' })
  await owner.locator('input[placeholder="0.00"]').fill('20.00', { timeout: 60_000 })
  await owner.getByRole('button', { name: 'Create Cashlink' }).click()
  const gen = (await (await generated).json()) as { claimUrl: string; claimKey: string }
  await cust.goto(`${BASE}/c/${new URL(gen.claimUrl).pathname.split('/').pop()}#k=${gen.claimKey}`, { waitUntil: 'load' })
  await cust.getByRole('button', { name: 'Add to my wallet' }).click({ timeout: 60_000 })
  await cust.waitForFunction(() => /Voucher added|Voucher unavailable/.test(document.body.innerText), undefined, { timeout: 90_000 }).catch(() => {})
  const added = /Voucher added/.test(await text(cust))
  step('W2a the customer holds EUR 20.00 from the stall', added)
  if (!added) return finish(browser)

  let code = ''
  for (let i = 0; i < 6 && !code; i++) {
    // The stall's profile names the shop once the enrolment published it; give the relay time.
    await cust.goto(`${BASE}/online?stall=${stall}`, { waitUntil: 'networkidle' })
    // "Checking your vouchers…" first, then the amount form, or a reason it cannot.
    await cust.waitForFunction(() => !/Checking your vouchers/.test(document.body.innerText), undefined, { timeout: 60_000 }).catch(() => {})
    const screen = await text(cust)
    if (!(await cust.getByLabel('Amount').count())) {
      info(`try ${i + 1}: ${screen.slice(0, 240)}`)
      await cust.waitForTimeout(10_000)
      continue
    }
    await cust.getByLabel('Amount').fill('10.00')
    await cust.getByRole('button', { name: 'Get code' }).click()
    code = await cust.getByTestId('checkout-code').innerText({ timeout: 120_000 }).then((s) => s.match(CODE_RE)?.[0] ?? '', () => '')
  }
  step('W2b Use online makes a checkout code for this shop', !!code, code || (await text(cust)).slice(0, 300))
  if (!code) return finish(browser)
  const codePage = cust.url()

  // W3
  const buyer = await page()
  await buyer.goto(`${SHOP}/?add-to-cart=${PRODUCT_ID}`, { waitUntil: 'domcontentloaded' })
  await buyer.goto(`${SHOP}/cart/`, { waitUntil: 'networkidle' })
  const totalOf = async () => {
    const t = await text(buyer)
    const m = [...t.matchAll(/Total\s*€\s?([0-9]+[.,][0-9]{2})|Total\s*([0-9]+[.,][0-9]{2})\s*€/g)].pop()
    return m ? Number((m[1] ?? m[2]).replace(',', '.')) : NaN
  }
  const before = await totalOf()
  const classic = buyer.locator('#coupon_code')
  if (await classic.count()) {
    await classic.fill(code)
    await buyer.locator('button[name="apply_coupon"]').click()
  } else {
    await buyer.getByRole('button', { name: /Add (a )?coupon/i }).first().click()
    await buyer.locator('.wc-block-components-totals-coupon input, input[id*="coupon"]').first().fill(code)
    await buyer.getByRole('button', { name: /^Apply$/ }).first().click()
  }
  await buyer.waitForTimeout(6_000)
  const after = await totalOf()
  const cartText = await text(buyer)
  step('W3 the shop takes the code: the cart total drops by EUR 10.00', Math.abs(before - after - 10) < 0.01, `total ${before} -> ${after} | ${cartText.match(/.{0,120}(Imani|IMANI-).{0,120}/)?.[0] ?? cartText.slice(0, 300)}`)
  if (!(before - after > 0)) return finish(browser)

  // W4
  await buyer.goto(`${SHOP}/checkout/`, { waitUntil: 'networkidle' })
  const fields: [string, string][] = [
    ['first_name', 'Test'], ['last_name', 'Buyer'], ['address_1', '1 Test Street'], ['city', 'Dublin'],
    ['postcode', 'D02 X285'], ['phone', '0851234567'],
  ]
  const email = buyer.locator('#billing_email, #email').first()
  if (await email.count()) await email.fill(`buyer${Date.now()}@example.com`)
  for (const [k, v] of fields) {
    const f = buyer.locator(`#billing_${k}, #billing-${k}`).first()
    if (await f.count()) await f.fill(v)
  }
  await buyer.locator('input[value="cod"]').first().check().catch(() => {})
  await buyer.getByRole('button', { name: /Place order/i }).click()
  await buyer.waitForURL(/order-received/, { timeout: 120_000 }).catch(() => {})
  const orderId = buyer.url().match(/order-received\/(\d+)/)?.[1] ?? ''
  step('W4a the order is placed with the code', !!orderId, orderId ? `order ${orderId}` : (await text(buyer)).slice(0, 400))
  if (!orderId) return finish(browser)

  // Cash on delivery collected: Processing is the plugin's redeem trigger.
  const orderUrl = `${SHOP}/wp-admin/admin.php?page=wc-orders&action=edit&id=${orderId}`
  await admin.goto(orderUrl, { waitUntil: 'domcontentloaded' })
  if (!(await admin.locator('#order_status').count())) await admin.goto(`${SHOP}/wp-admin/post.php?post=${orderId}&action=edit`, { waitUntil: 'domcontentloaded' })
  await admin.selectOption('#order_status', 'wc-processing')
  await Promise.all([admin.waitForLoadState('load'), admin.locator('button.save_order').first().click()])
  let notes = ''
  for (let i = 0; i < 12; i++) {
    await admin.reload({ waitUntil: 'domcontentloaded' })
    notes = (await admin.locator('ul.order_notes').innerText().catch(() => '')).replace(/\s+/g, ' ')
    if (/redeem/i.test(notes)) break
    await admin.waitForTimeout(10_000)
  }
  step('W4b paying the order redeems the code (order note, order not on hold)', /redeemed/i.test(notes) && !/on.hold|failed/i.test(notes), notes.slice(0, 400))

  let status = ''
  for (let i = 0; i < 9; i++) {
    await cust.goto(codePage, { waitUntil: 'networkidle' })
    status = (await text(cust)).match(/Status\s*([A-Za-z ]{3,20}?)\s*(Cancel|$|Done)/)?.[1]?.trim() ?? ''
    if (/used|redeemed|spent/i.test(status)) break
    await cust.waitForTimeout(10_000)
  }
  step('W4c the customer\'s wallet shows the code as used', /used|redeemed|spent/i.test(status), status)
  return finish(browser)
}

async function finish(browser: Browser) {
  await browser.close()
  log(`==== SUMMARY ${failures.length ? `${failures.length} failed: ${failures.join('; ')}` : 'all passed'} (${Math.round((Date.now() - t0) / 1000)}s)`)
  process.exit(failures.length ? 1 : 0)
}

main().catch((e) => {
  log(`FAIL  crashed: ${e instanceof Error ? e.stack : e}`)
  process.exit(1)
})
