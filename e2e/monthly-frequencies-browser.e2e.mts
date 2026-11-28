/**
 * Browser test of weekly and yearly instalment plans against staging (payment-adapter#347, wallet#698).
 *
 *   F1  the stall ticks Weekly and Yearly while turning plans on: payment-adapter holds all three
 *   F2  a buyer sees "Pay over time", chooses Weekly; Stripe's price recurs every week (E2E_PAY=1 pays
 *       it with 4242, checks "Weekly payments started", "1 of 8 paid", the stall's weekly total, stops it)
 *   F3  the buyer chooses Yearly; Stripe's price recurs every year
 *   F4  the stall unticks Weekly while on: a weekly start is refused, the Buy page drops Weekly
 *
 *   E2E_STALL_NSEC_FILE=... E2E_STRIPE_SK_FILE=... E2E_STALL_ACCOUNT=acct_... [E2E_PAY=1] E2E_SHOTS=dir npx tsx e2e/monthly-frequencies-browser.e2e.mts
 *
 * Needs a really eligible stall (caractere on staging). Leaves it off, monthly only, and expires the
 * Checkout sessions it opened.
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

const SK_STRIPE = process.env.E2E_STRIPE_SK_FILE ? readFileSync(process.env.E2E_STRIPE_SK_FILE, 'utf8').trim() : ''
// The sessions live on the stall's own Stripe account (a direct charge), so every read names it.
const ACCT = process.env.E2E_STALL_ACCOUNT ?? ''
const stripeHeaders = () => ({ Authorization: `Bearer ${SK_STRIPE}`, ...(ACCT ? { 'Stripe-Account': ACCT } : {}) })
/** The Checkout session's recurring price, read from Stripe (test key), so the interval is Stripe's own. */
async function sessionPrice(url: string): Promise<{ interval?: string; unit_amount?: number; id?: string }> {
  const id = /cs_test_[A-Za-z0-9]+/.exec(url)?.[0]
  if (!id || !SK_STRIPE) return {}
  const r = await fetch(`https://api.stripe.com/v1/checkout/sessions/${id}/line_items?limit=1`, { headers: stripeHeaders() })
  const p = (await r.json())?.data?.[0]?.price
  return { interval: p?.recurring?.interval, unit_amount: p?.unit_amount, id }
}
async function expireSession(id?: string) {
  if (id && SK_STRIPE) await fetch(`https://api.stripe.com/v1/checkout/sessions/${id}/expire`, { method: 'POST', headers: stripeHeaders() }).catch(() => {})
}
const sessions: string[] = []

try {
  console.log(`F1 the stall offers weekly, monthly and yearly (${STALL.slice(0, 8)})`)
  const sctx = await browser.newContext({ locale: 'en-GB', viewport: { width: 390, height: 844 } })
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
  await s.getByTestId('monthly-eligibility').waitFor({ timeout: 45_000 }).catch(() => {})
  await s.waitForTimeout(2000)
  const sw = s.getByRole('switch', { name: /payments/i })
  check('the switch is off and can be turned on', !(await sw.isChecked()) && await sw.isEnabled(), (await text(s)).slice(0, 300))
  await sw.click({ force: true })
  const box = (name: string) => s.getByTestId('instalment-intervals').getByRole('checkbox', { name })
  check('setting up shows "Customers can pay", Monthly ticked', await box('Monthly').isChecked().catch(() => false), (await text(s)).slice(0, 400))
  // Once, the boxes stayed disabled (the screen busy) and the disclosure re-rendered: wait for them
  // to be usable, and keep a picture if they never are.
  const usable = await until(async () => box('Weekly').isEnabled().catch(() => false), 45_000)
  if (!usable) await shot(s, 'f1-boxes-disabled')
  check('the tick boxes are usable while setting up', usable, (await text(s)).slice(0, 400))
  await box('Weekly').check()
  await box('Yearly').check()
  await shot(s, 'f1-ticks')
  const turnOn = s.getByRole('button', { name: 'Turn on regular payments' })
  check('the button names regular payments once weekly is ticked', await turnOn.isVisible().catch(() => false))
  await s.getByRole('checkbox', { name: /accept the regular payments terms/ }).check()
  await turnOn.click()
  const on = await until(async () => { const x = await settings(); return x.enabled === true && x.intervals?.join() === 'week,month,year' })
  check('payment-adapter holds enabled, weekly, monthly and yearly', on, JSON.stringify(await settings()))
  check('the screen confirms', await until(async () => /Shoppers can now pay you|Saved on this device, but not sent yet/.test(await text(s)), 20_000))
  check('the profile publishes acceptsInstalments', await until(async () => (await publishedInstalments()) === true, 30_000))
  await shot(s, 'f1-on')

  console.log('F2 a buyer chooses Weekly')
  const bctx = await browser.newContext({ locale: 'en-GB', viewport: { width: 390, height: 844 } })
  const b = await bctx.newPage()
  await registerCustomer(b, BASE)
  await b.goto(`${BASE}/buy/${STALL}`, { waitUntil: 'load' })
  await unlock(b)
  const tab = b.getByRole('tab', { name: 'Pay over time' })
  check('the Buy page offers "Pay over time"', await tab.waitFor({ timeout: 30_000 }).then(() => true, () => false), (await text(b)).slice(0, 300))
  await tab.click()
  const often = b.getByRole('radiogroup', { name: 'How often' })
  check('How often offers Weekly, Monthly and Yearly, Monthly chosen',
    (await often.getByRole('radio').count()) === 3 && (await often.getByRole('radio', { name: 'Monthly' }).getAttribute('aria-checked')) === 'true')
  await often.getByRole('radio', { name: 'Weekly' }).click({ force: true })
  await b.getByLabel('Amount each week').fill('25')
  check('the summary is in weeks', await until(async () => /£25(\.00)? a week for 8 weeks, £200(\.00)? in total/.test(await text(b)), 5000), (await text(b)).slice(0, 400))
  await b.waitForTimeout(500)
  await shot(b, 'f2-weekly')
  await b.getByRole('button', { name: /Start weekly payments/ }).click()
  const toStripe = await until(async () => b.url().startsWith('https://checkout.stripe.com'), 30_000)
  check('starting reaches Stripe Checkout', toStripe, `${b.url()} ${(await text(b)).slice(0, 200)}`)
  const wk = await sessionPrice(b.url())
  if (wk.id) sessions.push(wk.id)
  check("Stripe's price is £25 every week", wk.interval === 'week' && wk.unit_amount === 2500, JSON.stringify(wk))
  if (toStripe) await b.waitForTimeout(5000)

  if (PAY && toStripe) {
    console.log('P1 the buyer pays the first week with 4242')
    await payHere(b)
    check('Stripe returns the buyer to the wallet', await until(async () => b.url().startsWith(`${BASE}/buy/done`), 60_000), b.url())
    check('the return page says "Weekly payments started"', await until(async () => /Weekly payments started/.test(await text(b)), 20_000), (await text(b)).slice(0, 300))
    await shot(b, 'p1-done')
    let shown = ''
    const active = await until(async () => {
      await b.goto(`${BASE}/settings/monthly-payments`, { waitUntil: 'load' })
      await unlock(b)
      await b.waitForTimeout(4000)
      shown = await text(b)
      return /a week · 1 of 8 paid/.test(shown)
    }, 150_000)
    check('the buyer sees "£25 a week · 1 of 8 paid" under Regular payments', active && /Regular payments/.test(shown), shown.slice(0, 300))
    await shot(b, 'p1-plans')
    const sum = await signedGet(`/api/v1/checkout/plans/summary?stall=${STALL}`)
    check("the stall's summary has a weekly total", (sum?.totals ?? []).some((t: any) => t.interval === 'week' && t.amountMinor >= 2500), JSON.stringify(sum))
    await s.goto(`${BASE}/settings/payments`, { waitUntil: 'load' })
    await unlock(s)
    check('the stall screen says "pay you regularly ... a week"', await until(async () => /pay(s)? you regularly, .*a week/.test(await text(s)), 30_000), (await text(s)).slice(0, 500))
    await shot(s, 'p1-stall-summary')
    await b.getByText(/1 of 8 paid/).first().click().catch(() => {})
    await b.waitForTimeout(4000)
    const stopBtn = b.getByRole('button', { name: 'Stop regular payments' })
    if (await stopBtn.isVisible().catch(() => false)) {
      await stopBtn.click()
      const dialog = b.getByRole('alertdialog')
      check('the dialog asks "Stop regular payments to ...?"', /Stop regular payments to/.test(await dialog.innerText().catch(() => '')))
      await dialog.getByRole('button', { name: 'Stop', exact: true }).click()
      check('the buyer stops the weekly plan', await until(async () => !(await stopBtn.isVisible().catch(() => false)), 20_000))
      await shot(b, 'p1-stopped')
    } else check('the weekly plan screen has "Stop regular payments"', false, (await text(b)).slice(0, 300))
  }

  console.log('F3 a buyer chooses Yearly')
  await b.goto(`${BASE}/buy/${STALL}`, { waitUntil: 'load' })
  await unlock(b)
  await b.getByRole('tab', { name: 'Pay over time' }).click({ timeout: 30_000 })
  await b.getByRole('radiogroup', { name: 'How often' }).getByRole('radio', { name: 'Yearly' }).click({ force: true })
  await b.getByLabel('Amount each year').fill('60')
  check('the summary is in years', await until(async () => /£60(\.00)? a year for 3 years, £180(\.00)? in total/.test(await text(b)), 5000), (await text(b)).slice(0, 400))
  // The weekly payment's "Payment received" toast can sit over the Start button for a while (it took
  // the click once): wait for it to go before pressing Start.
  await until(async () => !/Payment received/.test(await text(b)), 20_000)
  await b.waitForTimeout(500)
  await shot(b, 'f3-yearly')
  await b.getByRole('button', { name: /Start yearly payments/ }).click()
  check('starting reaches Stripe Checkout', await until(async () => b.url().startsWith('https://checkout.stripe.com'), 30_000), b.url())
  const yr = await sessionPrice(b.url())
  if (yr.id) sessions.push(yr.id)
  check("Stripe's price is £60 every year", yr.interval === 'year' && yr.unit_amount === 6000, JSON.stringify(yr))

  console.log('F4 the stall stops offering weekly while on')
  await s.goto(`${BASE}/settings/payments`, { waitUntil: 'load' })
  await unlock(s)
  await box('Weekly').waitFor({ timeout: 45_000 })
  check('the saved ticks come back', await until(async () => (await box('Weekly').isChecked()) && (await box('Yearly').isChecked()), 20_000))
  await box('Weekly').uncheck()
  check('payment-adapter now holds monthly and yearly', await until(async () => (await settings()).intervals?.join() === 'month,year'), JSON.stringify(await settings()))
  check('the screen says so', await until(async () => /Shoppers can now pay you monthly or yearly/.test(await text(s)), 10_000), (await text(s)).slice(0, 400))
  await shot(s, 'f4-no-weekly')
  const direct = await fetch(`${BASE}/api/v1/checkout/plan`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stallPubkey: STALL, buyerPubkey: getPublicKey(new Uint8Array(32).fill(7)), amountMinor: 2500, instalments: 8, interval: 'week' }),
  })
  const dj = await direct.json().catch(() => ({}))
  check('a weekly start is refused INTERVAL_NOT_OFFERED, naming monthly and yearly',
    dj.code === 'INTERVAL_NOT_OFFERED' && (dj.intervals ?? []).join() === 'month,year', `${direct.status} ${JSON.stringify(dj)}`)
  await b.goto(`${BASE}/buy/${STALL}`, { waitUntil: 'load' })
  await unlock(b)
  await b.getByRole('tab', { name: 'Pay over time' }).click({ timeout: 30_000 })
  const often2 = b.getByRole('radiogroup', { name: 'How often' })
  check('the Buy page no longer offers Weekly', await until(async () => (await often2.getByRole('radio').count()) === 2 && (await often2.getByRole('radio', { name: 'Weekly' }).count()) === 0, 10_000))

  console.log('F5 the stall turns them off on its screen')
  // Through the screen, not only the API, so the published offer goes too: an earlier run that only
  // saved off left the record on, and the next run's switch started on (wallet#699 now withdraws it).
  await s.goto(`${BASE}/settings/payments`, { waitUntil: 'load' })
  await unlock(s)
  const sw3 = s.getByRole('switch', { name: /payments/i })
  await sw3.waitFor({ timeout: 45_000 })
  check('the switch shows on', await until(async () => sw3.isChecked(), 20_000))
  await sw3.click({ force: true })
  check('payment-adapter holds the opt-out, keeping monthly and yearly', await until(async () => { const x = await settings(); return x.enabled === false && x.intervals?.join() === 'month,year' }), JSON.stringify(await settings()))
  check('the profile withdraws acceptsInstalments', await until(async () => (await publishedInstalments()) !== true, 30_000))
} finally {
  // Back to how the stall was: off, monthly only. Open Checkout sessions are expired.
  const off = await signedPost('/api/v1/checkout/plans/settings', { enabled: false, intervals: ['month'] }).catch(() => null)
  if (off?.enabled !== false) console.log(`  WARN  could not switch the stall off afterwards: ${JSON.stringify(off)}`)
  for (const id of sessions) await expireSession(id)
  await browser.close()
}
const failed = results.filter((r) => !r.ok).length
console.log(`SUMMARY ${JSON.stringify({ passed: results.length - failed, failed })}`)
process.exit(failed ? 1 : 0)
