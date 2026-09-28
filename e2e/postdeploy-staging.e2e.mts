/**
 * Post-deploy browser suite for staging (T2-T5, T8-T10).
 *
 * Drives the REAL wallet against the live stack: a merchant and a customer register,
 * the merchant sells EUR (#95), the customer receives (#110/#119), a large sale
 * arrives as a multi-voucher bundle (#94/#110), and the customer pays the bundle
 * back to the stall that issued it (the 8-part self-issued scenario). The console of
 * both wallets is watched throughout for settled-but-not-saved receives (#112).
 *
 * Server-side assertions (escrow states, gateway 429s, the 409 replay) are made by
 * the companion script `imani-deploy/scripts/postdeploy/run.sh`, which reads the
 * handles and pubkeys this prints on its `CONTEXT` line.
 *
 * Output: one JSON line per check, then `CONTEXT {...}` and `SUMMARY {...}`.
 * Exit code 1 when any check fails.
 *
 *   E2E_BASE=https://wallet.staging.398ja.xyz npx tsx e2e/postdeploy-staging.e2e.mts
 */
import { chromium, type BrowserContext, type Page } from 'playwright'
import { finalizeEvent, generateSecretKey, getPublicKey, nip19, nip98 } from 'nostr-tools'
import { registerCustomer, registerMerchant } from './register.mts'

const BASE = process.env.E2E_BASE ?? 'https://wallet.staging.398ja.xyz'
const PASSPHRASE = 'correct horse battery'
const SINGLE_SALE = process.env.E2E_SINGLE_SALE ?? '7.00'
/** Coupons A holds for T8. A sends their total, which no single one covers, so it goes as a bundle. */
const BUNDLE_PARTS = ['3.00', '4.00', '5.00']
/** T9 reproduces the 8-part self-issued payment that lost EUR 100 (imani-wallet#110). */
const SELF_ISSUED_PARTS = 8
const SELF_ISSUED_TOP_UP = '2.00'
/** Kept from the END: the late receives (T8/T9) are where money goes missing. */
const CONSOLE_EVIDENCE_LINES = 400
const PERMISSION_CACHE_MS = 62_000
const BUNDLE_WINDOW_MS = 13 * 60_000
const POLL_MS = 10_000

type Check = { step: string; ok: boolean; detail: string }
const checks: Check[] = []
const consoleLines: string[] = []
const failedRequests: string[] = []
/** The wallets under test, printed on the CONTEXT line even when the run crashes. */
let runContext: Record<string, string> | null = null
/** Every time a wallet was found locked mid-run (its NAP session had lapsed). */
const sessionLapses: string[] = []

function record(step: string, ok: boolean, detail: string): void {
  checks.push({ step, ok, detail })
  console.log(JSON.stringify({ step, ok, detail: detail.slice(0, 700) }))
}

async function screenText(page: Page, limit = 1500): Promise<string> {
  return (await page.locator('body').innerText()).replace(/\n{2,}/g, '\n').slice(0, limit)
}

function oneLine(text: string): string {
  return text.replace(/\n/g, ' | ')
}

/**
 * Navigates, retrying a navigation the BROWSER aborted. Docker creating or removing a bridge
 * on the machine running the suite makes Chromium fail in-flight loads with
 * ERR_NETWORK_CHANGED; that is the test host, not staging (same helper as terminals.e2e.ts).
 */
async function goto(page: Page, url: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 60_000 })
      return
    } catch (e) {
      if (attempt === 4 || !/ERR_NETWORK_CHANGED|ERR_NETWORK_IO_SUSPENDED|net::ERR_ABORTED/.test(String(e))) throw e
      await page.waitForTimeout(2000)
    }
  }
}

function watch(who: string, page: Page): void {
  page.on('console', (m) => consoleLines.push(`[${who} ${m.type()}] ${m.text().slice(0, 500)}`))
  page.on('pageerror', (e) => consoleLines.push(`[${who} PAGEERROR] ${e.message}`))
  page.on('response', (r) => {
    if (r.status() >= 400) failedRequests.push(`[${who}] ${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`)
  })
}

async function handleOf(page: Page): Promise<string> {
  return page.evaluate(() => document.body.innerText.match(/@((?:cust|till)\d+)/)?.[1] ?? '')
}

async function pubkeyOf(page: Page): Promise<string> {
  return page.evaluate(() => {
    for (let i = 0; i < localStorage.length; i++) {
      const match = /^imani-wallet:profile:([0-9a-f]{64})$/.exec(localStorage.key(i) ?? '')
      if (match) return match[1]
    }
    return ''
  })
}

/**
 * Retries a step once, from a fresh load of the start page.
 *
 * The flakes this absorbs were on the TEST HOST, not staging: a crash-looping local container
 * churns Docker bridges, and Chromium then aborts in-flight requests with ERR_NETWORK_CHANGED
 * (12 of 12 registrations passed with the churn stopped). The retry is recorded, not hidden.
 */
async function withRetry<T>(label: string, page: Page, attempt: () => Promise<T>): Promise<T> {
  try {
    return await attempt()
  } catch (first) {
    record(`${label} (first attempt interrupted, retried)`, true, String(first).split('\n')[0]!.slice(0, 200))
    await goto(page, `${BASE}/onboarding`).catch(() => {})
    return attempt()
  }
}

/** A fresh session carries coupon:issue; the onboarding one does not (imani-wallet#114). */
async function relogin(context: BrowserContext, page: Page): Promise<void> {
  await context.clearCookies()
  await goto(page, `${BASE}/`)
  await page.locator('input[placeholder="Passphrase"]').fill(PASSPHRASE)
  await page.getByRole('button', { name: /unlock/i }).first().click()
  await page.waitForTimeout(6000)
}

/** Hard reload that bypasses the HTTP cache, then reports the bundle actually served (T0+). */
async function servedBundle(page: Page): Promise<string> {
  await goto(page, `${BASE}/`)
  await page.reload({ waitUntil: 'load', timeout: 60_000 })
  return page.evaluate(() => {
    const script = document.querySelector('script[type="module"][src*="/assets/index-"]') as HTMLScriptElement | null
    return script?.src ?? ''
  })
}

async function balance(page: Page): Promise<string> {
  // `load`, not `networkidle`: the wallet holds a relay subscription open, and on a busy
  // relay networkidle never arrives (the first staging run timed out here).
  await goto(page, `${BASE}/`)
  await unlockIfLocked(page)
  const home = page.getByText('Total balance')
  await home.waitFor({ timeout: 30_000 })
  await page.waitForTimeout(3000)
  return (await screenText(page, 800)).match(/Total balance\s*\n?([^\n]+)/)?.[1]?.trim() ?? '?'
}

/**
 * Unlocks the wallet if it is showing its lock screen, and says whether it had to.
 *
 * A session can lapse mid-run: the merchant's did twice, after a 401 on /auth/session. The
 * wallet then shows "Unlock" on any route, which is the product working, not the check failing.
 * Each lapse is recorded so a run that keeps locking wallets out is visible.
 */
async function unlockIfLocked(page: Page): Promise<boolean> {
  const lock = page.locator('input[placeholder="Passphrase"]')
  const unlocked = page.getByText(/Total balance|Scan the customer's code|Amount \(/)
  await Promise.race([lock.waitFor({ timeout: 30_000 }), unlocked.first().waitFor({ timeout: 30_000 })]).catch(() => {})
  if (!(await lock.isVisible().catch(() => false))) return false
  sessionLapses.push(`${new Date().toISOString()} ${page.url()}`)
  await lock.fill(PASSPHRASE)
  await page.getByRole('button', { name: /unlock/i }).first().click()
  await page.waitForTimeout(5000)
  return true
}

async function waitForBalanceChange(page: Page, before: string, windowMs: number): Promise<string> {
  const deadline = Date.now() + windowMs
  while (Date.now() < deadline) {
    await page.waitForTimeout(POLL_MS)
    const now = await balance(page)
    if (now !== before) return now
  }
  return balance(page)
}

/** Waits until the balance stops moving, so a bundle is judged on its final total. */
async function waitForBalanceToSettle(page: Page, windowMs: number): Promise<string> {
  const deadline = Date.now() + windowMs
  let last = await balance(page)
  let stableSince = Date.now()
  while (Date.now() < deadline) {
    await page.waitForTimeout(POLL_MS)
    const now = await balance(page)
    if (now !== last) {
      last = now
      stableSince = Date.now()
    } else if (Date.now() - stableSince > 90_000) {
      return now
    }
  }
  return last
}

function euros(text: string): number {
  const match = text.replace(/[^\d.,-]/g, '').replace(',', '.')
  return Number.parseFloat(match || 'NaN')
}

const FAILURE_WORDS = /failed|error|could not|NOT been delivered|never finished|refused/i

/**
 * Sells until the sale lands, re-logging-in once if the session lapsed. A setup sale that
 * does not land is not the scenario under test, so it is retried; a second failure is reported.
 */
async function sellForSetup(context: BrowserContext, merchant: Page, to: string, amount: string): Promise<string> {
  let sold = await sell(merchant, to, amount).catch((e) => `ERR ${e}`)
  if (!/It is in their wallet now/.test(sold)) {
    if (!merchant.url().includes('/sell') || /redirected/.test(sold)) await relogin(context, merchant)
    sold = await sell(merchant, to, amount).catch((e) => `ERR ${e}`)
  }
  return sold
}

async function sell(merchant: Page, customerHandle: string, amount: string): Promise<string> {
  await goto(merchant, `${BASE}/sell`)
  if (await unlockIfLocked(merchant)) await goto(merchant, `${BASE}/sell`)
  if (!merchant.url().includes('/sell')) return `redirected to ${merchant.url()} (no coupon:issue?)`
  await merchant.locator('input[placeholder="name"]').fill(customerHandle, { timeout: 30_000 })
  await merchant.getByRole('button', { name: /^Continue$/ }).click()
  await merchant.locator('input[placeholder="0.00"]').waitFor({ timeout: 30_000 })
  await merchant.locator('input[placeholder="0.00"]').fill(amount)
  await merchant.getByRole('button', { name: /Send voucher/i }).click()
  for (let i = 0; i < 60; i++) {
    await merchant.waitForTimeout(5000)
    const text = await screenText(merchant, 900)
    if (/sent|delivered|Done|failed|error|could not|NOT been delivered/i.test(text) && !/This takes a few seconds/.test(text)) {
      return text
    }
  }
  return screenText(merchant, 900)
}

/**
 * Sends `amount` to `recipient` from the Send screen and returns the result screen.
 *
 * A multi-voucher payment is not something to construct: the wallet draws several
 * coupons whenever no single one covers the amount (`deliver` in src/lib/pay.ts), so
 * holding N small coupons and sending more than any one of them makes a bundle.
 */
async function send(sender: Page, recipientPubkey: string, amount: string): Promise<string> {
  await goto(sender, `${BASE}/send?to=${recipientPubkey}`)
  const amountField = sender.locator('input[placeholder="0.00"]')
  if (!(await amountField.waitFor({ timeout: 15_000 }).then(() => true, () => false))) {
    await sender.getByRole('button').filter({ hasText: /Test Stall/i }).first().click()
    await amountField.waitFor({ timeout: 30_000 })
  }
  await amountField.fill(amount)
  await sender.getByRole('button', { name: /^Continue$/ }).click()
  await sender.getByRole('button', { name: /^(Pay|Send)$/ }).last().click()
  for (let i = 0; i < 180; i++) {
    await sender.waitForTimeout(5000)
    const text = await screenText(sender, 900)
    if (/^(Sent|Paid|Partly sent)$/m.test(text) || FAILURE_WORDS.test(text)) return text
  }
  return screenText(sender, 900)
}

async function notificationRows(page: Page): Promise<string[]> {
  await goto(page, `${BASE}/`)
  // The bell is a <details>/<summary>, not a button: its rows are the buttons in its <nav>.
  const bell = page.locator('summary[aria-label^="Notifications"]')
  if (!(await bell.first().waitFor({ timeout: 15_000 }).then(() => true, () => false))) return []
  await bell.first().click()
  await page.waitForTimeout(1500)
  const rows = await page.locator('details[open] nav li').allInnerTexts()
  await bell.first().click()
  return rows.map((r) => r.replace(/\n+/g, ' ').trim()).filter(Boolean)
}

/**
 * What the stall holds of its OWN coupons, read off its own merchant page (BALANCE), polled
 * until it stops moving. A page with no balance panel ("Nothing yet", or no row) is zero.
 */
async function ownCouponsHeld(merchant: Page, stallPubkey: string, windowMs: number): Promise<{ value: number; text: string }> {
  const read = async (): Promise<string> => {
    await goto(merchant, `${BASE}/merchants/${stallPubkey}`)
    await unlockIfLocked(merchant)
    await merchant.waitForTimeout(4000)
    const page = await screenText(merchant, 1200)
    return /BALANCE\s*\n?([^\n]+)/i.exec(page)?.[1]?.trim() ?? '€0.00 (no balance shown)'
  }
  const deadline = Date.now() + windowMs
  let last = await read()
  let stableSince = Date.now()
  while (Date.now() < deadline && Date.now() - stableSince < 90_000) {
    await merchant.waitForTimeout(POLL_MS)
    const now = await read()
    if (now !== last) {
      last = now
      stableSince = Date.now()
    }
  }
  return { value: euros(last), text: last }
}

/** The Transactions page states its own count ("1 entry", "3 entries"); read that. */
async function transactionCount(page: Page, stallPubkey: string): Promise<number> {
  await goto(page, `${BASE}/merchants/${stallPubkey}/transactions`)
  const subtitle = page.getByText(/^(\d+) entr(y|ies)$|^Nothing yet\.$/).first()
  await subtitle.waitFor({ timeout: 30_000 })
  const text = await subtitle.innerText()
  return Number(/^(\d+)/.exec(text)?.[1] ?? '0')
}

function visibleToasts(page: Page): Promise<string[]> {
  return page.locator('[data-sonner-toast], [role="status"]').allInnerTexts()
}

/** Every token the wallet itself POSTed to /wallet/receive, in order, with the answer. */
type ObservedReceive = { token: string; idempotencyKey: string; status: number }
const observedReceives: ObservedReceive[] = []

function captureReceives(page: Page): void {
  page.on('response', async (response) => {
    const request = response.request()
    if (request.method() !== 'POST' || !new URL(request.url()).pathname.endsWith('/api/v1/wallet/receive')) return
    try {
      const token = (JSON.parse(request.postData() ?? '{}') as { token?: string }).token ?? ''
      observedReceives.push({ token, idempotencyKey: request.headers()['idempotency-key'] ?? '', status: response.status() })
    } catch {
      /* not a JSON body */
    }
  })
}

type ReplayAnswer = { status: number; code: string; receiveId: string; body: string }

/**
 * Onboards customer A by importing a key the suite generated ("Log in" with a backup key),
 * so the suite can later sign requests as A from Node. Returns A's npub, which Sell accepts
 * in place of a handle.
 */
async function importCustomer(page: Page, secretKey: Uint8Array): Promise<string> {
  // Retried once: a browser-side network change during the import (ERR_NETWORK_CHANGED on
  // the test host) left run 6 on /onboarding with nothing to show for it.
  for (let attempt = 1; attempt <= 2; attempt++) {
    await goto(page, `${BASE}/onboarding`)
    if (!page.url().includes('onboarding')) break
    await page.getByRole('button', { name: /^Log in$/ }).first().click()
    await page.locator('input[placeholder^="nsec1"]').fill(nip19.nsecEncode(secretKey))
    await page.locator('input[placeholder="Choose a passphrase"]').fill(PASSPHRASE)
    await page.locator('input[placeholder="Confirm passphrase"]').fill(PASSPHRASE)
    await page.getByRole('button', { name: /^Add key and unlock$/ }).last().click()
    for (let i = 0; i < 30 && page.url().includes('onboarding'); i++) await page.waitForTimeout(1000)
    if (!page.url().includes('onboarding')) break
  }
  return nip19.npubEncode(getPublicKey(secretKey))
}

/**
 * Re-submits a token the wallet already received, signed as its recipient with NIP-98,
 * under a DIFFERENT idempotency key: the #119 case a stale client or a lost response
 * produces. The gateway must recognise the token and refuse without calling the mint.
 */
async function replayUnderNewKey(secretKey: Uint8Array, token: string): Promise<ReplayAnswer> {
  const url = `${BASE}/api/v1/wallet/receive`
  const body = JSON.stringify({ token })
  const authorization = await nip98.getToken(url, 'post', (event) => finalizeEvent(event, secretKey), true, JSON.parse(body))
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `postdeploy-replay-${Date.now()}`, Authorization: authorization },
    body,
  })
  const text = await response.text()
  let code = ''
  try {
    const parsed = JSON.parse(text) as { error?: { code?: string } | string; code?: string }
    code = typeof parsed.error === 'object' ? (parsed.error?.code ?? '') : (parsed.code ?? String(parsed.error ?? ''))
  } catch {
    /* empty or non-JSON */
  }
  return { status: response.status, code, receiveId: response.headers.get('X-Receive-Id') ?? '', body: text.slice(0, 300) }
}

async function main(): Promise<number> {
  const browser = await chromium.launch()
  const customerContext = await browser.newContext()
  const recipientContext = await browser.newContext()
  const merchantContext = await browser.newContext()
  const customer = await customerContext.newPage()
  const recipient = await recipientContext.newPage()
  const merchant = await merchantContext.newPage()
  watch('A', customer)
  watch('B', recipient)
  watch('M', merchant)
  captureReceives(customer)

  const bundle = await servedBundle(customer)
  record('T0+ wallet bundle served after hard reload', /\/assets\/index-.+\.js$/.test(bundle), bundle)

  // A logs in with a key the suite holds (so it can sign the T4+ replay as A); B registers
  // through the ordinary onboarding, which is what T2 is about.
  const customerKey = generateSecretKey()
  const customerHandle = await importCustomer(customer, customerKey)
  const customerPubkey = getPublicKey(customerKey)
  record('T2 customer A logs in with a backup key, lands on wallet', !customer.url().includes('onboarding'),
    `npub=${customerHandle.slice(0, 20)}… url=${customer.url()}`)
  await withRetry('T2 register customer B', recipient, () => registerCustomer(recipient, BASE))
  const recipientHandle = await handleOf(recipient)
  const recipientPubkey = await pubkeyOf(recipient)
  record('T2 customer B registers through onboarding, lands on wallet',
    !!recipientHandle && /^[0-9a-f]{64}$/.test(recipientPubkey) && !recipient.url().includes('onboarding'),
    `handle=${recipientHandle} url=${recipient.url()}`)

  await withRetry('T3 register merchant', merchant, () => registerMerchant(merchant, BASE))
  const merchantHandle = await handleOf(merchant)
  const merchantPubkey = await pubkeyOf(merchant)
  record('T3 merchant registered', !!merchantHandle && !merchant.url().includes('onboarding'), `handle=${merchantHandle}`)
  runContext = { customerHandle, customerPubkey, recipientHandle, recipientPubkey, merchantHandle, merchantPubkey, bundle }
  await merchant.waitForTimeout(PERMISSION_CACHE_MS)
  await relogin(merchantContext, merchant)
  await goto(merchant, `${BASE}/sell`)
  record('T3 merchant reaches Sell after re-login (#114 workaround)', merchant.url().includes('/sell'), merchant.url())

  // T3+ / T4: an explicit EUR sale, received by the customer.
  const beforeSingle = await balance(customer)
  const soldSingle = await sell(merchant, customerHandle, SINGLE_SALE).catch((e) => `ERR ${e}`)
  record(`T3+ sell EUR ${SINGLE_SALE} (#95: no "No active keyset for unit EUR")`,
    !FAILURE_WORDS.test(soldSingle) && !/No active keyset/i.test(soldSingle), oneLine(soldSingle))
  const afterSingle = await waitForBalanceChange(customer, beforeSingle, 3 * 60_000)
  record('T4 customer balance rises by the sale', euros(afterSingle) - euros(beforeSingle) === euros(SINGLE_SALE),
    `balance ${beforeSingle} -> ${afterSingle}`)
  const firstReceive = observedReceives.find((r) => r.status === 200 && r.token)
  record('T4 wallet sent a deterministic rcv_ idempotency key (#110)',
    !!firstReceive && /^rcv_[0-9a-f]{16,}$/.test(firstReceive.idempotencyKey), firstReceive?.idempotencyKey ?? 'no receive observed')
  if (firstReceive) {
    const replay = await replayUnderNewKey(customerKey, firstReceive.token)
    record('T4+ re-submit under a new key -> 409 RECEIVE_ALREADY_SETTLED with X-Receive-Id (#119)',
      replay.status === 409 && replay.code === 'RECEIVE_ALREADY_SETTLED' && replay.receiveId !== '',
      `HTTP ${replay.status} code=${replay.code} X-Receive-Id=${replay.receiveId || 'absent'} ${replay.body}`)
    const afterReplay = await balance(customer)
    record('T4+ balance unchanged by the re-submit', afterReplay === afterSingle, `balance ${afterSingle} -> ${afterReplay}`)
  }

  // T8: a multi-voucher payment between customers. A holds several small coupons
  // and sends more than any one covers, so the wallet sends a bundle (#94/#110).
  for (const part of BUNDLE_PARTS) {
    const sold = await sellForSetup(merchantContext, merchant, customerHandle, part)
    if (!/It is in their wallet now/.test(sold)) record(`T8 setup: sell EUR ${part} to A`, false, oneLine(sold))
  }
  const heldByA = await waitForBalanceToSettle(customer, 5 * 60_000)
  const bundleTotal = BUNDLE_PARTS.reduce((sum, p) => sum + euros(p), 0).toFixed(2)
  record(`T8 setup: A holds ${BUNDLE_PARTS.length} extra coupons`,
    Math.abs(euros(heldByA) - euros(afterSingle) - euros(bundleTotal)) < 0.005, `A balance ${afterSingle} -> ${heldByA}`)

  const beforeB = await balance(recipient)
  const toastsSeen = new Set<string>()
  const maxToastsAtOnce = { advance: 0, received: 0 }
  const toastTimer = setInterval(() => {
    visibleToasts(recipient).then((toasts) => {
      toasts.forEach((x) => toastsSeen.add(x.replace(/\n+/g, ' ')))
      maxToastsAtOnce.advance = Math.max(maxToastsAtOnce.advance, toasts.filter((t) => /on its way/i.test(t)).length)
      maxToastsAtOnce.received = Math.max(maxToastsAtOnce.received, toasts.filter((t) => /received/i.test(t)).length)
    }).catch(() => {})
  }, 2000)
  const sentToB = await send(customer, recipientPubkey, bundleTotal).catch((e) => `ERR ${e}`)
  const sentParts = Number(/as (\d+) vouchers/.exec(sentToB)?.[1] ?? '1')
  record(`T8 A sends EUR ${bundleTotal} to B as >= 3 vouchers`, !FAILURE_WORDS.test(sentToB) && sentParts >= 3,
    `parts=${sentParts} | ${oneLine(sentToB)}`)
  const afterB = await waitForBalanceToSettle(recipient, BUNDLE_WINDOW_MS)
  clearInterval(toastTimer)
  record('T8 B balance rises by the full total',
    Math.abs(euros(afterB) - euros(beforeB) - euros(bundleTotal)) < 0.005, `B balance ${beforeB} -> ${afterB}`)
  const bundleToasts = [...toastsSeen].filter((t) => /received|vouchers| of /i.test(t))
  record('T8 B never sees "has not arrived"',
    !bundleToasts.some((t) => /not arrived|hasn.t arrived/i.test(t)), bundleToasts.join(' || ') || 'no toast captured')
  // A bundle's toasts are updated IN PLACE (ids pending-bundle-<id>, received-bundle-<id>), so
  // the samples taken every 2 s show one toast at several stages ("€10.00 of €12.00", then
  // "€12.00"). One payment means no more than one "on its way" and one "received" toast visible
  // at the same moment, which is what the per-sample count checks.
  record('T8 B sees one toast per stage, never one per voucher',
    maxToastsAtOnce.advance <= 1 && maxToastsAtOnce.received <= 1,
    `max at once: on-its-way=${maxToastsAtOnce.advance} received=${maxToastsAtOnce.received} | ${bundleToasts.join(' || ') || 'no toast captured'}`)
  // #94's acceptance: exactly ONE advance row ("Payment on its way") and ONE settlement row
  // ("Payment received") for the bundle, the settlement row naming the full total and count.
  const bell = await notificationRows(recipient)
  const advanceRows = bell.filter((r) => /on its way/i.test(r))
  const settledRows = bell.filter((r) => /Payment received/i.test(r))
  const fullTotal = `€${bundleTotal}`
  record(`T8 bell: one advance row and one settlement row, "${fullTotal} received (${sentParts} vouchers)"`,
    advanceRows.length === 1 && settledRows.length === 1 && settledRows[0]!.includes(`${fullTotal} received (${sentParts} vouchers)`)
      && !bell.some((r) => /not arrived|hasn.t arrived/i.test(r)),
    bell.join(' || ') || 'no rows')
  const txCount = await transactionCount(recipient, merchantPubkey)
  record('T8 B Transactions list shows the payment as one line', txCount === 1, `${txCount} entries`)

  // T9: B pays the stall that issued the coupons back with an 8-part bundle. Every part
  // is received by the issuer and then burnt (the scenario that lost EUR 100, #110).
  const selfIssued = [...BUNDLE_PARTS]
  while (selfIssued.length < SELF_ISSUED_PARTS) selfIssued.push(SELF_ISSUED_TOP_UP)
  for (const part of selfIssued.slice(BUNDLE_PARTS.length)) {
    const sold = await sellForSetup(merchantContext, merchant, recipientHandle, part)
    if (!/It is in their wallet now/.test(sold)) record(`T9 setup: sell EUR ${part} to B`, false, oneLine(sold))
  }
  const heldByB = await waitForBalanceToSettle(recipient, 5 * 60_000)
  const expectedHeldByB = selfIssued.reduce((sum, p) => sum + euros(p), 0)
  record(`T9 setup: B holds every coupon it was sent (EUR ${expectedHeldByB.toFixed(2)})`,
    euros(heldByB) === expectedHeldByB, `B balance ${heldByB}`)
  const payBackTotal = heldByB.replace(/[^\d.,]/g, '').replace(',', '.')
  const paid = await send(recipient, merchantPubkey, payBackTotal).catch((e) => `ERR ${e}`)
  const paidParts = Number(/as (\d+) vouchers/.exec(paid)?.[1] ?? '1')
  record(`T9 B pays EUR ${payBackTotal} back to the issuing stall as ${SELF_ISSUED_PARTS} parts`,
    !FAILURE_WORDS.test(paid) && paidParts >= SELF_ISSUED_PARTS, `parts=${paidParts} | ${oneLine(paid)}`)
  const afterPayBack = await waitForBalanceToSettle(recipient, BUNDLE_WINDOW_MS)
  record('T9 B balance falls to zero', euros(afterPayBack) === 0, `B balance ${heldByB} -> ${afterPayBack}`)
  // A trading merchant's home is the till and shows no balance; what the stall HOLDS of its own
  // coupons is on its merchant page. Each part must have been received and then burnt, so that
  // holding returns to nothing once the 8 parts have landed.
  const stallHolds = await ownCouponsHeld(merchant, merchantPubkey, BUNDLE_WINDOW_MS)
  record('T9 the stall holds none of its own coupons afterwards (each part burnt)', stallHolds.value === 0,
    `stall's own-coupon balance: ${stallHolds.text}`)

  // T10: neither wallet reported a settled-but-not-saved receive.
  const unsaved = consoleLines.filter((l) => /redemption:unsaved|settled but not saved|settled at the gateway, not saved|not saved here/i.test(l))
  record('T10 console free of settled-but-not-saved (#112)', unsaved.length === 0, unsaved.join(' || ') || 'none')
  const pageErrors = consoleLines.filter((l) => /PAGEERROR/.test(l))
  record('T2-T9 no uncaught page errors', pageErrors.length === 0, pageErrors.join(' || ') || 'none')
  record('no wallet was locked out mid-run (session lapse)', sessionLapses.length === 0, sessionLapses.join(' || ') || 'none')

  console.log('--- failed requests ---')
  for (const r of failedRequests.slice(0, 60)) console.log(r)
  console.log('--- notable console ---')
  for (const l of consoleLines.filter((x) => /PAGEERROR|error|redemption|settled|429|receive_id/i.test(x)).slice(-CONSOLE_EVIDENCE_LINES)) console.log(l)
  console.log('CONTEXT ' + JSON.stringify({ customerHandle, customerPubkey, recipientHandle, recipientPubkey, merchantHandle, merchantPubkey, bundle }))
  console.log('SUMMARY ' + JSON.stringify(checks.map((c) => [c.step, c.ok])))
  await browser.close()
  return checks.every((c) => c.ok) ? 0 : 1
}

main().then((code) => process.exit(code), (e) => {
  // A crash mid-run is itself a finding: report it as a failed check, then dump what the
  // wallets logged, which is the evidence for what went wrong.
  record('suite ran to the end', false, String(e).split('\n').slice(0, 3).join(' | '))
  console.log('--- failed requests ---')
  for (const r of failedRequests.slice(0, 60)) console.log(r)
  console.log('--- notable console ---')
  for (const l of consoleLines.filter((x) => /PAGEERROR|error|redemption|settled|429|receive_id/i.test(x)).slice(-CONSOLE_EVIDENCE_LINES)) console.log(l)
  if (runContext) console.log('CONTEXT ' + JSON.stringify(runContext))
  process.exit(1)
})
