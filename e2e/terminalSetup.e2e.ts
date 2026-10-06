/**
 * #160 phases 2 to 4, three real browsers: an owner adds a terminal, a fresh device receives it,
 * the device opens its till and takes a payment, and the owner's revocation stops it.
 *
 * Context A registers a stall and adds a terminal from Settings → Terminals. Context B is a
 * fresh browser with nothing in storage: it opens /terminal/setup, shows its code, receives the
 * credential by DM, shows the same check code as A, takes a passphrase, and tells the stall.
 * A's row turns In service without a reload. No `localStorage` is injected anywhere.
 *
 * Phase 3: B reloads, unlocks with its passphrase (no NAP session) and lands on the till naming
 * the stall. A redeem-only B has no Sell route. A customer C pays B's Redeem request, and B shows
 * Paid, learned from gateway-core because the coupon went to the stall.
 *
 * Phase 4 (`E2E_PHASE=4` or higher): A revokes B, B reloads and is refused at unlock, B can
 * still take itself out of service, and A's row reads revoked.
 *
 * Needs a stack whose gateway-customer mints the stall co-key (imani-gateway-customer#187).
 *
 * Run against a local dev server:   E2E_BASE=http://localhost:5177 tsx e2e/terminalSetup.e2e.ts
 * Run a local build against staging: E2E_BASE=https://wallet.staging.398ja.xyz \
 *                                     E2E_BUNDLE_DIR=dist tsx e2e/terminalSetup.e2e.ts
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { registerCustomer, registerMerchant, TEST_PASSPHRASE, TEST_STALL_NAME } from './register.mts'

const BASE = (process.env.E2E_BASE ?? 'http://localhost:5177').replace(/\/+$/, '')
const BUNDLE_DIR = process.env.E2E_BUNDLE_DIR
const PHASE = Number(process.env.E2E_PHASE ?? '4')
const TILL_PASSPHRASE = 'counter-pass'
/** A new stall's coupon:issue permission is cached this long by the gateway (#114). */
const PERMISSION_CACHE_MS = 62_000
const failures: string[] = []

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

/** Serves the app from a local build while the API, relay and mint stay those of E2E_BASE. */
async function context(browser: Browser): Promise<BrowserContext> {
  const ctx = await browser.newContext({ locale: 'en-GB', serviceWorkers: BUNDLE_DIR ? 'block' : 'allow' })
  if (BUNDLE_DIR) {
    const root = normalize(BUNDLE_DIR)
    const shell = join(root, 'index.html')
    await ctx.route(`${BASE}/**`, async (route) => {
      const path = new URL(route.request().url()).pathname
      if (path.startsWith('/api/') || path.startsWith('/.well-known/')) return route.continue()
      const candidate = normalize(join(root, path))
      const file =
        candidate.startsWith(root) && extname(candidate)
          ? await readFile(candidate).then(() => candidate, () => shell)
          : shell
      return route.fulfill({ status: 200, body: await readFile(file), contentType: CONTENT_TYPES[extname(file)] ?? 'application/octet-stream' })
    })
  }
  return ctx
}

/** Unlocks the till on B, after a reload. Returns the screen. */
async function unlockTill(device: Page): Promise<string> {
  await device.goto(`${BASE}/`, { waitUntil: 'load' })
  await device.getByRole('button', { name: 'Open the till' }).waitFor({ timeout: 30_000 })
  await device.getByLabel('Passphrase').fill(TILL_PASSPHRASE)
  await device.getByRole('button', { name: 'Open the till' }).click()
  await device
    .waitForFunction(() => /Redeem|Not trading/.test(document.body.innerText), undefined, { timeout: 30_000 })
    .catch(() => {})
  return text(device)
}

async function main() {
  const browser: Browser = await chromium.launch()
  const owner = await (await context(browser)).newPage()
  const device = await (await context(browser)).newPage()
  const errors: string[] = []
  const authCalls: string[] = []
  owner.on('pageerror', (e) => errors.push(`A: ${e.message}`))
  device.on('pageerror', (e) => errors.push(`B: ${e.message}`))
  device.on('request', (r) => {
    if (new URL(r.url()).pathname.startsWith('/api/v1/auth')) authCalls.push(r.url())
  })

  console.log('\nA registers a stall')
  await registerMerchant(owner, BASE)
  check('A is registered', !owner.url().includes('onboarding'), owner.url())

  console.log('\nB, a fresh device, offers to become a terminal')
  await device.goto(`${BASE}/onboarding`, { waitUntil: 'networkidle' })
  await device.getByRole('link', { name: 'Set this device up as a terminal' }).click()
  const codeEl = device.getByTestId('terminal-code')
  await codeEl.waitFor({ timeout: 15_000 })
  const deviceKey = (await codeEl.innerText()).trim()
  check('B shows a 64-hex code', /^[0-9a-f]{64}$/.test(deviceKey), deviceKey)
  check('B says the code is not a secret', /not a secret/.test(await text(device)))
  const bStorage = await device.evaluate(() => Object.keys(localStorage).filter((k) => k.includes('terminal')))
  check('B has stored nothing yet', bStorage.length === 0, bStorage.join(','))

  console.log('\nA adds it')
  await owner.goto(`${BASE}/settings/terminals/add`, { waitUntil: 'networkidle' })
  await owner.getByRole('button', { name: 'Add terminal' }).waitFor({ timeout: 15_000 })
  await owner.getByLabel('Name').fill('Front counter')
  await owner.getByRole('button', { name: /Redemption only/ }).click()
  await owner.getByLabel("Or enter the device's key").fill(deviceKey)
  await owner.getByRole('button', { name: 'Continue' }).click()
  await owner.getByRole('button', { name: 'Add terminal' }).click()
  await owner
    .getByRole('heading', { name: /Waiting for the device/ })
    .waitFor({ timeout: 90_000 })
    .catch(() => {})
  const aAdded = await text(owner)
  check('A says it was sent and is waiting', /Sent to Front counter/.test(aAdded), aAdded.slice(-300))
  const aCode = aAdded.match(/Check code (\d{3} \d{3})/)?.[1] ?? ''
  check('A shows a check code', aCode.length === 7)
  if (!aCode) {
    if (/without a way for you to revoke it/.test(aAdded)) {
      console.log(
        '\n  This gateway-customer does not mint the stall co-key (imani-gateway-customer#187),\n' +
          '  so the owner\'s wallet refused the credential, as it should. Deploy #187 and rerun.',
      )
    }
    await browser.close()
    console.log(`\n${failures.length} FAILED: ${failures.join(', ')}\n`)
    process.exit(1)
  }

  // The device accepts only the offer the owner's setup code names (#160 review), so the
  // operator enters A's setup code on B, as the camera would read it.
  const setup = (await owner.getByTestId('setup-code').innerText().catch(() => '')).trim()
  check('A shows a setup code naming its stall', /^imani-terminal:1:[0-9a-f]{64}:/.test(setup), setup)
  await device.getByLabel('Or enter the setup code').fill(setup)
  await device.getByRole('button', { name: 'Continue' }).click()

  console.log('\nB receives it')
  await device.getByText('Check this is your stall').waitFor({ timeout: 60_000 }).catch(() => {})
  const bOffer = await text(device)
  check('B shows the same check code as A', aCode !== '' && bOffer.includes(aCode), bOffer.slice(0, 300))
  check('B names the stall', /Test Stall/.test(bOffer), bOffer.slice(0, 200))
  await device.getByRole('button', { name: 'They match' }).click()
  await device.getByLabel('Passphrase', { exact: true }).fill(TILL_PASSPHRASE)
  await device.getByLabel('Repeat passphrase').fill(TILL_PASSPHRASE)
  await device.getByRole('button', { name: 'Finish setup' }).click()
  await device.getByText('This terminal is set up').waitFor({ timeout: 30_000 }).catch(() => {})
  check('B is set up', /This terminal is set up/.test(await text(device)))
  const record = await device.evaluate(() => localStorage.getItem('imani-wallet:terminal') ?? '')
  check(
    'B stores the token and no role-bearing fields beside it',
    /"token"/.test(record) && !/"permissions"|"merchantMetadata"|"issuerId"/.test(record),
    record.slice(0, 200),
  )

  console.log('\nA sees it In service without a reload')
  await owner.goto(`${BASE}/settings/terminals`, { waitUntil: 'networkidle' })
  const turned = await owner
    .waitForFunction(() => !/Waiting for the device/.test(document.body.innerText), undefined, {
      timeout: 60_000,
    })
    .then(
      () => true,
      () => false,
    )
  check("A's row turned In service without a reload", turned, (await text(owner)).slice(0, 300))

  if (PHASE < 3) return finish(browser, errors)

  console.log('\nPhase 3: B reloads and opens its till')
  const till = await unlockTill(device)
  check('B lands on the till naming the stall', new RegExp(TEST_STALL_NAME).test(till), till.slice(0, 200))
  check('B names itself', /Front counter/.test(till), till.slice(0, 200))
  check('B offers Redeem', /Redeem/.test(till))
  check('a redeem-only B offers no Sell', !/\bSell\b/.test(till.replace(/Selling/g, '')), till.slice(0, 200))
  check('B made no call to /api/v1/auth', authCalls.length === 0, authCalls.join(', '))
  // In-app navigation, as staff would reach a URL: a reload locks the till by design (the
  // signer lives only in memory), so `page.goto` would land on the unlock screen instead.
  const visit = (path: string) =>
    device.evaluate((p) => {
      window.history.pushState({}, '', p)
      window.dispatchEvent(new PopStateEvent('popstate'))
    }, path)
  await visit('/sell')
  await device.getByTestId('terminal-name').waitFor({ timeout: 15_000 }).catch(() => {})
  check('a redeem-only B has no Sell route: /sell lands on the till', !device.url().endsWith('/sell') && !/Scan the customer/.test(await text(device)), device.url())
  await visit('/merchant/dashboard')
  await device.getByTestId('terminal-name').waitFor({ timeout: 15_000 }).catch(() => {})
  check("B cannot open the stall's dashboard", !device.url().endsWith('/dashboard') && !/Dashboard/.test(await text(device)), device.url())

  console.log('\nPhase 3: a customer C pays B\'s Redeem request')
  // The owner sells C a coupon first, so C has something of this stall's to pay with. The
  // stall's coupon:issue permission is cached by the gateway for a minute after registration.
  const customer = await (await context(browser)).newPage()
  customer.on('pageerror', (e) => errors.push(`C: ${e.message}`))
  const customerPubkey = await registerCustomer(customer, BASE)
  check('C is registered', /^[0-9a-f]{64}$/.test(customerPubkey), customerPubkey)
  await owner.waitForTimeout(PERMISSION_CACHE_MS)
  const sold = await ownerSells(owner, customerPubkey, '10.00')
  check('A sells C a coupon', /It is in their wallet now/.test(sold), sold.slice(0, 300))

  // The till may have idle-locked during the sale above (10 minutes is the default, the sale is
  // well under that), so unlock if asked, then tap Redeem.
  if (await device.getByRole('button', { name: 'Open the till' }).isVisible().catch(() => false)) {
    await unlockTill(device)
  }
  await device.getByRole('button', { name: /Redeem/ }).click()
  await device.getByLabel(/Amount/).waitFor({ timeout: 30_000 })
  await device.getByLabel(/Amount/).fill('3.00')
  await device.getByRole('button', { name: 'Show payment code' }).click()
  await device.getByText('Waiting for payment').waitFor({ timeout: 15_000 })
  const request = await device.evaluate(() => {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)!
      if (!key.startsWith('imani-wallet:payment-requests:')) continue
      const rows = JSON.parse(localStorage.getItem(key) ?? '[]') as Array<{ requestString: string }>
      if (rows[0]) return rows[0].requestString
    }
    return ''
  })
  check('B shows a payment request', request.startsWith('vreqA'), request.slice(0, 16))

  const paid = await customerPays(customer, request)
  check('C pays it', /Paid|Sent/.test(paid), paid.slice(0, 300))
  const bPaid = await device
    .getByText('Paid', { exact: true })
    .waitFor({ timeout: 120_000 })
    .then(
      () => true,
      () => false,
    )
  check('B shows Paid, learned from gateway-core', bPaid, (await text(device)).slice(0, 200))

  if (PHASE < 4) return finish(browser, errors)

  console.log('\nPhase 4: A revokes B, and B is refused at its next unlock')
  await owner.goto(`${BASE}/settings/terminals`, { waitUntil: 'load', timeout: 60_000 })
  await owner.getByRole('button', { name: 'Revoke' }).first().click({ timeout: 30_000 })
  await owner.getByRole('button', { name: /^Revoke/ }).last().click()
  const revoked = await owner
    .waitForFunction(() => /Revoked/.test(document.body.innerText), undefined, { timeout: 60_000 })
    .then(
      () => true,
      () => false,
    )
  check("A's row shows revoked", revoked, (await text(owner)).slice(0, 300))

  await device.reload({ waitUntil: 'load' })
  const refused = await unlockTill(device)
  check('B is refused: no longer in service', /no longer in service/.test(refused), refused.slice(0, 200))
  check('B offers no Redeem once refused', !/\bRedeem\b/.test(refused))

  console.log('\nPhase 4: B can still take itself out of service')
  await device.getByRole('button', { name: 'Take this terminal out of service' }).click()
  await device.getByRole('button', { name: 'Take out of service' }).click()
  const wiped = await device
    .waitForFunction(() => localStorage.getItem('imani-wallet:terminal') === null, undefined, { timeout: 30_000 })
    .then(
      () => true,
      () => false,
    )
  check('B erased its terminal record', wiped)

  return finish(browser, errors)
}

/** The owner sells `amount` to a customer, through the real Sell screen. */
async function ownerSells(owner: Page, customerPubkey: string, amount: string): Promise<string> {
  await owner.goto(`${BASE}/sell`, { waitUntil: 'load' })
  const lock = owner.locator('input[placeholder="Passphrase"]')
  if (await lock.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await lock.fill(TEST_PASSPHRASE)
    await owner.getByRole('button', { name: /unlock/i }).first().click()
    await owner.waitForTimeout(4_000)
    await owner.goto(`${BASE}/sell`, { waitUntil: 'load' })
  }
  const recipient = owner.locator('input[placeholder="name"]')
  if (!(await recipient.waitFor({ timeout: 30_000 }).then(() => true, () => false))) {
    // A cold staging relay can leave the merchant record unread on the first visit; one reload.
    await owner.screenshot({ path: 'e2e/.terminalSetup-sell.png' }).catch(() => {})
    console.log(`  (sell screen not ready: ${(await text(owner)).slice(0, 160)}; retrying)`)
    await owner.goto(`${BASE}/sell`, { waitUntil: 'load' })
  }
  await recipient.fill(customerPubkey, { timeout: 60_000 })
  await owner.getByRole('button', { name: /^Continue$/ }).click()
  await owner.locator('input[placeholder="0.00"]').waitFor({ timeout: 30_000 })
  await owner.locator('input[placeholder="0.00"]').fill(amount)
  await owner.getByRole('button', { name: /Send voucher/i }).click()
  for (let i = 0; i < 60; i++) {
    await owner.waitForTimeout(3_000)
    const t = await text(owner)
    if (/It is in their wallet now|failed|could not|refused/i.test(t)) return t
  }
  return text(owner)
}

/** The customer pays a payment request through /pay. */
async function customerPays(customer: Page, request: string): Promise<string> {
  // The coupon arrives by DM; give the customer's wallet time to receive it.
  for (let i = 0; i < 24; i++) {
    await customer.goto(`${BASE}/`, { waitUntil: 'load' })
    if (/Test Stall/.test(await text(customer))) break
    await customer.waitForTimeout(5_000)
  }
  await customer.goto(`${BASE}/pay?paymentRequest=${encodeURIComponent(request)}`, { waitUntil: 'load' })
  await customer.getByRole('button', { name: /^(Pay|Send)/ }).last().click({ timeout: 60_000 })
  for (let i = 0; i < 60; i++) {
    await customer.waitForTimeout(3_000)
    const t = await text(customer)
    if (/\bPaid\b|\bSent\b|failed|could not|refused/i.test(t)) return t
  }
  return text(customer)
}

async function finish(browser: Browser, errors: string[]) {
  check('no uncaught errors', errors.length === 0, errors.join('; '))
  await browser.close()
  console.log(failures.length === 0 ? '\nAll checks passed.\n' : `\n${failures.length} FAILED: ${failures.join(', ')}\n`)
  process.exit(failures.length === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('E2E harness error:', e)
  process.exit(1)
})
