/**
 * Browser probe for imani-wallet#157: a payment spends the soonest-expiring coupon, even when
 * its stored expiry is a legacy numeric STRING, and stored legacy expiries are migrated to
 * epoch seconds when the wallet opens.
 *
 * Legacy rows hold `expires_at` as a numeric string (e.g. "1798588800"), written by
 * gateway-core /inspect before v0.6.1 and carried forward by NIP-60 restore. Before the fix
 * the wallet read it with Date.parse, got NaN, treated the coupon as never expiring and spent
 * it LAST.
 *
 *  1. A till and a customer register.
 *  2. The till issues two EUR cashback codes the customer redeems: A with the stall's validity
 *     at 30 days (soon), then B at 60 days (later). Both can pay the amount alone.
 *  3. In the customer's IndexedDB, A's expires_at is rewritten to String(seconds), the
 *     pre-v0.6.1 form. The page is reloaded and unlocked, so openWallet runs.
 *  4. A's expires_at must now be a NUMBER equal to its real expiry (migration ran).
 *  5. The customer pays the till an amount either coupon covers. A must be the one spent:
 *     A's held face drops, B's does not, and the till's incoming row names A's voucher.
 *  6. No uncaught page errors on either side.
 *
 * Output: one JSON line per check, then CONTEXT and SUMMARY. Exit 1 on any failed check.
 *
 *   E2E_SERVE_FROM=http://localhost:5178 E2E_IGNORE_HTTPS_ERRORS=1 npx tsx e2e/probe-spend-order.mts
 *
 * The local stack trusts one browser origin, http://localhost:5177 (CORS on gateway-core,
 * gateway-customer, the mint and the claim host, and the NIP-98 public base URL). To test a
 * tree served on another port without touching the stack, the browser stays on E2E_BASE
 * (default http://localhost:5177) and every request to that origin is answered by the dev
 * server at E2E_SERVE_FROM. The app runs as the tree under test, under the origin the stack
 * expects. Without E2E_SERVE_FROM the probe talks to E2E_BASE directly.
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { parseVoucherToken } from '../src/lib/voucherToken'
import { registerCustomer, registerMerchant, TEST_PASSPHRASE, TEST_STALL_NAME } from './register.mts'

const BASE = (process.env.E2E_BASE ?? 'http://localhost:5177').replace(/\/+$/, '')
const SERVE_FROM = (process.env.E2E_SERVE_FROM ?? '').replace(/\/+$/, '')
const SOON_DAYS = 30
const LATER_DAYS = 60
const CASHBACK_AMOUNT = process.env.E2E_CASHBACK ?? '5.00'
/**
 * Exactly one coupon's face, so either coupon pays it alone with no split. A split needs
 * gateway-core to reach the mint, which the local stack cannot always do (mint-tls cert).
 */
const PAY_AMOUNT = process.env.E2E_PAY ?? CASHBACK_AMOUNT
const PERMISSION_CACHE_MS = 62_000
const POLL_MS = 5_000
const SETTLED_AFTER_MS = 30_000
const SETTLE_WINDOW_MS = 4 * 60_000
const PAYMENT_WAIT_POLLS = 120
const CLAIM_CODE = /\bCB-[A-Z0-9]{4,5}-[A-Z0-9]{2,5}\b/
const PAYMENT_DONE = /^(Sent|Paid|Partly sent)$/m
const FAILURE_WORDS = /failed|error|could not|NOT been delivered|never finished|refused/i
const SCREENSHOT_DIR = process.env.E2E_SCREENSHOTS ?? 'e2e/.probe-spend-order'

type Row = Record<string, unknown>
type Check = { step: string; ok: boolean; detail: string }
const checks: Check[] = []
const context: Record<string, unknown> = { base: BASE, serveFrom: SERVE_FROM || BASE }

function record(step: string, ok: boolean, detail: string): void {
  checks.push({ step, ok, detail })
  console.log(JSON.stringify({ step, ok, detail: detail.slice(0, 900) }))
}

async function screenText(page: Page, limit = 1500): Promise<string> {
  return (await page.locator('body').innerText()).replace(/\n{2,}/g, '\n').slice(0, limit)
}
const oneLine = (t: string): string => t.replace(/\n/g, ' | ')

/** Navigation that survives the dev server's ERR_NETWORK_CHANGED flake and an empty #root. */
async function goto(page: Page, url: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 60_000 })
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
  const unlocked = page.getByText(/Total balance|Scan the customer's code|Amount \(|Cashback|Vouchers stay valid/)
  await Promise.race([lock.waitFor({ timeout: 30_000 }), unlocked.first().waitFor({ timeout: 30_000 })]).catch(() => {})
  if (!(await lock.isVisible().catch(() => false))) return
  await lock.fill(TEST_PASSPHRASE)
  await page.getByRole('button', { name: /unlock/i }).first().click()
  await page.waitForTimeout(5000)
}

async function relogin(ctx: BrowserContext, page: Page): Promise<void> {
  await ctx.clearCookies()
  await goto(page, `${BASE}/`)
  await unlockIfLocked(page)
}

async function registerWithRetry(register: (p: Page, base: string) => Promise<unknown>, page: Page): Promise<void> {
  try {
    await register(page, BASE)
  } catch (e) {
    record('setup: registration retried once', true, String(e).split('\n')[0]!)
    await register(page, BASE)
  }
}

async function setValidity(till: Page, days: number): Promise<string> {
  await goto(till, `${BASE}/settings/merchant`)
  await unlockIfLocked(till)
  await till.getByRole('button', { name: new RegExp(`^${days} days`) }).first().click({ timeout: 30_000 })
  await till.getByRole('button', { name: /^Save$/ }).click()
  await till.waitForTimeout(5000)
  return oneLine(await screenText(till, 300))
}

async function issueCashback(till: Page): Promise<{ code: string; screen: string; generated: Row | null }> {
  let generated: Row | null = null
  const onResponse = async (r: import('playwright').Response): Promise<void> => {
    if (r.request().method() === 'POST' && r.url().endsWith('/api/v1/portal/cashback/generate')) {
      generated = { status: r.status(), body: await r.json().catch(() => null), request: r.request().postDataJSON() }
    }
  }
  till.on('response', onResponse)
  await goto(till, `${BASE}/sell/cashback`)
  await unlockIfLocked(till)
  await till.locator('input[placeholder="0.00"]').fill(CASHBACK_AMOUNT, { timeout: 30_000 })
  await till.getByRole('button', { name: /Create cashback code/i }).click()
  let text = ''
  for (let i = 0; i < 60; i++) {
    await till.waitForTimeout(2000)
    text = await screenText(till, 1200)
    if (CLAIM_CODE.test(text) || FAILURE_WORDS.test(text)) break
  }
  till.off('response', onResponse)
  return { code: CLAIM_CODE.exec(text)?.[0] ?? '', screen: text, generated }
}

async function redeem(customer: Page, code: string): Promise<string> {
  await goto(customer, `${BASE}/receive/cashback`)
  await unlockIfLocked(customer)
  await customer.locator('input[placeholder="CB-XXXXX-XXXXX"]').fill(code, { timeout: 30_000 })
  await customer.getByRole('button', { name: /^Redeem$/ }).click()
  let text = ''
  for (let i = 0; i < 60; i++) {
    await customer.waitForTimeout(2000)
    text = await screenText(customer, 900)
    if (/Cashback added/.test(text) || FAILURE_WORDS.test(text)) break
  }
  return text
}

async function balance(page: Page): Promise<string> {
  await goto(page, `${BASE}/`)
  await unlockIfLocked(page)
  await page.getByText('Total balance').waitFor({ timeout: 30_000 })
  await page.waitForTimeout(3000)
  return (await screenText(page, 800)).match(/Total balance\s*\n?([^\n]+)/)?.[1]?.trim() ?? '?'
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

/**
 * IndexedDB access, passed as source text: tsx compiles named inner functions with an
 * `__name` helper that exists only in Node. The wallet's DB is the one holding both stores.
 */
const OPEN_WALLET_DB = `
  const openWalletDb = async () => {
    for (const info of await indexedDB.databases()) {
      if (!info.name) continue
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open(info.name)
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
      const names = Array.from(db.objectStoreNames)
      if (names.includes('wallet_transactions') && names.includes('wallet_vouchers')) return db
      db.close()
    }
    return null
  }
  const readAll = (db, store) => new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).getAll()
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })`

const READ_WALLET_STORE = `(async () => {${OPEN_WALLET_DB}
  const all = []
  for (const info of await indexedDB.databases()) all.push(info.name)
  const db = await openWalletDb()
  if (!db) return { vouchers: [], transactions: [], db: null, all }
  const result = { vouchers: await readAll(db, 'wallet_vouchers'), transactions: await readAll(db, 'wallet_transactions'), db: db.name, all }
  db.close()
  return result
})()`

/** Rewrites the given rows (by token_id) to hold the given expires_at value as is. */
const writeLegacyExpiry = (tokenIds: string[], legacy: string | number): string => `(async () => {${OPEN_WALLET_DB}
  const db = await openWalletDb()
  if (!db) return 0
  const rows = await readAll(db, 'wallet_vouchers')
  const targets = rows.filter((r) => ${JSON.stringify(tokenIds)}.includes(r.token_id))
  await new Promise((resolve, reject) => {
    const tx = db.transaction('wallet_vouchers', 'readwrite')
    const store = tx.objectStore('wallet_vouchers')
    for (const row of targets) store.put({ ...row, expires_at: ${JSON.stringify(legacy)} })
    tx.oncomplete = () => resolve(undefined)
    tx.onerror = () => reject(tx.error)
  })
  db.close()
  return targets.length
})()`

async function walletStore(page: Page): Promise<{ vouchers: Row[]; transactions: Row[]; db: string | null }> {
  return page.evaluate(READ_WALLET_STORE) as Promise<{ vouchers: Row[]; transactions: Row[]; db: string | null }>
}

const str = (row: Row, ...keys: string[]): string | undefined => {
  for (const k of keys) if (typeof row[k] === 'string' && row[k]) return row[k] as string
  return undefined
}

/** The expiry signed into the token, in epoch seconds: the coupon's real expiry. */
function signedExpiry(row: Row): number | undefined {
  try {
    return parseVoucherToken(String(row.token)).voucher.expiresAt ?? undefined
  } catch {
    return undefined
  }
}

/**
 * A coupon is tracked by the stored rows its redeem added (token_id), not by voucher id: the
 * generate response's voucherId is not the one signed into the customer's token, and cashback
 * rows are stored with voucher_id null.
 */
type Coupon = { label: string; voucherId: string; tokenIds: string[]; signedExpiry?: number }
const rowsOf = (vouchers: Row[], c: Coupon): Row[] => vouchers.filter((v) => c.tokenIds.includes(String(v.token_id)))

const SPENT_STATUS = /^(redeemed|spent|sent|burnt|burned|pending)/i
/** Face value the customer still holds from one coupon, summed over its unspent rows. */
function heldFace(vouchers: Row[], c: Coupon): number {
  return rowsOf(vouchers, c)
    .filter((v) => !SPENT_STATUS.test(String(v.status ?? 'active')))
    .reduce((sum, v) => sum + Number(v.face_value ?? 0), 0)
}

function describeRows(vouchers: Row[], c: Coupon): string {
  const rows = rowsOf(vouchers, c)
  if (rows.length === 0) return 'no rows (gone from the store)'
  return rows
    .map((v) => `${String(v.token_id).slice(0, 8)} face=${String(v.face_value)} status=${String(v.status)} exp=${JSON.stringify(v.expires_at)}`)
    .join('; ')
}

/** Issue one cashback at a validity and redeem it; returns the rows it added. */
async function issueAndRedeem(till: { ctx: BrowserContext; page: Page }, customer: Page, label: string, days: number,
  waitForPermission: boolean): Promise<Coupon> {
  await setValidity(till.page, days)
  if (waitForPermission) await till.page.waitForTimeout(PERMISSION_CACHE_MS)
  await relogin(till.ctx, till.page)
  let issued = await issueCashback(till.page)
  if (!issued.code) {
    // The local portal's finalize step can time out under load (cashback.finalize timeout);
    // issuing is setup here, so retry once and say so.
    record(`setup: cashback ${label} issue retried once`, true, oneLine(issued.screen).slice(-200))
    issued = await issueCashback(till.page)
  }
  const gen = issued.generated as { status?: number; body?: Row; request?: Row } | null
  const voucherId = String(gen?.body?.voucherId ?? '')
  record(`till issues cashback ${label} at ${days} days validity`,
    !!issued.code && gen?.status === 200 && gen?.request?.voucherValidityDays === days,
    `code=${issued.code} voucherId=${voucherId} voucherValidityDays=${JSON.stringify(gen?.request?.voucherValidityDays)} | ${oneLine(issued.screen).slice(0, 200)}`)
  const held = new Set((await walletStore(customer)).vouchers.map((v) => String(v.token_id)))
  const redeemed = await redeem(customer, issued.code)
  record(`customer redeems cashback ${label}`, /Cashback added/.test(redeemed), oneLine(redeemed).slice(0, 200))
  await customer.waitForTimeout(3000)
  const store = await walletStore(customer)
  const added = store.vouchers.filter((v) => !held.has(String(v.token_id)))
  return { label, voucherId, tokenIds: added.map((v) => String(v.token_id)), signedExpiry: added.map(signedExpiry).find((e) => e != null) }
}

async function main(): Promise<number> {
  // A response fulfilled by a route carries no address space, so Chromium's Local Network Access
  // checks then block the app's calls to the stack's other localhost ports (relay, mint, claim).
  const browser: Browser = await chromium.launch(SERVE_FROM
    ? { args: ['--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights'] }
    : {})
  const pages: Page[] = []
  try {
    const mk = async () => {
      const ctx = await browser.newContext({ locale: 'en-GB', ignoreHTTPSErrors: process.env.E2E_IGNORE_HTTPS_ERRORS === '1' })
      if (SERVE_FROM) {
        const origin = new URL(BASE).origin
        await ctx.route((url) => url.origin === origin, async (route) => {
          const target = SERVE_FROM + route.request().url().slice(origin.length)
          // Host stays BASE's: NIP-98 routes are proxied with changeOrigin false, and the
          // gateway checks the signed `u` tag against the Host it is handed.
          const headers = { ...(await route.request().allHeaders()), host: new URL(BASE).host }
          // Retried: a pooled keep-alive socket to Vite occasionally hangs up, and one lost
          // module request leaves the app half-loaded.
          let response = null
          for (let attempt = 0; attempt < 4 && !response; attempt++) {
            if (attempt > 0 && route.request().method() !== 'GET') break
            response = await route.fetch({ url: target, headers, maxRedirects: 0, timeout: 60_000 }).catch(() => null)
          }
          if (!response) return route.abort('connectionreset').catch(() => {})
          return route.fulfill({ response }).catch(() => {})
        })
        // Vite's HMR socket would otherwise reach whatever really listens on BASE.
        await ctx.routeWebSocket((url) => url.port === new URL(BASE).port, (ws) => ws.close())
      }
      return { ctx, page: await ctx.newPage() }
    }
    const till = await mk()
    const customer = await mk()
    pages.push(till.page, customer.page)
    const pageErrors: string[] = []
    const customerConsole: string[] = []
    for (const [name, p] of [['till', till.page], ['customer', customer.page]] as const) {
      p.on('pageerror', (e) => pageErrors.push(`${name}: ${e.message.slice(0, 200)}`))
    }
    customer.page.on('console', (m) => {
      const t = m.text()
      if (/\[expiry\]|\[pay\]/.test(t)) customerConsole.push(t.slice(0, 300))
    })
    const net: string[] = []
    for (const [name, p] of [['till', till.page], ['customer', customer.page]] as const) {
      p.on('requestfailed', (r) => net.push(`${name} FAILED ${r.method()} ${r.url().slice(0, 140)} ${r.failure()?.errorText ?? ''}`))
      p.on('response', (r) => {
        if (r.status() >= 400 && !/\/nostr\/subscribe/.test(r.url())) net.push(`${name} ${r.status()} ${r.request().method()} ${r.url().slice(0, 140)}`)
      })
    }
    context.net = net

    await registerWithRetry(registerCustomer, customer.page)
    await registerWithRetry(registerMerchant, till.page)
    const tillPubkey = await till.page.evaluate(() => {
      for (let i = 0; i < localStorage.length; i++) {
        const m = /^imani-wallet:profile:([0-9a-f]{64})$/.exec(localStorage.key(i) ?? '')
        if (m) return m[1]
      }
      return ''
    })
    context.tillPubkey = tillPubkey
    record('setup: a till and a customer registered', /^[0-9a-f]{64}$/.test(tillPubkey), tillPubkey)

    // ── 1. two coupons from the same till: A soon, B later ──────────────────
    const a = await issueAndRedeem(till, customer.page, 'A (soon)', SOON_DAYS, true)
    const b = await issueAndRedeem(till, customer.page, 'B (later)', LATER_DAYS, false)
    const aSeconds = a.signedExpiry ?? NaN
    const bSeconds = b.signedExpiry ?? NaN
    context.A = a
    context.B = b
    record('setup: A and B each added one coupon, and A (signed expiry) expires before B',
      a.tokenIds.length > 0 && b.tokenIds.length > 0 && Number.isFinite(aSeconds) && aSeconds < bSeconds,
      `A rows ${a.tokenIds.join(',')} signed exp=${aSeconds} | B rows ${b.tokenIds.join(',')} signed exp=${bSeconds}`)
    await waitForBalanceToSettle(customer.page)

    // ── 2. A as a pre-v0.6.1 row, B as a correctly stored row ───────────────
    // The local stack stores cashback rows with expires_at null, which every version reads as
    // "never expires". B gets its real expiry as a NUMBER (what a current writer stores), so
    // the spend order turns on how A's legacy string is read: unreadable (main) sorts it after
    // B, read correctly (fix) sorts it first.
    const legacy = String(aSeconds)
    const rewroteA = (await customer.page.evaluate(writeLegacyExpiry(a.tokenIds, legacy))) as number
    const rewroteB = (await customer.page.evaluate(writeLegacyExpiry(b.tokenIds, bSeconds))) as number
    const injected = await walletStore(customer.page)
    record(`setup: A's stored expires_at is the legacy string "${legacy}", B's the number ${bSeconds}`,
      rewroteA > 0 && rewroteB > 0
        && rowsOf(injected.vouchers, a).every((v) => v.expires_at === legacy)
        && rowsOf(injected.vouchers, b).every((v) => v.expires_at === bSeconds),
      `in ${injected.db}: A ${describeRows(injected.vouchers, a)} | B ${describeRows(injected.vouchers, b)}`)

    // The customer's relay is cut from here on. On every login `restoreVouchers` rewrites each
    // coupon from its NIP-60 relay copy, and this stack published those copies with
    // expires_at null; a real legacy wallet's relay copy carries the same legacy string. Left
    // connected, the restore overwrites both A and B with null after openWallet, and the checks
    // would measure the restore, not the migration or the spend order.
    const relayPort = process.env.E2E_RELAY_PORT ?? '27778'
    await customer.ctx.routeWebSocket((url) => url.port === relayPort, (ws) => ws.close())

    // Reload so openWallet runs on the legacy row (a fresh page load locks the wallet).
    await customer.page.reload({ waitUntil: 'load' })
    await unlockIfLocked(customer.page)
    await customer.page.getByText('Total balance').waitFor({ timeout: 30_000 }).catch(() => {})
    await customer.page.waitForTimeout(4000)

    // ── 3. migration on open ────────────────────────────────────────────────
    const migrated = await walletStore(customer.page)
    const aRows = rowsOf(migrated.vouchers, a)
    record("#157 after reopening, A's expires_at is a NUMBER in epoch seconds equal to its real expiry",
      aRows.length > 0 && aRows.every((v) => typeof v.expires_at === 'number' && v.expires_at === aSeconds),
      `expected ${aSeconds}: ${describeRows(migrated.vouchers, a)}`)

    // ── 4. spend order ──────────────────────────────────────────────────────
    const before = await walletStore(customer.page)
    const aBefore = heldFace(before.vouchers, a)
    const bBefore = heldFace(before.vouchers, b)
    const tillInBefore = new Set((await walletStore(till.page)).transactions.filter((t) => t.direction === 'in').map((t) => String(t.id)))
    const paid = await pay(customer.page, tillPubkey, PAY_AMOUNT)
    record(`customer pays the till ${PAY_AMOUNT}`, PAYMENT_DONE.test(paid) && !FAILURE_WORDS.test(paid), oneLine(paid).slice(0, 400))
    await waitForBalanceToSettle(customer.page)
    const after = await walletStore(customer.page)
    const aAfter = heldFace(after.vouchers, a)
    const bAfter = heldFace(after.vouchers, b)
    context.held = { A: [aBefore, aAfter], B: [bBefore, bAfter] }
    record('#157 the payment spent A, the sooner-expiring coupon (A drops, B untouched)',
      aAfter < aBefore && bAfter === bBefore,
      `A face ${aBefore} -> ${aAfter} | B face ${bBefore} -> ${bAfter} || A rows: ${describeRows(after.vouchers, a)} || B rows: ${describeRows(after.vouchers, b)}`)

    await till.page.waitForTimeout(10_000)
    await goto(till.page, `${BASE}/`)
    await unlockIfLocked(till.page)
    await till.page.waitForTimeout(5000)
    const tillStore = await walletStore(till.page)
    const newIn = tillStore.transactions.filter((t) => t.direction === 'in' && !tillInBefore.has(String(t.id)))
    const named = newIn.map((t) => str(t, 'voucherId', 'voucher_id') ?? '?')
    // The till's rows name the voucher id the generate response returned.
    record("#157 the till's new incoming row names A's voucher, not B's",
      named.includes(a.voucherId) && !named.includes(b.voucherId),
      `${newIn.length} new incoming row(s) name: ${named.join(', ') || 'none'} (A=${a.voucherId}, B=${b.voucherId})`)

    context.customerConsole = customerConsole.slice(-10)
    record('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' || ') || 'none')
  } catch (e) {
    record('probe ran to the end', false, String(e).split('\n').slice(0, 3).join(' | '))
  } finally {
    if (checks.some((c) => !c.ok)) {
      for (const [i, p] of pages.entries()) await p.screenshot({ path: `${SCREENSHOT_DIR}/${i === 0 ? 'till' : 'customer'}.png`, fullPage: true }).catch(() => {})
      console.log(`SCREENSHOTS ${SCREENSHOT_DIR}`)
    }
    console.log(`CONTEXT ${JSON.stringify(context)}`)
    console.log(`SUMMARY ${JSON.stringify({ passed: checks.filter((c) => c.ok).length, failed: checks.filter((c) => !c.ok).length })}`)
    await browser.close().catch(() => {})
  }
  return checks.every((c) => c.ok) ? 0 : 1
}

main().then((code) => process.exit(code))
