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
// The whole coupon by default: a part of one needs carving, which is imani-wallet#447.
const CODE_AMOUNT = process.env.E2E_CODE_AMOUNT ?? '20.00'
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
  // The wallet logs '[online-shop] ...' when the relay refuses the stall's profile: kept for W1e's detail.
  owner.on('console', (c) => { if (c.text().startsWith('[online-shop]')) relayFrames.push(`${new Date().toISOString().slice(11, 19)} ${c.text()}`) })
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

  // W2: cashback from the stall to a fresh customer, claimed in the customer's own browser.
  // First, stay on Terminals until the relay holds a profile naming the shop (or 90 s).
  const relayHasShop = async () => {
    const r = await fetch(`${BASE}/api/v1/nostr/query`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kinds: [30078], authors: [stall], limit: 20 }) })
    const j = (await r.json()) as { events: Array<{ content: string; tags: string[][] }> }
    return j.events.some((e) => e.tags.some((t) => t[0] === 'd' && t[1] === 'imani:merchant') && e.content.includes('online_shop'))
  }
  let advertised = false
  for (let i = 0; i < 18 && !advertised; i++) {
    advertised = await relayHasShop()
    if (!advertised) await owner.waitForTimeout(5_000)
  }
  step('W1e the stall\'s published profile names the shop', advertised, (relayFrames.filter((f) => f.includes('[online-shop]')).slice(-2).join(' / ')) || 'no relay warnings')
  if (!advertised) return finish(browser)
  const cust = await page()
  cust.on('requestfinished', async (r) => {
    if (!r.url().includes('/v1/checkout-codes') || r.method() !== 'POST') return
    const res = await r.response()
    if (!res || res.status() < 400) return
    const body = r.postData() ?? ''
    let parts = ''
    try {
      const j = JSON.parse(body) as { parts?: Array<{ token: string; amount: number }> }
      parts = (j.parts ?? []).map((p) => `${p.amount}:${p.token.length}ch`).join(',')
    } catch { parts = `unparsed ${body.length}ch` }
    info(`deposit ${res.status()} ${(await res.text().catch(() => '')).slice(0, 120)} parts=[${parts}]`)
  })
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
    await cust.getByLabel('Amount').fill(CODE_AMOUNT)
    await cust.getByRole('button', { name: 'Get code' }).click()
    code = await Promise.race([
      cust.getByTestId('checkout-code').innerText({ timeout: 120_000 }).then((s) => s.match(CODE_RE)?.[0] ?? '', () => ''),
      cust.getByText(/cannot be used online right now|No code could be made/).waitFor({ timeout: 120_000 }).then(() => '', () => ''),
    ])
    if (!code) break
  }
  step('W2b Use online makes a checkout code for this shop', !!code, code || (await text(cust)).slice(0, 300))
  if (!code) {
    const why = await cust.evaluate(() => {
      const out: string[] = []
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i) ?? ''
        if (/checkout/i.test(k)) out.push(`${k}: ${(localStorage.getItem(k) ?? '').match(/"refusal":"[^"]*"|"status":"[^"]*"/g)?.join(',') ?? ''}`)
      }
      return out.join(' | ')
    })
    info(`customer checkout records: ${why.slice(0, 600)}`)
    return finish(browser)
  }
  const codePage = cust.url()

  // W3
  const buyer = await page()
  await buyer.goto(`${SHOP}/?add-to-cart=${PRODUCT_ID}`, { waitUntil: 'domcontentloaded' })
  await buyer.goto(`${SHOP}/cart/`, { waitUntil: 'networkidle' })
  const totalOf = async () => {
    // The block cart renders prices client-side; its footer reads "Estimated total €39.00".
    const footer = buyer.locator('.wc-block-components-totals-footer-item, .order-total').first()
    await buyer.waitForFunction(() => /\d[.,]\d{2}/.test(document.querySelector('.wc-block-components-totals-footer-item, .order-total')?.textContent ?? ''), undefined, { timeout: 30_000 }).catch(() => {})
    const t = (await footer.innerText().catch(() => '')).replace(/\s+/g, ' ')
    const m = t.match(/([0-9]+[.,][0-9]{2})/)
    return m ? Number(m[1].replace(',', '.')) : NaN
  }
  const before = await totalOf()
  const classic = buyer.locator('#coupon_code')
  if (await classic.count()) {
    await classic.fill(code)
    await buyer.locator('button[name="apply_coupon"]').click()
  } else {
    await buyer.getByText(/^Add coupons?$/i).first().click()
    const input = buyer.locator('.wc-block-components-totals-coupon input, input[id*="coupon"]').first()
    await input.waitFor({ timeout: 15_000 })
    await input.fill(code)
    await buyer.locator('.wc-block-components-totals-coupon button, button:has-text("Apply")').first().click()
  }
  // The total re-renders after the store API answers.
  await buyer.waitForFunction((b) => {
    const t = document.querySelector('.wc-block-components-totals-footer-item, .order-total')?.textContent ?? ''
    const m = t.match(/([0-9]+[.,][0-9]{2})/)
    return !!m && Number(m[1].replace(',', '.')) !== b
  }, before, { timeout: 30_000 }).catch(() => {})
  const after = await totalOf()
  const cartText = await text(buyer)
  step('W3 the shop takes the code: the cart total drops by the code amount', Math.abs(before - after - Number(CODE_AMOUNT)) < 0.01, `total ${before} -> ${after} | ${cartText.match(/.{0,120}(Imani|IMANI-).{0,120}/)?.[0] ?? cartText.slice(0, 300)}`)
  if (!(before - after > 0)) return finish(browser)

  // W4
  await buyer.goto(`${SHOP}/checkout/`, { waitUntil: 'networkidle' })
  const fields: [string, string][] = [
    ['first_name', 'Test'], ['last_name', 'Buyer'], ['address_1', '1 Test Street'], ['city', 'Dublin'],
    ['postcode', 'D02 X285'], ['phone', '0851234567'],
  ]
  const email = buyer.locator('#billing_email, #email').first()
  if (await email.count()) await email.fill(`buyer${Date.now()}@example.com`)
  // Block checkout: shipping-* fields with billing the same; classic: billing_*.
  const country = buyer.locator('#shipping-country, #billing-country').first()
  if (await country.count()) await country.selectOption('IE').catch(() => {})
  await buyer.waitForTimeout(1_500) // the address fields re-render for the country
  // Ireland needs a county (shipping-state); pick Dublin, or the first real option.
  const state = buyer.locator('#shipping-state, #billing-state, #billing_state').first()
  if (await state.count()) {
    await state.selectOption({ label: 'Dublin' }).catch(async () => {
      const v = await state.evaluate((e) => [...(e as HTMLSelectElement).options].find((o) => o.value)?.value ?? '')
      if (v) await state.selectOption(v)
    })
  }
  for (const [k, v] of fields) {
    const f = buyer.locator(`#shipping-${k}, #billing_${k}, #billing-${k}`).first()
    if (await f.count()) await f.fill(v)
  }
  await buyer.locator('#radio-control-wc-payment-method-options-cod, input[value="cod"]').first().check().catch(() => {})
  buyer.on('response', async (r) => {
    if (/wc\/store\/v1\/checkout/.test(r.url()) && r.request().method() === 'POST') info(`store checkout ${r.status()} ${(await r.text().catch(() => '')).slice(0, 400)}`)
  })
  await buyer.waitForLoadState('networkidle').catch(() => {})
  const place = buyer.locator('button.wc-block-components-checkout-place-order-button, #place_order').first()
  await place.waitFor({ timeout: 30_000 })
  await buyer.waitForFunction(() => {
    const b = document.querySelector('button.wc-block-components-checkout-place-order-button, #place_order') as HTMLButtonElement | null
    return !!b && !b.disabled && !b.classList.contains('wc-block-components-button--loading')
  }, undefined, { timeout: 30_000 }).catch(() => {})
  // The form re-calculates totals (checkout?__experimental_calc_totals) as fields change; only a
  // POST to /checkout WITHOUT that flag places the order. Click, and click again if nothing went.
  const isPlace = (r: { url(): string; request(): { method(): string } }) =>
    /wc\/store\/v1\/checkout(\?|$)/.test(r.url()) && !/calc_totals/.test(r.url()) && r.request().method() === 'POST'
  let placedRes = null as Awaited<ReturnType<typeof buyer.waitForResponse>> | null
  for (let i = 0; i < 3 && !placedRes; i++) {
    const placed = buyer.waitForResponse(isPlace, { timeout: 30_000 }).catch(() => null)
    // After a click that did go, the button stays disabled while the order is processed: done.
    if (i > 0 && (await place.isDisabled().catch(() => true))) break
    await place.click({ timeout: 10_000 }).catch(() => {})
    placedRes = await placed
  }
  info(`place order -> ${placedRes ? `${placedRes.status()} ${(await placedRes.text().catch(() => '')).match(/"order_id":\d+,"status":"[^"]*"|"message":"[^"]*"/g)?.join(' ') ?? ''}` : 'no order request'}`)
  await buyer.waitForURL(/order-received/, { timeout: 120_000 }).catch(() => {})
  if (!/order-received/.test(buyer.url())) {
    await buyer.screenshot({ path: `${process.env.JCODE_SCRATCH_DIR ?? '/tmp'}/woo-checkout-fail.png`, fullPage: true }).catch(() => {})
    info(`checkout notices: ${(await buyer.locator('.wc-block-components-notice-banner, .woocommerce-error, .wc-block-components-validation-error').allInnerTexts().catch(() => [])).join(' | ').slice(0, 500)}`)
  }
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
  // The customer pays the rest only: the order total is the cart total less the code. Read from the
  // customer's own order-received page (its "Total:" row), which is what they were charged.
  const receivedText = (await buyer.locator('.woocommerce-order-overview__total, .wc-block-order-confirmation-totals, .woocommerce-table--order-details tfoot').allInnerTexts().catch(() => [])).join(' ').replace(/\s+/g, ' ')
  const orderTotal = Number((receivedText.match(/Total:?\s*€\s?([0-9]+[.,][0-9]{2})(?![\s\S]*Total:?\s*€)/i)?.[1] ?? receivedText.match(/€\s?([0-9]+[.,][0-9]{2})/)?.[1] ?? 'NaN').replace(',', '.'))
  step('W4d the order charges only the rest (cart total less the code)', Math.abs(orderTotal - after) < 0.01, `order total ${orderTotal}, cart after code ${after}, before ${before}`)

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
