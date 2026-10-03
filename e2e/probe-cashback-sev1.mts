/**
 * Browser probe for the cashback sev-1 fixes:
 *
 *  - imani-gateway-portal#58  a cashback coupon's expiry is the stall's voucher validity, not
 *    gateway-customer's 90-day default. The till sets its validity to 30 days, issues a
 *    cashback, and the customer's coupon must carry expires_at ~= claim time + 30 days. The
 *    generate request must carry voucherValidityDays=30, and gateway-customer must log no
 *    create_voucher_missing_expiry for this stall (E2E_CUSTOMER_LOG=<file> or docker logs).
 *  - imani-wallet#156  the customer's redeemed cashback row records a validation with
 *    signatureValid true, and its detail page does not say "Not checked".
 *  - imani-wallet#155  the till's voucher detail page for the claimed cashback shows no Sell
 *    lines ("Not collected", "At the counter") and does show "Claimed".
 *
 * Output: one JSON line per check, then CONTEXT and SUMMARY. Exit 1 on any failed check.
 *
 *   E2E_BASE=http://localhost:5177 E2E_IGNORE_HTTPS_ERRORS=1 npx tsx e2e/probe-cashback-sev1.mts
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { execFileSync } from 'node:child_process'
import { parseVoucherToken } from '../src/lib/voucherToken'
import { registerCustomer, registerMerchant, TEST_PASSPHRASE } from './register.mts'

const BASE = (process.env.E2E_BASE ?? 'http://localhost:5177').replace(/\/+$/, '')
const VALIDITY_DAYS = Number(process.env.E2E_VALIDITY_DAYS ?? '30')
const CASHBACK_AMOUNT = process.env.E2E_CASHBACK ?? '5.00'
const CUSTOMER_CONTAINER = process.env.E2E_CUSTOMER_CONTAINER ?? 'gateway-customer-test'
const PERMISSION_CACHE_MS = 62_000
const DAY_MS = 86_400_000
/** Tolerance on expires_at: the gateway computes it from its own clock at mint time. */
const EXPIRY_TOLERANCE_MS = 2 * 3_600_000
const CLAIM_CODE = /\bCB-[A-Z0-9]{4,5}-[A-Z0-9]{2,5}\b/
const FAILURE_WORDS = /failed|error|could not|refused/i
const SCREENSHOT_DIR = process.env.E2E_SCREENSHOTS ?? 'e2e/.probe-cashback-sev1'

type Check = { step: string; ok: boolean; detail: string }
const checks: Check[] = []
const context: Record<string, unknown> = { base: BASE, validityDays: VALIDITY_DAYS }

function record(step: string, ok: boolean, detail: string): void {
  checks.push({ step, ok, detail })
  console.log(JSON.stringify({ step, ok, detail: detail.slice(0, 900) }))
}

async function screenText(page: Page, limit = 2500): Promise<string> {
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
  await page.waitForTimeout(1500)
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
type Row = Record<string, unknown>
async function walletStore(page: Page): Promise<{ vouchers: Row[]; transactions: Row[] }> {
  return page.evaluate(READ_WALLET_STORE) as Promise<{ vouchers: Row[]; transactions: Row[] }>
}
const str = (row: Row, ...keys: string[]): string | undefined => {
  for (const k of keys) if (typeof row[k] === 'string' && row[k]) return row[k] as string
  return undefined
}

async function setValidity(till: Page, days: number): Promise<string> {
  await goto(till, `${BASE}/settings/merchant`)
  await unlockIfLocked(till)
  const label = days === 0 ? /^Never expires/ : new RegExp(`^${days} days`)
  await till.getByRole('button', { name: label }).first().click({ timeout: 30_000 })
  await till.getByRole('button', { name: /^Save$/ }).click()
  await till.waitForTimeout(5000)
  return oneLine(await screenText(till, 400))
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

async function redeem(customer: Page, code: string): Promise<{ text: string; at: number }> {
  await goto(customer, `${BASE}/receive/cashback`)
  await unlockIfLocked(customer)
  await customer.locator('input[placeholder="CB-XXXXX-XXXXX"]').fill(code, { timeout: 30_000 })
  const at = Date.now()
  await customer.getByRole('button', { name: /^Redeem$/ }).click()
  let text = ''
  for (let i = 0; i < 60; i++) {
    await customer.waitForTimeout(2000)
    text = await screenText(customer, 900)
    if (/Cashback added/.test(text) || FAILURE_WORDS.test(text)) break
  }
  return { text, at }
}

function customerLogSince(sinceIso: string): string {
  if (process.env.E2E_CUSTOMER_LOG) return execFileSync('cat', [process.env.E2E_CUSTOMER_LOG]).toString()
  return execFileSync('sh', ['-c', `docker logs --since ${sinceIso} ${CUSTOMER_CONTAINER} 2>&1`], { maxBuffer: 256 * 1024 * 1024 }).toString()
}

async function main(): Promise<number> {
  const browser: Browser = await chromium.launch()
  const pages: Page[] = []
  const startedIso = new Date().toISOString()
  try {
    const mk = async () => {
      const ctx = await browser.newContext({ locale: 'en-GB', ignoreHTTPSErrors: process.env.E2E_IGNORE_HTTPS_ERRORS === '1' })
      return { ctx, page: await ctx.newPage() }
    }
    const till = await mk()
    const customer = await mk()
    pages.push(till.page, customer.page)
    const pageErrors: string[] = []
    for (const [name, p] of [['till', till.page], ['customer', customer.page]] as const) {
      p.on('pageerror', (e) => pageErrors.push(`${name}: ${e.message.slice(0, 200)}`))
    }
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

    // ── #58: stall validity drives the coupon's expiry ──────────────────────
    record(`setup: till sets voucher validity to ${VALIDITY_DAYS} days`, true, await setValidity(till.page, VALIDITY_DAYS))
    await till.page.waitForTimeout(PERMISSION_CACHE_MS)
    await relogin(till.ctx, till.page)

    const issued = await issueCashback(till.page)
    const gen = issued.generated as { status?: number; body?: Row; request?: Row } | null
    const voucherId = String(gen?.body?.voucherId ?? '')
    const cashbackId = String(gen?.body?.cashbackId ?? '')
    context.cashback = { code: issued.code, cashbackId, voucherId }
    record('till issues a cashback code', !!issued.code && gen?.status === 200, oneLine(issued.screen).slice(0, 300))
    record(`#58 generate request carries voucherValidityDays=${VALIDITY_DAYS}`,
      gen?.request?.voucherValidityDays === VALIDITY_DAYS,
      `voucherValidityDays=${JSON.stringify(gen?.request?.voucherValidityDays)} expiryDays=${JSON.stringify(gen?.request?.expiryDays)}`)

    const { text: redeemed, at: redeemedAt } = await redeem(customer.page, issued.code)
    record('customer redeems the code', /Cashback added/.test(redeemed), oneLine(redeemed).slice(0, 200))

    const store = await walletStore(customer.page)
    const coupon = store.vouchers
      .map((v) => { try { return parseVoucherToken(String(v.token)) } catch { return null } })
      .find((p) => p && (!voucherId || p.voucher.voucherId === voucherId))
    const expiresAt = coupon?.voucher.expiresAt
    const expiresMs = expiresAt == null ? NaN : (expiresAt < 1e12 ? expiresAt * 1000 : expiresAt)
    const expectedMs = redeemedAt + VALIDITY_DAYS * DAY_MS
    const days = (expiresMs - redeemedAt) / DAY_MS
    if (VALIDITY_DAYS === 0) {
      // 0 is "never expires": the coupon must carry NO expires_at, not the 90-day default.
      record('#58 coupon has no expiry (validity 0 = never expires)', expiresAt == null,
        `expires_at=${expiresAt ?? 'none'}${Number.isFinite(expiresMs) ? ` = ${days.toFixed(2)} days after redeem` : ''}`)
    } else {
      record(`#58 coupon expires_at = issue time + ${VALIDITY_DAYS} days (not the 90-day default)`,
        Number.isFinite(expiresMs) && Math.abs(expiresMs - expectedMs) < EXPIRY_TOLERANCE_MS,
        `expires_at=${expiresAt ?? 'none'} (${Number.isFinite(expiresMs) ? new Date(expiresMs).toISOString() : '-'}) = ${days.toFixed(2)} days after redeem`)
    }

    let log = ''
    try { log = customerLogSince(startedIso) } catch (e) { log = `UNREADABLE ${String(e).slice(0, 100)}` }
    const warns = log.split('\n').filter((l) => l.includes('create_voucher_missing_expiry') && l.includes(tillPubkey))
    record('#58 gateway-customer logged no create_voucher_missing_expiry for this stall',
      !log.startsWith('UNREADABLE') && warns.length === 0,
      log.startsWith('UNREADABLE') ? log : warns[0]?.slice(0, 300) ?? `0 of ${log.split('\n').filter((l) => l.includes('create_voucher_missing_expiry')).length} such WARNs name this stall`)

    // ── #156: the redeemed row records a validation ─────────────────────────
    const inRows = store.transactions.filter((t) => t.direction === 'in')
    const row = inRows.find((t) => str(t, 'voucherId', 'voucher_id') === voucherId) ?? inRows[0]
    const validation = row?.validation as { signatureValid?: boolean; warrant?: string } | undefined
    record('#156 the cashback receive row records a validation', !!validation,
      row ? `row ${String(row.id)} validation=${JSON.stringify(validation ?? null)}` : `no incoming row (of ${store.transactions.length})`)
    record('#156 validation.signatureValid is true', validation?.signatureValid === true, JSON.stringify(validation ?? null))
    if (row?.id) {
      await goto(customer.page, `${BASE}/transaction/${encodeURIComponent(String(row.id))}`)
      await unlockIfLocked(customer.page)
      await customer.page.waitForTimeout(3000)
      const detail = await screenText(customer.page)
      record('#156 the receive detail does not say "Not checked"', !/Not checked/.test(detail), oneLine(detail).slice(0, 500))
    }

    // ── #155: the till's voucher detail for a claimed cashback ──────────────
    // The claim notification (#53) reaches the portal on its own; the till reads
    // the stored status. Poll the detail page until it lands.
    await goto(till.page, `${BASE}/merchant/coupons`)
    await unlockIfLocked(till.page)
    let detail = ''
    const deadline = Date.now() + 2 * 60_000
    while (Date.now() < deadline) {
      await goto(till.page, `${BASE}/merchant/coupon/${encodeURIComponent(voucherId)}`)
      await unlockIfLocked(till.page)
      await till.page.waitForTimeout(4000)
      detail = await screenText(till.page, 3000)
      if (/Claimed on /.test(detail)) break
      await till.page.waitForTimeout(5000)
    }
    context.detail = oneLine(detail).slice(0, 600)
    record('#155 cashback voucher detail shows no "Not collected"', !/Not collected/.test(detail), oneLine(detail).slice(0, 600))
    record('#155 cashback voucher detail shows no "At the counter"', !/At the counter/.test(detail), '')
    // "Claimed on <date>", the evidence line #155 adds; the header's "· Claimed" is not it.
    record('#155 cashback voucher detail shows "Claimed on <date>"', /Claimed on \S/.test(detail),
      (/Claimed on [^|\n]*/.exec(detail) ?? ['(none)'])[0])

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
