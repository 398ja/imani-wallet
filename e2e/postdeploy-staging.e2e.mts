/**
 * Post-deploy browser suite for staging (T2-T5, T8-T10).
 *
 * Drives the REAL wallet against the live stack: a merchant and a customer register,
 * the merchant sells EUR (#95), the customer receives (#110/#119), a large sale
 * arrives as a multi-voucher bundle (#94/#110), and the customer pays the bundle
 * back to the stall that issued it (the 8-part self-issued scenario). The console of
 * both wallets is watched throughout for settled-but-not-saved receives (#112), and
 * the #119 re-submit is signed here, as customer A, and checked for its 409.
 *
 * Server-side assertions (escrow states, gateway rate limiting, relay rejections) are
 * made by the companion script `imani-deploy/scripts/postdeploy/run.sh`, which reads
 * the wallets and the T9 part count this prints on its `CONTEXT` line.
 *
 * Output: one JSON line per check, then `CONTEXT {...}` and `SUMMARY {...}`.
 * Exit code 1 when any check fails.
 *
 *   E2E_BASE=https://wallet.staging.398ja.xyz npx tsx e2e/postdeploy-staging.e2e.mts
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { finalizeEvent, generateSecretKey, getPublicKey, nip19, nip98 } from 'nostr-tools'
import { registerCustomer, registerMerchant, TEST_PASSPHRASE, TEST_STALL_NAME } from './register.mts'

const BASE = (process.env.E2E_BASE ?? 'https://wallet.staging.398ja.xyz').replace(/\/+$/, '')
const PASSPHRASE = TEST_PASSPHRASE
/** Amounts are read off the screen, so the browser's locale is pinned to the one they are parsed in. */
const BROWSER_LOCALE = 'en-GB'
const SINGLE_SALE = process.env.E2E_SINGLE_SALE ?? '7.00'
/**
 * Coupons A is sold for T8, on top of the T4 sale. A then sends EVERYTHING it holds: a payment
 * of the whole balance must draw every coupon whole, so the part count does not depend on how
 * the wallet orders coupons when it has a choice (soonest expiry, then largest face).
 */
const BUNDLE_PARTS = ['3.00', '4.00', '5.00']
/** T9 reproduces the 8-part self-issued payment that lost EUR 100 (imani-wallet#110). */
const SELF_ISSUED_PARTS = 8
const SELF_ISSUED_TOP_UP = '2.00'
/** Kept from the END: the late receives (T8/T9) are where money goes missing. */
const CONSOLE_EVIDENCE_LINES = 400
const BUNDLE_WINDOW_MS = 13 * 60_000
const POLL_MS = 10_000
/** A balance unchanged for this long is taken as final. */
const SETTLED_AFTER_MS = 90_000
/** Matches every path in shared/tokenRedemption.js that leaves a settled receive unsaved. */
const UNSAVED_RECEIVE = /needs reconciliation|RECEIVE_SETTLED_NOT_SAVED|ReceiveSettledNotSaved|settled but not saved|not saved here/i
const EVIDENCE_FILTER = /PAGEERROR|error|redemption|settled|429|receive_id/i

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

/** A fresh session, for a merchant whose session lapsed mid-run. */
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

/**
 * Reads the balance on the page as it stands, without navigating. Used while toasts are being
 * watched: a reload wipes them, and interrupts whatever receive the wallet is in the middle of.
 */
async function balanceInPlace(page: Page): Promise<string> {
  if (new URL(page.url()).pathname !== '/') return balance(page)
  await unlockIfLocked(page)
  return (await screenText(page, 800)).match(/Total balance\s*\n?([^\n]+)/)?.[1]?.trim() ?? '?'
}

type BalanceReader = (page: Page) => Promise<string>

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
async function waitForBalanceToSettle(page: Page, windowMs: number, read: BalanceReader = balance): Promise<string> {
  const deadline = Date.now() + windowMs
  let last = await read(page)
  let stableSince = Date.now()
  while (Date.now() < deadline) {
    await page.waitForTimeout(POLL_MS)
    const now = await read(page)
    if (now !== last) {
      last = now
      stableSince = Date.now()
    } else if (Date.now() - stableSince > SETTLED_AFTER_MS) {
      return now
    }
  }
  return last
}

/**
 * An amount as shown by the wallet in the pinned en-GB locale ("€1,234.56"), in whole cents so
 * amounts compare exactly. Anything that is not an amount ("?", an empty balance) is NaN.
 */
function cents(text: string): number {
  const digits = text.replace(/[^\d.-]/g, '')
  return digits ? Math.round(Number.parseFloat(digits) * 100) : Number.NaN
}

function sumOfCents(amounts: string[]): number {
  return amounts.reduce((sum, amount) => sum + cents(amount), 0)
}

function asEuros(amountInCents: number): string {
  return (amountInCents / 100).toFixed(2)
}

const FAILURE_WORDS = /failed|error|could not|NOT been delivered|never finished|refused/i
/** The only screen that means a sale landed: anything short of it is still pending, or failed. */
const SALE_DELIVERED = /It is in their wallet now/

/**
 * Sells until the sale lands, re-logging-in once if the session lapsed. A setup sale that
 * does not land is not the scenario under test, so it is retried; a second failure is reported.
 */
async function sellForSetup(context: BrowserContext, merchant: Page, to: string, amount: string): Promise<string> {
  let sold = await sell(merchant, to, amount).catch((e) => `ERR ${e}`)
  if (!SALE_DELIVERED.test(sold)) {
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
    if (SALE_DELIVERED.test(text) || FAILURE_WORDS.test(text)) return text
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
    await sender.getByRole('button').filter({ hasText: TEST_STALL_NAME }).first().click()
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
 * until it stops moving. A page with no balance panel is zero. Zero alone does not prove the
 * parts ARRIVED; run.sh proves that from the stall's escrows, using `payBackParts` on CONTEXT.
 */
async function ownCouponsHeld(merchant: Page, stallPubkey: string, windowMs: number): Promise<{ cents: number; text: string }> {
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
  while (Date.now() < deadline && Date.now() - stableSince < SETTLED_AFTER_MS) {
    await merchant.waitForTimeout(POLL_MS)
    const now = await read()
    if (now !== last) {
      last = now
      stableSince = Date.now()
    }
  }
  return { cents: cents(last), text: last }
}

/**
 * The Transactions page states its own count ("1 entry", "3 entries"); read that. The list
 * renders "0 entries" before its records load, so the count is read until it is non-zero and
 * has held for a few seconds, or the wait runs out.
 */
async function transactionCount(page: Page, stallPubkey: string): Promise<number> {
  await goto(page, `${BASE}/merchants/${stallPubkey}/transactions`)
  const subtitle = page.getByText(/^(\d+) entr(y|ies)$|^Nothing yet\.$/).first()
  await subtitle.waitFor({ timeout: 30_000 })
  const read = async (): Promise<number> => Number(/^(\d+)/.exec(await subtitle.innerText())?.[1] ?? '0')
  let count = await read()
  for (let stableReads = 0, attempt = 0; attempt < 15 && stableReads < 3; attempt++) {
    await page.waitForTimeout(2000)
    const now = await read()
    stableReads = now === count && now > 0 ? stableReads + 1 : 0
    count = now
  }
  return count
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
    // #325: Log in opens the backup chooser; the key form is the secondary link.
    await page.getByRole('button', { name: 'Use your backup key instead' }).click()
    await page.locator('input[aria-label="Backup key"]').fill(nip19.nsecEncode(secretKey))
    await page.locator('input[placeholder="Choose a passphrase"]').fill(PASSPHRASE)
    await page.locator('input[placeholder="Confirm passphrase"]').fill(PASSPHRASE)
    await page.getByRole('button', { name: /^Log in$/ }).last().click()
    // Since #338/#357 a key with no profile must claim a handle (and accept the Terms) before it
    // is let in; the suite's key is always fresh, so A always lands here. Missing this step left
    // the whole browser suite timing out on its retry from 2026-10-21 on.
    const finish = page.getByRole('button', { name: 'Finish and log in' })
    if (await finish.waitFor({ timeout: 15_000 }).then(() => true, () => false)) {
      await page.locator('input[aria-label="Handle"]').fill('pd' + Date.now().toString().slice(-8))
      await page.getByRole('checkbox', { name: /I accept the Terms and Conditions/ }).check()
      await finish.click()
    }
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

/** The three wallets of a run, and what the later scenarios need to know about them. */
type Wallets = {
  merchantContext: BrowserContext
  customer: Page
  recipient: Page
  merchant: Page
  customerKey: Uint8Array
  customerHandle: string
  customerPubkey: string
  recipientHandle: string
  recipientPubkey: string
  merchantHandle: string
  merchantPubkey: string
}

async function openWallet(browser: Browser, who: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ locale: BROWSER_LOCALE })
  const page = await context.newPage()
  watch(who, page)
  return { context, page }
}

/** T0+: the bundle the browser is actually served, after a reload that skips the cache. */
async function checkServedBundle(page: Page): Promise<void> {
  const bundle = await servedBundle(page)
  const expected = process.env.E2E_EXPECTED_BUNDLE
  const ok = /\/assets\/index-.+\.js$/.test(bundle) && (!expected || bundle.endsWith(expected))
  record('T0+ wallet bundle served after hard reload', ok, `${bundle}${expected ? ` (expected ${expected})` : ''}`)
  if (runContext) runContext.bundle = bundle
  else runContext = { bundle }
}

/** T2/T3: A imports a key the suite holds, B onboards normally, the merchant registers. */
async function registerWallets(browser: Browser): Promise<Wallets> {
  const a = await openWallet(browser, 'A')
  const b = await openWallet(browser, 'B')
  const m = await openWallet(browser, 'M')
  captureReceives(a.page)
  await checkServedBundle(a.page)

  // A logs in with a key the suite holds (so it can sign the T4+ replay as A); B registers
  // through the ordinary onboarding, which is what T2 is about.
  const customerKey = generateSecretKey()
  const customerHandle = await importCustomer(a.page, customerKey)
  const landedOnWallet = await a.page.getByText('Total balance').waitFor({ timeout: 30_000 }).then(() => true, () => false)
  record('T2 customer A logs in with a backup key, lands on wallet', landedOnWallet && !a.page.url().includes('onboarding'),
    `npub=${customerHandle.slice(0, 20)}… url=${a.page.url()}`)
  await withRetry('T2 register customer B', b.page, () => registerCustomer(b.page, BASE))
  const recipientHandle = await handleOf(b.page)
  const recipientPubkey = await pubkeyOf(b.page)
  record('T2 customer B registers through onboarding, lands on wallet',
    !!recipientHandle && /^[0-9a-f]{64}$/.test(recipientPubkey) && !b.page.url().includes('onboarding'),
    `handle=${recipientHandle} url=${b.page.url()}`)

  await withRetry('T3 register merchant', m.page, () => registerMerchant(m.page, BASE))
  const merchantHandle = await handleOf(m.page)
  const merchantPubkey = await pubkeyOf(m.page)
  record('T3 merchant registered', !!merchantHandle && !m.page.url().includes('onboarding'), `handle=${merchantHandle}`)
  const customerPubkey = getPublicKey(customerKey)
  runContext = { ...runContext, customerHandle, customerPubkey, recipientHandle, recipientPubkey, merchantHandle, merchantPubkey }

  // No sleep and no re-login (#114): a stall registered through onboarding can sell at once.
  await goto(m.page, `${BASE}/sell`)
  record('T3 merchant reaches Sell straight after registering (#114)', m.page.url().includes('/sell'), m.page.url())

  return {
    merchantContext: m.context,
    customer: a.page,
    recipient: b.page,
    merchant: m.page,
    customerKey,
    customerHandle,
    customerPubkey,
    recipientHandle,
    recipientPubkey,
    merchantHandle,
    merchantPubkey,
  }
}

/** T3+/T4/T4+: an EUR sale lands in A's wallet, and a re-submit of its token is refused. */
async function sellAndReceive(w: Wallets): Promise<void> {
  const before = await balance(w.customer)
  const sold = await sell(w.merchant, w.customerHandle, SINGLE_SALE).catch((e) => `ERR ${e}`)
  record(`T3+ sell EUR ${SINGLE_SALE} (#95: no "No active keyset for unit EUR")`,
    SALE_DELIVERED.test(sold) && !/No active keyset/i.test(sold), oneLine(sold))
  const after = await waitForBalanceChange(w.customer, before, 3 * 60_000)
  record('T4 customer balance rises by the sale', cents(after) - cents(before) === cents(SINGLE_SALE),
    `balance ${before} -> ${after}`)

  const firstReceive = observedReceives.find((r) => r.status === 200 && r.token)
  record('T4 wallet sent a deterministic rcv_ idempotency key (#110)',
    !!firstReceive && /^rcv_[0-9a-f]{16,}$/.test(firstReceive.idempotencyKey), firstReceive?.idempotencyKey ?? 'no receive observed')
  if (!firstReceive) return
  const replay = await replayUnderNewKey(w.customerKey, firstReceive.token)
  record('T4+ re-submit under a new key -> 409 RECEIVE_ALREADY_SETTLED with X-Receive-Id (#119)',
    replay.status === 409 && replay.code === 'RECEIVE_ALREADY_SETTLED' && replay.receiveId !== '',
    `HTTP ${replay.status} code=${replay.code} X-Receive-Id=${replay.receiveId || 'absent'} ${replay.body}`)
  const afterReplay = await balance(w.customer)
  record('T4+ balance unchanged by the re-submit', afterReplay === after, `balance ${after} -> ${afterReplay}`)
}

/** Samples the toasts on a page every 2 s, without navigating it, until stopped. */
function watchToasts(page: Page): { stop: () => void; seen: Set<string>; maxAtOnce: { advance: number; received: number } } {
  const seen = new Set<string>()
  const maxAtOnce = { advance: 0, received: 0 }
  const timer = setInterval(() => {
    visibleToasts(page).then((toasts) => {
      toasts.forEach((x) => seen.add(x.replace(/\n+/g, ' ')))
      maxAtOnce.advance = Math.max(maxAtOnce.advance, toasts.filter((t) => /on its way/i.test(t)).length)
      maxAtOnce.received = Math.max(maxAtOnce.received, toasts.filter((t) => /received/i.test(t)).length)
    }).catch(() => {})
  }, 2000)
  return { stop: () => clearInterval(timer), seen, maxAtOnce }
}

/**
 * T8: A pays B everything it holds, which is several coupons, so it goes as a bundle (#94/#110).
 */
async function payCustomerToCustomer(w: Wallets): Promise<void> {
  const beforeSetup = await balance(w.customer)
  for (const part of BUNDLE_PARTS) {
    const sold = await sellForSetup(w.merchantContext, w.merchant, w.customerHandle, part)
    if (!SALE_DELIVERED.test(sold)) record(`T8 setup: sell EUR ${part} to A`, false, oneLine(sold))
  }
  const heldByA = await waitForBalanceToSettle(w.customer, 5 * 60_000)
  record(`T8 setup: A holds ${BUNDLE_PARTS.length} extra coupons`,
    cents(heldByA) - cents(beforeSetup) === sumOfCents(BUNDLE_PARTS), `A balance ${beforeSetup} -> ${heldByA}`)
  const expectedParts = 1 + BUNDLE_PARTS.length
  const total = asEuros(cents(heldByA))

  // B sits on its home screen for the whole delivery: the toasts are read where they appear,
  // and the balance is read off the same screen rather than by reloading it.
  const beforeB = await balance(w.recipient)
  const toasts = watchToasts(w.recipient)
  const sent = await send(w.customer, w.recipientPubkey, total).catch((e) => `ERR ${e}`)
  const sentParts = Number(/as (\d+) vouchers/.exec(sent)?.[1] ?? '1')
  record(`T8 A sends all it holds, EUR ${total}, to B as ${expectedParts} vouchers`,
    !FAILURE_WORDS.test(sent) && sentParts === expectedParts, `parts=${sentParts} | ${oneLine(sent)}`)
  const afterB = await waitForBalanceToSettle(w.recipient, BUNDLE_WINDOW_MS, balanceInPlace)
  toasts.stop()
  record('T8 B balance rises by the full total', cents(afterB) - cents(beforeB) === cents(total), `B balance ${beforeB} -> ${afterB}`)
  checkBundleToasts(toasts.seen, toasts.maxAtOnce)
  await checkBundleBell(w.recipient, total, sentParts)
  const txCount = await transactionCount(w.recipient, w.merchantPubkey)
  record('T8 B Transactions list shows the payment as one line', txCount === 1, `${txCount} entries`)
}

function checkBundleToasts(seen: Set<string>, maxAtOnce: { advance: number; received: number }): void {
  const bundleToasts = [...seen].filter((t) => /received|vouchers| of /i.test(t))
  const shown = bundleToasts.join(' || ') || 'no toast captured'
  record('T8 B is shown the payment arriving (at least one toast)', bundleToasts.length > 0, shown)
  record('T8 B never sees "has not arrived"', !bundleToasts.some((t) => /not arrived|hasn.t arrived/i.test(t)), shown)
  // A bundle's toasts are updated IN PLACE (ids pending-bundle-<id>, received-bundle-<id>), so
  // the samples taken every 2 s show one toast at several stages ("€10.00 of €12.00", then
  // "€12.00"). One payment means no more than one "on its way" and one "received" toast visible
  // at the same moment, which is what the per-sample count checks.
  record('T8 B sees one toast per stage, never one per voucher',
    bundleToasts.length > 0 && maxAtOnce.advance <= 1 && maxAtOnce.received <= 1,
    `max at once: on-its-way=${maxAtOnce.advance} received=${maxAtOnce.received} | ${shown}`)
}

/** #94's acceptance: ONE advance row and ONE settlement row naming the full total and count. */
async function checkBundleBell(recipient: Page, total: string, parts: number): Promise<void> {
  const bell = await notificationRows(recipient)
  const advanceRows = bell.filter((r) => /on its way/i.test(r))
  const settledRows = bell.filter((r) => /Payment received/i.test(r))
  const expected = `€${total} received (${parts} vouchers)`
  record(`T8 bell: one advance row and one settlement row, "${expected}"`,
    advanceRows.length === 1 && settledRows.length === 1 && settledRows[0]!.includes(expected)
      && !bell.some((r) => /not arrived|hasn.t arrived/i.test(r)),
    bell.join(' || ') || 'no rows')
}

/**
 * T9: B pays the stall that issued the coupons back with an 8-part bundle. Every part is
 * received by the issuer and then burnt (the scenario that lost EUR 100, #110).
 */
async function payBackToIssuer(w: Wallets): Promise<void> {
  const heldBefore = await balance(w.recipient)
  const topUps = Array.from({ length: SELF_ISSUED_PARTS - (1 + BUNDLE_PARTS.length) }, () => SELF_ISSUED_TOP_UP)
  for (const part of topUps) {
    const sold = await sellForSetup(w.merchantContext, w.merchant, w.recipientHandle, part)
    if (!SALE_DELIVERED.test(sold)) record(`T9 setup: sell EUR ${part} to B`, false, oneLine(sold))
  }
  const heldByB = await waitForBalanceToSettle(w.recipient, 5 * 60_000)
  const expectedHeld = cents(heldBefore) + sumOfCents(topUps)
  record(`T9 setup: B holds every coupon it was sent (EUR ${asEuros(expectedHeld)})`,
    cents(heldByB) === expectedHeld, `B balance ${heldBefore} -> ${heldByB}`)

  const total = asEuros(cents(heldByB))
  const paid = await send(w.recipient, w.merchantPubkey, total).catch((e) => `ERR ${e}`)
  const paidParts = Number(/as (\d+) vouchers/.exec(paid)?.[1] ?? '1')
  if (runContext) runContext.payBackParts = String(paidParts)
  record(`T9 B pays EUR ${total} back to the issuing stall as ${SELF_ISSUED_PARTS} parts`,
    !FAILURE_WORDS.test(paid) && paidParts === SELF_ISSUED_PARTS, `parts=${paidParts} | ${oneLine(paid)}`)
  const afterPayBack = await waitForBalanceToSettle(w.recipient, BUNDLE_WINDOW_MS)
  record('T9 B balance falls to zero', cents(afterPayBack) === 0, `B balance ${heldByB} -> ${afterPayBack}`)
  // A trading merchant's home is the till and shows no balance; what the stall HOLDS of its own
  // coupons is on its merchant page. Each part must have been received and then burnt.
  const stallHolds = await ownCouponsHeld(w.merchant, w.merchantPubkey, BUNDLE_WINDOW_MS)
  record('T9 the stall holds none of its own coupons afterwards (each part burnt)', stallHolds.cents === 0,
    `stall's own-coupon balance: ${stallHolds.text}`)
}

/** T10 and the run-wide checks, over everything the wallets logged and requested. */
function checkWholeRun(): void {
  const unsaved = consoleLines.filter((l) => UNSAVED_RECEIVE.test(l))
  record('T10 console free of settled-but-not-saved (#112, #123)', unsaved.length === 0, unsaved.join(' || ') || 'none')
  const pageErrors = consoleLines.filter((l) => /PAGEERROR/.test(l))
  record('T2-T9 no uncaught page errors', pageErrors.length === 0, pageErrors.join(' || ') || 'none')
  const rateLimited = failedRequests.filter((r) => / 429 /.test(r))
  record('no request was rate limited (429)', rateLimited.length === 0, rateLimited.join(' || ') || 'none')
  record('no wallet was locked out mid-run (session lapse)', sessionLapses.length === 0, sessionLapses.join(' || ') || 'none')
}

/** What run.sh and a human need afterwards: the failed requests, the console, the wallets. */
function printEvidence(): void {
  console.log('--- failed requests ---')
  for (const r of failedRequests.slice(-CONSOLE_EVIDENCE_LINES)) console.log(r)
  console.log('--- notable console ---')
  for (const l of consoleLines.filter((x) => EVIDENCE_FILTER.test(x)).slice(-CONSOLE_EVIDENCE_LINES)) console.log(l)
  if (runContext) console.log('CONTEXT ' + JSON.stringify(runContext))
  console.log('SUMMARY ' + JSON.stringify(checks.map((c) => [c.step, c.ok])))
}

async function main(): Promise<number> {
  const browser = await chromium.launch()
  try {
    const wallets = await registerWallets(browser)
    await sellAndReceive(wallets)
    await payCustomerToCustomer(wallets)
    await payBackToIssuer(wallets)
    checkWholeRun()
  } catch (e) {
    // A crash mid-run is itself a finding: report it as a failed check; the evidence follows.
    record('suite ran to the end', false, String(e).split('\n').slice(0, 3).join(' | '))
  } finally {
    printEvidence()
    await browser.close().catch(() => {})
  }
  return checks.every((c) => c.ok) ? 0 : 1
}

main().then((code) => process.exit(code))
