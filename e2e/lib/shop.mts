/**
 * The WooCommerce shop's side of a checkout code, as a buyer and the shop admin do it, lifted from
 * e2e/checkout-codes-woo-staging.e2e.mts (W3, W4) so the real-day load test redeems codes at bart's
 * shop the way the shop does. The plugin (imani-checkout-codes) holds, then redeems on Processing,
 * through the code store's API with the shop's own redeem key: no harness holds that key.
 */
import type { Browser, Page } from 'playwright'

export type ShopOptions = { shop: string; productId?: number; adminPassword?: string }

const totalSelector = '.wc-block-components-totals-footer-item, .order-total'

async function cartTotal(buyer: Page): Promise<number> {
  await buyer.waitForFunction((sel) => /\d[.,]\d{2}/.test(document.querySelector(sel)?.textContent ?? ''), totalSelector, { timeout: 30_000 }).catch(() => {})
  const t = (await buyer.locator(totalSelector).first().innerText().catch(() => '')).replace(/\s+/g, ' ')
  const m = t.match(/([0-9]+[.,][0-9]{2})/)
  return m ? Number(m[1]!.replace(',', '.')) : Number.NaN
}

/** W3: the code in a real cart's coupon field. Returns the totals either side. */
export async function applyCode(buyer: Page, o: ShopOptions, code: string): Promise<{ before: number; after: number }> {
  await buyer.goto(`${o.shop}/?add-to-cart=${o.productId ?? 32}`, { waitUntil: 'domcontentloaded' })
  await buyer.goto(`${o.shop}/cart/`, { waitUntil: 'networkidle' })
  const before = await cartTotal(buyer)
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
  await buyer.waitForFunction(({ b, sel }) => {
    const m = (document.querySelector(sel)?.textContent ?? '').match(/([0-9]+[.,][0-9]{2})/)
    return !!m && Number(m[1]!.replace(',', '.')) !== b
  }, { b: before, sel: totalSelector }, { timeout: 30_000 }).catch(() => {})
  return { before, after: await cartTotal(buyer) }
}

/** W4a: a cash-on-delivery order with the code. Returns the order id, or ''. */
export async function placeOrder(buyer: Page, o: ShopOptions): Promise<string> {
  await buyer.goto(`${o.shop}/checkout/`, { waitUntil: 'networkidle' })
  const email = buyer.locator('#billing_email, #email').first()
  if (await email.count()) await email.fill(`buyer${Date.now()}@example.com`)
  const country = buyer.locator('#shipping-country, #billing-country').first()
  if (await country.count()) await country.selectOption('IE').catch(() => {})
  await buyer.waitForTimeout(1_500)
  const state = buyer.locator('#shipping-state, #billing-state, #billing_state').first()
  if (await state.count()) await state.selectOption({ label: 'Dublin' }).catch(() => {})
  const fields: [string, string][] = [['first_name', 'Test'], ['last_name', 'Buyer'], ['address_1', '1 Test Street'], ['city', 'Dublin'], ['postcode', 'D02 X285'], ['phone', '0851234567']]
  for (const [k, v] of fields) {
    const f = buyer.locator(`#shipping-${k}, #billing_${k}, #billing-${k}`).first()
    if (await f.count()) await f.fill(v)
  }
  await buyer.locator('#radio-control-wc-payment-method-options-cod, input[value="cod"]').first().check().catch(() => {})
  await buyer.waitForLoadState('networkidle').catch(() => {})
  const place = buyer.locator('button.wc-block-components-checkout-place-order-button, #place_order').first()
  await place.waitFor({ timeout: 30_000 })
  const isPlace = (r: { url(): string; request(): { method(): string } }) =>
    /wc\/store\/v1\/checkout(\?|$)/.test(r.url()) && !/calc_totals/.test(r.url()) && r.request().method() === 'POST'
  for (let i = 0; i < 3; i++) {
    const placed = buyer.waitForResponse(isPlace, { timeout: 30_000 }).catch(() => null)
    if (i > 0 && (await place.isDisabled().catch(() => true))) break
    await place.click({ timeout: 10_000 }).catch(() => {})
    if (await placed) break
  }
  await buyer.waitForURL(/order-received/, { timeout: 120_000 }).catch(() => {})
  return buyer.url().match(/order-received\/(\d+)/)?.[1] ?? ''
}

/** W4b: the admin sets the order Processing; the plugin redeems the code. Returns the order notes. */
export async function processOrder(browser: Browser, o: ShopOptions, orderId: string): Promise<string> {
  const ctx = await browser.newContext({ locale: 'en-GB' })
  try {
    const admin = await ctx.newPage()
    await admin.goto(`${o.shop}/wp-login.php`, { waitUntil: 'domcontentloaded' })
    await admin.fill('#user_login', 'shopadmin')
    await admin.fill('#user_pass', o.adminPassword ?? '')
    await Promise.all([admin.waitForURL(/wp-admin/, { timeout: 60_000 }), admin.click('#wp-submit')])
    await admin.goto(`${o.shop}/wp-admin/admin.php?page=wc-orders&action=edit&id=${orderId}`, { waitUntil: 'domcontentloaded' })
    if (!(await admin.locator('#order_status').count())) await admin.goto(`${o.shop}/wp-admin/post.php?post=${orderId}&action=edit`, { waitUntil: 'domcontentloaded' })
    await admin.selectOption('#order_status', 'wc-processing')
    await Promise.all([admin.waitForLoadState('load'), admin.locator('button.save_order').first().click()])
    let notes = ''
    for (let i = 0; i < 12; i++) {
      await admin.reload({ waitUntil: 'domcontentloaded' })
      notes = (await admin.locator('ul.order_notes').innerText().catch(() => '')).replace(/\s+/g, ' ')
      if (/redeem/i.test(notes)) break
      await admin.waitForTimeout(10_000)
    }
    return notes
  } finally {
    await ctx.close().catch(() => {})
  }
}
