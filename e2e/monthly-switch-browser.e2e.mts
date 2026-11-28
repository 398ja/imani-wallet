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
 * The stall's account must be really eligible: a Standard account paying its own fees, in the stall's
 * currency, with card sales on (caractere on staging). E2E_PAY=1 then pays the first instalment with
 * 4242 in the same browser (6 months, the form's default), waits for the plan to show 1 of 6 paid, and
 * stops it from the buyer's screen.
 *
 * E2E_STUB_ELIGIBLE=1 is only for a stall whose account is NOT eligible (raclette: Express, GBP for a
 * CHF stall): the stall's browser then sees its Stripe status read with the account controls of an
 * eligible one, and E2E_PA_SQL (a command taking SQL on stdin) gives the account those controls in
 * payment-adapter around the plan starts, putting them back afterwards.
 */
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { chromium, type Page } from 'playwright'
import { nip19, getPublicKey, finalizeEvent } from 'nostr-tools'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'
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
const STUB = process.env.E2E_STUB_ELIGIBLE === '1'
const PAY = process.env.E2E_PAY === '1'
const SK = nip19.decode(NSEC).data as Uint8Array

/** A GET signed by the stall (NIP-98), for its own summary. */
async function signedGet(path: string): Promise<any> {
  const ev = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags: [['u', BASE + path], ['method', 'GET']], content: '' }, SK)
  const r = await fetch(BASE + path, { headers: { Authorization: 'Nostr ' + Buffer.from(JSON.stringify(ev)).toString('base64') } })
  return r.json().catch(() => null)
}

/** A POST signed by the stall (NIP-98, with the body's hash). */
async function signedPost(path: string, payload: unknown): Promise<any> {
  const body = JSON.stringify(payload)
  const hash = bytesToHex(sha256(new TextEncoder().encode(body)))
  const ev = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags: [['u', BASE + path], ['method', 'POST'], ['payload', hash]], content: '' }, SK)
  const r = await fetch(BASE + path, { method: 'POST', body, headers: { 'content-type': 'application/json', Authorization: 'Nostr ' + Buffer.from(JSON.stringify(ev)).toString('base64') } })
  return r.json().catch(() => null)
}

/** Pays the Checkout page this tab is on with the 4242 test card (Payment Element layout). */
async function payHere(page: Page) {
  const inner = page.frames().find((f) => f.url().includes('elements-inner'))
  const root = inner ?? page.mainFrame()
  await page.locator('#email').fill('e2e-buyer@example.com').catch(() => {})
  await root.locator('#linkAuthentication-emailInput, #email').first().fill('e2e-buyer@example.com', { timeout: 2000 }).catch(() => {})
  await root.getByText('Card', { exact: true }).first().click({ timeout: 3000 }).catch(() => {})
  await root.locator('#payment-numberInput, #cardNumber').first().fill('4242424242424242')
  await root.locator('#payment-expiryInput, #cardExpiry').first().fill('12 / 34')
  await root.locator('#payment-cvcInput, #cardCvc').first().fill('123')
  await page.locator('#billingName').fill('E2E Buyer', { timeout: 2000 }).catch(() => {})
  await root.locator('#payment-nameInput').first().fill('E2E Buyer', { timeout: 2000 }).catch(() => {})
  await page.locator('#billingPostalCode').fill('SW1A 1AA', { timeout: 2000 }).catch(() => {})
  await root.locator('#payment-postalCodeInput').first().fill('SW1A 1AA', { timeout: 2000 }).catch(() => {})
  const optIn = root.locator('#payment-linkOptInInput, #enableStripePass')
  if (await optIn.first().isChecked().catch(() => false)) await optIn.first().uncheck({ force: true }).catch(() => {})
  await shot(page, 'p1-card')
  for (const loc of [page.getByTestId('hosted-payment-submit-button'), root.getByTestId('payment-form-submit-button'), page.locator('button[type=submit]')]) {
    if (await loc.first().isVisible().catch(() => false)) { await loc.first().click(); return }
  }
  throw new Error('no submit button on the Checkout page')
}
try {
  console.log(`B1 the stall turns monthly payments on (${STALL.slice(0, 8)})`)
  const sctx = await browser.newContext({ locale: 'en-GB', viewport: { width: 390, height: 844 } })
  if (STUB) await sctx.route('**/api/v1/merchant/stripe/status', async (route) => {
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
  const sql = (q: string) => STUB && process.env.E2E_PA_SQL ? execFileSync('sh', ['-c', process.env.E2E_PA_SQL], { input: q }).toString().trim() : ''
  sql(`UPDATE connected_stripe_account SET fee_payer='account', losses_payer='stripe' WHERE merchant_pubkey='${STALL}';`)
  await b.getByRole('button', { name: /Start monthly payments/ }).click().catch(() => {})
  const toStripe = await until(async () => b.url().startsWith('https://checkout.stripe.com'), 30_000)
  check('starting reaches Stripe Checkout (the server accepted the plan)', toStripe, `${b.url()} ${(await text(b)).slice(0, 200)}`)
  if (toStripe) await b.waitForTimeout(5000)
  await shot(b, 'b2-stripe')

  if (PAY && toStripe) {
    console.log('P1 the buyer pays the first instalment with 4242, in the same browser')
    await payHere(b)
    const back = await until(async () => b.url().startsWith(`${BASE}/buy/done`), 60_000)
    check('Stripe returns the buyer to the wallet', back, b.url())
    await shot(b, 'p1-done')
    // The buyer's Monthly payments screen, where the plan lives.
    let shown = ''
    const active = await until(async () => {
      await b.goto(`${BASE}/settings/monthly-payments`, { waitUntil: 'load' })
      await unlock(b)
      await b.waitForTimeout(4000)
      shown = await text(b)
      return /1 of 6 paid/.test(shown)
    }, 150_000)
    check('the buyer sees the plan running, 1 of 6 paid', active, shown.slice(0, 300))
    await shot(b, 'p1-plans')
    const sum = await signedGet(`/api/v1/checkout/plans/summary?stall=${STALL}`)
    check("the stall's summary counts it at £40.00 a month", sum?.activePlans >= 1 && (sum?.monthlyTotals ?? []).some((t: any) => t.amountMinor >= 4000), JSON.stringify(sum))
    // Stop it from the buyer's own screen: Stripe cancels at period end.
    await b.getByText(/1 of 6 paid/).first().click().catch(() => {})
    await b.waitForTimeout(4000)
    await shot(b, 'p1-detail')
    const stopBtn = b.getByRole('button', { name: 'Stop monthly payments' })
    if (await stopBtn.isVisible().catch(() => false)) {
      const before = await text(b)
      await stopBtn.click()
      const dialog = b.getByRole('alertdialog')
      check('stopping asks first, keeping is the default', await dialog.getByRole('button', { name: 'Keep paying' }).isVisible().catch(() => false), (await text(b)).slice(0, 300))
      await shot(b, 'p1-confirm')
      await dialog.getByRole('button', { name: 'Stop', exact: true }).click()
      check('the buyer stops it from the plan screen', await until(async () => !(await stopBtn.isVisible().catch(() => false)) && (await text(b)) !== before, 20_000), (await text(b)).slice(0, 300))
      await b.waitForTimeout(2000)
      await shot(b, 'p1-stopped')
    } else check('the plan screen has a Stop button', false, (await text(b)).slice(0, 300))
  }

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
  // Whatever happened above, leave the stall's switch off on the server, so the next run starts
  // from "off" (a run that stopped halfway once left it on, and the next one failed at its first step).
  const off = await signedPost('/api/v1/checkout/plans/settings', { enabled: false }).catch(() => null)
  if (off?.enabled !== false) console.log(`  WARN  could not switch the stall off afterwards: ${JSON.stringify(off)}`)
  if (STUB && process.env.E2E_PA_SQL) {
    execFileSync('sh', ['-c', process.env.E2E_PA_SQL], {
      input: `UPDATE connected_stripe_account SET fee_payer=NULL, losses_payer=NULL WHERE merchant_pubkey='${STALL}';`,
    })
  }
  await browser.close()
}
const failed = results.filter((r) => !r.ok).length
console.log(`SUMMARY ${JSON.stringify({ passed: results.length - failed, failed })}`)
process.exit(failed ? 1 : 0)
