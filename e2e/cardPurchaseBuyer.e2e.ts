/**
 * imani-wallet#267, buyer side, real browser against the local gate (imani-deploy
 * scripts/local-terminal-gate, E2E_SCRIPT=cardPurchaseBuyer.e2e.ts) or a dev server.
 *
 *   G1  A guest (no wallet) is refused on the Buy page: "Create a wallet first to buy a voucher
 *       by card", no Pay button, NO request to /api/v1/checkout/purchase and no navigation to
 *       checkout.stripe.com. So nothing can be charged.
 *   G2  The purchase endpoint refuses `buyerPubkey: null` with 422 before any Checkout Session
 *       exists. Needs payment-adapter with stripe.enabled and this change; when the controller
 *       is absent (Stripe disabled, 404 with no JSON error) it is reported as SKIP, not PASS.
 *   R1  /buy/done?session_id=… renders "Payment received" and "Go to my vouchers", and never
 *       prints the session id.
 *   R2  /buy/cancelled renders "Payment cancelled, nothing was charged".
 *   M1  A merchant's issued card voucher (seeded into its own wallet store with a processor
 *       warrant carrying ref=pi_…) shows the ref on the record with a copy button, the amount
 *       and the date, and a compact copyable ref on the sales list row.
 *
 *   E2E_BASE=http://localhost:<edge> E2E_BUNDLE_DIR=<dist> npx tsx e2e/cardPurchaseBuyer.e2e.ts
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { registerMerchant } from './register.mts'

const BASE = (process.env.E2E_BASE ?? 'http://localhost:5177').replace(/\/+$/, '')
const BUNDLE_DIR = process.env.E2E_BUNDLE_DIR
const IGNORE_HTTPS_ERRORS = process.env.E2E_IGNORE_HTTPS_ERRORS === '1'
const CHROMIUM_ARGS = (process.env.E2E_CHROMIUM_ARGS ?? '').split(' ').filter(Boolean)

const STALL = 'b'.repeat(64)
const REF = 'pi_3E2eTestRef267abcdef'
const SESSION = 'cs_test_e2e_should_never_show'

const failures: string[] = []
const errors: string[] = []
function check(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(name)
}
async function text(page: Page): Promise<string> {
  return (await page.locator('body').innerText()).replace(/\s+/g, ' ')
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
}

async function context(browser: Browser, name: string): Promise<BrowserContext> {
  const ctx = await browser.newContext({
    locale: 'en-GB',
    serviceWorkers: BUNDLE_DIR ? 'block' : 'allow',
    ignoreHTTPSErrors: IGNORE_HTTPS_ERRORS,
    permissions: ['clipboard-read', 'clipboard-write'],
  })
  if (BUNDLE_DIR) {
    const root = normalize(BUNDLE_DIR)
    const shell = join(root, 'index.html')
    await ctx.route(`${BASE}/**`, async (route) => {
      const path = new URL(route.request().url()).pathname
      if (path.startsWith('/api/') || path.startsWith('/.well-known/') || path.startsWith('/fcaptcha/')) return route.continue()
      const candidate = normalize(join(root, path))
      const file = candidate.startsWith(root) && extname(candidate)
        ? await readFile(candidate).then(() => candidate, () => shell)
        : shell
      return route.fulfill({ status: 200, body: await readFile(file), contentType: CONTENT_TYPES[extname(file)] ?? 'application/octet-stream' })
    })
  }
  ctx.on('page', (p) => p.on('pageerror', (e) => errors.push(`${name}: ${e.message}`)))
  return ctx
}

async function guestRefused(browser: Browser) {
  console.log('\nG1/G2  guest purchase is refused before Stripe')
  const ctx = await context(browser, 'guest')
  const page = await ctx.newPage()
  const purchaseCalls: string[] = []
  page.on('request', (r) => {
    if (r.url().includes('/api/v1/checkout/purchase') || r.url().includes('checkout.stripe.com')) purchaseCalls.push(r.url())
  })
  await page.goto(`${BASE}/buy/${STALL}`, { waitUntil: 'networkidle' })
  await page.getByText('Create a wallet first to buy a voucher by card').waitFor({ timeout: 20_000 }).catch(() => {})
  const body = await text(page)
  check('G1 guest sees "Create a wallet first to buy a voucher by card"', body.includes('Create a wallet first to buy a voucher by card'), body.slice(0, 200))
  check('G1 no "Pay by card" button for a guest', (await page.getByRole('button', { name: 'Pay by card' }).count()) === 0)
  check('G1 no purchase request and no Stripe navigation', purchaseCalls.length === 0, purchaseCalls.join(' '))

  const res = await page.request.post(`${BASE}/api/v1/checkout/purchase`, {
    data: { stallPubkey: STALL, amountMinor: 100, buyerPubkey: null },
    failOnStatusCode: false,
  })
  const json = (await res.json().catch(() => null)) as { error?: string; checkoutUrl?: string } | null
  if (res.status() === 404 && !json?.error) {
    console.log('  SKIP  G2 purchase endpoint absent here (Stripe disabled on this payment-adapter)')
  } else {
    check('G2 endpoint refuses a guest with 422 and creates no session',
      res.status() === 422 && !json?.checkoutUrl && /Create a wallet first/.test(json?.error ?? ''),
      `status ${res.status()} body ${JSON.stringify(json)}`)
  }
  await ctx.close()
}

async function returnPages(browser: Browser) {
  console.log('\nR1/R2  buyer return pages')
  const ctx = await context(browser, 'return')
  const page = await ctx.newPage()
  await page.goto(`${BASE}/buy/done?session_id=${SESSION}`, { waitUntil: 'networkidle' })
  await page.getByText('Payment received').waitFor({ timeout: 20_000 }).catch(() => {})
  const done = await text(page)
  check('R1 /buy/done says "Payment received" and the voucher is on its way', /Payment received/.test(done) && /voucher.*is on its way/.test(done), done.slice(0, 200))
  check('R1 offers "Go to my vouchers"', (await page.getByRole('link', { name: 'Go to my vouchers' }).count()) === 1)
  check('R1 never prints the session id', !done.includes(SESSION) && !(await page.content()).includes(`>${SESSION}<`))

  await page.goto(`${BASE}/buy/cancelled`, { waitUntil: 'networkidle' })
  await page.getByText('Payment cancelled, nothing was charged').waitFor({ timeout: 20_000 }).catch(() => {})
  check('R2 /buy/cancelled says nothing was charged', (await text(page)).includes('Payment cancelled, nothing was charged'))
  await ctx.close()
}

async function reconciliation(browser: Browser) {
  console.log('\nM1  merchant reconciliation: the pi_ ref is copyable')
  const ctx = await context(browser, 'merchant')
  const page = await ctx.newPage()
  await registerMerchant(page, BASE)
  const voucherId = `e2e267-${Date.now()}`
  const seeded = await page.evaluate(
    `(async () => {
      const name = (await indexedDB.databases()).map((d) => d.name || '').find((n) => n.startsWith('imani-wallet-'))
      if (!name) return 'no wallet db'
      const db = await new Promise((ok, ko) => { const r = indexedDB.open(name); r.onsuccess = () => ok(r.result); r.onerror = () => ko(r.error) })
      if (!db.objectStoreNames.contains('wallet_transactions')) return 'no store'
      const row = {
        id: 'issued:${voucherId}', type: 'issued', direction: 'out', amount: 2500, unit: 'EUR', decimals: 2,
        timestamp: Date.now() - 3600000, memo: 'Card voucher 267', voucherId: '${voucherId}', voucher_id: '${voucherId}',
        expiresAt: Date.now() + 30 * 86400000,
        issuanceWarrant: JSON.stringify({ form: 'processor', sale_total: 2500, face_decimals: 2, unit: 'EUR', nonce: 'e2e-267', ref: '${REF}' }),
      }
      await new Promise((ok, ko) => { const t = db.transaction('wallet_transactions', 'readwrite'); t.objectStore('wallet_transactions').put(row); t.oncomplete = ok; t.onerror = () => ko(t.error) })
      db.close()
      return 'ok'
    })()`,
  )
  check('M1 seeded an issued card voucher with a ref', seeded === 'ok', String(seeded))

  await page.goto(`${BASE}/merchant/coupon/${voucherId}`, { waitUntil: 'networkidle' })
  const block = page.getByTestId('payment-reference')
  await block.waitFor({ timeout: 30_000 }).catch(() => {})
  const blockText = (await block.innerText().catch(() => '')).replace(/\s+/g, ' ')
  check('M1 record shows the pi_ ref with the amount and the date', blockText.includes(REF) && /25[.,]00/.test(blockText) && /Paid /.test(blockText), blockText)
  const copy = page.getByRole('button', { name: 'Copy payment reference' })
  check('M1 record has a copy button', (await copy.count()) === 1)
  if ((await copy.count()) === 1) {
    await copy.click()
    const clip = await page.evaluate('navigator.clipboard.readText()').catch(() => '')
    check('M1 copy puts the full ref on the clipboard', clip === REF, String(clip))
  }
  check('M1 no Stripe dashboard link (Express accounts, no login-link endpoint)', (await page.locator('a[href*="dashboard.stripe.com"]').count()) === 0)

  await page.goto(`${BASE}/merchant/coupons`, { waitUntil: 'networkidle' })
  const rowCopy = page.getByRole('button', { name: 'Copy payment reference' })
  await rowCopy.first().waitFor({ timeout: 30_000 }).catch(() => {})
  check('M1 the sales list row carries a compact copyable ref', (await rowCopy.count()) >= 1 && /pi_3E2eT/.test(await rowCopy.first().innerText().catch(() => '')))
  await ctx.close()
}

async function main() {
  const browser = await chromium.launch({ args: CHROMIUM_ARGS })
  try {
    await guestRefused(browser)
    await returnPages(browser)
    await reconciliation(browser)
  } finally {
    await browser.close()
  }
  check('no uncaught page errors', errors.length === 0, errors.join(' | '))
  console.log('')
  if (failures.length) {
    console.log(`${failures.length} FAILED:`)
    failures.forEach((f) => console.log(`  - ${f}`))
    process.exit(1)
  }
  console.log('all checks passed')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
