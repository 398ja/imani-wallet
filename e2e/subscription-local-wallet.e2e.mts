/**
 * The LOCAL deployment of the subscription site, driven like a stall would, with the REAL wallet:
 *
 *   ./deploy/up.sh && npm run dev                         # local stack + wallet on :5173
 *   GATEWAY=local ./deploy/subscription-local/up.sh       # site + service on :18910, Stripe test mode
 *   npx tsx e2e/subscription-local-wallet.e2e.mts
 *
 * Registers a fresh stall in the wallet dev server, opens Settings › Subscription, taps "Upgrade my
 * plan" (whose URL comes from VITE_SUBSCRIPTION_SITE_URL in .env.local), and checks the site opens
 * in its own tab already signed in as that stall. Pays Essentials monthly on Stripe's hosted Checkout
 * with the 4242 test card, then waits for the plan, minted and DM'd by the LOCAL gateway-customer,
 * to show in that same wallet's Settings › Subscription.
 */
import { chromium, type Page } from 'playwright'

const WALLET = process.env.E2E_BASE ?? 'http://localhost:5173'
const SITE = process.env.SUB_ORIGIN ?? 'http://localhost:18910'
const PW = 'correct horse battery'

const results: Array<[string, boolean]> = []
const check = (name: string, ok: boolean, detail = '') => {
  results.push([name, ok])
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `  (${detail})` : ''}`)
  if (!ok) throw new Error(name)
}
const text = async (p: Page) => (await p.locator('body').innerText()).replace(/\s+/g, ' ')

async function registerStall(page: Page): Promise<string> {
  await page.goto(`${WALLET}/`, { waitUntil: 'load' })
  await page.getByText('Register').first().click()
  const handle = 'sub' + Math.random().toString(36).slice(2, 8)
  await page.locator('input[type=text]:visible').first().fill(handle)
  const pw = page.locator('input[type=password]:visible')
  await pw.nth(0).fill(PW)
  await pw.nth(1).fill(PW)
  await page.getByRole('switch').first().check({ force: true })
  const boxes = page.locator('input[type=checkbox]:not([role=switch])')
  for (let i = 0; i < (await boxes.count()); i++) await boxes.nth(i).check({ force: true })
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.locator('input[placeholder="Bridge Street Coffee"]').fill('Plan Test Stall')
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Food' }).click()
  await page.getByRole('button', { name: 'Create merchant account' }).click()
  await page.getByText('You are all set').waitFor({ timeout: 90_000 })
  await page.getByText('I have saved my backup key somewhere safe.').click()
  await page.getByRole('button', { name: 'Continue to my wallet' }).click()
  await page.waitForTimeout(3000)
  return handle
}

async function fillStripe(page: Page, email: string) {
  await page.waitForURL(/checkout\.stripe\.com/, { timeout: 30_000 })
  await page.locator('#email').waitFor({ timeout: 30_000 })
  // What Stripe itself will charge: the published Essentials monthly price, in pounds.
  const summary = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  check('Stripe Checkout charges £8.00 a month for Essentials', /£8\.00/.test(summary) && /month/i.test(summary), summary.slice(0, 300))
  check('Stripe Checkout names the plan "Imani Essentials", never Basic', /Imani Essentials/.test(summary) && !/Basic/.test(summary), summary.slice(0, 300))
  await page.locator('#email').fill(email)
  await page.locator('#cardNumber').fill('4242424242424242')
  await page.locator('#cardExpiry').fill('12 / 34')
  await page.locator('#cardCvc').fill('123')
  await page.locator('#billingName').fill('Plan Test Stall')
  const country = page.locator('#billingCountry')
  if (await country.count()) await country.selectOption('GB')
  const postal = page.locator('#billingPostalCode')
  if (await postal.isVisible().catch(() => false)) await postal.fill('SW1A 1AA')
  for (const id of ['#billingAddressLine1', '#billingLocality']) {
    const f = page.locator(id)
    if (await f.isVisible().catch(() => false)) await f.fill(id.includes('Line1') ? '1 Test Street' : 'London')
  }
  await page.locator('button[type=submit], .SubmitButton').first().click()
}

async function main() {
  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 420, height: 900 } })
  const errors: string[] = []
  context.on('page', (p) => p.on('pageerror', (e) => errors.push(`${p.url()}: ${e.message}`)))
  try {
    const wallet = await context.newPage()
    const handle = await registerStall(wallet)
    check(`stall registered in the local wallet (@${handle})`, true)

    await wallet.goto(`${WALLET}/settings/subscription`, { waitUntil: 'load' })
    const upgrade = wallet.getByRole('link', { name: 'Upgrade my plan' })
    await upgrade.waitFor({ timeout: 20_000 })
    const href = await upgrade.getAttribute('href')
    check('Upgrade my plan points at the site this environment configured', href === SITE, String(href))

    const [site] = await Promise.all([context.waitForEvent('page'), upgrade.click()])
    await site.getByRole('button', { name: 'Choose Essentials' }).waitFor({ timeout: 30_000 })
    check('the site opened in its own tab, signed in, with no login page', new URL(site.url()).origin === SITE)

    // The plans as www.imani.casa/pricing publishes them, with the amounts read from REAL Stripe.
    await site.getByText('£70/year').waitFor({ timeout: 15_000 })
    const yearly = await text(site)
    check(
      'plans are Starter, Essentials and Pro, with no Town / BID partnership',
      /Starter/.test(yearly) && /Essentials/.test(yearly) && /Pro/.test(yearly) && !/Town|BID|Partner/.test(yearly),
      yearly.slice(0, 400),
    )
    check('yearly by default, in pounds: Essentials £70/year, Pro £100/year', /£70\/year/.test(yearly) && /£100\/year/.test(yearly), yearly.slice(0, 500))
    check('Essentials issues without limit on 3 tills', /Unlimited voucher issuance/.test(yearly) && /plus 3 tills/.test(yearly), yearly.slice(0, 500))
    await site.getByRole('radio', { name: /Monthly/ }).click()
    const monthly = await text(site)
    check('monthly, in pounds: Essentials £8/month, Pro £11/month', /£8\/month/.test(monthly) && /£11\/month/.test(monthly), monthly.slice(0, 500))

    await site.getByRole('button', { name: 'Choose Essentials' }).click()
    await fillStripe(site, `${handle}@example.com`)
    await site.waitForURL(new RegExp(`${SITE.replace(/[/.:]/g, '\\$&')}/done`), { timeout: 60_000 })
    check('paid on real Stripe test Checkout, back on the site still signed in', true)

    await site.goto(`${SITE}/account`)
    let account = ''
    for (let i = 0; i < 30 && !/Sent/.test(account); i++) {
      await site.waitForTimeout(3000)
      account = await text(site)
    }
    check('the local gateway minted and delivered it: account page says Sent', /Essentials/.test(account) && /Sent/.test(account), account.slice(0, 300))

    let plan = ''
    for (let i = 0; i < 20 && !/Essentials/.test(plan); i++) {
      await wallet.goto(`${WALLET}/settings/subscription`, { waitUntil: 'load' })
      await wallet.waitForTimeout(5000)
      plan = await text(wallet)
    }
    check('the plan arrived in this local wallet: Settings › Subscription shows Essentials', /Essentials/.test(plan), plan.slice(0, 400))

    // The notice the wallet raised for it names the plan, never a key (owner rule: no npubs).
    await wallet.locator('summary[aria-label^="Notifications"]').click()
    await wallet.waitForTimeout(500)
    const bell = (await wallet.locator('details:has(summary[aria-label^="Notifications"])').innerText()).replace(/\s+/g, ' ')
    check(
      'the notice names the plan ("Imani Essentials plan activated"), shows no key, and is not a payment',
      /Imani Essentials plan activated/.test(bell) && !/npub1|Licence from|\b[0-9a-f]{12,}\b|Payment on its way/.test(bell),
      bell.slice(0, 400),
    )
    check('no uncaught page errors', errors.length === 0, errors.join(' | '))
  } catch (e) {
    if (!(e instanceof Error && results.some(([n, ok]) => !ok && n === e.message))) console.log(`FAIL  flow  (${String(e).slice(0, 300)})`)
    for (const p of context.pages()) console.log(`--- ${p.url()}\n${(await text(p).catch(() => '')).slice(0, 500)}`)
  } finally {
    await browser.close()
  }
  const failed = results.filter(([, ok]) => !ok).length
  console.log(`\n${results.length - failed}/${results.length} passed`)
  process.exit(failed || results.length < 8 ? 1 : 0)
}

void main()
