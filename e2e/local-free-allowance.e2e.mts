/**
 * LOCAL stack: a FREE merchant at 30 of its 100 lifetime allowance tries 100 and is refused with an
 * invitation to upgrade, nothing is issued; 70.01 is refused; 70 (exactly at the cap) is allowed.
 *
 *   npx tsx e2e/local-free-allowance.e2e.mts
 */
import { chromium, type Browser, type Page } from 'playwright'

const BASE = process.env.E2E_BASE ?? 'http://localhost:5173'
const PW = 'correct horse battery'
const log: string[] = []
const text = async (p: Page) => (await p.locator('body').innerText()).replace(/\s+/g, ' ')
const UPGRADE = /\/settings\/subscription\?reason=sales-limit$/
const fail = (msg: string): never => {
  console.log(`FAIL  ${msg}`)
  process.exit(1)
}

async function register(browser: Browser, merchant: boolean): Promise<{ page: Page; handle: string }> {
  const page = await (await browser.newContext({ viewport: { width: 420, height: 900 } })).newPage()
  page.on('response', async (r) => {
    if (r.url().includes('/api/v1/portal/vouchers') && r.request().method() === 'POST') {
      const body = await r.text().catch(() => '')
      log.push(`POST /api/v1/portal/vouchers -> ${r.status()} ${body.slice(0, 220)}`)
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
    await page.locator('input[placeholder="Bridge Street Coffee"]').fill('Free Stall')
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByRole('button', { name: 'Food' }).click()
    await page.getByRole('button', { name: 'Create merchant account' }).click()
  } else {
    await page.getByRole('button', { name: 'Create account' }).click()
  }
  await page.getByText('You are all set').waitFor({ timeout: 90_000 }).catch(() => fail('registration'))
  await page.getByText('I have saved my backup key somewhere safe.').click()
  await page.getByRole('button', { name: 'Continue to my wallet' }).click()
  await page.waitForTimeout(2000)
  console.log(`PASS  ${merchant ? 'merchant' : 'customer'} registered @${handle}`)
  return { page, handle }
}

async function sell(p: Page, customer: string, amount: string): Promise<'sent' | 'limit' | string> {
  await p.goto(`${BASE}/sell`, { waitUntil: 'load' })
  await p.locator('input[placeholder="name"]').or(p.getByTestId('sales-limit-upgrade-banner')).first()
    .waitFor({ timeout: 30_000 })
  if (UPGRADE.test(p.url())) return 'limit'
  await p.locator('input[placeholder="name"]').fill(customer)
  await p.getByRole('button', { name: 'Continue' }).click()
  const field = p.locator('input[placeholder="0.00"], input[placeholder="0"]').first()
  await field.waitFor({ timeout: 30_000 })
  await field.fill(amount)
  await p.getByRole('button', { name: 'Send voucher' }).click()
  const sent = p.getByText(new RegExp(`Sent to ${customer}`))
  const limit = p.getByTestId('sales-limit-upgrade-banner')
  const which = await Promise.race([
    sent.waitFor({ timeout: 120_000 }).then(() => 'sent' as const),
    limit.waitFor({ timeout: 120_000 }).then(() => 'limit' as const),
  ]).catch(async () => `neither: ${(await text(p)).slice(-300)}`)
  return which
}

async function main() {
  const browser = await chromium.launch()
  try {
    const m = await register(browser, true)
    const c = await register(browser, false)
    const p = m.page

    if ((await sell(p, c.handle, '30.00')) !== 'sent') fail('30.00 should be issued')
    console.log('PASS  30.00 issued (30 of 100 used)')

    const r100 = await sell(p, c.handle, '100.00')
    if (r100 !== 'limit') fail(`100.00 should be refused, got ${r100}`)
    if (!UPGRADE.test(p.url())) fail(`100.00 should land on the subscription screen, at ${p.url()}`)
    const banner = await p.getByTestId('sales-limit-upgrade-banner').innerText()
    console.log(`PASS  100.00 refused, sent to ${new URL(p.url()).pathname}${new URL(p.url()).search}: "${banner.replace(/\s+/g, ' ')}"`)

    if ((await sell(p, c.handle, '70.01')) !== 'limit') fail('70.01 should be refused')
    console.log('PASS  70.01 refused')
    if ((await sell(p, c.handle, '70.00')) !== 'sent') fail('70.00 (exactly at the cap) should be issued')
    console.log('PASS  70.00 issued (100 of 100 used)')
    // At the cap: pressing Sell goes straight to the subscription screen, no customer scanned.
    await p.goto(`${BASE}/`, { waitUntil: 'load' })
    await p.getByRole('button', { name: /^Sell$/ }).first().click()
    await p.waitForURL(UPGRADE, { timeout: 30_000 }).catch(() => fail(`Sell at the cap stayed at ${p.url()}`))
    await p.getByTestId('sales-limit-upgrade-banner').waitFor({ timeout: 30_000 })
    if (await p.locator('input[placeholder="name"]').count()) fail('the Sell form showed at the cap')
    await p.screenshot({ path: process.env.SHOT ?? 'free-allowance-refused.png', fullPage: true })
    console.log('PASS  pressing Sell at the cap opens the subscription screen with the upgrade message')
    await p.goto(`${BASE}/sell/cashback`, { waitUntil: 'load' })
    await p.waitForURL(UPGRADE, { timeout: 30_000 }).catch(() => fail('Cashlink at the cap was not redirected'))
    console.log('PASS  Cashlink at the cap opens the subscription screen too')
    console.log(`MERCHANT_HANDLE=${m.handle}`)
    console.log('\n' + log.join('\n'))
  } finally {
    await browser.close()
  }
}

void main()
