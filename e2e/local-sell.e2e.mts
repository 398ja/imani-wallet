/**
 * Smoke test for the LOCAL stack: a merchant sells a voucher and the customer receives it.
 *
 *   ./deploy/up.sh && npm run dev      # the stack, and the wallet on :5173
 *   npx tsx e2e/local-sell.e2e.mts
 *
 * Registers a fresh merchant (with a stall) and a fresh customer in two browser contexts, sells
 * the customer EUR 2.50 from the Sell screen, then opens the customer's wallet and checks the
 * balance. This is the path every local stack fix of 2026-10-27/28 was about: keyset ids, mint
 * keys in HashiCorp, the wallet passphrase, mint URL validation, service tokens, and the
 * two-database layout. It fails loudly at the first step that does not happen.
 */
import { chromium, type Browser, type Page } from 'playwright'

const BASE = process.env.E2E_BASE ?? 'http://localhost:5173'
const PW = 'correct horse battery'
const AMOUNT = '2.50'

const httpErrors = new Set<string>()
const text = async (p: Page) => (await p.locator('body').innerText()).replace(/\s+/g, ' ')
const fail = (msg: string): never => {
  console.log(`FAIL  ${msg}`)
  process.exit(1)
}

async function register(browser: Browser, merchant: boolean): Promise<{ page: Page; handle: string }> {
  const page = await (await browser.newContext({ viewport: { width: 420, height: 900 } })).newPage()
  page.on('response', (r) => {
    if (r.url().includes('/api/') && r.status() >= 400 && !/resolve|subscribe|session/.test(r.url())) {
      httpErrors.add(`${r.status()} ${r.url().replace(BASE, '').split('?')[0].slice(0, 80)}`)
    }
  })
  await page.goto(`${BASE}/`, { waitUntil: 'load' })
  await page.getByText('Register').first().click()
  const handle = (merchant ? 'm' : 'c') + Math.random().toString(36).slice(2, 9)
  await page.locator('input[type=text]:visible').first().fill(handle)
  const pw = page.locator('input[type=password]:visible')
  await pw.nth(0).fill(PW)
  await pw.nth(1).fill(PW)
  if (merchant) await page.getByRole('switch').first().check({ force: true })
  const boxes = page.locator('input[type=checkbox]:not([role=switch])')
  for (let i = 0; i < (await boxes.count()); i++) await boxes.nth(i).check({ force: true })
  if (merchant) {
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.locator('input[placeholder="Bridge Street Coffee"]').fill('Test Stall')
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByRole('button', { name: 'Food' }).click()
    await page.getByRole('button', { name: 'Create merchant account' }).click()
  } else {
    await page.getByRole('button', { name: 'Create account' }).click()
  }
  await page
    .getByText('You are all set')
    .waitFor({ timeout: 90_000 })
    .catch(() => fail(`${merchant ? 'merchant' : 'customer'} registration: ${[...httpErrors].join(', ')}`))
  await page.getByText('I have saved my backup key somewhere safe.').click()
  await page.getByRole('button', { name: 'Continue to my wallet' }).click()
  await page.waitForTimeout(2000)
  console.log(`PASS  ${merchant ? 'merchant' : 'customer'} registered @${handle}`)
  return { page, handle }
}

async function main() {
  const browser = await chromium.launch()
  try {
    const m = await register(browser, true)
    const c = await register(browser, false)

    const p = m.page
    await p.goto(`${BASE}/sell`, { waitUntil: 'load' })
    await p.locator('input[placeholder="name"]').fill(c.handle)
    await p.getByRole('button', { name: 'Continue' }).click()
    const amount = p.locator('input[placeholder="0.00"], input[placeholder="0"]').first()
    await amount.waitFor({ timeout: 30_000 })
    await amount.fill(AMOUNT)
    await p.getByRole('button', { name: 'Send voucher' }).click()
    const t0 = Date.now()
    const sent = await p
      .getByText(new RegExp(`Sent to ${c.handle}`))
      .waitFor({ timeout: 120_000 })
      .then(() => true, () => false)
    if (!sent) fail(`sale did not complete: ${(await text(p)).slice(-300)}`)
    console.log(`PASS  sale completed in ${Math.round((Date.now() - t0) / 1000)}s`)

    let balance = ''
    for (let i = 0; i < 12 && !balance.includes(`€${AMOUNT}`); i++) {
      await c.page.goto(`${BASE}/`, { waitUntil: 'load' })
      await c.page.waitForTimeout(5000)
      balance = await text(c.page)
    }
    if (!balance.includes(`€${AMOUNT}`)) fail(`customer balance: ${balance.slice(0, 200)}`)
    console.log(`PASS  customer wallet shows €${AMOUNT}`)
    console.log(`\nhttp errors seen (non-fatal): ${[...httpErrors].join(' | ') || 'none'}`)
  } finally {
    await browser.close()
  }
}

void main()
