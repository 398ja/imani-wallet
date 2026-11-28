/**
 * Browser test of the stall's monthly-payments switch against staging (payment-adapter#347, wallet#697).
 *
 *   B1  the stall (raclette, from its nsec) opens Settings > Card payments, turns Monthly payments on
 *       through the disclosure and terms: payment-adapter now holds enabled=true, the profile publishes it
 *   B2  a fresh buyer sees "Pay monthly" on the stall's Buy page and starting reaches Stripe's Checkout
 *   B3  the stall turns it off in the same screen: payment-adapter holds enabled=false, the buyer's
 *       Buy page drops the tab, and a direct plan start is refused NOT_OFFERED
 *
 *   E2E_STALL_NSEC_FILE=... E2E_SHOTS=dir npx tsx e2e/monthly-switch-browser.e2e.mts
 *
 * No staging stall has an account that is really eligible (a Standard account paying its own fees)
 * AND enrolled for card sales, so the stall's browser sees its Stripe status read with the account
 * controls of an eligible one (fee payer `account`, losses `stripe`, currency matching the stall).
 * Only that read is changed; the switch, the save to payment-adapter, the published profile, the
 * buyer's page and the plan start are all real. E2E_PA_SQL (a command taking SQL on stdin) gives the
 * account those controls in payment-adapter for the plan start, and puts them back afterwards.
 */
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { chromium, type Page } from 'playwright'
import { nip19, getPublicKey } from 'nostr-tools'
import { registerCustomer, TEST_PASSPHRASE } from './register.mts'

const BASE = 'https://wallet.staging.398ja.xyz'
const NSEC = readFileSync(process.env.E2E_STALL_NSEC_FILE!, 'utf8').trim()
const STALL = getPublicKey(nip19.decode(NSEC).data as Uint8Array)
const SHOTS = process.env.E2E_SHOTS ?? ''
const results: { name: string; ok: boolean }[] = []
const check = (name: string, ok: boolean, detail = '') => {
  results.push({ name, ok })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  -> ${detail}`}`)
}
const shot = async (p: Page, name: string) => { if (SHOTS) await p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }) }
const text = async (p: Page) => (await p.locator('body').innerText()).replace(/\s+/g, ' ')
const settings = async () => (await fetch(`${BASE}/api/v1/checkout/plans/settings?stall=${STALL}`)).json()
async function until(fn: () => Promise<boolean>, ms = 30_000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 1000))) if (await fn()) return true
  return false
}
async function unlock(p: Page) {
  const l = p.locator('input[placeholder="Passphrase"]')
  if (await l.waitFor({ timeout: 5000 }).then(() => true, () => false)) {
    await l.fill(TEST_PASSPHRASE)
    await p.getByRole('button', { name: /unlock/i }).first().click()
  }
}
async function publishedInstalments(): Promise<boolean | undefined> {
  const r = await fetch(`${BASE}/api/v1/nostr/query`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kinds: [30078], authors: [STALL], tags: { '#d': ['imani:merchant'] }, limit: 5 }),
  })
  const ev = ((await r.json()).events ?? []).sort((a: any, b: any) => b.createdAt - a.createdAt)[0]
  return ev ? JSON.parse(ev.content).acceptsInstalments : undefined
}

const browser = await chromium.launch()
try {
  console.log(`B1 the stall turns monthly payments on (${STALL.slice(0, 8)})`)
  const sctx = await browser.newContext({ locale: 'en-GB', viewport: { width: 390, height: 844 } })
  await sctx.route('**/api/v1/merchant/stripe/status', async (route) => {
    const res = await route.fetch()
    const body = await res.json().catch(() => null)
    if (!body || !body.stripe_account_id) return route.fulfill({ response: res })
    await route.fulfill({ response: res, json: {
      ...body, fee_payer: 'account', losses_payer: 'stripe', instalments_eligible: true, default_currency: process.env.E2E_STALL_CURRENCY ?? 'chf',
    } })
  })
  const s = await sctx.newPage()
  await s.goto(`${BASE}/restore`, { waitUntil: 'networkidle' })
  await s.waitForTimeout(3000)
  if (!/backup key|private key|nsec/i.test(await text(s))) await s.getByRole('button', { name: /^Log in$/ }).first().click().catch(() => {})
  await s.getByText(/backup key|private key|nsec/i).last().click()
  await s.getByLabel('Backup key').fill(NSEC)
  const pw = s.locator('input[type="password"]:visible:not([aria-label="Backup key"])')
  for (let i = 0; i < await pw.count(); i++) await pw.nth(i).fill(TEST_PASSPHRASE)
  await s.getByRole('button', { name: /log in|restore|continue|unlock/i }).last().click()
  await until(async () => !s.url().includes('onboarding') && !s.url().includes('restore'), 60_000)
  await s.waitForTimeout(4000)

  await s.goto(`${BASE}/settings/payments`, { waitUntil: 'load' })
  await unlock(s)
  const eligibility = s.getByTestId('monthly-eligibility')
  await eligibility.waitFor({ timeout: 45_000 }).catch(() => {})
  await s.waitForTimeout(2000)
  await shot(s, 'b1-settings')
  check('the screen says monthly payments are available', /Monthly payments are available/.test(await eligibility.innerText().catch(() => '')), await text(s).then((t) => t.slice(0, 300)))
  const sw = s.getByRole('switch', { name: /Monthly payments/ })
  check('the switch is off and can be turned on', !(await sw.isChecked()) && await sw.isEnabled(), `checked=${await sw.isChecked()} enabled=${await sw.isEnabled()}`)
  await sw.click({ force: true })
  const turnOn = s.getByRole('button', { name: 'Turn on monthly payments' })
  check('turning it on shows the terms first, the button disabled until accepted', await turnOn.isDisabled())
  await s.getByRole('checkbox', { name: /accept the monthly payments terms/ }).check()
  await shot(s, 'b1-terms')
  await turnOn.click()
  const savedOn = await until(async () => (await settings()).enabled === true)
  check('payment-adapter holds the opt-in (enabled, monthly)', savedOn, JSON.stringify(await settings()))
  check('the intervals stay monthly', (await settings()).intervals?.join() === 'month')
  // The wallet's own note: "Shoppers can now pay you monthly." once the relay confirms, or "Saved on
  // this device, but not sent yet" while the relay is slow (it still publishes, checked next).
  check('the screen confirms', await until(async () => /Shoppers can now pay you monthly|Saved on this device, but not sent yet/.test(await text(s)), 20_000))
  check('the profile publishes acceptsInstalments', await until(async () => (await publishedInstalments()) === true, 30_000))
  await shot(s, 'b1-on')

  console.log('B2 a buyer sees "Pay monthly" and reaches Stripe')
  const bctx = await browser.newContext({ locale: 'en-GB', viewport: { width: 390, height: 844 } })
  const b = await bctx.newPage()
  await registerCustomer(b, BASE)
  await b.goto(`${BASE}/buy/${STALL}`, { waitUntil: 'load' })
  await unlock(b)
  const tab = b.getByRole('tab', { name: 'Pay monthly' })
  check('the Buy page offers "Pay monthly"', await tab.waitFor({ timeout: 30_000 }).then(() => true, () => false), (await text(b)).slice(0, 300))
  await tab.click().catch(() => {})
  await b.locator('input[placeholder="40.00"]').fill('40.00').catch(() => {})
  await b.getByRole('radio').nth(1).click().catch(() => {})
  await shot(b, 'b2-monthly-form')
  const sql = (q: string) => process.env.E2E_PA_SQL ? execFileSync('sh', ['-c', process.env.E2E_PA_SQL], { input: q }).toString().trim() : ''
  sql(`UPDATE connected_stripe_account SET fee_payer='account', losses_payer='stripe' WHERE merchant_pubkey='${STALL}';`)
  await b.getByRole('button', { name: /Start monthly payments/ }).click().catch(() => {})
  const toStripe = await until(async () => b.url().startsWith('https://checkout.stripe.com'), 30_000)
  check('starting reaches Stripe Checkout (the server accepted the plan)', toStripe, `${b.url()} ${(await text(b)).slice(0, 200)}`)
  if (toStripe) await b.waitForTimeout(3000)
  await shot(b, 'b2-stripe')

  console.log('B3 the stall turns it off')
  await s.goto(`${BASE}/settings/payments`, { waitUntil: 'load' })
  await unlock(s)
  const sw2 = s.getByRole('switch', { name: /Monthly payments/ })
  await sw2.waitFor({ timeout: 45_000 })
  check('the switch shows on when the stall comes back', await until(async () => sw2.isChecked(), 20_000))
  await sw2.click({ force: true })
  const savedOff = await until(async () => (await settings()).enabled === false)
  check('payment-adapter holds the opt-out', savedOff, JSON.stringify(await settings()))
  check('the screen confirms plans already running carry on', await until(async () => /Monthly payments are off/.test(await text(s)), 20_000))
  check('the profile withdraws acceptsInstalments', await until(async () => (await publishedInstalments()) !== true, 30_000))
  await shot(s, 'b3-off')

  await b.goto(`${BASE}/buy/${STALL}`, { waitUntil: 'load' })
  await unlock(b)
  await b.waitForTimeout(8000)
  check('the Buy page no longer offers "Pay monthly"', (await b.getByRole('tab', { name: 'Pay monthly' }).count()) === 0)
  await shot(b, 'b3-buy')
  // The account still has the controls of an eligible one (E2E_PA_SQL), so the stall's own switch is
  // the only thing refusing.
  sql(`UPDATE connected_stripe_account SET fee_payer='account', losses_payer='stripe' WHERE merchant_pubkey='${STALL}';`)
  const direct = await fetch(`${BASE}/api/v1/checkout/plan`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stallPubkey: STALL, buyerPubkey: getPublicKey(new Uint8Array(32).fill(7)), amountMinor: 4000, instalments: 3 }),
  })
  const dj = await direct.json().catch(() => ({}))
  check('a direct plan start is refused NOT_OFFERED', direct.status === 409 && dj.code === 'NOT_OFFERED', `${direct.status} ${JSON.stringify(dj)}`)
} finally {
  if (process.env.E2E_PA_SQL) {
    execFileSync('sh', ['-c', process.env.E2E_PA_SQL], {
      input: `UPDATE connected_stripe_account SET fee_payer=NULL, losses_payer=NULL WHERE merchant_pubkey='${STALL}';`,
    })
  }
  await browser.close()
}
const failed = results.filter((r) => !r.ok).length
console.log(`SUMMARY ${JSON.stringify({ passed: results.length - failed, failed })}`)
process.exit(failed ? 1 : 0)
