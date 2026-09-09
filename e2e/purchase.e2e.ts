/**
 * The card purchase, driven through the real Buy screen in a real browser.
 *
 * ## The bug this exists for
 *
 * A shopper reached Stripe's hosted checkout, typed a card, and got a 400 on
 * `POST /v1/payment_pages/cs_.../confirm`. The stall's connected account had
 * never been asked for the `card_payments` capability:
 *
 * ```
 * charges_enabled: true   payouts_enabled: true   details_submitted: true
 * requirements.currently_due: []      disabled_reason: null
 * capabilities: {transfers: active}   card_payments: unrequested
 * ```
 *
 * Express grants `transfers` by default and transfers ALONE set
 * `charges_enabled`, so every flag we stored said the stall could sell. The
 * refusal happened inside Stripe's own page, in a request our code never makes,
 * and nothing on our side logged a thing.
 *
 * ## Why a browser test, and why THIS assertion
 *
 * `BuyPage` and `purchase.ts` both open with the same promise in prose:
 * everything refusable is decided BEFORE the customer sees a card form,
 * "because a payment page that fails after somebody has typed their card number
 * is the worst place to learn a stall is misconfigured". That promise was false
 * and no test held it, because holding it needs the real screen, the real
 * proxy, the real controller and the real account state at once.
 *
 * So this does not assert that a purchase succeeds. It asserts the REFUSAL
 * LANDS ON OUR SCREEN: a stall that cannot take a card must fail on the Buy
 * page, in our words, with no navigation to checkout.stripe.com. That is the
 * invariant the incident violated, and unlike "a payment completes" it needs no
 * fully-onboarded Stripe account to run, so it will still run in CI a year from
 * now.
 *
 * A completed payment cannot be tested here anyway: finishing Stripe's hosted
 * form requires a connected account through full Express onboarding, with a
 * bank account and TOS acceptance a script cannot supply. Driving Stripe's own
 * DOM would also be testing Stripe, and it changes without telling us.
 *
 * ## Running
 *
 *   npm run dev -- --port 5177        # dev server, for the API proxy
 *   npx tsx e2e/purchase.e2e.ts
 */
import { chromium, type Browser, type Page } from 'playwright'

const BASE = process.env.E2E_BASE ?? 'http://localhost:5177'

/** A stall that exists and cannot take cards — the incident's exact shape. */
const RESTRICTED_STALL =
  process.env.E2E_STALL ?? '35f7a28b6adc9a923686a4506a02cae0fcf634cb32f42675872a5bd07d67af47'

/** Shaped like a pubkey, belonging to no stall. */
const UNKNOWN_STALL = 'a'.repeat(64)

const failures: string[] = []
const pageErrors: string[] = []

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
    failures.push(label)
  }
}

/** `goto` with a retry: this host intermittently answers ERR_NETWORK_CHANGED. */
async function goto(p: Page, url: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await p.goto(url, { waitUntil: 'networkidle', timeout: 20_000 })
      return
    } catch (error) {
      if (attempt >= 3) throw error
      await p.waitForTimeout(500)
    }
  }
}

/**
 * Type an amount and press Buy, then wait for the outcome.
 *
 * Returns where the browser ended up, because "did we leave for Stripe" is the
 * question every check here is really asking.
 */
async function attemptPurchase(p: Page, stall: string, amount: string): Promise<string> {
  await goto(p, `${BASE}/buy/${stall}`)
  await p.locator('input:visible').first().fill(amount)
  await p.getByRole('button', { name: /Continue to payment|Buy|Pay/i }).first().click()
  // Long enough for the POST to answer and the screen to settle. Not
  // networkidle: a refusal leaves the page put, so there is nothing to wait on.
  await p.waitForTimeout(3000)
  return p.url()
}

async function main(): Promise<void> {
  const browser: Browser = await chromium.launch()
  const context = await browser.newContext()
  const page = await context.newPage()

  page.on('pageerror', (error) => pageErrors.push(String(error)))

  try {
    console.log('\nBuy screen renders')
    await goto(page, `${BASE}/buy/${RESTRICTED_STALL}`)
    const body = (await page.textContent('body')) ?? ''
    check('the Buy screen loads', /voucher|amount|buy/i.test(body))
    check('an amount field is present', (await page.locator('input:visible').count()) > 0)

    console.log('\nA stall that cannot take cards is refused ON OUR SCREEN')
    const restrictedUrl = await attemptPurchase(page, RESTRICTED_STALL, '15.00')
    check(
      'the customer never reaches Stripe',
      !restrictedUrl.includes('checkout.stripe.com'),
      `landed on ${restrictedUrl}`,
    )
    check('the customer is still on the Buy screen', restrictedUrl.includes('/buy/'))

    const refusal = (await page.textContent('body')) ?? ''
    check(
      "the refusal says the stall cannot take cards, in the service's own words",
      /cannot accept card payments yet/i.test(refusal),
      `screen read: ${refusal.replace(/\s+/g, ' ').slice(0, 160)}`,
    )
    check(
      'nothing suggests money moved',
      !/charged|paid|success|thank you/i.test(refusal),
    )

    console.log('\nA stall that does not exist is refused the same way')
    const unknownUrl = await attemptPurchase(page, UNKNOWN_STALL, '15.00')
    check('no navigation to Stripe', !unknownUrl.includes('checkout.stripe.com'))
    check(
      'told this stall does not take cards',
      /does not take card payments/i.test((await page.textContent('body')) ?? ''),
    )

    console.log('\nAmount validation happens before any network call')
    await goto(page, `${BASE}/buy/${RESTRICTED_STALL}`)
    const buy = page.getByRole('button', { name: /Continue to payment|Buy|Pay/i }).first()
    check('Buy is disabled with an empty amount', await buy.isDisabled())
    await page.locator('input:visible').first().fill('0')
    await page.waitForTimeout(200)
    check('Buy is disabled for a zero amount', await buy.isDisabled())

    console.log('\nNo uncaught page errors')
    check('the page threw nothing', pageErrors.length === 0, pageErrors.join(' | '))
  } finally {
    await browser.close()
  }

  console.log('')
  if (failures.length > 0) {
    console.log(`${failures.length} FAILED:`)
    failures.forEach((f) => console.log(`  - ${f}`))
    process.exit(1)
  }
  console.log('all checks passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
