/**
 * imani-checkout-magento end to end on the LOCAL stack, with a real Magento (Mage-OS 4.0) and a
 * fresh test merchant, through the real wallet UI. The Magento counterpart of
 * checkout-codes-woo-staging.e2e.mts.
 *
 *   M0  Magento shows the shop's enrolment code (the module's admin block, real DI)
 *   M1  a fresh stall enrols the shop (Settings > Terminals > Add, redeem-only); Magento's inbox
 *       takes the NIP-17 credential and answers; the stall's row turns In service
 *   M2  a customer claims the stall's cashback and makes a checkout code for this shop
 *   M3  a buyer applies the code to a real Magento cart: the grand total drops (post-tax payment)
 *   M4  the order is placed; the invoice is paid; the module redeems the code to the stall
 *   M5  replay: a second invoice-pay / cron pass settles nothing twice
 *
 * Magento runs in imani-magento-local (compose), reachable at MAGENTO (default
 * http://localhost:8085). Admin steps run as `bin/magento`-level PHP inside that container
 * (MAGENTO_EXEC), because the admin UI needs nothing this test checks.
 *
 * Run:  TSX_TSCONFIG_PATH=tsconfig.app.json npx tsx e2e/checkout-codes-magento-local.e2e.mts
 */
import { execFileSync } from 'node:child_process'
import { chromium, type Browser, type Page } from 'playwright'
import { registerCustomer, registerMerchant, TEST_PASSPHRASE } from './register.mts'

const BASE = (process.env.E2E_BASE ?? 'http://localhost:5173').replace(/\/+$/, '')
const MAGENTO = (process.env.MAGENTO ?? 'http://localhost:8085').replace(/\/+$/, '')
const COMPOSE_DIR = process.env.MAGENTO_COMPOSE ?? `${process.env.HOME}/IdeaProjects/imani-magento-local`
const SKU = process.env.MAGENTO_SKU ?? 'pour-over-kit' // EUR 39.00
const CODE_AMOUNT = process.env.E2E_CODE_AMOUNT ?? '20.00'
const CODE_RE = /IMANI-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}/

const failures: string[] = []
const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`)
const info = (s: string) => log(`  INFO ${s.slice(0, 900)}`)
function step(name: string, ok: boolean, detail = '') {
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  | ${detail.slice(0, 700)}` : ''}`)
  if (!ok) failures.push(name)
}
const text = async (p: Page) => (await p.locator('body').innerText()).replace(/\s+/g, ' ')

/** PHP inside the Magento container, with Magento bootstrapped; prints JSON. */
function mage(php: string): any {
  const script = `<?php
require "/var/www/html/app/bootstrap.php";
$om = \\Magento\\Framework\\App\\Bootstrap::create(BP, $_SERVER)->getObjectManager();
try { $om->get(\\Magento\\Framework\\App\\State::class)->setAreaCode("adminhtml"); } catch (\\Throwable) {}
$out = (function () use ($om) { ${php} })();
echo json_encode($out, JSON_UNESCAPED_SLASHES);`
  const raw = execFileSync('docker', ['compose', 'exec', '-T', 'php', 'php', '-d', 'display_errors=stderr', '--', '/dev/stdin'], {
    cwd: COMPOSE_DIR,
    input: script,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 180_000,
  })
  try {
    return JSON.parse(raw.trim().split('\n').pop() ?? 'null')
  } catch {
    throw new Error(`magento php: ${raw.slice(0, 400)}`)
  }
}

async function finish(browser: Browser) {
  await browser.close()
  log(`==== ${failures.length ? `FAILED: ${failures.join(', ')}` : 'all passed'}`)
  process.exit(failures.length ? 1 : 0)
}

async function main() {
  log(`==== imani-checkout-magento on the local stack  wallet=${BASE} magento=${MAGENTO}`)
  // A fresh run: forget the previous enrolment (and S), so this run's stall enrols a new shop key.
  mage(`$om->get(\\Imani\\CheckoutCodes\\Model\\EnrolmentScreen::class)->forget(); return true;`)

  const browser = await chromium.launch()
  const page = async () => {
    const ctx = await browser.newContext({ locale: 'en-GB', serviceWorkers: 'block' })
    // Vouchers name the mint by its stack alias; outside the stack's DNS, carry it to the published port.
    await ctx.route(/^http:\/\/127\.0\.0\.1\.mint:7777\//, async (route) => {
      const req = route.request()
      const r = await fetch(req.url().replace('http://127.0.0.1.mint:7777', process.env.MINT_REACH ?? 'http://localhost:27777'), { method: req.method(), headers: req.headers(), body: req.postDataBuffer() ?? undefined })
      await route.fulfill({ status: r.status, headers: { ...Object.fromEntries(r.headers), 'access-control-allow-origin': '*' }, body: Buffer.from(await r.arrayBuffer()) })
    })
    return ctx.newPage()
  }

  const owner = await page()
  let handle = ''
  for (let i = 0; i < 3 && !handle; i++) {
    // The onboarding page sometimes never settles (register.mts waits for networkidle): try again.
    handle = await registerMerchant(owner, BASE).catch((e) => (info(`merchant register ${i + 1}: ${String(e).slice(0, 120)}`), ''))
  }
  if (!handle) return step('M-2 a merchant registers', false), finish(browser)
  const stall = await owner.evaluate(() => {
    for (let i = 0; i < localStorage.length; i++) {
      const k = /^imani-wallet:profile:([0-9a-f]{64})$/.exec(localStorage.key(i) ?? '')
      if (k) return k[1]
    }
    return ''
  })
  info(`stall ${handle} ${stall}`)

  // Online shops are Pro (onlineShopAccess.ts; gateway-customer refuses FEATURE_NOT_IN_PLAN). Sell
  // this stall a pilot Pro licence the way support does (scripts/sell-subscription.mjs, the local
  // seller from deploy/subscription-local/.env), delivered to the stall by DM.
  const sellerEnv = process.env.SELLER_ENV_FILE ?? `${process.env.HOME}/.jcode/scratch/wk1115/imani-wallet/deploy/subscription-local/.env`
  const sold = execFileSync('node', ['scripts/sell-subscription.mjs', '--env-file', sellerEnv, '--customer-pubkey', stall, '--paid', '0', '--pilot', '--tier', 'pro', '--currency', 'EUR'], {
    encoding: 'utf8',
    timeout: 240_000,
  })
  info(`licence: ${sold.split('\n').filter((l) => /minted|delivered|tier/.test(l)).join(' / ')}`)
  let pro = false
  for (let i = 0; i < 12 && !pro; i++) {
    await owner.goto(`${BASE}/settings/online-shop`, { waitUntil: 'load' })
    await owner.getByTestId('online-shop-loading').waitFor({ state: 'detached', timeout: 30_000 }).catch(() => {})
    await owner.waitForTimeout(1_000)
    pro = (await owner.getByTestId('online-shop-locked').count()) === 0 && !(await owner.getByTestId('online-shop-loading').count())
    if (!pro) await owner.waitForTimeout(5_000)
  }
  step('M-1 the stall holds a Pro licence (online shops unlocked)', pro, pro ? '' : (await text(owner)).slice(0, 300))
  if (!pro) return finish(browser)

  // M0
  const enrol: string = mage(`return $om->get(\\Imani\\CheckoutCodes\\Model\\EnrolmentScreen::class)->code();`)
  step('M0 Magento shows the shop\'s enrolment code', /^imani-shop-enrol:1:[0-9a-f]{64}:https:\/\/.+:magento:\d+:[0-9a-f]{128}$/.test(enrol), enrol.slice(0, 100))
  if (!enrol.startsWith('imani-shop-enrol:1:')) return finish(browser)
  const host = new URL(enrol.split(':').slice(3, -3).join(':')).host

  // M1
  let shopLine = false
  for (let attempt = 0; attempt < 4 && !shopLine; attempt++) {
    for (let i = 0; i < 3; i++) {
      await owner.goto(`${BASE}/settings/terminals/add`, { waitUntil: 'load' })
      if (await owner.getByRole('button', { name: 'Add terminal' }).waitFor({ timeout: 30_000 }).then(() => true, () => false)) break
      info(`terminals/add ${i + 1}: ${(await text(owner)).slice(0, 200)}`)
    }
    await owner.getByLabel('Name').fill('Magento shop')
    await owner.getByLabel(/Or enter the device's/).fill(enrol)
    await owner.getByRole('button', { name: 'Continue' }).click()
    shopLine = await owner.getByText(`Connect ${host}?`).waitFor({ timeout: 20_000 }).then(async () => /Platform\s*Magento/.test(await text(owner)) && /can never issue them/.test(await text(owner)), () => false)
    // The licence is read again on each load; until it is, the page offers the upgrade instead.
    if (!shopLine) { info(`M1a attempt ${attempt + 1}: ${(await text(owner)).slice(-120)}`); await owner.waitForTimeout(5_000) }
  }
  step('M1a the wallet reads the code as this Magento shop, redeem-only', shopLine, shopLine ? '' : (await text(owner)).slice(-300))
  if (!shopLine) return finish(browser)
  let setup = ''
  for (let i = 0; i < 4 && !setup; i++) {
    const confirm = owner.getByTestId('online-shop-confirm').getByRole('button', { name: 'Connect', exact: true })
    if (await confirm.isVisible().catch(() => false)) {
      if (i > 0) info(`M1b: still on confirm, clicking Connect again (${i})`)
      await confirm.click().catch(() => {})
    }
    setup = await owner.getByTestId('online-shop-waiting').waitFor({ timeout: 30_000 }).then(async () => (await owner.getByTestId('online-shop-check-code').innerText()).replace(/\D/g, ''), () => '')
  }
  step('M1b the stall issues the shop its credential (sent by DM, waiting for the shop)', /^\d{6}$/.test(setup), setup || (await text(owner)).slice(-300))
  if (!setup) return finish(browser)

  // Magento's side: the cron's inbox step (run here instead of waiting for */5).
  let polled = ''
  for (let i = 0; i < 12; i++) {
    polled = mage(`return $om->get(\\Imani\\CheckoutCodes\\Model\\Services::class)->inbox()?->run();`) ?? 'no inbox'
    info(`inbox ${i + 1}: ${polled}`)
    if (/^Enrolled/.test(polled)) break
    await owner.waitForTimeout(5_000)
  }
  const enrolment = mage(`return $om->get(\\Imani\\CheckoutCodes\\Model\\EnrolmentScreen::class)->enrolment();`)
  step('M1c Magento takes the credential from the stall and answers it', enrolment?.stall === stall && !!enrolment?.answered_at, `${polled} | ${JSON.stringify(enrolment)}`)
  if (enrolment?.stall !== stall) return finish(browser)

  let inService = false
  for (let i = 0; i < 12 && !inService; i++) {
    await owner.goto(`${BASE}/settings/online-shop`, { waitUntil: 'load' })
    inService = await owner.waitForFunction(() => {
      const box = document.querySelector('[data-testid="online-shop-connected"]') as HTMLElement | null
      return !!box && /Connected/.test(box.innerText) && !document.querySelector('[data-testid="online-shop-waiting"]')
    }, undefined, { timeout: 15_000 }).then(() => true, () => false)
  }
  step('M1d the stall\'s Online shop page shows the shop Connected', inService, inService ? '' : (await text(owner)).slice(0, 300))
  if (!inService) return finish(browser)
  const enabled = mage(`return $om->get(\\Imani\\CheckoutCodes\\Model\\Services::class)->enabled();`)
  step('M1e the module is on: S exists and the enrolled stall is the shop\'s stall', enabled === true)

  // M2
  const cust = await page()
  let custHandle = '' // registerCustomer answers the pubkey, which Sell resolves
  for (let i = 0; i < 3 && !custHandle; i++) {
    // The onboarding page sometimes never settles (registerCustomer waits for networkidle).
    custHandle = await registerCustomer(cust, BASE).catch((e) => (info(`customer register ${i + 1}: ${String(e).slice(0, 120)}`), ''))
  }
  if (!custHandle) return step('M2 a customer registers', false), finish(browser)
  // The stall sells the customer EUR 20.00 by handle (the Sell flow, POST /portal/vouchers). Not
  // cashback: the local portal's cashback mints at the plain-http mint alias, which customer-wallet's
  // https-only mintUrl check refuses (local stack only, staging has https).
  const amountInput = owner.locator('input[placeholder="0.00"], input[placeholder="0"]').first()
  let sold20 = false
  for (let attempt = 0; attempt < 3 && !sold20; attempt++) {
    await owner.goto(`${BASE}/sell`, { waitUntil: 'load' })
    const to = owner.locator('input[placeholder="name"]')
    if (!(await to.waitFor({ timeout: 30_000 }).then(() => true, () => false))) {
      // A new stall's session can predate coupon:issue (#114): log in again, as claimLinks does.
      await owner.context().clearCookies()
      await owner.goto(`${BASE}/`, { waitUntil: 'load' })
      const pass = owner.locator('input[placeholder="Passphrase"]')
      if (await pass.waitFor({ timeout: 30_000 }).then(() => true, () => false)) {
        await pass.fill(TEST_PASSPHRASE)
        await owner.getByRole('button', { name: /unlock/i }).first().click()
        await owner.waitForTimeout(6_000)
      }
      continue
    }
    await to.fill(custHandle)
    await owner.getByRole('button', { name: 'Continue' }).click()
    await amountInput.waitFor({ timeout: 30_000 })
    await amountInput.fill('20.00')
    await owner.getByRole('button', { name: 'Send voucher' }).click()
    sold20 = await owner.waitForFunction(() => /Sent to .+ It is in their wallet now/.test(document.body.innerText), undefined, { timeout: 120_000 }).then(() => true, () => false)
    if (!sold20) info(`sale ${attempt + 1}: ${(await text(owner)).slice(-300)}`)
  }
  let added = false
  for (let i = 0; i < 12 && sold20 && !added; i++) {
    await cust.goto(`${BASE}/`, { waitUntil: 'load' })
    await cust.waitForTimeout(5_000)
    added = (await text(cust)).includes('€20.00')
  }
  step('M2a the customer holds EUR 20.00 from the stall', added, added ? '' : (await text(cust)).slice(0, 300))
  if (!added) return finish(browser)

  let code = ''
  for (let i = 0; i < 6 && !code; i++) {
    await cust.goto(`${BASE}/online?stall=${stall}`, { waitUntil: 'load' })
    await cust.waitForFunction(() => !/Checking your vouchers/.test(document.body.innerText), undefined, { timeout: 60_000 }).catch(() => {})
    const amountField = cust.getByLabel(/^Amount/)
    if (!(await amountField.waitFor({ timeout: 30_000 }).then(() => true, () => false))) {
      info(`try ${i + 1}: ${(await text(cust)).slice(0, 240)}`)
      continue
    }
    await amountField.fill(CODE_AMOUNT)
    cust.on('response', async (r) => { if (r.status() >= 400 && !/refunds/.test(r.url())) info(`cust http ${r.status()} ${r.request().method()} ${r.url().slice(0, 160)} ${(await r.text().catch(() => '')).slice(0, 300)}`) })
    cust.on('requestfailed', (r) => info(`cust reqfail ${r.method()} ${r.url().slice(0, 160)} ${r.failure()?.errorText}`))
    await cust.getByRole('button', { name: 'Get code' }).click()
    code = await Promise.race([
      cust.getByTestId('checkout-code').innerText({ timeout: 120_000 }).then((s) => s.match(CODE_RE)?.[0] ?? '', () => ''),
      cust.getByText(/cannot be used online right now|No code could be made/).waitFor({ timeout: 120_000 }).then(() => '', () => ''),
    ])
    if (!code) {
      info(`get code ${i + 1}: ${(await text(cust)).slice(0, 400)}`)
      break
    }
  }
  const refusals = code ? '' : await cust.evaluate(() => Object.keys(localStorage).filter((k) => /checkout/i.test(k)).map((k) => {
    try { return (JSON.parse(localStorage.getItem(k) ?? '[]') as Array<{ refusal?: string; status?: string }>).map((r) => `${r.status}:${r.refusal}`).join(' ') } catch { return '' }
  }).join(' | '))
  step('M2b Use online makes a checkout code for the Magento shop', !!code, code || `${refusals} :: ${(await text(cust)).slice(0, 200)}`)
  if (!code) return finish(browser)
  const codePage = cust.url()

  // M3: a guest cart through Magento's own REST API (what the storefront JS calls), then the
  // module's own apply endpoint on that quote, through the same service the controller uses.
  const rest = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${MAGENTO}/rest/V1${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const t = await r.text()
    if (r.status >= 400) info(`magento ${method} ${path} -> ${r.status} ${t.slice(0, 300)}`)
    return JSON.parse(t)
  }
  const cartId: string = await rest('POST', '/guest-carts')
  await rest('POST', `/guest-carts/${cartId}/items`, { cartItem: { sku: SKU, qty: 1, quote_id: cartId } })
  const address = { firstname: 'Test', lastname: 'Buyer', street: ['1 Test Street'], city: 'Lisbon', postcode: '1000-001', country_id: 'PT', region_id: Number(process.env.MAGENTO_REGION_ID ?? 1034), telephone: '912345678', email: `buyer${Date.now()}@example.com` }
  await rest('POST', `/guest-carts/${cartId}/shipping-information`, { addressInformation: { shipping_address: address, billing_address: address, shipping_method_code: 'flatrate', shipping_carrier_code: 'flatrate' } })
  const before = (await rest('GET', `/guest-carts/${cartId}/totals`)).grand_total as number
  const applied = mage(`
    $mask = $om->get(\\Magento\\Quote\\Model\\QuoteIdMaskFactory::class)->create()->load(${JSON.stringify(cartId)}, 'masked_id');
    $quote = $om->get(\\Magento\\Quote\\Api\\CartRepositoryInterface::class)->get((int) $mask->getQuoteId());
    $r = $om->get(\\Imani\\CheckoutCodes\\Model\\QuoteCodes::class)->apply($quote, ${JSON.stringify(code)});
    return ['applied' => $r->applied, 'deduction' => $r->deduction, 'message' => $r->message, 'notice' => $r->notice];`)
  const totals = await rest('GET', `/guest-carts/${cartId}/totals`)
  const after = totals.grand_total as number
  const line = (totals.total_segments as Array<{ code: string; value: number; title: string }>).find((s) => s.code === 'imani_code')
  step('M3 the cart takes the code: grand total drops by the code amount, an "Imani coupon" line', applied?.applied === true && Math.abs(before - after - Number(CODE_AMOUNT)) < 0.01 && !!line,
    `${JSON.stringify(applied)} total ${before} -> ${after} line=${JSON.stringify(line)}`)
  if (!applied?.applied) return finish(browser)

  // M4: place the order (check / money order), then invoice it: `sales_order_invoice_pay` redeems.
  const orderId = await rest('PUT', `/guest-carts/${cartId}/order`, { paymentMethod: { method: 'checkmo' } })
  step('M4a the order is placed with the code (re-checked and held at placement)', typeof orderId === 'number' || /^\d+$/.test(String(orderId)), `order ${JSON.stringify(orderId).slice(0, 200)}`)
  const invoiced = mage(`
    $order = $om->get(\\Magento\\Sales\\Api\\OrderRepositoryInterface::class)->get(${Number(orderId)});
    $invoice = $om->get(\\Magento\\Sales\\Model\\Service\\InvoiceService::class)->prepareInvoice($order);
    $invoice->setRequestedCaptureCase(\\Magento\\Sales\\Model\\Order\\Invoice::CAPTURE_OFFLINE);
    $invoice->register();
    $om->create(\\Magento\\Framework\\DB\\Transaction::class)->addObject($invoice)->addObject($invoice->getOrder())->save();
    $order = $om->get(\\Magento\\Sales\\Model\\OrderFactory::class)->create()->load(${Number(orderId)});
    $rec = $om->get(\\Imani\\CheckoutCodes\\Service\\Ledger::class)->byOrder($order->getIncrementId());
    return [
      'increment' => $order->getIncrementId(), 'state' => $order->getState(), 'grand' => (float) $order->getGrandTotal(),
      'imani' => (float) $order->getData('imani_code_amount'), 'invoice_grand' => (float) $invoice->getGrandTotal(),
      'record' => $rec ? ['state' => $rec->state, 'error' => $rec->error, 'mode' => $rec->mode, 'left' => $rec->balanceLeft] : null,
      'notes' => array_map(fn ($h) => (string) $h->getComment(), array_values($order->getStatusHistories())),
    ];`)
  info(JSON.stringify(invoiced))
  step('M4b paying the invoice redeems the code (record redeemed, order not on hold)', invoiced?.record?.state === 'redeemed' && invoiced?.state !== 'holded', JSON.stringify(invoiced?.record))
  step('M4c the order note says what the code paid', (invoiced?.notes ?? []).some((n: string) => /Imani code .*(redeemed|used for)/.test(n)), (invoiced?.notes ?? []).join(' / '))
  step('M4d the customer is charged only the rest (invoice = cart total less the code)', Math.abs(invoiced?.invoice_grand - after) < 0.01 && Math.abs(invoiced?.imani - Number(CODE_AMOUNT)) < 0.01, `invoice ${invoiced?.invoice_grand} cart-after ${after} imani ${invoiced?.imani}`)

  // M5
  const replay = mage(`
    $s = $om->get(\\Imani\\CheckoutCodes\\Model\\Services::class);
    $r = $s->redeem()->paid(${JSON.stringify(String(invoiced?.increment ?? ''))});
    return ['state' => $r?->state, 'retry' => count($s->redeem()->retryAll())];`)
  step('M5 a replayed pay and a cron pass settle nothing twice', replay?.state === 'redeemed' && replay?.retry === 0, JSON.stringify(replay))

  let status = ''
  for (let i = 0; i < 9; i++) {
    await cust.goto(codePage, { waitUntil: 'load' })
    await cust.waitForTimeout(2_000)
    const page = await text(cust)
    status = page.match(/\b(Used|Redeemed|Spent|Paid)\b[^.]{0,60}/i)?.[0] ?? page.slice(0, 240)
    if (/^(used|redeemed|spent|paid)/i.test(status)) break
    await cust.waitForTimeout(10_000)
  }
  step('M6 the customer\'s wallet shows the code as used', /^(used|redeemed|spent|paid)/i.test(status), status)
  return finish(browser)
}

main().catch((e) => {
  log(`CRASH ${e?.stack ?? e}`)
  process.exit(2)
})
