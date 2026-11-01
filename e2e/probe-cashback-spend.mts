/**
 * Browser probe for imani-gateway-portal#52 / imani-wallet#144 and #53: a cashback a merchant
 * issues must be spendable back at that merchant, and its claim must reach the merchant.
 *
 * Before the fix the coupon behind a cashback code carried no issuance warrant. The customer
 * could claim it, but when they paid the issuing stall with it the stall's wallet refused it as
 * "Coupon not authorised", before any mint call. The portal also never heard that the code was
 * claimed, so the merchant's records said "Unclaimed".
 *
 *  1. A till and a customer register.
 *  2. The till issues a EUR cashback code (/sell/cashback).
 *  3. The customer redeems the code (/receive/cashback).
 *  4. The customer pays the whole balance back to the till.
 *  5. The till must accept it: no refusal, the customer ends at zero, and the till's store holds
 *     an incoming row for the cashback's voucher.
 *  6. The portal must hear of the claim by itself: GET /api/v1/portal/cashback/{id} reads
 *     Claimed, signed as the till. Not `/status`: that one asks the claim service on every read
 *     and fixes the record as it goes, so it reads Claimed even when no notification ever came
 *     (it passed on a staging without #53). Set E2E_SKIP_CLAIM_STATUS=1 to skip it.
 *  7. The till's Vouchers list shows the cashback voucher.
 *  8. The till's bell holds ONE "€5.00 cashback claimed (CB-…)" entry (imani-wallet#158,
 *     imani-gateway-portal#59), from the push or the in-app drain, and its cashback row is
 *     stamped Claimed without a status fetch. Skipped with E2E_SKIP_CLAIM_STATUS=1 too.
 *
 * Output: one JSON line per check, then CONTEXT and SUMMARY. Exit 1 on any failed check.
 *
 *   E2E_BASE=https://wallet.staging.398ja.xyz npx tsx e2e/probe-cashback-spend.mts
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { parseVoucherToken } from '../src/lib/voucherToken'
import { registerCustomer, registerMerchant, TEST_PASSPHRASE, TEST_STALL_NAME } from './register.mts'
import { bypassCaptcha } from './captchaBypass.mts'

const BASE = (process.env.E2E_BASE ?? 'https://wallet.staging.398ja.xyz').replace(/\/+$/, '')
const BROWSER_LOCALE = 'en-GB'
const CASHBACK_AMOUNT = process.env.E2E_CASHBACK ?? '5.00'
/** A new stall's coupon:issue permission is cached this long by the gateway (#114). */
const PERMISSION_CACHE_MS = 62_000
const POLL_MS = 5_000
const SETTLED_AFTER_MS = 45_000
const SETTLE_WINDOW_MS = 5 * 60_000
const PAYMENT_WAIT_POLLS = 120
/** How long the claim notification has to reach the portal before the check gives up. */
const CLAIM_STATUS_WINDOW_MS = 3 * 60_000
const STORED_CLAIMED = /^200 status=Claimed$/
/** How long the merchant's bell has to show the claim (drain ticks every 10s). */
const CLAIM_BELL_WINDOW_MS = 2 * 60_000
const CLAIM_CODE = /\bCB-[A-Z0-9]{4,5}-[A-Z0-9]{2,5}\b/
const PAYMENT_DONE = /^(Sent|Paid|Partly sent)$/m
const FAILURE_WORDS = /failed|error|could not|NOT been delivered|never finished|refused/i
const REFUSAL = /not authorised|refus|already spent/i
const SCREENSHOT_DIR = process.env.E2E_SCREENSHOTS ?? 'e2e/.probe-cashback-spend'

type Check = { step: string; ok: boolean; detail: string }
const checks: Check[] = []
const tillConsole: string[] = []
const tillToasts = new Set<string>()
const context: Record<string, unknown> = { base: BASE }

function record(step: string, ok: boolean, detail: string): void {
  checks.push({ step, ok, detail })
  console.log(JSON.stringify({ step, ok, detail: detail.slice(0, 900) }))
}

async function screenText(page: Page, limit = 1500): Promise<string> {
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
      // ERR_NETWORK_CHANGED can abort a module request without failing the
      // navigation (the dev server serves ~hundreds of modules), leaving an empty
      // #root. Treat that as the same host flake and reload.
      const rendered = await page
        .waitForFunction(() => (document.getElementById('root')?.childElementCount ?? 1) > 0, null, { timeout: 15_000 })
        .then(() => true, () => false)
      if (!rendered && attempt < 4) throw new Error('net::ERR_NETWORK_CHANGED (empty #root)')
      return
    } catch (e) {
      if (attempt === 4 || !/ERR_NETWORK_CHANGED|ERR_NETWORK_IO_SUSPENDED|net::ERR_ABORTED/.test(String(e))) throw e
      await page.waitForTimeout(2000)
    }
  }
}

async function unlockIfLocked(page: Page): Promise<void> {
  const lock = page.locator('input[placeholder="Passphrase"]')
  const unlocked = page.getByText(/Total balance|Scan the customer's code|Amount \(|Cashback/)
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

/** Issues a cashback on the till and returns the claim code shown, plus the portal's answer. */
async function issueCashback(till: Page, amount: string): Promise<{ code: string; screen: string; generated: Record<string, unknown> | null }> {
  let generated: Record<string, unknown> | null = null
  const onResponse = async (r: import('playwright').Response): Promise<void> => {
    if (r.request().method() === 'POST' && r.url().endsWith('/api/v1/portal/cashback/generate')) {
      generated = { status: r.status(), body: await r.json().catch(() => null), request: r.request().postDataJSON() }
    }
  }
  till.on('response', onResponse)
  await goto(till, `${BASE}/sell/cashback`)
  await unlockIfLocked(till)
  await till.locator('input[placeholder="0.00"]').fill(amount, { timeout: 30_000 })
  await till.getByRole('button', { name: /Create cashback code/i }).click()
  for (let i = 0; i < 60; i++) {
    await till.waitForTimeout(2000)
    const text = await screenText(till, 1200)
    const code = CLAIM_CODE.exec(text)?.[0]
    if (code || FAILURE_WORDS.test(text)) {
      till.off('response', onResponse)
      return { code: code ?? '', screen: text, generated }
    }
  }
  till.off('response', onResponse)
  return { code: '', screen: await screenText(till, 1200), generated }
}

async function redeemCashback(customer: Page, code: string): Promise<string> {
  await goto(customer, `${BASE}/receive/cashback`)
  await unlockIfLocked(customer)
  await customer.locator('input[placeholder="CB-XXXXX-XXXXX"]').fill(code, { timeout: 30_000 })
  await customer.getByRole('button', { name: /^Redeem$/ }).click()
  for (let i = 0; i < 60; i++) {
    await customer.waitForTimeout(2000)
    const text = await screenText(customer, 900)
    if (/Cashback added/.test(text) || FAILURE_WORDS.test(text)) return text
  }
  return screenText(customer, 900)
}

async function pay(customer: Page, tillPubkey: string, amount: string): Promise<string> {
  await goto(customer, `${BASE}/send?to=${tillPubkey}`)
  await unlockIfLocked(customer)
  const amountField = customer.locator('input[placeholder="0.00"]')
  if (!(await amountField.waitFor({ timeout: 15_000 }).then(() => true, () => false))) {
    await customer.getByRole('button').filter({ hasText: TEST_STALL_NAME }).first().click()
    await amountField.waitFor({ timeout: 30_000 })
  }
  await amountField.fill(amount)
  await customer.getByRole('button', { name: /^Continue$/ }).click()
  await customer.getByRole('button', { name: /^(Pay|Send)$/ }).last().click()
  for (let i = 0; i < PAYMENT_WAIT_POLLS; i++) {
    await customer.waitForTimeout(POLL_MS)
    const text = await screenText(customer, 900)
    if (PAYMENT_DONE.test(text) || FAILURE_WORDS.test(text)) return text
  }
  return screenText(customer, 900)
}

type StoredRow = Record<string, unknown>
type WalletStore = { vouchers: StoredRow[]; transactions: StoredRow[] }

/**
 * The wallet's own IndexedDB rows. Passed to the page as source text, not a function: tsx
 * compiles named inner functions with an `__name` helper that exists only in Node.
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

/** The voucher a coupon was signed for, and whether its secret carries an issuance warrant. */
function couponFacts(row: StoredRow): { voucherId?: string; warranted: boolean } {
  const token = text(row, 'token')
  if (!token) return { warranted: false }
  try {
    const parsed = parseVoucherToken(token)
    return { voucherId: parsed.voucher.voucherId, warranted: !!parsed.voucher.issuanceWarrant }
  } catch {
    return { warranted: false }
  }
}

/**
 * The portal's stored status for a cashback, read without reconciling it, as the till.
 * Parses the JSON rather than matching a slice of it: the body grew past any fixed cut once
 * the response gained voucherId, and a cut-off "status" read as never Claimed.
 */
async function portalStoredStatus(till: Page, cashbackId: string): Promise<string> {
  return till.evaluate(async (id) => {
    try {
      const r = await fetch(`/api/v1/portal/cashback/${id}`, { credentials: 'include' })
      const body = await r.text()
      try {
        return `${r.status} status=${String(JSON.parse(body).status)}`
      } catch {
        return `${r.status} ${body.slice(0, 200)}`
      }
    } catch (e) {
      return `fetch failed: ${String(e)}`
    }
  }, cashbackId)
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
  // A local stack fronts the claim host with a self-signed cert (e2e/stack/claim-tls).
  const browserContext = await browser.newContext({
    locale: BROWSER_LOCALE,
    ignoreHTTPSErrors: process.env.E2E_IGNORE_HTTPS_ERRORS === '1',
  })
  await bypassCaptcha(browserContext)
  return { browserContext, page: await browserContext.newPage() }
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

/** Registers once more if the first try failed; setup is not what this probe tests. */
async function registerWithRetry(register: (p: Page, base: string) => Promise<unknown>, page: Page): Promise<void> {
  try {
    await register(page, BASE)
  } catch (e) {
    record('setup: registration retried once', true, String(e).split('\n')[0]!)
    await register(page, BASE)
  }
}

async function checkSpendAtIssuer(till: Page, customer: Page, tillPubkey: string, voucherId: string): Promise<void> {
  const held = await waitForBalanceToSettle(customer)
  await goto(till, `${BASE}/`)
  await unlockIfLocked(till)
  const paid = await pay(customer, tillPubkey, (cents(held) / 100).toFixed(2))
  record(`customer pays the cashback (${held}) back to the issuing till`, PAYMENT_DONE.test(paid) && !FAILURE_WORDS.test(paid), oneLine(paid))
  const after = await waitForBalanceToSettle(customer)
  record('customer ends at zero', cents(after) === 0, `balance ${held} -> ${after}`)
  await till.waitForTimeout(10_000)

  const store = await walletStore(till)
  const incoming = store.transactions.filter((t) => t.direction === 'in')
  const forVoucher = incoming.filter((t) => text(t, 'voucherId', 'voucher_id') === voucherId)
  record('till booked an incoming redemption against the cashback voucher', forVoucher.length > 0,
    `${forVoucher.length} of ${incoming.length} incoming rows name ${voucherId}`)
  const refusals = tillConsole.filter((l) => REFUSAL.test(l) && /redemption|refus|warrant/i.test(l))
  record('till console shows no refused redemption', refusals.length === 0, refusals.join(' || ') || 'none')
  const refusedToasts = [...tillToasts].filter((t) => REFUSAL.test(t))
  record('till showed no "Coupon not authorised" or other refusal toast', refusedToasts.length === 0,
    refusedToasts.join(' || ') || `${tillToasts.size} toasts seen`)
}

async function checkClaimReachedPortal(till: Page, cashbackId: string): Promise<void> {
  if (process.env.E2E_SKIP_CLAIM_STATUS === '1') return
  const deadline = Date.now() + CLAIM_STATUS_WINDOW_MS
  let last = ''
  while (Date.now() < deadline) {
    last = await portalStoredStatus(till, cashbackId)
    if (STORED_CLAIMED.test(last)) break
    await till.waitForTimeout(POLL_MS)
  }
  record('portal stored the claim without being asked (claim notification arrived)', STORED_CLAIMED.test(last), last)
}

async function checkVouchersList(till: Page, voucherId: string): Promise<void> {
  await goto(till, `${BASE}/merchant/coupons`)
  await unlockIfLocked(till)
  await till.waitForTimeout(5000)
  const listed = await screenText(till, 3000)
  const store = await walletStore(till)
  const rowWithVoucher = store.transactions.find((t) => text(t, 'voucherId', 'voucher_id') === voucherId && t.direction !== 'in')
  record("till's own records name the cashback voucher (Vouchers list source)", !!rowWithVoucher,
    rowWithVoucher ? `row ${String(rowWithVoucher.id)} type ${String(rowWithVoucher.type)}` : `no issued/cashback row names ${voucherId}`)
  const listsIt = !/None yet\./.test(listed) && listed.includes(`€${CASHBACK_AMOUNT}`)
  record(`till's Vouchers list shows the €${CASHBACK_AMOUNT} cashback`, listsIt, oneLine(listed).slice(0, 600))
}

/** The till's bell rows, straight from the inbox's localStorage key (notifications/inbox.ts). */
async function bellEntries(till: Page, pubkey: string): Promise<Array<{ id?: string; type?: string; body?: string }>> {
  return till.evaluate((pk) => {
    try {
      const raw = localStorage.getItem(`imani-wallet:notifications:${pk}`)
      const parsed: unknown = raw ? JSON.parse(raw) : []
      return Array.isArray(parsed) ? (parsed as Array<{ id?: string; type?: string; body?: string }>) : []
    } catch {
      return []
    }
  }, pubkey)
}

async function checkClaimBell(till: Page, tillPubkey: string, cashbackId: string, code: string): Promise<void> {
  if (process.env.E2E_SKIP_CLAIM_STATUS === '1') return
  await goto(till, `${BASE}/`)
  await unlockIfLocked(till)
  const id = `cashback-claimed:${cashbackId}`
  const deadline = Date.now() + CLAIM_BELL_WINDOW_MS
  let matching: Array<{ id?: string; type?: string; body?: string }> = []
  while (Date.now() < deadline) {
    matching = (await bellEntries(till, tillPubkey)).filter((e) => e.id === id)
    if (matching.length > 0) break
    await till.waitForTimeout(POLL_MS)
  }
  const body = matching[0]?.body ?? ''
  const expected = `€${CASHBACK_AMOUNT} cashback claimed`
  record(`till's bell shows "${expected} (${code || 'CB-…'})"`,
    matching.length === 1 && body.startsWith(expected) && (!code || body.includes(`(${code})`)),
    matching.length === 0 ? `no bell entry ${id}` : `${matching.length} entr${matching.length === 1 ? 'y' : 'ies'}: ${body}`)
  const store = await walletStore(till)
  const row = store.transactions.find((t) => t.id === `cashback:${cashbackId}`)
  record("till's cashback row is stamped Claimed without a status fetch",
    !!row && text(row, 'cashbackStatus') === 'Claimed' && row.claimedAt !== undefined,
    row ? `cashbackStatus=${String(row.cashbackStatus)} claimedAt=${String(row.claimedAt)}` : `no row cashback:${cashbackId}`)
}

async function main(): Promise<number> {
  const browser = await chromium.launch()
  const pages: Page[] = []
  try {
    const till = await openWallet(browser)
    const customer = await openWallet(browser)
    pages.push(till.page, customer.page)
    const stopWatching = watchTill(till.page)
    customer.page.on('pageerror', (e) => console.log(`CUSTOMER_PAGEERROR ${e.message.slice(0, 300)}`))
    till.page.on('pageerror', (e) => console.log(`TILL_PAGEERROR ${e.message.slice(0, 300)}`))
    await registerWithRetry(registerCustomer, customer.page)
    await registerWithRetry(registerMerchant, till.page)
    const tillPubkey = await pubkeyOf(till.page)
    context.till = { handle: await handleOf(till.page), pubkey: tillPubkey }
    context.customer = await handleOf(customer.page)
    record('setup: a till and a customer registered', /^[0-9a-f]{64}$/.test(tillPubkey), JSON.stringify(context))
    await till.page.waitForTimeout(PERMISSION_CACHE_MS)
    await relogin(till.browserContext, till.page)

    const issued = await issueCashback(till.page, CASHBACK_AMOUNT)
    const generated = issued.generated as { status?: number; body?: Record<string, unknown>; request?: Record<string, unknown> } | null
    const cashbackId = String(generated?.body?.cashbackId ?? '')
    const responseVoucherId = String(generated?.body?.voucherId ?? '')
    context.cashback = { code: issued.code, cashbackId, voucherId: responseVoucherId }
    record(`till issues a EUR ${CASHBACK_AMOUNT} cashback code`, !!issued.code, oneLine(issued.screen).slice(0, 400))
    record('generate request carries an issuance warrant', typeof generated?.request?.issuanceWarrant === 'string',
      `request keys: ${Object.keys(generated?.request ?? {}).join(',')}`)
    record('generate response returns the voucher id', !!responseVoucherId, `status ${generated?.status} keys: ${Object.keys(generated?.body ?? {}).join(',')}`)

    const redeemed = await redeemCashback(customer.page, issued.code)
    record('customer redeems the code', /Cashback added/.test(redeemed), oneLine(redeemed).slice(0, 300))
    const customerStore = await walletStore(customer.page)
    const coupon = customerStore.vouchers.map(couponFacts).find((c) => !responseVoucherId || c.voucherId === responseVoucherId)
    record("the customer's coupon carries an issuance warrant in its signed secret", !!coupon?.warranted,
      `voucher ${coupon?.voucherId ?? '?'} warranted=${coupon?.warranted ?? false}`)
    const voucherId = responseVoucherId || coupon?.voucherId || ''

    await checkSpendAtIssuer(till.page, customer.page, tillPubkey, voucherId)
    if (cashbackId) await checkClaimReachedPortal(till.page, cashbackId)
    if (cashbackId) await checkClaimBell(till.page, tillPubkey, cashbackId, issued.code)
    await checkVouchersList(till.page, voucherId)
    stopWatching()
    const pageErrors = tillConsole.filter((l) => l.startsWith('[PAGEERROR]'))
    record('till: no uncaught page errors', pageErrors.length === 0, pageErrors.join(' || ') || 'none')
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
    const name = i === 0 ? 'till' : 'customer'
    await page.screenshot({ path: `${SCREENSHOT_DIR}/${name}.png`, fullPage: true }).catch(() => {})
  }
  console.log(`SCREENSHOTS ${SCREENSHOT_DIR}`)
}

main().then((code) => process.exit(code))
