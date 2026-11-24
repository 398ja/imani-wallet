/**
 * Spec 049 in a real browser, on the local stack: a customer pays a till, gets a receipt,
 * shows it as a QR, and the till scans it and is told "Paid to you".
 *
 *   npm run dev                        # the wallet on :5173, the origin the stack trusts
 *   npx tsx e2e/receipts-local.e2e.mts
 *
 *  1. A till and a customer register; the till sells the customer a voucher from Sell
 *     (issued vouchers carry DLEQ on every proof, which a receipt needs).
 *  2. The customer pays the till exactly the coupon's face (no split).
 *  3. The customer's outgoing payment shows a Receipt section, and in time "Confirmed by the
 *     stall": the till claimed, countersigned and sent the acknowledgement back.
 *  4. "Show receipt" draws a QR; it decodes to an `imrc1:` code.
 *  5. The till scans that code (Paste code, the Scan screen's own no-camera path): the check
 *     card says "Paid to you", with the mint confirming the collection.
 *  6. The same code with one character changed: "Not a valid receipt".
 *  7. The customer scanning their own receipt is not told it was paid to them.
 *  8. No uncaught page errors.
 *
 * Output: one JSON line per check, then SUMMARY. Exit 1 on any failed check.
 */
import { chromium, type Browser, type Page } from 'playwright'
import { registerCustomer, registerMerchant, TEST_STALL_NAME } from './register.mts'
import { bypassCaptcha } from './captchaBypass.mts'

const BASE = (process.env.E2E_BASE ?? 'http://localhost:5173').replace(/\/+$/, '')
const AMOUNT = process.env.E2E_CASHBACK ?? '5.00'
const PAYMENT_DONE = /^(Sent|Paid|Partly sent)$/m
const FAILURE_WORDS = /failed|error|could not|NOT been delivered|never finished|refused/i
const SCREENSHOT_DIR = process.env.E2E_SCREENSHOTS ?? 'e2e/.receipts-local'
const MINT_PUBLIC_HOST = process.env.E2E_MINT_PUBLIC_HOST ?? '127.0.0.1.mint:7777'
const MINT_PUBLISHED_HOST = process.env.E2E_MINT_PUBLISHED_HOST ?? 'localhost:27777'

type Check = { step: string; ok: boolean; detail: string }
const checks: Check[] = []
function record(step: string, ok: boolean, detail: string): void {
  checks.push({ step, ok, detail })
  console.log(JSON.stringify({ step, ok, detail: detail.slice(0, 600) }))
}
const screenText = async (p: Page, limit = 1500) => (await p.locator('body').innerText()).replace(/\n{2,}/g, '\n').slice(0, limit)
const oneLine = (t: string) => t.replace(/\n/g, ' | ')

/** Navigation that survives the dev server's ERR_NETWORK_CHANGED flake and an empty #root (probe-spend-order). */
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
      if (attempt === 4 || !/ERR_NETWORK_CHANGED|net::ERR_ABORTED/.test(String(e))) throw e
      await page.waitForTimeout(2000)
    }
  }
}

async function unlockIfLocked(page: Page): Promise<void> {
  const lock = page.locator('input[placeholder="Passphrase"]')
  const unlocked = page.getByText(/Total balance|Scan the customer's code|Amount \(|Cashback|Vouchers stay valid|Receipt|Scan|Sell/)
  await Promise.race([lock.waitFor({ timeout: 30_000 }), unlocked.first().waitFor({ timeout: 30_000 })]).catch(() => {})
  if (!(await lock.isVisible().catch(() => false))) return
  await lock.fill('correct horse battery')
  await page.getByRole('button', { name: /unlock/i }).first().click()
  await page.waitForTimeout(4000)
}

/** The till sells the customer a voucher from the Sell screen (local-sell.e2e.mts). */
async function sellTo(till: Page, customerPubkey: string): Promise<string> {
  await goto(till, `${BASE}/sell`)
  await unlockIfLocked(till)
  await till.locator('input[placeholder="name"]').fill(customerPubkey, { timeout: 30_000 })
  await till.getByRole('button', { name: 'Continue' }).click()
  const amount = till.locator('input[placeholder="0.00"], input[placeholder="0"]').first()
  await amount.waitFor({ timeout: 30_000 })
  await amount.fill(AMOUNT)
  await till.getByRole('button', { name: 'Send voucher' }).click()
  for (let i = 0; i < 60; i++) {
    await till.waitForTimeout(2000)
    const t = await screenText(till, 1200)
    if (/Sent to /.test(t) || FAILURE_WORDS.test(t)) return t
  }
  return screenText(till, 1200)
}

async function waitForBalance(customer: Page): Promise<string> {
  let t = ''
  for (let i = 0; i < 12 && !t.includes(`€${AMOUNT}`); i++) {
    await goto(customer, `${BASE}/`)
    await unlockIfLocked(customer)
    await customer.waitForTimeout(5000)
    t = await screenText(customer, 800)
  }
  return t
}

async function pay(customer: Page, tillPubkey: string): Promise<string> {
  const field = customer.locator('input[placeholder="0.00"]')
  for (let attempt = 1; attempt <= 3; attempt++) {
    await goto(customer, `${BASE}/send?to=${tillPubkey}`)
    await unlockIfLocked(customer)
    if (await field.waitFor({ timeout: 15_000 }).then(() => true, () => false)) break
    const stall = customer.getByRole('button').filter({ hasText: TEST_STALL_NAME }).first()
    if (await stall.waitFor({ timeout: 15_000 }).then(() => true, () => false)) {
      await stall.click()
      if (await field.waitFor({ timeout: 30_000 }).then(() => true, () => false)) break
    }
  }
  await field.fill(AMOUNT)
  await customer.getByRole('button', { name: /^Continue$/ }).click()
  await customer.getByRole('button', { name: /^(Pay|Send)$/ }).last().click()
  for (let i = 0; i < 120; i++) {
    await customer.waitForTimeout(3000)
    const t = await screenText(customer, 900)
    if (PAYMENT_DONE.test(t) || FAILURE_WORDS.test(t)) return t
  }
  return screenText(customer, 900)
}

/** The newest outgoing transaction id, from the wallet's own IndexedDB. */
const NEWEST_OUT = `(async () => {
  for (const info of await indexedDB.databases()) {
    if (!info.name) continue
    const db = await new Promise((res, rej) => { const r = indexedDB.open(info.name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
    if (!Array.from(db.objectStoreNames).includes('wallet_transactions')) { db.close(); continue }
    const rows = await new Promise((res, rej) => { const r = db.transaction('wallet_transactions').objectStore('wallet_transactions').getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
    db.close()
    const out = rows.filter((t) => t.direction === 'out').sort((a, b) => (b.created_at ?? b.timestamp ?? 0) - (a.created_at ?? a.timestamp ?? 0))
    return out[0] ? String(out[0].id) : ''
  }
  return ''
})()`

/**
 * On failure only: each stored receipt's role, countersignature and notes (the notes say why an
 * acknowledgement was not attached), plus the status the UI shows. No secrets.
 */
const DUMP_NOTES = `(async () => {
  const { listReceipts } = await import('/src/lib/receipts/index.ts')
  const pkg = await import('/packages/receipts/src/stored.ts')
  const out = []
  for (const info of await indexedDB.databases()) {
    if (!info.name || !info.name.startsWith('imani-receipts-')) continue
    const db = await new Promise((res, rej) => { const r = indexedDB.open(info.name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
    const rows = await new Promise((res, rej) => { const r = db.transaction('receipts').objectStore('receipts').getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
    db.close()
    for (const row of rows) {
      const b64 = row.stored.replace(/-/g, '+').replace(/_/g, '/')
      const bytes = Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0))
      const s = pkg.decodeStoredReceipt(bytes)
      out.push({ pid: row.paymentId.slice(0, 8), role: s.role, cs: !!s.receipt.countersignature, showable: s.showable, notes: s.notes })
    }
  }
  return { out, views: (await listReceipts()).map((v) => ({ pid: v.paymentId.slice(0, 8), role: v.role, status: v.status })) }
})()`

/**
 * Decode the QR the page drew, in the page, with the decoder the wallet's own scanner uses. From
 * the image's own data URL at its full 640 px, not the 320 px it is laid out at: a receipt QR is
 * dense, and a camera at the till sees it at a phone's resolution, not a thumbnail's.
 */
const DECODE_QR = `(async () => {
  const img = document.querySelector('img[alt="Receipt QR code"]')
  if (!img) return ''
  const { default: QrScanner } = await import('/node_modules/qr-scanner/qr-scanner.min.js')
  const full = new Image()
  full.src = img.src
  await full.decode()
  const canvas = document.createElement('canvas')
  canvas.width = full.naturalWidth * 2
  canvas.height = full.naturalHeight * 2
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(full, 0, 0, canvas.width, canvas.height)
  const r = await QrScanner.scanImage(canvas, { returnDetailedScanResult: true, alsoTryWithoutScanRegion: true })
  return r.data
})()`

async function scanOn(page: Page, code: string): Promise<{ title: string; text: string }> {
  await goto(page, `${BASE}/scan`)
  await unlockIfLocked(page)
  // No camera in a headless browser: the screen's own fallback, Paste code, reads the clipboard.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE })
  await page.evaluate((t) => navigator.clipboard.writeText(t), code)
  await page.getByRole('button', { name: /Paste code/ }).click({ timeout: 30_000 })
  const h1 = page.getByRole('heading', { level: 1 })
  await page.waitForURL(/\/receipt\/check$/, { timeout: 15_000 })
  await h1.waitFor({ timeout: 60_000 })
  return { title: (await h1.textContent()) ?? '', text: oneLine(await screenText(page, 1500)) }
}

async function main(): Promise<number> {
  // A response fulfilled by a route has no address space, so Chromium's Local Network Access
  // checks would block it (probe-spend-order.mts does the same).
  const browser: Browser = await chromium.launch({
    args: ['--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights'],
  })
  const pages: Page[] = []
  try {
    const mk = async () => {
      const ctx = await browser.newContext({ locale: 'en-GB', viewport: { width: 420, height: 900 } })
      await bypassCaptcha(ctx)
      // The stack stamps tokens with its PUBLIC mint name, `http://127.0.0.1.mint:7777`, which
      // only the containers resolve. In production that name is the real public mint; here the
      // browser is pointed at the mint's published port, as DNS would. Receipts are the first
      // browser-side reader of the mint by its token URL (checkstate, keys), so they need it.
      await ctx.route((u) => u.host === MINT_PUBLIC_HOST, async (route) => {
        const url = route.request().url().replace(`//${MINT_PUBLIC_HOST}`, `//${MINT_PUBLISHED_HOST}`)
        const response = await route.fetch({ url }).catch(() => null)
        return response ? route.fulfill({ response }) : route.abort('connectionrefused')
      })
      return ctx.newPage()
    }
    const till = await mk()
    const customer = await mk()
    pages.push(till, customer)
    const pageErrors: string[] = []
    for (const [n, p] of [['till', till], ['customer', customer]] as const) p.on('pageerror', (e) => pageErrors.push(`${n}: ${e.message.slice(0, 200)}`))
    const receiptLog: string[] = []
    for (const [n, p] of [['till', till], ['customer', customer]] as const) {
      p.on('console', (m) => {
        const t = m.text()
        if (/receipt|\[dmPoll\]|\[dmCrypto\]/i.test(t) && !/unwrapp|receipt-drain/.test(t)) receiptLog.push(`${n}: ${t.slice(0, 240)}`)
      })
    }

    const registerWith = async (p: Page, register: (p: Page, base: string) => Promise<string>): Promise<string> => {
      for (let attempt = 1; ; attempt++) {
        try {
          await goto(p, `${BASE}/onboarding`)
          return await register(p, BASE)
        } catch (e) {
          // The dev server's blank first render after a reload (probe-spend-order retries too).
          if (attempt === 3) throw e
        }
      }
    }
    const customerPubkey = await registerWith(customer, registerCustomer)
    await registerWith(till, registerMerchant)
    const tillPubkey = await till.evaluate(() => {
      for (let i = 0; i < localStorage.length; i++) {
        const m = /^imani-wallet:profile:([0-9a-f]{64})$/.exec(localStorage.key(i) ?? '')
        if (m) return m[1]
      }
      return ''
    })
    record('1. a till and a customer registered', /^[0-9a-f]{64}$/.test(tillPubkey), tillPubkey)

    const sold = await sellTo(till, customerPubkey)
    const held = /Sent to /.test(sold) ? await waitForBalance(customer) : ''
    record('1. the customer holds a voucher sold by the till', held.includes(`€${AMOUNT}`), `${oneLine(sold).slice(0, 160)} || ${oneLine(held).slice(0, 160)}`)

    const paid = await pay(customer, tillPubkey)
    record(`2. the customer pays the till ${AMOUNT}`, PAYMENT_DONE.test(paid) && !FAILURE_WORDS.test(paid), oneLine(paid).slice(0, 300))

    // 3. The receipt on the payment's own record.
    const txId = (await customer.evaluate(NEWEST_OUT)) as string
    let status = ''
    for (let i = 0; i < 20 && !/Confirmed by the stall/.test(status); i++) {
      await goto(customer, `${BASE}/transaction/${encodeURIComponent(txId)}`)
      await unlockIfLocked(customer)
      await customer.getByText('Receipt', { exact: true }).first().waitFor({ timeout: 20_000 }).catch(() => {})
      status = oneLine(await screenText(customer, 3000))
      if (!/Confirmed by the stall/.test(status)) await customer.waitForTimeout(6000)
    }
    const receiptLine = /Receipt \| Status \| ([^|]+)/.exec(status)?.[1]?.trim() ?? status.slice(-300)
    record('3. the payment shows a receipt, confirmed by the stall', /Confirmed by the stall/.test(status), `tx ${txId}: ${receiptLine}`)
    console.log(`LOG ${receiptLog.join(' ; ')}`)
    if (!/Confirmed by the stall/.test(status)) {
      console.log(`DIAG till ${JSON.stringify(await till.evaluate(DUMP_NOTES))}`)
      console.log(`DIAG customer ${JSON.stringify(await customer.evaluate(DUMP_NOTES))}`)
    }

    // 4. The QR.
    await customer.getByRole('button', { name: /Show receipt/ }).click({ timeout: 15_000 })
    await customer.locator('img[alt="Receipt QR code"]').waitFor({ timeout: 30_000 })
    const qr = (await customer.evaluate(DECODE_QR)) as string
    record('4. "Show receipt" draws a QR that decodes to an imrc1: code', qr.toLowerCase().startsWith('imrc1:'), `${qr.length} chars: ${qr.slice(0, 40)}…`)

    // 5. The till checks it.
    const atTill = await scanOn(till, qr)
    record('5. the till scans it: "Paid to you", the mint confirms', atTill.title === 'Paid to you' && /Collected/.test(atTill.text), `${atTill.title} || ${atTill.text.slice(0, 500)}`)

    // 6. Tampered.
    const i = Math.floor(qr.length * 0.6)
    const flipped = qr.slice(0, i) + (qr[i] === 'A' ? 'B' : 'A') + qr.slice(i + 1)
    const bad = await scanOn(till, flipped)
    record('6. one character changed: "Not a valid receipt"', bad.title === 'Not a valid receipt', bad.title)

    // 7. The payer's own phone is not the payee.
    const self = await scanOn(customer, qr)
    record('7. the customer scanning their own receipt is not told "Paid to you"', self.title !== 'Paid to you' && self.title !== 'Not a valid receipt', self.title)

    record('8. no uncaught page errors', pageErrors.length === 0, pageErrors.join(' || ') || 'none')
  } catch (e) {
    record('probe ran to the end', false, String(e).split('\n').slice(0, 3).join(' | '))
  } finally {
    if (checks.some((c) => !c.ok)) {
      for (const [i, p] of pages.entries()) await p.screenshot({ path: `${SCREENSHOT_DIR}/${i === 0 ? 'till' : 'customer'}.png`, fullPage: true }).catch(() => {})
      console.log(`SCREENSHOTS ${SCREENSHOT_DIR}`)
    }
    console.log(`SUMMARY ${JSON.stringify({ passed: checks.filter((c) => c.ok).length, failed: checks.filter((c) => !c.ok).length })}`)
    await browser.close().catch(() => {})
  }
  return checks.every((c) => c.ok) ? 0 : 1
}

process.exit(await main())
