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
 * Phase 5b (#160 decision 5, owner attestation): B3 is enrolled by an owner app that signs the
 * attestation, so B3's warrant carries a credential whose metadata holds `owner_attestation`, the
 * till offers Sell with no renewal notice, and C reads the coupon `verified`. Then a LEGACY
 * credential, minted the way an owner app before 5b-5 asked for one (no attestation), is refused:
 * at mint by a gateway-customer with 5b-2 (400), or else at Sell by the 0.17.0 portal (403), and
 * the owner's roster shows the re-enrol path (Renew to keep selling: revoke, take out of service,
 * add again), whose first step, Revoke, is then carried out for real.
 *
 * Needs a stack whose gateway-customer mints the stall co-key (imani-gateway-customer#187).
 *
 * Run against a local dev server:   E2E_BASE=http://localhost:5177 tsx e2e/terminalSetup.e2e.ts
 * Run a local build against staging: E2E_BASE=https://wallet.staging.398ja.xyz \
 *                                     E2E_BUNDLE_DIR=dist tsx e2e/terminalSetup.e2e.ts
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { mkdir, readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { finalizeEvent, nip98 } from 'nostr-tools'
import WebSocket from 'ws'
import { registerCustomer, registerMerchant, TEST_PASSPHRASE, TEST_STALL_NAME } from './register.mts'
import { tokenProofs } from '../src/lib/voucherToken'

const BASE = (process.env.E2E_BASE ?? 'http://localhost:5177').replace(/\/+$/, '')
const BUNDLE_DIR = process.env.E2E_BUNDLE_DIR
const PHASE = Number(process.env.E2E_PHASE ?? '4')
/** Phase 5's server half (portal, gateway-customer, gateway-core) is deployed where E2E_BASE points. */
const P5_DEPLOYED = process.env.E2E_P5_DEPLOYED === '1'
const TILL_PASSPHRASE = 'counter-pass'
/**
 * Where the run leaves screenshots and a Playwright trace per browser (round 4: the r3 run left no
 * artifacts, so whether the owner's Revoke landed could only be read from the edge's access log).
 */
const ARTIFACTS = process.env.E2E_ARTIFACTS ?? ''
/** A local gate fronts its mint with a throwaway CA (imani-deploy scripts/local-terminal-gate). */
const IGNORE_HTTPS_ERRORS = process.env.E2E_IGNORE_HTTPS_ERRORS === '1'
const contexts: Array<{ name: string; ctx: BrowserContext }> = []
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

/**
 * Make publish and login concurrent, deterministically (#114 review 3c).
 *
 * Every relay socket the page opens is proxied. A kind-30078 merchant record is acked to the
 * wallet at once (so onboarding goes straight on to log in) but held from the relay until
 * /auth/complete has answered, then forwarded. The gateway therefore cannot know about the stall
 * when the login is decided: the slow-ingest case staging can hit, every run.
 */
async function holdStallRecordUntilLogin(page: Page) {
  const state = { held: 0, releasedAfterLogin: false, loginHadIssue: false }
  let loggedIn = false
  const pending: Array<() => Promise<void>> = []
  const heldIds = new Set<string>()
  page.on('response', async (r) => {
    if (!new URL(r.url()).pathname.endsWith('/auth/complete')) return
    try { state.loginHadIssue = ((await r.json()).permissions ?? []).includes('coupon:issue') } catch { /* body gone */ }
    loggedIn = true
    await Promise.all(pending.splice(0).map((send) => send()))
  })
  await page.routeWebSocket(/^wss?:\/\//, (ws) => {
    const server = ws.connectToServer()
    ws.onMessage((message) => {
      const frame = typeof message === 'string' ? message : message.toString()
      let event: { id?: string, kind?: number } | undefined
      try {
        const parsed = JSON.parse(frame)
        if (Array.isArray(parsed) && parsed[0] === 'EVENT') event = parsed[1]
      } catch { /* not JSON: pass through */ }
      if (event?.kind !== 30078 || loggedIn) return server.send(message)
      state.held++
      if (event.id) heldIds.add(event.id)
      ws.send(JSON.stringify(['OK', event.id, true, '']))
      // The wallet may close its socket once it has our OK, so forward on a socket of our own.
      const url = ws.url()
      pending.push(() => new Promise<void>((resolve) => {
        const out = new WebSocket(url)
        out.on('open', () => out.send(frame))
        out.on('message', (m) => {
          if (m.toString().startsWith('["OK"')) { state.releasedAfterLogin = true; out.close(); resolve() }
        })
        out.on('error', () => resolve())
      }))
    })
    // The relay's own OK for a held event arrives after ours. Drop it so the client sees one.
    server.onMessage((message) => {
      const frame = typeof message === 'string' ? message : message.toString()
      if (frame.startsWith('["OK"')) {
        try { if (heldIds.has(JSON.parse(frame)[1])) return } catch { /* pass through */ }
      }
      ws.send(message)
    })
  })
  return state
}

/** Serves the app from a local build while the API, relay and mint stay those of E2E_BASE. */
async function context(browser: Browser, name = `ctx${contexts.length}`): Promise<BrowserContext> {
  const ctx = await browser.newContext({
    locale: 'en-GB',
    serviceWorkers: BUNDLE_DIR ? 'block' : 'allow',
    ignoreHTTPSErrors: IGNORE_HTTPS_ERRORS,
  })
  if (ARTIFACTS) await ctx.tracing.start({ screenshots: true, snapshots: true })
  contexts.push({ name, ctx })
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

/** A full-page screenshot under E2E_ARTIFACTS, named for the step. No-op without it. */
async function snap(page: Page, step: string): Promise<void> {
  if (!ARTIFACTS) return
  await mkdir(ARTIFACTS, { recursive: true })
  await page.screenshot({ path: join(ARTIFACTS, `${step}.png`), fullPage: true }).catch(() => {})
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
  // E2E_CHROMIUM_ARGS: the local gate's relay and mint are on loopback ports, which Chromium's Local
  // Network Access checks block from a page (staging's are public https/wss, so it never needed this).
  const browser: Browser = await chromium.launch({ args: (process.env.E2E_CHROMIUM_ARGS ?? '').split(' ').filter(Boolean) })
  const owner = await (await context(browser, 'A-owner')).newPage()
  const device = await (await context(browser, 'B-device')).newPage()
  const errors: string[] = []
  const authCalls: string[] = []
  owner.on('pageerror', (e) => errors.push(`A: ${e.message}`))
  device.on('pageerror', (e) => errors.push(`B: ${e.message}`))
  device.on('request', (r) => {
    if (new URL(r.url()).pathname.startsWith('/api/v1/auth')) authCalls.push(r.url())
  })

  console.log('\nA registers a stall')
  const race = await holdStallRecordUntilLogin(owner)
  await registerMerchant(owner, BASE)
  check('A is registered', !owner.url().includes('onboarding'), owner.url())
  // The race the #114 review reproduced, forced: the gateway cannot have seen the stall record
  // when auth/complete answered, so the login answer is customer and the first render must still
  // come out as a merchant (the wallet re-reads /auth/session).
  check('A\'s stall record reached the relay only after login (race forced, #114)',
    race.held > 0 && race.releasedAfterLogin, `held=${race.held} afterLogin=${race.releasedAfterLogin}`)
  console.log(`  i auth/complete answered coupon:issue=${race.loginHadIssue}`)
  // imani-wallet#114: a stall registered through onboarding is a merchant from its FIRST render.
  // No sleep and no re-login: those are what the post-deploy suite used to hide this behind.
  await owner.getByText('Total balance').waitFor({ timeout: 30_000 }).catch(() => undefined)
  const firstRender = await text(owner)
  check('A offers Sell and Redeem on its first render (#114)',
    /\bSell\b/.test(firstRender.replace(/Selling/g, '')) && /\bRedeem\b/.test(firstRender), firstRender.slice(0, 200))
  const sessionGrants = await owner.evaluate(async () => {
    const r = await fetch('/api/v1/auth/session', { credentials: 'include' })
    return r.ok ? ((await r.json()).permissions ?? []) as string[] : [`HTTP ${r.status}`]
  })
  check('A\'s session carries coupon:issue (#114)', sessionGrants.includes('coupon:issue'), sessionGrants.join(','))
  await owner.reload({ waitUntil: 'load' })
  const relock = owner.locator('input[placeholder="Passphrase"]')
  if (await relock.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await relock.fill(TEST_PASSPHRASE)
    await owner.getByRole('button', { name: /unlock/i }).first().click()
  }
  await owner.getByText('Total balance').waitFor({ timeout: 30_000 }).catch(() => undefined)
  const resumed = await text(owner)
  check('A still offers Sell after a reload resumes the session (#114)',
    /\bSell\b/.test(resumed.replace(/Selling/g, '')), resumed.slice(0, 200))

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
  // The stall's name is looked up when the offer appears, so it lands a moment after the heading
  // (one gateway round trip, a 150 ms grace for the relay, then React). Round 3 read the screen
  // ~0.1 s after the heading and so raced the lookup: "A stall with no public name" on staging
  // in redeploy 3 and here, while the gateway had answered "Test Stall" in 48 ms. Wait for it.
  await device
    .waitForFunction((n) => document.body.innerText.includes(n), TEST_STALL_NAME, { timeout: 15_000 })
    .catch(() => {})
  await snap(device, 'p1-b-offer')
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
  // As on the offer screen: the stall's name and record are read after the till opens.
  const named = await device
    .waitForFunction((n) => document.body.innerText.includes(n), TEST_STALL_NAME, { timeout: 15_000 })
    .then(() => text(device), () => till)
  check('B lands on the till naming the stall', new RegExp(TEST_STALL_NAME).test(named), named.slice(0, 200))
  check('B names itself', /Front counter/.test(till), till.slice(0, 200))
  check('B offers Redeem', /Redeem/.test(named))
  // A negative check on the later text (`named`, read once the stall's record has loaded), not the
  // early `till` snapshot: a Sell button that renders late would be missed by the early one, and
  // the check would pass without having looked (wallet#201 review, W-1).
  check('a redeem-only B offers no Sell', !/\bSell\b/.test(named.replace(/Selling/g, '')), named.slice(0, 200))
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
  // The owner sells C a coupon first, so C has something of this stall's to pay with. No wait for
  // a permission cache: the stall's session carries coupon:issue from registration (#114).
  const customer = await (await context(browser, 'C-customer')).newPage()
  customer.on('pageerror', (e) => errors.push(`C: ${e.message}`))
  const customerPubkey = await registerCustomer(customer, BASE)
  check('C is registered', /^[0-9a-f]{64}$/.test(customerPubkey), customerPubkey)
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
  const second = await (await context(browser, 'B2-door')).newPage()
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
  const till = await (await context(browser, 'B3-till')).newPage()
  till.on('pageerror', (e) => errors.push(`B3: ${e.message}`))
  const ready = await setUpDevice(owner, till, 'Sales counter', /Sell and redeem/)
  check('B3 is set up as a sell-and-redeem till', ready)
  if (!ready) return
  const home = await unlockTill(till)
  check('B3 offers Sell and Redeem', /\bSell\b/.test(home) && /Redeem/.test(home), home.slice(0, 200))
  // Attested at enrolment (#160 decision 5), so the till is not told to ask for a renewal.
  check('B3, attested, shows no "renew to sell" notice', !/renew this terminal to sell/.test(home), home.slice(0, 200))

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
  const outbound: Array<{ path: string; header: string | null; warrant: string | null; body: string }> = []
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
    outbound.push({ path, header: r.headers()['x-imani-terminal-credential'] ?? null, warrant, body })
  })
  await visit('/sell')
  const sold = await tillSells(till, customerPubkey, '4.00')
  await snap(till, 'p5-b3-sell-result')
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
  // The credential in B3's warrant carries the stall's attestation, inside the metadata the
  // service signed (option A), with the four string fields and nothing else.
  const attestation = credentialAttestation(k.secret)
  check(
    "B3's credential carries the owner's attestation in its signed metadata",
    attestation !== null &&
      attestation.v === '1' &&
      /^[0-9]+$/.test(attestation.expires_at) &&
      /^[0-9a-f]{64}$/.test(attestation.nonce) &&
      /^[0-9a-f]{128}$/.test(attestation.sig),
    JSON.stringify(attestation),
  )
  checkDeployed('the gateway mints B3\'s sale ("It is in their wallet now")', /It is in their wallet now/.test(sold), sold.slice(0, 200))
  const verdict = /It is in their wallet now/.test(sold)
    ? await couponVerdict(customer, Number(sentWarrant?.sale_total))
    : 'not sold'
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
    // The SAME sale replayed: B3's exact Sell body, warrant and all, under a fresh NIP-98 signature.
    // The nonce is already spent, so 409. (Round 3 rebuilt the body as GBP 4.00 against B3's EUR
    // warrant, so the portal refused the denomination with 400 before it ever read the nonce.)
    if (sellRequest?.warrant) {
      const replay = await asTill(k, 'POST', '/api/v1/portal/vouchers', JSON.parse(sellRequest.body) as unknown)
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
    // The owner's Revoke must actually land: round 3 picked the deepest div naming "Sales counter"
    // (the name's own <div>, which holds no button), swallowed both click failures, and probed a
    // till nobody had revoked. Now the row is the element that holds BOTH the name and its Revoke,
    // every step must succeed, and the revocation is read back from A's roster (revokedAt), which
    // the screen only writes once the mint took the spend (terminalRevoke.ts).
    await owner.goto(`${BASE}/settings/terminals`, { waitUntil: 'load', timeout: 60_000 })
    const row = owner
      .locator('div')
      .filter({ has: owner.getByText('Sales counter', { exact: true }) })
      .filter({ has: owner.getByRole('button', { name: 'Revoke', exact: true }) })
      .last()
    const asked = await row
      .getByRole('button', { name: 'Revoke', exact: true })
      .click({ timeout: 30_000 })
      .then(() => true, () => false)
    const confirmed =
      asked &&
      (await owner
        .getByRole('button', { name: 'Revoke Sales counter', exact: true })
        .click({ timeout: 30_000 })
        .then(() => true, () => false))
    const revokedAt = confirmed ? await rosterRevokedAt(owner, 'Sales counter') : null
    await snap(owner, 'p5-a-revoked-b3')
    check("A's Revoke of B3 landed (spent at the mint, roster reads revoked)", revokedAt !== null,
      `asked=${asked} confirmed=${confirmed} ${(await text(owner)).slice(0, 300)}`)
    // The spec's AC: a revoked till gets 403 on Sell within 30 s. gateway-customer caches an UNSPENT
    // answer for 30 s and the portal caches no grant (TerminalPermissionResolver.ISSUE_TTL = 0), so
    // probe from 31 s after the revocation landed, not after a padded wait.
    const since = Date.now() - (revokedAt ?? Date.now())
    if (since < 31_000) await owner.waitForTimeout(31_000 - since)
    const revoked = await asTill(k, 'POST', '/api/v1/portal/vouchers', {
      face_value_minor: 100, currency: 'EUR', quantity: 1, issuance_warrant: await freshWarrant(k, 100, 'EUR'),
    })
    checkDeployed('a revoked B3 gets 403 on Sell (31 s after the revocation)', revoked === 403, String(revoked))
  }

  await legacyTill(owner)
}

/**
 * Phase 5b: a legacy, unattested selling credential is refused, and the roster shows the way out.
 *
 * Minted by the harness with the owner's own key and NIP-98, exactly as an owner app before 5b-5
 * asked for one: an issue-and-redeem credential whose metadata carries no `owner_attestation`. The
 * harness generates the till key K itself, so it can sign a sale with it as that till would.
 */
async function legacyTill(owner: Page) {
  console.log('\nPhase 5b: a legacy, unattested selling credential is refused')
  const ownerSk = await ownerKey(owner)
  if (!/^[0-9a-f]{64}$/.test(ownerSk)) return check("the harness opened A's key with its passphrase", false, ownerSk)
  const stall = bytesToHex(schnorr.getPublicKey(hexToBytes(ownerSk)))
  const tillSk = bytesToHex(crypto.getRandomValues(new Uint8Array(32)))
  const lock = bytesToHex(schnorr.getPublicKey(hexToBytes(tillSk)))
  const body = {
    face_value: 1, face_unit: 'sat', face_decimals: 0, backing_strategy: 'PROPORTIONAL',
    issuer_id: stall, memo: 'Imani terminal credential', expires_in_days: 365,
    merchant_metadata: { terminal: true, stall_pubkey: stall, role: 'issue-and-redeem', lock_key: lock, name: 'Legacy till' },
  }
  const minted = await asKey(ownerSk, 'POST', '/api/v1/wallet/vouchers', body, { 'Idempotency-Key': crypto.randomUUID() })
  if (minted.status === 400) {
    // gateway-customer with 5b-2: a selling credential without the stall's attestation is never minted.
    check(
      'a legacy selling credential is refused at mint (400 TERMINAL_ATTESTATION_INVALID)',
      /TERMINAL_ATTESTATION_INVALID/.test(minted.body),
      minted.body.slice(0, 200),
    )
    return
  }
  const voucherId = (JSON.parse(minted.body || '{}') as { voucher_id?: string }).voucher_id ?? ''
  check('a pre-5b-2 gateway mints the legacy credential', minted.status === 201 && voucherId !== '', `${minted.status} ${minted.body.slice(0, 160)}`)
  if (!voucherId) return
  let token = ''
  for (let i = 0; i < 30 && !token; i++) {
    const got = await asKey(ownerSk, 'GET', `/api/v1/wallet/vouchers/${encodeURIComponent(voucherId)}`)
    const answer = JSON.parse(got.body || '{}') as { status?: string; token?: string }
    if (answer.status === 'ISSUED' && answer.token) token = answer.token.trim()
    else await owner.waitForTimeout(2_000)
  }
  check('the legacy credential arrives', token !== '')
  if (!token) return

  // The portal (cashu-voucher 0.17.0) refuses the till's Sell: no stall attestation, metric
  // label owner_attestation. Signed with K and naming the credential, as the till would.
  const secret = tokenProofs(token)[0]?.secret ?? ''
  const k: TillKey = { sk: tillSk, voucherId, secret, stall }
  const sale = await asTillResponse(k, 'POST', '/api/v1/portal/vouchers', {
    face_value_minor: 100, currency: 'EUR', quantity: 1, issuance_warrant: await freshWarrant(k, 100, 'EUR'),
  })
  // With cv 0.17.0 (5b-4) the refusal is the owner attestation (metric label owner_attestation).
  // Before it, a 403 here can have another cause (licence, service keys unset), so the body is
  // printed for the record.
  checkDeployed('the portal refuses a Sell from the legacy till (403)', sale.status === 403, `${sale.status} ${sale.body.slice(0, 160)}`)
  console.log(`  (portal answer to the legacy Sell: ${sale.status} ${sale.body.slice(0, 200)})`)

  // The owner's roster shows the re-enrol path. The row is the one an owner app before 5b-5 wrote
  // for this mint, token and all, so it is written into A's roster as that app left it.
  await owner.evaluate(
    ({ key, row }) => {
      const rows = JSON.parse(localStorage.getItem(key) ?? '[]') as unknown[]
      localStorage.setItem(key, JSON.stringify([...rows, row]))
    },
    {
      key: `imani-wallet:terminals:${stall}`,
      row: { terminalPubkey: lock, name: 'Legacy till', role: 'issue-and-redeem', enrolledAt: Date.now(), token, voucherId, status: 'in-service', gatewayState: 'confirmed' },
    },
  )
  await owner.goto(`${BASE}/settings/terminals`, { waitUntil: 'load', timeout: 60_000 })
  const notice = await owner
    .getByTestId('renew-to-sell')
    .first()
    .innerText({ timeout: 30_000 })
    .catch(() => '')
  await snap(owner, 'p5b-a-renew-to-sell')
  check(
    'A\'s roster reads "Renew to keep selling" with the revoke, decommission and set-up-again steps',
    /^Renew to keep selling/.test(notice) && /Revoke it here/.test(notice) && /take it out of service/.test(notice) && /Add it again here/.test(notice),
    notice.slice(0, 300),
  )

  // Step 1 of the path, for real: the owner revokes the legacy till and the mint takes the spend.
  const row = owner
    .locator('div')
    .filter({ has: owner.getByText('Legacy till', { exact: true }) })
    .filter({ has: owner.getByRole('button', { name: 'Revoke', exact: true }) })
    .last()
  const asked = await row.getByRole('button', { name: 'Revoke', exact: true }).click({ timeout: 30_000 }).then(() => true, () => false)
  const confirmed =
    asked &&
    (await owner.getByRole('button', { name: 'Revoke Legacy till', exact: true }).click({ timeout: 30_000 }).then(() => true, () => false))
  const revokedAt = confirmed ? await rosterRevokedAt(owner, 'Legacy till') : null
  check('A revokes the legacy till (step 1 of re-enrolling), spent at the mint', revokedAt !== null, `asked=${asked} confirmed=${confirmed}`)
}

/** The `owner_attestation` in a credential secret's signed metadata, or null. */
function credentialAttestation(secret: string): Record<string, string> | null {
  try {
    const body = (JSON.parse(secret) as [string, { tags: string[][] }])[1]
    const metadata = body.tags.find((t) => t[0] === 'merchant_metadata')?.[1]
    const a = metadata ? (JSON.parse(metadata) as { owner_attestation?: Record<string, string> }).owner_attestation : undefined
    return a ?? null
  } catch {
    return null
  }
}

/** The owner's key, decrypted from A's key store with the test passphrase (as `tillKey` does). */
async function ownerKey(owner: Page): Promise<string> {
  const source = `(async () => {
    try {
      const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
      const env = JSON.parse(localStorage.getItem('imani-wallet-key') || 'null')
      const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(${JSON.stringify(TEST_PASSPHRASE)}), 'PBKDF2', false, ['deriveKey'])
      const key = await crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt: b64(env.kdf.salt), iterations: env.kdf.iterations, hash: env.kdf.hash },
        material, { name: 'AES-GCM', length: 256 }, false, ['decrypt'])
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(env.iv) }, key, b64(env.ciphertext))
      return new TextDecoder().decode(plain)
    } catch (e) {
      return String(e)
    }
  })()`
  return (await owner.evaluate(source)) as string
}

/** A request signed with NIP-98 by `sk`, with no terminal credential header. */
async function asKey(
  sk: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  const url = `${BASE}${path}`
  const payload = body === undefined ? undefined : JSON.stringify(body)
  const auth = await nip98.getToken(url, method.toUpperCase(), (e) => finalizeEvent(e, hexToBytes(sk)), true, body as Record<string, unknown>)
  const res = await fetch(url, {
    method,
    headers: { Authorization: auth, ...(payload ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: payload,
    signal: AbortSignal.timeout(20_000),
  }).catch(() => null)
  return { status: res?.status ?? 0, body: res ? await res.text().catch(() => '') : '' }
}

/** When A's roster recorded the named terminal as revoked (epoch ms), or null within 60 s. */
async function rosterRevokedAt(owner: Page, name: string): Promise<number | null> {
  const source = `(() => {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key || !key.startsWith('imani-wallet:terminals:')) continue
      const rows = JSON.parse(localStorage.getItem(key) || '[]')
      const row = rows.find((r) => r.name === ${JSON.stringify(name)} && typeof r.revokedAt === 'number')
      if (row) return row.revokedAt
    }
    return null
  })()`
  for (let i = 0; i < 60; i++) {
    const at = (await owner.evaluate(source)) as number | null
    if (at !== null) return at
    await owner.waitForTimeout(1_000)
  }
  return null
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
  const auth = await nip98.getToken(url, method.toUpperCase(), (e) => finalizeEvent(e, hexToBytes(k.sk)), true, body as Record<string, unknown>)
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
 * The warrant verdict C's wallet recorded on the coupon B3 sold, from its own history.
 * The wallet writes `validation.warrant` and `validation.warrantedSaleTotal` on every received row
 * (voucherValidationRecord.ts). Round 3 searched for the warrant's nonce, and a voucher id would not
 * do either: no received row stores the nonce, and a received row's voucherId is the swap result's
 * (a fresh UUID), not the issuer's. C holds two coupons of this stall, A's 10.00 and B3's 4.00, so
 * the warranted sale total tells them apart.
 */
async function couponVerdict(customer: Page, saleTotal: number): Promise<string> {
  if (!Number.isFinite(saleTotal)) return 'no sale total in B3 warrant'
  // Source text, for the same tsx reason as `tillKey`.
  const source = `(async () => {
    const wanted = ${JSON.stringify(`"warrantedSaleTotal":${saleTotal}`)}
    const dbs = (await indexedDB.databases()).filter((d) => (d.name || '').startsWith('imani-wallet'))
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
  if (ARTIFACTS) {
    await mkdir(ARTIFACTS, { recursive: true })
    for (const { name, ctx } of contexts) {
      await ctx.tracing.stop({ path: join(ARTIFACTS, `trace-${name}.zip`) }).catch(() => {})
    }
    console.log(`  (screenshots and traces in ${ARTIFACTS}; open a trace with: npx playwright show-trace <zip>)`)
  }
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
