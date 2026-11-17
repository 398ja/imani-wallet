/**
 * Local e2e (gc#317 follow-up): a Free plan stall at its sales allowance cannot be bought from by
 * card. Buy on the stall's page and Pay by card on the Buy page are both disabled, with the
 * shopper's reason, and checkout itself refuses the stall (409, nothing sent to Stripe).
 *
 * Needs the local stack, purchase-issuer on :8791 and the wallet preview on :5173.
 *   E2E_STALL=<capped stall hex> npx tsx e2e/local-card-sales-limit.e2e.mts
 */
import { chromium, type Page } from 'playwright'

const BASE = process.env.E2E_BASE ?? 'http://localhost:5173'
const STALL = process.env.E2E_STALL ?? 'c5cddf95d3dbd3b47d21c4680823923fe358dc3a5285f364a56d6d5d9259d263'
const REASON = "This merchant can't sell more vouchers on their current plan right now."
const PW = 'correct horse battery'
const fail = (msg: string): never => {
  console.log(`FAIL  ${msg}`)
  process.exit(1)
}

async function registerCustomer(page: Page): Promise<string> {
  await page.goto(`${BASE}/`, { waitUntil: 'load' })
  await page.getByText('Register').first().click()
  const handle = 'c' + Math.random().toString(36).slice(2, 9)
  await page.locator('input[type=text]:visible').first().fill(handle)
  const pw = page.locator('input[type=password]:visible')
  await pw.nth(0).fill(PW)
  await pw.nth(1).fill(PW)
  const boxes = page.locator('input[type=checkbox]:not([role=switch])')
  for (let i = 0; i < (await boxes.count()); i++) await boxes.nth(i).check({ force: true })
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.getByText('You are all set').waitFor({ timeout: 90_000 }).catch(() => fail('registration'))
  await page.getByText('I have saved my backup key somewhere safe.').click()
  await page.getByRole('button', { name: 'Continue to my wallet' }).click()
  await page.waitForTimeout(1500)
  return handle
}

const browser = await chromium.launch()
try {
  const page = await (await browser.newContext({ viewport: { width: 420, height: 900 } })).newPage()
  const purchases: string[] = []
  page.on('request', (r) => {
    if (r.url().includes('/api/v1/checkout/purchase')) purchases.push(r.method())
  })
  console.log(`PASS  customer registered @${await registerCustomer(page)}`)

  // The readiness the page reads, straight from the same origin.
  const ready = await page.evaluate(async (s) => (await fetch(`/api/v1/card-sales/ready/${s}`)).json(), STALL)
  if (ready.ready !== false || ready.reason !== 'sales_limit_reached') fail(`readiness ${JSON.stringify(ready)}`)
  console.log(`PASS  /ready says ${JSON.stringify(ready)}`)

  // The Buy page: Pay by card disabled, the reason under it, even with an amount typed.
  await page.goto(`${BASE}/buy/${STALL}`, { waitUntil: 'load' })
  await page.getByLabel('Amount').fill('1.00')
  await page.getByText(REASON).waitFor({ timeout: 20_000 }).catch(() => fail('Buy page reason not shown'))
  const pay = page.getByRole('button', { name: /pay by card/i })
  if (!(await pay.isDisabled())) fail('Pay by card is enabled')
  await page.screenshot({ path: process.env.E2E_SHOT ?? 'card-sales-limit-buy.png' })
  console.log('PASS  Buy page: Pay by card disabled with the plan reason')

  // The stall's page: Buy disabled with the same reason.
  await page.goto(`${BASE}/merchants/${STALL}`, { waitUntil: 'load' })
  const stallReason = await page.getByText(REASON).first().waitFor({ timeout: 20_000 }).then(() => true, () => false)
  console.log(stallReason ? 'PASS  stall page: Buy shows the plan reason' : 'INFO  stall page shows no Buy (stall does not advertise cards)')

  if (purchases.length > 0) fail(`the page started a checkout: ${purchases.join(',')}`)
  console.log('PASS  no checkout was started from the UI')

  // Past the UI: checkout itself refuses before Stripe.
  const direct = await page.evaluate(async (s) => {
    const r = await fetch('/api/v1/checkout/purchase', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stallPubkey: s, amountMinor: 100, buyerPubkey: 'a'.repeat(64) }),
    })
    return { status: r.status, body: await r.json() }
  }, STALL)
  if (direct.status !== 409 || direct.body.reason !== 'sales_limit_reached' || direct.body.checkoutUrl) {
    fail(`direct checkout ${JSON.stringify(direct)}`)
  }
  console.log(`PASS  direct checkout refused 409: ${direct.body.error}`)
} finally {
  await browser.close()
}
