/**
 * imani-wallet#280, real browser against the local gate or a dev server.
 *
 *   S1  A customer types a merchant's handle on Scan and lands on /merchants/:pubkey.
 *   S2  That profile draws Buy and Pay. The fresh test stall has no Stripe and the customer
 *       holds none of its vouchers, so both are disabled, each with its reason.
 *   S3  A customer's handle on Scan still goes to /send?to=.
 *   S4  Logged out, Buy on the stall's profile goes to /login and the purchase is remembered
 *       for after it (the return itself is covered by the afterLogin unit tests).
 *
 * Pay ENABLED needs a minted voucher from the stall, which this stack-light script does not
 * mint; the enablement rule is covered by src/lib/__tests__/merchantActions.test.ts.
 *
 *   E2E_BASE=http://localhost:<edge> npx tsx e2e/scanMerchantProfile.e2e.ts
 */
import { chromium, type Browser, type Page } from 'playwright'
import { registerCustomer, registerMerchant } from './register.mts'

const BASE = (process.env.E2E_BASE ?? 'http://localhost:5177').replace(/\/+$/, '')
const IGNORE_HTTPS_ERRORS = process.env.E2E_IGNORE_HTTPS_ERRORS === '1'

const failures: string[] = []
function check(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(name)
}

async function page(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({ locale: 'en-GB', ignoreHTTPSErrors: IGNORE_HTTPS_ERRORS })
  return ctx.newPage()
}

async function scanText(p: Page, text: string) {
  await p.goto(`${BASE}/scan`, { waitUntil: 'networkidle' })
  await p.getByLabel('Code').fill(text)
  await p.getByRole('button', { name: 'Continue' }).click()
}

async function main() {
  const browser = await chromium.launch()
  try {
    const stall = await page(browser)
    const stallHandle = await registerMerchant(stall, BASE)
    const friend = await page(browser)
    const friendHandle = await registerCustomer(friend, BASE)

    const shopper = await page(browser)
    await registerCustomer(shopper, BASE)

    console.log('\nS1/S2  scan a merchant -> its profile, Buy and Pay')
    await scanText(shopper, stallHandle)
    await shopper.waitForURL(/\/merchants\/[0-9a-f]{64}$/, { timeout: 30_000 }).catch(() => {})
    const stallUrl = shopper.url()
    check('S1 lands on /merchants/:pubkey', /\/merchants\/[0-9a-f]{64}$/.test(stallUrl), stallUrl)
    const buy = shopper.getByRole('button', { name: 'Buy a voucher with card' })
    const pay = shopper.getByRole('button', { name: 'Pay with your vouchers' })
    await buy.waitFor({ timeout: 20_000 }).catch(() => {})
    check('S2 Buy disabled for a stall without Stripe', await buy.isDisabled().catch(() => false))
    check('S2 Buy says why', (await shopper.getByText("Card payments aren't set up for this merchant").count()) === 1)
    check('S2 Pay disabled with no vouchers', await pay.isDisabled().catch(() => false))
    check('S2 Pay says why', (await shopper.getByText('You have no vouchers from this merchant yet').count()) === 1)

    console.log('\nS3  scan a customer -> send, as before')
    await scanText(shopper, friendHandle)
    await shopper.waitForURL(/\/send\?to=/, { timeout: 30_000 }).catch(() => {})
    check('S3 lands on /send?to=', /\/send\?to=[0-9a-f]{64}/.test(shopper.url()), shopper.url())

    console.log('\nS4  logged out: Buy -> login, purchase remembered')
    const visitor = await page(browser)
    await visitor.goto(stallUrl.replace(/^.*\/merchants\//, `${BASE}/merchants/`), { waitUntil: 'networkidle' })
    const vBuy = visitor.getByRole('button', { name: 'Buy a voucher with card' })
    await vBuy.waitFor({ timeout: 20_000 }).catch(() => {})
    check('S4 Pay disabled for a visitor', await visitor.getByRole('button', { name: 'Pay with your vouchers' }).isDisabled().catch(() => false))
    // The fresh stall takes no cards, so Buy is disabled here too; the login detour is
    // exercised when the stack runs with Stripe connected.
    if (await vBuy.isEnabled().catch(() => false)) {
      await vBuy.click()
      await visitor.waitForURL(/\/(login|onboarding)/, { timeout: 10_000 }).catch(() => {})
      const remembered = await visitor.evaluate(() => sessionStorage.getItem('imani:afterLogin'))
      check('S4 Buy goes to login with the purchase remembered', /\/buy\/[0-9a-f]{64}$/.test(remembered ?? ''), String(remembered))
    } else {
      console.log('  SKIP  S4 login detour: the test stall has no Stripe')
    }
  } finally {
    await browser.close()
  }
  console.log('')
  if (failures.length) {
    console.log(`${failures.length} FAILED:`)
    failures.forEach((f) => console.log(`  - ${f}`))
    process.exit(1)
  }
  console.log('all checks passed')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
