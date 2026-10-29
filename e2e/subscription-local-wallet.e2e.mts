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
    // A new stall holds no licence: the wallet names the free tier as the website does.
    const before = await text(wallet)
    check('a new stall’s wallet shows the Starter plan, never "Free" or "Basic"', /Plan Starter/.test(before) && !/Plan Free|Basic/.test(before), before.slice(0, 400))

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
    check('yearly by default, in pounds: Essentials £70/year, Pro £250/year', /£70\/year/.test(yearly) && /£250\/year/.test(yearly), yearly.slice(0, 500))
    check('Essentials issues without limit on 3 tills', /Unlimited voucher issuance/.test(yearly) && /plus 3 tills/.test(yearly), yearly.slice(0, 500))
    await site.getByRole('radio', { name: /Monthly/ }).click()
    const monthly = await text(site)
    check('monthly, in pounds: Essentials £8/month, Pro £25/month', /£8\/month/.test(monthly) && /£25\/month/.test(monthly), monthly.slice(0, 500))
    check('the plans page never says Basic', !/Basic/.test(yearly) && !/Basic/.test(monthly))

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
    check('the account page never says Basic', !/Basic/.test(account), account.slice(0, 300))

    let plan = ''
    for (let i = 0; i < 20 && !/Essentials/.test(plan); i++) {
      await wallet.goto(`${WALLET}/settings/subscription`, { waitUntil: 'load' })
      await wallet.waitForTimeout(5000)
      plan = await text(wallet)
    }
    check('the plan arrived in this local wallet: Settings › Subscription shows Essentials', /Essentials/.test(plan), plan.slice(0, 400))
    check('the wallet’s plan screen never says Basic', !/Basic/.test(plan), plan.slice(0, 400))

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

    // ---- Cancel in the REAL Stripe customer portal: the webhook must reach this wallet (#407).
    // At the wallet's phone width the portal's confirm button sits under its sticky footer and a
    // click never lands; the probe that first cancelled through the portal ran at desktop width.
    await site.setViewportSize({ width: 1280, height: 900 })
    await site.goto(`${SITE}/account`)
    await site.getByRole('button', { name: 'Card, invoices and cancellation' }).click()
    await site.waitForURL(/billing\.stripe\.com/, { timeout: 30_000 })
    await site.getByRole('link', { name: /cancel subscription/i }).or(site.getByRole('button', { name: /cancel subscription/i })).first().click()
    await site.waitForURL(/\/cancel/, { timeout: 30_000 })
    const stripeSub = new URL(site.url()).pathname.match(/sub_[A-Za-z0-9]+/)?.[0] ?? ''
    const key = process.env.STRIPE_SECRET_KEY ?? ''
    if (!key || !stripeSub) throw new Error('set STRIPE_SECRET_KEY (test) so the e2e can read the subscription at Stripe')
    const atStripe = async () =>
      (await (await fetch(`https://api.stripe.com/v1/subscriptions/${stripeSub}`, { headers: { Authorization: `Bearer ${key}` } })).json()) as { cancel_at: number | null }
    // As this account's portal does it (seen 2026-10-29): a "why are you leaving?" dialog with a
    // custom Reason dropdown, then "Continue to cancellation", then the review page's own
    // "Cancel subscription" button (`data-testid=confirm`), which is what cancels.
    const continueStep = site.getByText('Continue to cancellation')
    // `isVisible` does not wait (its timeout is ignored), so it read "no dialog" before the dialog
    // had opened, and the dialog then covered the confirm button. Wait for it to appear.
    const asksReason = await continueStep.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true, () => false)
    if (asksReason) {
      await site.getByText('Choose an option').click()
      await site.getByRole('option').first().click()
      await continueStep.click()
      // The dialog animates away; until it has, it is what a click on the confirm button lands on.
      await site.getByText('Continue to cancellation').waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined)
      await site.waitForTimeout(1500)
    }
    await site.locator('[data-testid=confirm]').click({ timeout: 20_000 })
    let cancelAt: number | null = null
    for (let i = 0; i < 20 && !cancelAt; i++) {
      await site.waitForTimeout(1500)
      cancelAt = (await atStripe()).cancel_at
    }
    check('cancelled in the real Stripe customer portal (Stripe has a cancel date)', Boolean(cancelAt), String(cancelAt))

    const until = async (want: RegExp, label: string) => {
      let screen = ''
      for (let i = 0; i < 24 && !want.test(screen); i++) {
        await wallet.goto(`${WALLET}/settings/subscription`, { waitUntil: 'load' })
        await wallet.waitForTimeout(5000)
        screen = await text(wallet)
      }
      check(label, want.test(screen), screen.slice(0, 500))
      return screen
    }
    const cancelled = await until(/Cancelled/, 'the wallet says Cancelled, from the webhook, with no other step')
    check('it says when the plan ends and that it will not renew', /works until .* and will not renew/.test(cancelled) && /Renews No, cancelled/.test(cancelled), cancelled.slice(0, 500))
    check('the plan still works to its end: still Essentials, still unlocks', /Essentials/.test(cancelled) && /Unlocks/.test(cancelled), cancelled.slice(0, 500))

    // ---- Undo it: the same `customer.subscription.updated` webhook, cancel_at cleared. Done through
    // Stripe's API (the portal on this account offers no "renew" button), so Stripe itself sends it.
    const undo = await fetch(`https://api.stripe.com/v1/subscriptions/${stripeSub}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'cancel_at=',
    })
    check('cancellation undone at Stripe', undo.ok, String(undo.status))
    const back = await until(/\bActive\b/, 'the wallet says Active again once the cancellation is undone')
    check('and Renews Yes', /Renews Yes/.test(back), back.slice(0, 500))
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
