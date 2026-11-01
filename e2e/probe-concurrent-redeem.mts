/**
 * Browser probe for imani-wallet#145: two coupons of DIFFERENT vouchers redeemed by one till
 * at the same moment must each be booked against their own voucher.
 *
 * Before 0.11.1 the legacy bridge kept one correlation slot, so two overlapping redeems could
 * swap stamps. One voucher then carried two rows for one redemption, and its owner's honest
 * last payment was refused as "already spent". Only live SSE delivery processes gift wraps
 * without waiting (DmPollService), so the till is kept online on its home screen while two
 * customers press Pay together.
 *
 * Each round:
 *  1. The till sells one coupon to each customer (two vouchers).
 *  2. Both customers pay part of their coupon to the till in the same instant.
 *  3. Both pay the rest, again together. This is the payment #145 refused.
 *
 * Checks, per round and for the whole run:
 *  - every payment is accepted, and each customer ends at zero;
 *  - the till shows no refusal, as a toast or in its console;
 *  - in the till's own store, every incoming row is stamped with the voucher its own coupon
 *    names (the stamp swap itself, independent of timing), and each voucher's rows add up to
 *    what its customer paid.
 *
 * Output: one JSON line per check, then CONTEXT and SUMMARY. Exit 1 on any failed check.
 *
 *   E2E_BASE=https://wallet.staging.398ja.xyz E2E_ROUNDS=3 npx tsx e2e/probe-concurrent-redeem.mts
 *
 * A control run: set E2E_BUNDLE_DIR to the `dist` of another build (e.g. v0.11.0). Every page
 * and asset under E2E_BASE is then served from that directory instead, while the API, relay and
 * mint stay the live ones. Expect the ledger checks to fail on a build without the fix.
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { parseVoucherToken } from '../src/lib/voucherToken'
import { registerCustomer, registerMerchant, TEST_PASSPHRASE, TEST_STALL_NAME } from './register.mts'

const BASE = (process.env.E2E_BASE ?? 'https://wallet.staging.398ja.xyz').replace(/\/+$/, '')
const ROUNDS = Number(process.env.E2E_ROUNDS ?? '3')
/** Amounts are read off the screen, so the locale they are parsed in is pinned. */
const BROWSER_LOCALE = 'en-GB'
const COUPON_FACE = '10.00'
/** The first payments are partial draws, so each coupon is split and has a remainder to pay. */
const FIRST_PAYMENTS = ['3.00', '4.00'] as const
/** A new stall's coupon:issue permission is cached this long by the gateway (#114). */
const PERMISSION_CACHE_MS = 62_000
const POLL_MS = 5_000
const SALE_WAIT_POLLS = 60
const PAYMENT_WAIT_POLLS = 120
/** A balance unchanged for this long is taken as final. */
const SETTLED_AFTER_MS = 45_000
const SETTLE_WINDOW_MS = 5 * 60_000
const SALE_DELIVERED = /It is in their wallet now/
const PAYMENT_DONE = /^(Sent|Paid|Partly sent)$/m
const FAILURE_WORDS = /failed|error|could not|NOT been delivered|never finished|refused/i
const REFUSAL = /refus|already spent|already redeemed/i
/** Where a failed run leaves a screenshot of every open wallet. */
const SCREENSHOT_DIR = process.env.E2E_SCREENSHOTS ?? 'e2e/.probe-concurrent-redeem'
const BUNDLE_DIR = process.env.E2E_BUNDLE_DIR
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
}

type Check = { step: string; ok: boolean; detail: string }
const checks: Check[] = []
const tillConsole: string[] = []
const tillToasts = new Set<string>()
const context: Record<string, unknown> = { base: BASE, rounds: ROUNDS }

function record(step: string, ok: boolean, detail: string): void {
  checks.push({ step, ok, detail })
  console.log(JSON.stringify({ step, ok, detail: detail.slice(0, 900) }))
}

async function screenText(page: Page, limit = 1200): Promise<string> {
  return (await page.locator('body').innerText()).replace(/\n{2,}/g, '\n').slice(0, limit)
}

function oneLine(text: string): string {
  return text.replace(/\n/g, ' | ')
}

/** Retries a navigation the browser itself aborted on a host network change. */
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

/** A lapsed session shows the lock screen on any route; that is the product, not a failure. */
async function unlockIfLocked(page: Page): Promise<void> {
  const lock = page.locator('input[placeholder="Passphrase"]')
  const unlocked = page.getByText(/Total balance|Scan the customer's code|Amount \(/)
  await Promise.race([lock.waitFor({ timeout: 30_000 }), unlocked.first().waitFor({ timeout: 30_000 })]).catch(() => {})
  if (!(await lock.isVisible().catch(() => false))) return
  await lock.fill(TEST_PASSPHRASE)
  await page.getByRole('button', { name: /unlock/i }).first().click()
  await page.waitForTimeout(5000)
}

async function relogin(browserContext: BrowserContext, page: Page): Promise<void> {
  await browserContext.clearCookies()
  await goto(page, `${BASE}/`)
  await page.locator('input[placeholder="Passphrase"]').fill(TEST_PASSPHRASE)
  await page.getByRole('button', { name: /unlock/i }).first().click()
  await page.waitForTimeout(6000)
}

async function balance(page: Page): Promise<string> {
  await goto(page, `${BASE}/`)
  await unlockIfLocked(page)
  await page.getByText('Total balance').waitFor({ timeout: 30_000 })
  await page.waitForTimeout(3000)
  return (await screenText(page, 800)).match(/Total balance\s*\n?([^\n]+)/)?.[1]?.trim() ?? '?'
}

/** Whole cents of an en-GB amount ("€1,234.56"). Anything else is NaN. */
function cents(text: string): number {
  const digits = text.replace(/[^\d.-]/g, '')
  return digits ? Math.round(Number.parseFloat(digits) * 100) : Number.NaN
}

async function waitForBalanceToSettle(page: Page): Promise<string> {
  const deadline = Date.now() + SETTLE_WINDOW_MS
  let last = await balance(page)
  let stableSince = Date.now()
  while (Date.now() < deadline && Date.now() - stableSince < SETTLED_AFTER_MS) {
    await page.waitForTimeout(POLL_MS)
    const now = await balance(page)
    if (now !== last) {
      last = now
      stableSince = Date.now()
    }
  }
  return last
}

async function sell(till: Page, customerHandle: string, amount: string): Promise<string> {
  await goto(till, `${BASE}/sell`)
  await unlockIfLocked(till)
  if (!till.url().includes('/sell')) await goto(till, `${BASE}/sell`)
  await till.locator('input[placeholder="name"]').fill(customerHandle, { timeout: 30_000 })
  await till.getByRole('button', { name: /^Continue$/ }).click()
  await till.locator('input[placeholder="0.00"]').waitFor({ timeout: 30_000 })
  await till.locator('input[placeholder="0.00"]').fill(amount)
  await till.getByRole('button', { name: /Send voucher/i }).click()
  for (let i = 0; i < SALE_WAIT_POLLS; i++) {
    await till.waitForTimeout(POLL_MS)
    const text = await screenText(till, 900)
    if (SALE_DELIVERED.test(text) || FAILURE_WORDS.test(text)) return text
  }
  return screenText(till, 900)
}

/** Fills in a payment to the till and stops on the final Pay button, so two can be pressed together. */
async function preparePayment(customer: Page, tillPubkey: string, amount: string): Promise<void> {
  await goto(customer, `${BASE}/send?to=${tillPubkey}`)
  await unlockIfLocked(customer)
  const amountField = customer.locator('input[placeholder="0.00"]')
  if (!(await amountField.waitFor({ timeout: 15_000 }).then(() => true, () => false))) {
    await customer.getByRole('button').filter({ hasText: TEST_STALL_NAME }).first().click()
    await amountField.waitFor({ timeout: 30_000 })
  }
  await amountField.fill(amount)
  await customer.getByRole('button', { name: /^Continue$/ }).click()
  await customer.getByRole('button', { name: /^(Pay|Send)$/ }).last().waitFor({ timeout: 30_000 })
}

async function confirmPayment(customer: Page): Promise<string> {
  await customer.getByRole('button', { name: /^(Pay|Send)$/ }).last().click()
  for (let i = 0; i < PAYMENT_WAIT_POLLS; i++) {
    await customer.waitForTimeout(POLL_MS)
    const text = await screenText(customer, 900)
    if (PAYMENT_DONE.test(text) || FAILURE_WORDS.test(text)) return text
  }
  return screenText(customer, 900)
}

/** Both customers press Pay in the same instant, which is what makes the till's redeems overlap. */
async function payTogether(payments: Array<{ customer: Page; amount: string }>, tillPubkey: string): Promise<string[]> {
  await Promise.all(payments.map((p) => preparePayment(p.customer, tillPubkey, p.amount)))
  return Promise.all(payments.map((p) => confirmPayment(p.customer)))
}

type StoredRow = Record<string, unknown>
type WalletStore = { vouchers: StoredRow[]; transactions: StoredRow[] }

/**
 * The wallet's own IndexedDB rows, read from whichever database holds the wallet stores.
 *
 * Passed to the page as source text, not a function: tsx compiles named inner functions with an
 * `__name` helper that exists only in Node, and the page then throws on it.
 */
const READ_WALLET_STORE = `(async () => {
  const readAll = (db, store) => new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).getAll()
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  for (const info of await indexedDB.databases()) {
    if (!info.name) continue
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(info.name)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    const names = Array.from(db.objectStoreNames)
    if (names.includes('wallet_transactions') && names.includes('wallet_vouchers')) {
      const result = { vouchers: await readAll(db, 'wallet_vouchers'), transactions: await readAll(db, 'wallet_transactions') }
      db.close()
      return result
    }
    db.close()
  }
  return { vouchers: [], transactions: [] }
})()`

async function walletStore(page: Page): Promise<WalletStore> {
  return page.evaluate(READ_WALLET_STORE) as Promise<WalletStore>
}

function text(row: StoredRow, ...keys: string[]): string | undefined {
  for (const key of keys) if (typeof row[key] === 'string' && row[key]) return row[key] as string
  return undefined
}

/**
 * The voucher a coupon was signed for, read from its token as the app does (`redemptionRows`).
 * A coupon row's own `voucher_id` is a per-row id, not the signed voucher, so it is not used.
 */
function signedVoucherOf(row: StoredRow): string | undefined {
  const token = text(row, 'token')
  if (!token) return undefined
  try {
    return parseVoucherToken(token).voucher.voucherId || undefined
  } catch {
    return undefined
  }
}

/** The signed voucher of the one coupon a customer holds. */
async function heldVoucherId(customer: Page): Promise<string> {
  const store = await walletStore(customer)
  const held = store.vouchers.filter((v) => (v.status ?? 'active') === 'active')
  return held.length === 1 ? (signedVoucherOf(held[0]!) ?? '') : `ambiguous:${held.length}`
}

type LedgerAudit = { misfiled: string[]; incomingByVoucher: Map<string, number[]> }

/** Every incoming till row against the coupon it names: the #145 stamp swap, read off the store. */
function auditLedger(store: WalletStore): LedgerAudit {
  const couponVoucher = new Map(store.vouchers.map((v) => [text(v, 'token_id') ?? '', signedVoucherOf(v) ?? '']))
  const misfiled: string[] = []
  const incomingByVoucher = new Map<string, number[]>()
  for (const tx of store.transactions) {
    if (tx.direction !== 'in') continue
    const stamped = text(tx, 'voucherId', 'voucher_id') ?? ''
    const tokenId = text(tx, 'tokenId', 'token_id') ?? ''
    const named = couponVoucher.get(tokenId)
    if (named && stamped && named !== stamped) misfiled.push(`row ${String(tx.id)} stamped ${stamped} but its coupon names ${named}`)
    const amounts = incomingByVoucher.get(named || stamped) ?? []
    amounts.push(Number(tx.amount ?? 0))
    incomingByVoucher.set(named || stamped, amounts)
  }
  return { misfiled, incomingByVoucher }
}

function watchTill(till: Page): () => void {
  till.on('console', (m) => tillConsole.push(`[${new Date().toISOString()} ${m.type()}] ${m.text().slice(0, 400)}`))
  till.on('pageerror', (e) => tillConsole.push(`[PAGEERROR] ${e.message}`))
  const timer = setInterval(() => {
    till.locator('[data-sonner-toast], [role="status"]').allInnerTexts()
      .then((toasts) => toasts.forEach((t) => tillToasts.add(oneLine(t))))
      .catch(() => {})
  }, 1000)
  return () => clearInterval(timer)
}

async function openWallet(browser: Browser): Promise<{ browserContext: BrowserContext; page: Page }> {
  // No service worker on a control run: it would cache whichever bundle it saw first.
  const browserContext = await browser.newContext({ locale: BROWSER_LOCALE, serviceWorkers: BUNDLE_DIR ? 'block' : 'allow' })
  if (BUNDLE_DIR) await serveBundleFrom(browserContext, BUNDLE_DIR)
  return { browserContext, page: await browserContext.newPage() }
}

/** Serves the app shell and assets from a local build; API calls still go to staging. */
async function serveBundleFrom(browserContext: BrowserContext, dir: string): Promise<void> {
  const root = normalize(dir)
  const shell = join(root, 'index.html')
  await browserContext.route(`${BASE}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.startsWith('/api/') || path.startsWith('/.well-known/') || path.startsWith('/fcaptcha/')) return route.continue()
    const file = await bundleFile(root, path, shell)
    return route.fulfill({ status: 200, body: await readFile(file), contentType: CONTENT_TYPES[extname(file)] ?? 'application/octet-stream' })
  })
}

/** The built file for a path, or the app shell for a client-side route, as the wallet's nginx does. */
async function bundleFile(root: string, path: string, shell: string): Promise<string> {
  const file = normalize(join(root, path))
  if (!file.startsWith(root) || !extname(file)) return shell
  return readFile(file).then(() => file, () => shell)
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

async function handleOf(page: Page): Promise<string> {
  return page.evaluate(() => document.body.innerText.match(/@((?:cust|till)\d+)/)?.[1] ?? '')
}

type Party = { page: Page; handle: string }

/**
 * Registers once more if the first try failed. Setup is not what this probe tests, and its
 * known flakes are on the test host (Docker churning bridges aborts Chromium's loads) or the
 * onboarding walk racing the page. A second failure is reported.
 */
async function registerWithRetry(register: (p: Page, base: string) => Promise<unknown>, page: Page): Promise<void> {
  try {
    await register(page, BASE)
  } catch (e) {
    record('setup: registration retried once', true, String(e).split('\n')[0]!)
    await register(page, BASE)
  }
}

async function runRound(round: number, till: Page, tillContext: BrowserContext, tillPubkey: string, customers: Party[]): Promise<void> {
  const label = `R${round}`
  const vouchers: string[] = []
  for (const customer of customers) {
    let sold = await sell(till, customer.handle, COUPON_FACE).catch((e) => `ERR ${e}`)
    if (!SALE_DELIVERED.test(sold)) {
      await relogin(tillContext, till)
      sold = await sell(till, customer.handle, COUPON_FACE).catch((e) => `ERR ${e}`)
    }
    record(`${label} setup: till sells EUR ${COUPON_FACE} to ${customer.handle}`, SALE_DELIVERED.test(sold), oneLine(sold))
  }
  for (const customer of customers) {
    const held = await waitForBalanceToSettle(customer.page)
    vouchers.push(await heldVoucherId(customer.page))
    record(`${label} setup: ${customer.handle} holds one coupon of EUR ${COUPON_FACE}`, cents(held) === cents(COUPON_FACE),
      `balance ${held}, voucher ${vouchers.at(-1)}`)
  }
  record(`${label} setup: the two coupons are different vouchers`, vouchers[0] !== vouchers[1] && !vouchers.some((v) => !v || v.startsWith('ambiguous')),
    vouchers.join(' vs '))

  // The till waits on its home screen, online, so both DMs arrive over live SSE.
  await goto(till, `${BASE}/`)
  await unlockIfLocked(till)
  const first = await payTogether(customers.map((c, i) => ({ customer: c.page, amount: FIRST_PAYMENTS[i]! })), tillPubkey)
  first.forEach((screen, i) => record(`${label} ${customers[i]!.handle} pays EUR ${FIRST_PAYMENTS[i]} together with the other`,
    PAYMENT_DONE.test(screen) && !FAILURE_WORDS.test(screen), oneLine(screen)))

  const remainders = await Promise.all(customers.map((c) => waitForBalanceToSettle(c.page)))
  await goto(till, `${BASE}/`)
  await unlockIfLocked(till)
  const last = await payTogether(customers.map((c, i) => ({ customer: c.page, amount: (cents(remainders[i]!) / 100).toFixed(2) })), tillPubkey)
  last.forEach((screen, i) => record(`${label} ${customers[i]!.handle} pays the rest (EUR ${remainders[i]}), the payment #145 refused`,
    PAYMENT_DONE.test(screen) && !FAILURE_WORDS.test(screen), oneLine(screen)))

  for (const customer of customers) {
    const after = await waitForBalanceToSettle(customer.page)
    record(`${label} ${customer.handle} ends at zero`, cents(after) === 0, `balance ${after}`)
  }
  ;(context.vouchers as string[][]).push(vouchers)
}

function checkTill(store: WalletStore): void {
  const audit = auditLedger(store)
  record('till: every incoming row is stamped with the voucher its own coupon names', audit.misfiled.length === 0,
    audit.misfiled.join(' || ') || `${store.transactions.filter((t) => t.direction === 'in').length} incoming rows checked`)
  for (const pair of context.vouchers as string[][]) {
    for (const voucherId of pair) {
      const amounts = audit.incomingByVoucher.get(voucherId) ?? []
      record(`till: voucher ${voucherId.slice(0, 12)} has its two redemptions, no more`, amounts.length === 2,
        `incoming amounts ${JSON.stringify(amounts)}`)
    }
  }
  const refusals = tillConsole.filter((l) => REFUSAL.test(l) && /redemption|refus/i.test(l))
  record('till console shows no refused redemption', refusals.length === 0, refusals.join(' || ') || 'none')
  const refusedToasts = [...tillToasts].filter((t) => REFUSAL.test(t))
  record('till showed no refusal toast', refusedToasts.length === 0, refusedToasts.join(' || ') || `${tillToasts.size} toasts seen`)
  const pageErrors = tillConsole.filter((l) => l.startsWith('[PAGEERROR]'))
  record('till: no uncaught page errors', pageErrors.length === 0, pageErrors.join(' || ') || 'none')
}

async function main(): Promise<number> {
  const browser = await chromium.launch()
  const pages: Page[] = []
  context.vouchers = []
  try {
    const till = await openWallet(browser)
    pages.push(till.page)
    const stopWatching = watchTill(till.page)
    const customers: Party[] = []
    for (let i = 0; i < 2; i++) {
      const c = await openWallet(browser)
      pages.push(c.page)
      await registerWithRetry(registerCustomer, c.page)
      customers.push({ page: c.page, handle: await handleOf(c.page) })
    }
    await registerWithRetry(registerMerchant, till.page)
    const tillPubkey = await pubkeyOf(till.page)
    context.till = { handle: await handleOf(till.page), pubkey: tillPubkey }
    context.customers = customers.map((c) => c.handle)
    record('setup: a till and two customers registered', /^[0-9a-f]{64}$/.test(tillPubkey) && customers.every((c) => c.handle),
      JSON.stringify(context))
    await till.page.waitForTimeout(PERMISSION_CACHE_MS)
    await relogin(till.browserContext, till.page)

    for (let round = 1; round <= ROUNDS; round++) await runRound(round, till.page, till.browserContext, tillPubkey, customers)
    stopWatching()
    checkTill(await walletStore(till.page))
  } catch (e) {
    record('probe ran to the end', false, String(e).split('\n').slice(0, 3).join(' | '))
  } finally {
    if (checks.some((c) => !c.ok)) await screenshotAll(pages)
    console.log(`CONTEXT ${JSON.stringify(context)}`)
    console.log(`SUMMARY ${JSON.stringify({ passed: checks.filter((c) => c.ok).length, failed: checks.filter((c) => !c.ok).length })}`)
    await browser.close().catch(() => {})
  }
  return checks.every((c) => c.ok) ? 0 : 1
}

/** A failed check leaves what each wallet was showing, so the failure explains itself. */
async function screenshotAll(pages: Page[]): Promise<void> {
  for (const [i, page] of pages.entries()) {
    const name = i === 0 ? 'till' : `customer-${i}`
    await page.screenshot({ path: `${SCREENSHOT_DIR}/${name}.png`, fullPage: true }).catch(() => {})
  }
  console.log(`SCREENSHOTS ${SCREENSHOT_DIR}`)
}

main().then((code) => process.exit(code))
