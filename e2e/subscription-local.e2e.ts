/**
 * The LOCAL DEPLOYMENT (deploy/subscription-local) driven like a customer would, against REAL Stripe
 * test mode and STAGING gateway-customer:
 *
 *   ./deploy/subscription-local/up.sh && npx tsx e2e/subscription-local.e2e.ts
 *
 * Signs in with a fresh stall key, chooses Basic monthly, pays on Stripe's hosted Checkout with the
 * 4242 test card, waits for the forwarded invoice.paid, then reads the stall's staging inbox the
 * way the wallet does and verifies the licence with the wallet's own code.
 */
import { chromium } from 'playwright'
import { generateSecretKey, getPublicKey, nip17, nip19 } from 'nostr-tools'

import { BUNDLED_CATALOG, entitlementOf, verifyLicence } from '../packages/licence/src/index.ts'
import { licenceOf } from '../packages/licence/src/read.ts'
import { parseVoucherToken, verifyVoucher } from '../src/lib/voucherToken.ts'

const ORIGIN = process.env.SUB_ORIGIN ?? 'http://localhost:18910'
const GATEWAY = process.env.GATEWAY ?? 'https://wallet.staging.398ja.xyz'
const SELLER = '62dd912f098cb439e97e0bfe3e6513b27b0cecc9f262a1778635c6fe18545c01'
const sk = generateSecretKey()
const stall = getPublicKey(sk)

const results: Array<[string, boolean]> = []
const check = (name: string, ok: boolean, detail = '') => {
  results.push([name, ok])
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `  (${detail})` : ''}`)
}

async function fillStripe(page: import('playwright').Page) {
  await page.waitForURL(/checkout\.stripe\.com/, { timeout: 30_000 })
  await page.locator('#email').fill(`stall-${stall.slice(0, 8)}@example.com`)
  await page.locator('#cardNumber').fill('4242424242424242')
  await page.locator('#cardExpiry').fill('12 / 34')
  await page.locator('#cardCvc').fill('123')
  await page.locator('#billingName').fill('Test Stall')
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

async function inbox(): Promise<unknown[]> {
  const r = await fetch(`${GATEWAY}/api/v1/nostr/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kinds: [1059], pTags: [stall], limit: 10 }),
  })
  return (((await r.json()) as { events?: unknown[] }).events ?? [])
}

async function main() {
  const browser = await chromium.launch()
  const page = await browser.newPage()
  try {
    await page.goto(`${ORIGIN}/sign-in?next=/plans`, { waitUntil: 'networkidle' })
    await page.getByText('Use my secret key instead').click()
    await page.getByLabel('Stall secret key').fill(nip19.nsecEncode(sk))
    await page.getByRole('button', { name: 'Sign in' }).click()
    await page.waitForURL(/\/plans/)
    await page.getByRole('button', { name: 'Choose Basic' }).click()
    await fillStripe(page)
    check('real Stripe Checkout loaded and accepted the test card', true)
    await page.waitForURL(new RegExp(`${ORIGIN.replace(/[/.]/g, '\\$&')}/done`), { timeout: 60_000 })
    check('Stripe returned to the site', /you are subscribed/i.test(await page.locator('body').innerText()))

    // The webhook mints through staging (about 10 s): wait for it, up to two minutes.
    let wraps: unknown[] = []
    for (let i = 0; i < 60 && !wraps.length; i++) {
      wraps = await inbox()
      if (!wraps.length) await page.waitForTimeout(2000)
    }
    check('the licence reached the stall inbox on staging', wraps.length > 0, String(wraps.length))
    if (wraps.length) {
      const rumor = nip17.unwrapEvent(wraps[0] as never, sk) as { content: string }
      const token = (JSON.parse(rumor.content) as { token: string }).token
      const v = parseVoucherToken(token).voucher
      const l = licenceOf(v as never)!
      const now = Math.floor(Date.now() / 1000) + 60
      const verdict = verifyLicence(l, { issuerPublicKey: v.issuerPublicKey, sellerPublicKey: SELLER, now, presenter: stall, verifySignature: () => verifyVoucher(v).signatureValid })
      check('it verifies for this stall, sold by the staging seller', verdict.granted)
      if (verdict.granted) {
        const e = entitlementOf({ catalog: BUNDLED_CATALOG, grants: [verdict.grant], currency: 'GBP', now })
        check('the wallet reads it as Basic: 1,000 GBP a month, 3 tills', e.tier === 'basic' && e.terminals === 3 && e.sales?.amount === 100000 && e.sales.period === 'month', JSON.stringify(e))
      }
    }

    await page.getByRole('link', { name: 'Sign in to see my plan' }).click()
    await page.getByText('Use my secret key instead').click()
    await page.getByLabel('Stall secret key').fill(nip19.nsecEncode(sk))
    await page.getByRole('button', { name: 'Sign in' }).click()
    await page.getByText('Active').waitFor({ timeout: 15_000 })
    const account = await page.locator('body').innerText()
    check('account page: Basic, active, sent', /Basic/.test(account) && /Active/.test(account) && /Sent/.test(account), account.slice(0, 300))
    const portal = page.getByRole('button', { name: 'Card, invoices and cancellation' })
    check('Stripe portal offered for the card subscription', await portal.isVisible())
  } catch (e) {
    check('flow completed', false, String(e).slice(0, 300))
    await page.screenshot({ path: '/tmp/sub-local-fail.png', fullPage: true }).catch(() => {})
  } finally {
    await browser.close()
  }
  console.log(`\nstall ${nip19.npubEncode(stall)}\n${results.filter(([, ok]) => ok).length}/${results.length} passed`)
  process.exit(results.every(([, ok]) => ok) ? 0 : 1)
}

void main()
