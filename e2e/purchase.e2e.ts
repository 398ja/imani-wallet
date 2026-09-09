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

/**
 * A stall that exists and cannot take cards — the incident's exact shape.
 *
 * Overridable because it is a row in the local test database, not a constant of
 * the product. The default is a seeded account with `charges_enabled = false`.
 * If a real stall completes Stripe onboarding it stops being usable here, which
 * is what `preflight` detects and says out loud.
 */
const RESTRICTED_STALL =
  process.env.E2E_STALL ?? '7203f8173204c7dbc2862a28115a51dd259d9fe19839fe0963ee1c360c8d1bdb'

/** Shaped like a pubkey, belonging to no stall. */
const UNKNOWN_STALL = 'a'.repeat(64)

/**
 * Fail early and by name if the fixture stall is not the shape this suite
 * needs.
 *
 * The default stall is a row in the local test database, and a reset stack, a
 * different machine, or a merchant who finishes onboarding will all change it.
 * Without this the refusal check fails with "does not take card payments"
 * instead of the expected "cannot accept card payments yet" — a message one
 * word away from the one being asserted, which reads like a product regression
 * rather than missing test data.
 *
 * ## The side effect, stated plainly
 *
 * There is no side-effect-free probe. `PurchaseCheckoutController` validates
 * the amount and the pubkey shape BEFORE it looks the account up, so any
 * request that reaches the chargeable check is a request that creates a real
 * Checkout Session when the stall turns out to be chargeable. That only happens
 * when the fixture is already wrong — the run then stops — and the session is
 * unpaid and expires on its own. Worth knowing, not worth a stray session on
 * every green run.
 */
async function preflight(page: Page): Promise<boolean> {
  const response = await page.request.post(`${BASE}/api/v1/checkout/purchase`, {
    data: { stallPubkey: RESTRICTED_STALL, amountMinor: 100, buyerPubkey: null },
    failOnStatusCode: false,
  })
  if (response.status() === 409) return true

  const why =
    response.status() === 200
      ? 'it CAN take cards now (onboarding completed?), so it cannot demonstrate a refusal'
      : response.status() === 404
        ? 'no connected account exists for it'
        : 'unexpected status'

  console.log(
    `  SKIP fixture stall ${RESTRICTED_STALL.slice(0, 12)}… answered ${response.status()}: ${why}.\n` +
      '       Expected 409. Set E2E_STALL to a stall with charges_enabled = false.',
  )
  return false
}

const failures: string[] = []
const pageErrors: string[] = []

/**
 * The button's real label. Matched exactly rather than by an alternation of
 * guesses: a regex like /Buy|Pay/ silently matches the wrong control if the
 * label changes, and `.first()` then clicks whatever it found. An exact name
 * that stops matching fails loudly, which is the behaviour worth having when
 * the point of the suite is to notice changes.
 */
const PAY_BUTTON = 'Pay by card'

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
 * Type an amount and press Pay, then wait for the outcome.
 *
 * Returns where the browser ended up, because "did we leave for Stripe" is the
 * question every check here is really asking.
 *
 * Waits for a real signal rather than sleeping: either an error paragraph
 * appears, or the URL leaves the Buy page. A fixed timeout would pass a slow
 * refusal as a success, and this suite exists to catch exactly the case where
 * the customer ends up somewhere they should not.
 */
async function attemptPurchase(p: Page, stall: string, amount: string): Promise<string> {
  await goto(p, `${BASE}/buy/${stall}`)
  await p.locator('input:visible').first().fill(amount)
  await p.getByRole('button', { name: PAY_BUTTON }).click()

  await Promise.race([
    p.waitForURL((url) => !url.pathname.includes('/buy/'), { timeout: 15_000 }).catch(() => {}),
    p.locator('p.text-red-600, [role="alert"]').first().waitFor({ timeout: 15_000 }).catch(() => {}),
    // The screen can also settle by re-enabling the button after `busy`.
    p.getByRole('button', { name: PAY_BUTTON }).waitFor({ timeout: 15_000 }).catch(() => {}),
  ])
  // A short settle for the redirect to commit, once something has happened.
  await p.waitForTimeout(500)
  return p.url()
}

async function main(): Promise<void> {
  const browser: Browser = await chromium.launch()
  const context = await browser.newContext()
  const page = await context.newPage()

  page.on('pageerror', (error) => pageErrors.push(String(error)))

  try {
    console.log('\nPreflight')
    const ready = await preflight(page)
    check('the fixture stall exists and cannot take cards', ready)
    if (!ready) {
      // Everything below asserts on that stall's refusal, so continuing would
      // print a screen of failures that all mean "wrong test data".
      throw new Error('fixture stall unusable; see SKIP above')
    }

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
    const buy = page.getByRole('button', { name: PAY_BUTTON })
    check('Pay is disabled with an empty amount', await buy.isDisabled())
    await page.locator('input:visible').first().fill('0')
    await page.waitForTimeout(200)
    check('Pay is disabled for a zero amount', await buy.isDisabled())

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
