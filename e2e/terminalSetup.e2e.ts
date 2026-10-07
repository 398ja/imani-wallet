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
 * Phase 4 (`E2E_PHASE=4`, the default): A revokes B, B reloads and is refused at unlock, B can
 * still take itself out of service, and A's row reads revoked.
 *
 * Phase 5 (`E2E_PHASE>=5`, run after phase 4, once B and B2 are revoked, so the stall's one free
 * terminal is available again without a licence): a sell-and-redeem till B3 sells to C,
 * C's coupon verdict is `verified`, A sees the sale attributed, a replayed warrant nonce gets 409,
 * B3 is refused on dashboard, campaigns, policies and SSE (401 at the edge or 403 at the portal),
 * a REDUCED B3 is refused before minting, and once A revokes B3 its next Sell gets 403. These need the portal, gateway-customer and
 * gateway-core Phase 5 PRs deployed: until `E2E_P5_DEPLOYED=1` their checks print PENDING and do
 * not fail the run.
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
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { finalizeEvent, nip98 } from 'nostr-tools'
import { registerCustomer, registerMerchant, TEST_PASSPHRASE, TEST_STALL_NAME } from './register.mts'

const BASE = (process.env.E2E_BASE ?? 'http://localhost:5177').replace(/\/+$/, '')
const BUNDLE_DIR = process.env.E2E_BUNDLE_DIR
const PHASE = Number(process.env.E2E_PHASE ?? '4')
/** Phase 5's server half (portal, gateway-customer, gateway-core) is deployed where E2E_BASE points. */
const P5_DEPLOYED = process.env.E2E_P5_DEPLOYED === '1'
const TILL_PASSPHRASE = 'counter-pass'
/** A new stall's coupon:issue permission is cached this long by the gateway (#114). */
const PERMISSION_CACHE_MS = 62_000
const failures: string[] = []
const pendingDeploy: string[] = []

function check(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(name)
}

/**
 * A check that needs the Phase 5 server PRs. Before they are deployed it is reported, not
 * failed: PENDING with what it saw, so the run still shows which half already holds.
 */
function checkDeployed(name: string, ok: boolean, detail = '') {
  if (P5_DEPLOYED || ok) return check(name, ok, detail)
  console.log(`  PENDING  ${name} (needs the phase 5 deploys)${detail ? ` — ${detail}` : ''}`)
  pendingDeploy.push(name)
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
  // #160 review (BLOCKER): the till registers the request's terms with gateway-core before it
  // shows the code (core#131). Against a gateway without that endpoint the till must refuse to
  // show a code it could never confirm, rather than show one a customer could fake Paid on.
  const shown = await device
    .getByText('Waiting for payment')
    .waitFor({ timeout: 15_000 })
    .then(
      () => true,
      () => false,
    )
  if (!shown) {
    const refusedToShow = /could not be set up/i.test(await text(device))
    check(
      'B refuses to show a request gateway-core will not register (gateway without core#131)',
      refusedToShow,
      (await text(device)).slice(0, 200),
    )
    console.log('  (gateway-core here has no registration endpoint: the Paid half needs core#131 deployed)')
  } else {
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
  }


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

  console.log('\nPhase 4: a device that hands itself back shows revoked on the owner\'s list')
  // A second device, set up and then taken out of service FROM THE DEVICE while still live. The
  // credential is spent by the device's own key, and A's list learns it from the mint.
  const second = await (await context(browser)).newPage()
  second.on('pageerror', (e) => errors.push(`B2: ${e.message}`))
  const secondReady = await setUpDevice(owner, second, 'Door')
  check('a second device B2 is set up', secondReady)
  if (secondReady) {
    await unlockTill(second)
    await second.getByRole('link', { name: /Settings/ }).click()
    await second.getByRole('link', { name: 'Security' }).click()
    await second.getByRole('button', { name: 'Take this terminal out of service' }).click()
    await second.getByRole('button', { name: 'Take out of service' }).click()
    const handedBack = await second
      .waitForFunction(() => localStorage.getItem('imani-wallet:terminal') === null, undefined, { timeout: 60_000 })
      .then(
        () => true,
        () => false,
      )
    check('B2 handed its authority back and erased itself', handedBack, (await text(second)).slice(0, 200))
    await owner.goto(`${BASE}/settings/terminals`, { waitUntil: 'load', timeout: 60_000 })
    // Read from A's own roster record, not the screen text, where B's revoked row sits nearby.
    const doorRevoked = await owner
      .waitForFunction(
        () => {
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i)!
            if (!key.startsWith('imani-wallet:terminals:')) continue
            const rows = JSON.parse(localStorage.getItem(key) ?? '[]') as Array<{ name?: string; revokedAt?: number }>
            if (rows.some((r) => r.name === 'Door' && typeof r.revokedAt === 'number')) return true
          }
          return false
        },
        undefined,
        { timeout: 60_000 },
      )
      .then(
        () => true,
        () => false,
      )
    check("A's row for B2 reads revoked, learned from the mint", doorRevoked, (await text(owner)).slice(0, 400))
  }

  if (PHASE >= 5) await phase5(browser, owner, customer, customerPubkey, errors)

  return finish(browser, errors)
}

/**
 * Phase 5: a sell-and-redeem till sells (#160, spec section 8 phase 5).
 *
 * A fresh device B3 is enrolled as Sell and redeem, sells C a coupon through its own /sell, and
 * C's wallet records the coupon's warrant verdict as `verified`. The server-side refusals (403
 * on owner endpoints, 409 on a replayed nonce, 403 once revoked) are probed with B3's own key K
 * and credential header, exactly as its signedFetch sends them.
 */
async function phase5(browser: Browser, owner: Page, customer: Page, customerPubkey: string, errors: string[]) {
  console.log('\nPhase 5: a sell-and-redeem till B3 is set up and opens a FULL till')
  const till = await (await context(browser)).newPage()
  till.on('pageerror', (e) => errors.push(`B3: ${e.message}`))
  const ready = await setUpDevice(owner, till, 'Sales counter', /Sell and redeem/)
  check('B3 is set up as a sell-and-redeem till', ready)
  if (!ready) return
  const home = await unlockTill(till)
  check('B3 offers Sell and Redeem', /\bSell\b/.test(home) && /Redeem/.test(home), home.slice(0, 200))

  // B3's key and credential, read the way the app reads them: K from its encrypted key store with
  // the passphrase, the voucher id and secret from the stored token. Used only to probe the
  // gateway the way B3's own signedFetch does.
  const k = await tillKey(till)
  check("the harness opened B3's key with its passphrase", /^[0-9a-f]{64}$/.test(k.sk), k.sk ? '' : k.error)

  console.log('\nPhase 5: B3 sells C a coupon, and C reads it as verified')
  const visit = (p: string) =>
    till.evaluate((path) => {
      window.history.pushState({}, '', path)
      window.dispatchEvent(new PopStateEvent('popstate'))
    }, p)
  const outbound: Array<{ path: string; header: string | null; warrant: string | null }> = []
  till.on('request', (r) => {
    const path = new URL(r.url()).pathname
    if (!path.startsWith('/api/v1/portal/')) return
    const body = r.postData() ?? ''
    let warrant: string | null = null
    try {
      warrant = (JSON.parse(body) as { issuance_warrant?: string }).issuance_warrant ?? null
    } catch {
      /* not JSON */
    }
    outbound.push({ path, header: r.headers()['x-imani-terminal-credential'] ?? null, warrant })
  })
  await visit('/sell')
  const sold = await tillSells(till, customerPubkey, '4.00')
  const sellRequest = outbound.find((o) => o.path === '/api/v1/portal/vouchers' && o.warrant)
  check('B3 names its credential on the Sell request', sellRequest?.header === k.voucherId, sellRequest?.header ?? 'none')
  const sentWarrant = sellRequest?.warrant ? (JSON.parse(sellRequest.warrant) as Record<string, unknown>) : null
  // The credential B3 put in its warrant: its own signed secret, naming the voucher it unlocked
  // with. Kept for the probes below, which sign fresh warrants with the same credential.
  k.secret = typeof sentWarrant?.credential === 'string' ? sentWarrant.credential : ''
  check(
    'B3 sends a terminal warrant carrying its credential secret',
    sentWarrant?.form === 'terminal' &&
      k.secret.startsWith('["P2PK_VOUCHER"') &&
      k.secret.includes(`["voucher_id","${k.voucherId}"]`) &&
      !/cashuB|"C":/.test(sellRequest?.warrant ?? ''),
    String(sentWarrant?.form),
  )
  checkDeployed('the gateway mints B3\'s sale ("It is in their wallet now")', /It is in their wallet now/.test(sold), sold.slice(0, 200))
  const verdict = /It is in their wallet now/.test(sold) ? await couponVerdict(customer, sentWarrant?.nonce as string) : 'not sold'
  checkDeployed("C's coupon from B3 has warrant verdict `verified`", verdict === 'verified', verdict)

  console.log("\nPhase 5: A sees B3's sale attributed")
  // The stall's history row for the sale names the till that sold it (terminals ticket 09). A
  // reads it from its own encrypted history, restored from the relay.
  const attributed = /It is in their wallet now/.test(sold)
    ? await owner
        .goto(`${BASE}/merchant/coupons`, { waitUntil: 'load' })
        .then(() => owner.waitForFunction(() => /Sales counter/.test(document.body.innerText), undefined, { timeout: 120_000 }))
        .then(() => true, () => false)
    : false
  checkDeployed('A sees the sale attributed to "Sales counter"', attributed)

  if (k.sk) {
    console.log('\nPhase 5: the gateway refuses what a till may not do')
    // The same warrant, replayed under a new request: the nonce is spent, so 409.
    if (sellRequest?.warrant) {
      const replay = await asTill(k, 'POST', '/api/v1/portal/vouchers', {
        face_value_minor: 400, currency: 'GBP', quantity: 1, issuance_warrant: sellRequest.warrant,
      })
      checkDeployed('a replayed warrant nonce gets 409', replay === 409, String(replay))
    }
    for (const [method, path] of [
      ['GET', '/api/v1/portal/dashboard'],
      ['GET', '/api/v1/portal/campaigns'],
      ['GET', '/api/v1/policies'],
      ['GET', '/api/v1/portal/events'],
    ] as const) {
      // Refused at either lock: the edge answers 401 "No session cookie" before the portal sees
      // it (only Sell and cashback issue pass the edge without a session, imani-deploy#139), and
      // the portal answers 403 if it ever does. Anything else, a 2xx above all, is a failure.
      const { status, body } = await asTillResponse(k, method, path)
      const refusedAtEdge = status === 401 && /No session cookie/.test(body)
      checkDeployed(
        `B3 is refused on ${path} (403 at the portal or 401 at the edge)`,
        status === 403 || refusedAtEdge,
        `${status} ${body.slice(0, 120)}`,
      )
    }

    console.log('\nPhase 5: a REDUCED B3 is refused before minting')
    // The mint is unreachable at unlock, so the till opens REDUCED. A reload is how a till next
    // asks the mint (`terminalMintApi.validateToken`); the route below makes that call fail.
    await till.route('**/api/v1/wallet/token/validate', (r) => r.abort())
    await till.reload({ waitUntil: 'load' })
    const reduced = await unlockTill(till)
    check('a REDUCED B3 offers no Sell', !/\bSell\b/.test(reduced.replace(/Selling/g, '')), reduced.slice(0, 200))
    const minted: string[] = []
    till.on('request', (r) => {
      if (new URL(r.url()).pathname === '/api/v1/portal/vouchers' && r.method() === 'POST') minted.push(r.url())
    })
    await visit('/sell')
    await till.getByTestId('terminal-name').waitFor({ timeout: 15_000 }).catch(() => {})
    check('a REDUCED B3 typing /sell lands on the till, and nothing is minted', !till.url().endsWith('/sell') && minted.length === 0, till.url())
    await till.unroute('**/api/v1/wallet/token/validate')

    console.log('\nPhase 5: A revokes B3, and its next Sell gets 403')
    await owner.goto(`${BASE}/settings/terminals`, { waitUntil: 'load', timeout: 60_000 })
    const row = owner.locator('li, [role="listitem"], div').filter({ hasText: 'Sales counter' }).last()
    await row.getByRole('button', { name: 'Revoke' }).click({ timeout: 30_000 }).catch(() => {})
    await owner.getByRole('button', { name: /^Revoke/ }).last().click().catch(() => {})
    // The portal caches a credential's grants for 60 s, and a revocation reaches the verifier
    // within 30 s (spec phase 5 AC).
    await owner.waitForTimeout(95_000)
    const revoked = await asTill(k, 'POST', '/api/v1/portal/vouchers', {
      face_value_minor: 100, currency: 'GBP', quantity: 1, issuance_warrant: await freshWarrant(k, 100, 'GBP'),
    })
    checkDeployed('a revoked B3 gets 403 on Sell', revoked === 403, String(revoked))
  }
}

interface TillKey {
  sk: string
  voucherId: string
  secret: string
  stall: string
  error?: string
}

/**
 * B3's K (decrypted from its key store with the passphrase) and its credential, from storage.
 *
 * Passed to the page as source text: tsx compiles a function argument with `__name` helpers
 * that do not exist in the page, so a closure here would throw before it ran.
 */
async function tillKey(till: Page): Promise<TillKey> {
  const source = `(async () => {
    const out = { sk: '', voucherId: '', secret: '', stall: '', error: '' }
    try {
      const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
      const env = JSON.parse(localStorage.getItem('imani-wallet-key') || 'null')
      const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(${JSON.stringify(TILL_PASSPHRASE)}), 'PBKDF2', false, ['deriveKey'])
      const key = await crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt: b64(env.kdf.salt), iterations: env.kdf.iterations, hash: env.kdf.hash },
        material, { name: 'AES-GCM', length: 256 }, false, ['decrypt'])
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(env.iv) }, key, b64(env.ciphertext))
      out.sk = new TextDecoder().decode(plain)
      const record = JSON.parse(localStorage.getItem('imani-wallet:terminal') || '{}')
      out.voucherId = record.voucherId || ''
      out.stall = record.stallPubkey || ''
    } catch (e) {
      out.error = String(e)
    }
    return out
  })()`
  // The credential's secret is taken from B3's own Sell request, where it matters.
  return (await till.evaluate(source)) as TillKey
}

/** A request signed with NIP-98 by B3's K and naming its credential, as its signedFetch does. */
async function asTill(k: TillKey, method: string, path: string, body?: unknown): Promise<number> {
  return (await asTillResponse(k, method, path, body)).status
}

/** As {@link asTill}, with the response body, to tell the edge's refusal from the portal's. */
async function asTillResponse(
  k: TillKey,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: string }> {
  const url = `${BASE}${path}`
  const payload = body === undefined ? undefined : JSON.stringify(body)
  const auth = await nip98.getToken(url, method.toLowerCase(), (e) => finalizeEvent(e, hexToBytes(k.sk)), true, body as Record<string, unknown>)
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: auth,
      'X-Imani-Terminal-Credential': k.voucherId,
      ...(payload ? { 'Content-Type': 'application/json' } : {}),
    },
    body: payload,
    signal: AbortSignal.timeout(20_000),
  }).catch(() => null)
  return { status: res?.status ?? 0, body: res ? await res.text().catch(() => '') : '' }
}

/** A new `terminal` warrant from K, for a probe that must not be refused as a replay. */
async function freshWarrant(k: TillKey, total: number, unit: string): Promise<string> {
  const nonce = bytesToHex(crypto.getRandomValues(new Uint8Array(16)))
  const digest = sha256(new TextEncoder().encode([k.stall, String(total), '2', unit, nonce].join('\u001f')))
  return JSON.stringify({
    form: 'terminal', sale_total: total, face_decimals: 2, unit, nonce,
    signature: bytesToHex(schnorr.sign(digest, hexToBytes(k.sk))), credential: k.secret,
  })
}

/** The till sells `amount` to a customer from its own Sell screen. */
async function tillSells(till: Page, customerPubkey: string, amount: string): Promise<string> {
  const recipient = till.locator('input[placeholder="name"]')
  if (!(await recipient.waitFor({ timeout: 30_000 }).then(() => true, () => false))) return text(till)
  await recipient.fill(customerPubkey)
  await till.getByRole('button', { name: /^Continue$/ }).click()
  await till.locator('input[placeholder="0.00"]').waitFor({ timeout: 30_000 })
  await till.locator('input[placeholder="0.00"]').fill(amount)
  await till.getByRole('button', { name: /Send voucher/i }).click()
  for (let i = 0; i < 60; i++) {
    await till.waitForTimeout(3_000)
    const t = await text(till)
    if (/It is in their wallet now|failed|could not|refused|Nothing has been issued/i.test(t)) return t
  }
  return text(till)
}

/**
 * The warrant verdict C's wallet recorded on the coupon carrying `nonce`, from its own history.
 * The wallet writes `validation.warrant` on every received row (voucherValidationRecord.ts).
 */
async function couponVerdict(customer: Page, nonce: string): Promise<string> {
  // Source text, for the same tsx reason as `tillKey`.
  const source = `(async () => {
    const wanted = ${JSON.stringify(nonce)}
    const dbs = (await indexedDB.databases()).filter((d) => (d.name || '').startsWith('imani-wallet-'))
    for (const info of dbs) {
      const db = await new Promise((ok, ko) => {
        const r = indexedDB.open(info.name)
        r.onsuccess = () => ok(r.result)
        r.onerror = () => ko(r.error)
      })
      for (const store of Array.from(db.objectStoreNames)) {
        const rows = await new Promise((ok) => {
          const r = db.transaction(store).objectStore(store).getAll()
          r.onsuccess = () => ok(r.result)
          r.onerror = () => ok([])
        })
        for (const row of rows) {
          const s = JSON.stringify(row)
          if (!s.includes(wanted)) continue
          const m = s.match(/"warrant":"(\\w+)"/)
          if (m) return m[1]
        }
      }
    }
    return ''
  })()`
  for (let i = 0; i < 24; i++) {
    await customer.goto(`${BASE}/`, { waitUntil: 'load' })
    const verdict = (await customer.evaluate(source)) as string
    if (verdict) return verdict
    await customer.waitForTimeout(5_000)
  }
  return 'not received'
}

/** A adds a terminal named `name`, and `device` (a fresh browser) sets itself up. */
async function setUpDevice(
  owner: Page,
  device: Page,
  name: string,
  role: RegExp = /Redemption only/,
): Promise<boolean> {
  await device.goto(`${BASE}/terminal/setup`, { waitUntil: 'load' })
  const code = device.getByTestId('terminal-code')
  if (!(await code.waitFor({ timeout: 30_000 }).then(() => true, () => false))) return false
  const key = (await code.innerText()).trim()
  await owner.goto(`${BASE}/settings/terminals/add`, { waitUntil: 'load', timeout: 60_000 })
  await owner.getByRole('button', { name: 'Add terminal' }).waitFor({ timeout: 30_000 })
  await owner.getByLabel('Name').fill(name)
  await owner.getByRole('button', { name: role }).click()
  await owner.getByLabel("Or enter the device's key").fill(key)
  await owner.getByRole('button', { name: 'Continue' }).click()
  // Add stays disabled when enrolment is refused (allowance, licence, a live row): say why.
  if (!(await owner.getByRole('button', { name: 'Add terminal' }).isEnabled({ timeout: 15_000 }).catch(() => false))) {
    console.log(`  (Add terminal is disabled: ${(await text(owner)).slice(0, 300)})`)
    return false
  }
  await owner.getByRole('button', { name: 'Add terminal' }).click()
  const setup = owner.getByTestId('setup-code')
  if (!(await setup.waitFor({ timeout: 90_000 }).then(() => true, () => false))) return false
  await device.getByLabel('Or enter the setup code').fill((await setup.innerText()).trim())
  await device.getByRole('button', { name: 'Continue' }).click()
  await device.getByRole('button', { name: 'They match' }).click({ timeout: 60_000 })
  await device.getByLabel('Passphrase', { exact: true }).fill(TILL_PASSPHRASE)
  await device.getByLabel('Repeat passphrase').fill(TILL_PASSPHRASE)
  await device.getByRole('button', { name: 'Finish setup' }).click()
  return device
    .getByText('This terminal is set up')
    .waitFor({ timeout: 30_000 })
    .then(
      () => true,
      () => false,
    )
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
  // A cold staging relay can leave the merchant record unread on a visit, and the new stall's
  // coupon:issue can lag the gateway's permission cache: reload a few times before giving up.
  for (let attempt = 0; attempt < 4; attempt++) {
    if (await recipient.waitFor({ timeout: 30_000 }).then(() => true, () => false)) break
    console.log(`  (sell screen not ready: ${(await text(owner)).slice(0, 160)}; logging in again)`)
    // A new stall's session carries the permissions it had at login, before coupon:issue
    // landed (#114). A fresh login picks it up, as probe-concurrent-redeem's relogin does.
    await owner.context().clearCookies()
    await owner.goto(`${BASE}/`, { waitUntil: 'load' })
    const pass = owner.locator('input[placeholder="Passphrase"]')
    if (await pass.waitFor({ timeout: 30_000 }).then(() => true, () => false)) {
      await pass.fill(TEST_PASSPHRASE)
      await owner.getByRole('button', { name: /unlock/i }).first().click()
      await owner.waitForTimeout(6_000)
    }
    await owner.goto(`${BASE}/sell`, { waitUntil: 'load' })
  }
  await recipient.fill(customerPubkey, { timeout: 30_000 })
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
  if (pendingDeploy.length > 0) {
    console.log(`\n${pendingDeploy.length} PENDING DEPLOY (set E2E_P5_DEPLOYED=1 once portal, gateway-customer and gateway-core phase 5 are live): ${pendingDeploy.join(', ')}`)
  }
  console.log(failures.length === 0 ? '\nAll checks passed.\n' : `\n${failures.length} FAILED: ${failures.join(', ')}\n`)
  process.exit(failures.length === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('E2E harness error:', e)
  process.exit(1)
})
