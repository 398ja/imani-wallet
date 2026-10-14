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
 * Phase 6 (`E2E_PHASE>=6`, #160 plan 4.1): E1 the till sale reaches A attributed (hard check), E2 the
 * record verifies, E3 a till cashback is filed, E4 a restored A sees the attribution and the roster,
 * E5 A' revokes, E6 the roster survives logout, E7 expiry badges on a moved clock, E8 Renew to the
 * same key with the old credential spent and Sell 201, E9 a wider role refused, E10 a legacy
 * redeem-only till renews attested, E11 the home-coming alert, E12 an expired till opens Redeem only.
 *
 * Needs a stack whose gateway-customer mints the stall co-key (imani-gateway-customer#187).
 *
 * Run against a local dev server:   E2E_BASE=http://localhost:5177 tsx e2e/terminalSetup.e2e.ts
 * Run a local build against staging: E2E_BASE=https://wallet.staging.398ja.xyz \
 *                                     E2E_BUNDLE_DIR=dist tsx e2e/terminalSetup.e2e.ts
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { mkdir, readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { extname, join, normalize } from 'node:path'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { finalizeEvent, getPublicKey, nip19, nip44, nip98, type Event } from 'nostr-tools'
import WebSocket from 'ws'
import { registerCustomer, registerMerchant, TEST_PASSPHRASE, TEST_STALL_NAME } from './register.mts'
import { bypassCaptcha } from './captchaBypass.mts'
import { parseVoucherToken, tokenProofs } from '../src/lib/voucherToken'

const BASE = (process.env.E2E_BASE ?? 'http://localhost:5177').replace(/\/+$/, '')
const BUNDLE_DIR = process.env.E2E_BUNDLE_DIR
const PHASE = Number(process.env.E2E_PHASE ?? '4')
/** Phase 5's server half (portal, gateway-customer, gateway-core) is deployed where E2E_BASE points. */
const P5_DEPLOYED = process.env.E2E_P5_DEPLOYED === '1'
/** inv-terminal-not-merchant's server-side checks (gateway-customer and gateway-core with the fix). */
const NOT_MERCHANT = process.env.E2E_TERMINAL_NOT_MERCHANT === '1'
/** The relay the harness publishes stall records to (the gate's published port). */
const RELAY_URL = process.env.E2E_RELAY_URL ?? 'ws://localhost:28378'
const TILL_PASSPHRASE = 'counter-pass'
/**
 * Where the run leaves screenshots and a Playwright trace per browser (round 4: the r3 run left no
 * artifacts, so whether the owner's Revoke landed could only be read from the edge's access log).
 */
const ARTIFACTS = process.env.E2E_ARTIFACTS ?? ''
/** A local gate fronts its mint with a throwaway CA (imani-deploy scripts/local-terminal-gate). */
const IGNORE_HTTPS_ERRORS = process.env.E2E_IGNORE_HTTPS_ERRORS === '1'
const contexts: Array<{ name: string; ctx: BrowserContext }> = []
/** What phase 5 leaves for phase 6 (#160 phase 6). */
const p6: { b3?: Page; saleTotal?: number } = {}
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
      if (path.startsWith('/api/') || path.startsWith('/.well-known/') || path.startsWith('/fcaptcha/')) return route.continue()
      const candidate = normalize(join(root, path))
      const file =
        candidate.startsWith(root) && extname(candidate)
          ? await readFile(candidate).then(() => candidate, () => shell)
          : shell
      return route.fulfill({ status: 200, body: await readFile(file), contentType: CONTENT_TYPES[extname(file)] ?? 'application/octet-stream' })
    })
  }
  // Last, so it runs first. A till never calls by-code (its cashback QR is built locally),
  // so this is insurance only: harmless if by-code is ever reached (E2E_CAPTCHA_BYPASS).
  await bypassCaptcha(ctx)
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
  // The whole signed code (inv-terminal-not-merchant): only it proves K was made as a terminal.
  const deviceCode = (await device.getByTestId('terminal-enrolment-code').textContent())?.trim() ?? ''
  check('B shows its signed terminal code', deviceCode.startsWith(`imani-terminal-key:1:${deviceKey}:`), deviceCode)
  check('B says the code is not a secret', /not a secret/.test(await text(device)))
  const bStorage = await device.evaluate(() => Object.keys(localStorage).filter((k) => k.includes('terminal')))
  check('B has stored nothing yet', bStorage.length === 0, bStorage.join(','))

  console.log('\nA adds it')
  await owner.goto(`${BASE}/settings/terminals/add`, { waitUntil: 'networkidle' })
  await owner.getByRole('button', { name: 'Add terminal' }).waitFor({ timeout: 15_000 })
  await owner.getByLabel('Name').fill('Front counter')
  await owner.getByRole('button', { name: /Redemption only/ }).click()
  await owner.getByLabel("Or enter the device's code").fill(deviceCode)
  await owner.getByRole('button', { name: 'Continue' }).click()
  await owner.getByText('Device scanned').waitFor({ timeout: 15_000 })
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
  if (PHASE >= 6) await phase6(browser, owner, customer, customerPubkey, errors)

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
  p6.b3 = till
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
  // E1 (#160 phase 6, wallet#202): the till's sale reaches A's own history by a sealed sale record,
  // and A's Vouchers list names the till. A hard check from phase 6 on; PENDING before it.
  if (PHASE >= 6) check('A sees the sale attributed to "Sales counter"', attributed)
  else checkDeployed('A sees the sale attributed to "Sales counter"', attributed)
  if (PHASE >= 6 && attributed) p6.saleTotal = Number(sentWarrant?.sale_total)

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
 * Phase 6 (#160, plan 4.1, E1 to E12): till sales reach the owner, the roster syncs and survives
 * logout and restore, Renew to the same key, expiry on the till, and the home-coming check.
 *
 * E1 is the phase 5 attribution check, made hard above. Run after phase 5, so B3 has been revoked
 * and the stall's free terminal is available again for B4.
 */
async function phase6(browser: Browser, owner: Page, customer: Page, customerPubkey: string, errors: string[]) {
  const ownerSk = await ownerKey(owner)
  if (!/^[0-9a-f]{64}$/.test(ownerSk)) return check("the harness opened A's key with its passphrase (phase 6)", false, ownerSk)
  const stall = bytesToHex(schnorr.getPublicKey(hexToBytes(ownerSk)))

  console.log("\nPhase 6: A's records of B3's sale")
  // E2: the record behind the row names the till and verifies its warrant.
  await owner.goto(`${BASE}/merchant/coupons`, { waitUntil: 'load' })
  const row = owner.getByRole('link').filter({ hasText: /Sold on Sales counter/ }).first()
  const opened = await row.click({ timeout: 30_000 }).then(() => true, () => false)
  const detail = opened
    ? await owner.waitForFunction(() => /Signed by this stall|Authorised/.test(document.body.innerText), undefined, { timeout: 30_000 })
        .then(() => text(owner), () => text(owner))
    : ''
  check('E2 the sale record says "Signed by this stall" (warrant verified)', /Signed by this stall/.test(detail), detail.slice(0, 300))
  const handled = await handledBy(owner, 'Sales counter')
  check('E2 the transaction reads "Handled by: Sales counter"', handled, '')
  await snap(owner, 'p6-e2-record')

  console.log('\nPhase 6: a till issues cashback, and the stall files it (E3)')
  // B3 was revoked in phase 5, so a fresh selling till B4 is set up (the free slot is free again).
  const b4 = await (await context(browser, 'B4-till')).newPage()
  b4.on('pageerror', (e) => errors.push(`B4: ${e.message}`))
  const b4Ready = await setUpDevice(owner, b4, 'Back counter', /Sell and redeem/)
  check('B4 is set up as a sell-and-redeem till', b4Ready)
  if (!b4Ready) return
  await unlockTill(b4)
  const visitB4 = (path: string) => b4.evaluate((p) => {
    window.history.pushState({}, '', p)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }, path)
  await visitB4('/sell/cashback')
  const amount = b4.locator('input[placeholder="0.00"]')
  let cashbackCode = ''
  if (await amount.waitFor({ timeout: 30_000 }).then(() => true, () => false)) {
    await amount.fill('1.50')
    await b4.getByRole('button', { name: 'Create cashback code' }).click()
    cashbackCode = await b4.waitForFunction(() => document.body.innerText.match(/CB-[A-Z0-9]{5}-[A-Z0-9]{5}/)?.[0] ?? '', undefined, { timeout: 60_000 })
      .then((h) => h.jsonValue() as Promise<string>, () => '')
  }
  check('B4 issues a cashback code', /^CB-/.test(cashbackCode), (await text(b4)).slice(0, 200))
  const cashbackFiled = cashbackCode
    ? await waitForOwnerRow(owner, { type: 'cashback', claimCode: cashbackCode }, 'terminalPubkey')
    : false
  check("E3 B4's cashback is in A's history, attributed to the till", cashbackFiled)

  console.log('\nPhase 6: A, restored on a fresh device from its backup key (E4)')
  const nsec = nip19.nsecEncode(hexToBytes(ownerSk))
  const restored = await (await context(browser, "A'-restored")).newPage()
  restored.on('pageerror', (e) => errors.push(`A': ${e.message}`))
  await restored.goto(`${BASE}/onboarding`, { waitUntil: 'networkidle' })
  await restored.getByRole('button', { name: /^Log in$/ }).first().click()
  await restored.locator('input[placeholder^="nsec1"]').fill(nsec)
  await restored.locator('input[placeholder="Choose a passphrase"]').fill(TEST_PASSPHRASE)
  await restored.locator('input[placeholder="Confirm passphrase"]').fill(TEST_PASSPHRASE)
  await restored.getByRole('button', { name: /^Add key and unlock$/ }).last().click()
  await restored.waitForFunction(() => !location.pathname.startsWith('/onboarding'), undefined, { timeout: 60_000 }).catch(() => {})
  // In-app navigation, not a reload: a reload right after the login can land before the unlocked
  // session is kept, and the app opens at home, never at the list (found by the local gate).
  await restored.waitForFunction(() => /\b(Sell|Redeem)\b/.test(document.body.innerText), undefined, { timeout: 60_000 }).catch(() => {})
  const restoredSale = await restored.evaluate(() => {
    window.history.pushState({}, '', '/merchant/coupons')
    window.dispatchEvent(new PopStateEvent('popstate'))
  })
    .then(() => restored.waitForFunction(() => /Sold on Sales counter/.test(document.body.innerText), undefined, { timeout: 120_000 }))
    .then(() => true, () => false)
  check("E4 A' sees B3's sale still attributed to Sales counter", restoredSale, (await text(restored)).slice(0, 300))
  const aB4 = await rosterRow(owner, 'Back counter')
  const rB4 = await waitRosterRow(restored, 'Back counter', (r) => r.status === 'in-service')
  check("E4 A' lists B4 In service, with the same credential and expiry", !!rB4 && rB4.voucherId === aB4?.voucherId && rB4.status === 'in-service',
    JSON.stringify({ a: aB4?.voucherId, r: rB4?.voucherId, s: rB4?.status }))
  await restored.goto(`${BASE}/settings/terminals`, { waitUntil: 'load' })
  const listsB4 = await restored.getByText('Back counter', { exact: true }).first().waitFor({ timeout: 60_000 }).then(() => true, () => false)
  check("E4 A' Terminals screen lists Back counter", listsB4)

  console.log("\nPhase 6: A' revokes B4, and B4 is refused at its next unlock (E5)")
  const rowR = restored.locator('div')
    .filter({ has: restored.getByText('Back counter', { exact: true }) })
    .filter({ has: restored.getByRole('button', { name: 'Revoke', exact: true }) }).last()
  const asked = await rowR.getByRole('button', { name: 'Revoke', exact: true }).click({ timeout: 30_000 }).then(() => true, () => false)
  const confirmed = asked && (await restored.getByRole('button', { name: 'Revoke Back counter', exact: true }).click({ timeout: 30_000 }).then(() => true, () => false))
  const revokedAt = confirmed ? await rosterRevokedAt(restored, 'Back counter') : null
  check("E5 A' revokes B4 (spent at the mint)", revokedAt !== null, `asked=${asked} confirmed=${confirmed}`)
  await b4.reload({ waitUntil: 'load' })
  const refused = await unlockTill(b4)
  check('E5 B4 reloads and its unlock is refused: no longer in service', /no longer in service/.test(refused), refused.slice(0, 200))
  await owner.goto(`${BASE}/settings/terminals`, { waitUntil: 'load' })
  const aSeesRevoked = (await rosterRevokedAt(owner, 'Back counter')) !== null
  check('E5 A, reopened, shows B4 revoked', aSeesRevoked)

  console.log('\nPhase 6: A logs out and in again, and the roster is back (E6)')
  await owner.goto(`${BASE}/settings/security`, { waitUntil: 'load' })
  owner.once('dialog', (d) => void d.accept())
  await owner.getByRole('button', { name: 'Log out' }).click({ timeout: 30_000 }).catch(() => {})
  await owner.waitForFunction(() => !Object.keys(localStorage).some((k) => k.startsWith('imani-wallet:terminals:')), undefined, { timeout: 30_000 }).catch(() => {})
  // Log out navigates, so the page's context can be torn down under this read ("Execution context
  // was destroyed", a flake seen in the #197 and mint#540 gates). Retried after the load settles.
  const wiped = await evaluateAcrossNavigation(owner,
    () => !Object.keys(localStorage).some((k) => k.startsWith('imani-wallet:terminals:')))
  check('E6 logout wiped the roster from this device', wiped)
  await owner.goto(`${BASE}/onboarding`, { waitUntil: 'networkidle' })
  await owner.getByRole('button', { name: /^Log in$/ }).first().click()
  await owner.locator('input[placeholder^="nsec1"]').fill(nsec)
  await owner.locator('input[placeholder="Choose a passphrase"]').fill(TEST_PASSPHRASE)
  await owner.locator('input[placeholder="Confirm passphrase"]').fill(TEST_PASSPHRASE)
  await owner.getByRole('button', { name: /^Add key and unlock$/ }).last().click()
  await owner.waitForFunction(() => !location.pathname.startsWith('/onboarding'), undefined, { timeout: 60_000 }).catch(() => {})
  const back = await waitRosterRow(owner, 'Sales counter', () => true)
  const backB4 = await waitRosterRow(owner, 'Back counter', (r) => typeof r.revokedAt === 'number')
  check('E6 after logging in again the roster is back (Sales counter, and Back counter revoked)', !!back && !!backB4)

  console.log('\nPhase 6: a fresh attested till B5, expiry badges (E7) and Renew (E8)')
  const b5 = await (await context(browser, 'B5-till')).newPage()
  b5.on('pageerror', (e) => errors.push(`B5: ${e.message}`))
  const b5Ready = await setUpDevice(owner, b5, 'Market till', /Sell and redeem/)
  check('B5 is set up as a sell-and-redeem till', b5Ready)
  if (!b5Ready) return finishPhase6(owner, stall, ownerSk, customer, customerPubkey, null)
  await unlockTill(b5)
  const b5Row = await waitRosterRow(owner, 'Market till', (r) => r.status === 'in-service')
  const b5Old = b5Row?.voucherId ?? ''
  const t = b5Row?.attestation ? Number(b5Row.attestation.expires_at) : 0
  check('B5 is in service on A with an attested expiry T', !!b5Old && t > 0, JSON.stringify(b5Row?.attestation ?? {}))

  // E7: A's clock moved to T - 20 days (amber), then T - 5 days (red). Only A's page clock, and
  // only after the unlock: NAP's challenge is signed with the page's time, and a clock a year out
  // is refused (401). The badge and line are Market till's own, not the first on the page.
  for (const [days, badge] of [[20, 'renew-amber'], [5, 'renew-red']] as const) {
    const at = (t - days * 86_400) * 1000
    const page = await (await context(browser, `A-clock-${days}`)).newPage()
    await page.clock.install()
    await copyLogin(owner, page)
    await page.clock.setFixedTime(at)
    await page.evaluate(() => {
      window.history.pushState({}, '', '/settings/terminals')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    const renew = page.getByRole('button', { name: 'Renew Market till' })
    const shown = await renew.waitFor({ timeout: 30_000 }).then(() => true, () => false)
      && (await renew.getAttribute('data-testid')) === badge
    const lines = shown ? await page.getByTestId('expiry-line').allInnerTexts().catch(() => [] as string[]) : []
    const line = lines.find((l) => l.startsWith('Market till')) ?? lines.join(' / ')
    check(`E7 at T - ${days} days A shows ${badge === 'renew-amber' ? 'amber' : 'red'}, "stops on … Renew it."`, shown && /Market till stops on .+\. Renew it\./.test(line), line)
    await snap(page, `p6-e7-${days}`)
    await page.context().close()
  }

  // E8: real clock. A taps Renew; B5 locked, then unlocked with the same passphrase, adopts it.
  await owner.goto(`${BASE}/settings/terminals`, { waitUntil: 'load' })
  const renewClicked = await owner.getByRole('button', { name: 'Renew Market till' }).click({ timeout: 30_000 }).then(() => true, () => false)
  const renewalSent = renewClicked && (await waitRosterRow(owner, 'Market till', (r) => !!r.renewal?.token && r.renewal?.delivered === true)) !== null
  check('E8 A renews B5: a fresh credential to the same key, sent to the device', renewalSent)
  const b5OldToken = await b5.evaluate(() => (JSON.parse(localStorage.getItem('imani-wallet:terminal') || '{}') as { token?: string }).token ?? '')
  await b5.getByRole('button', { name: /Lock/ }).click().catch(() => {})
  await b5.getByRole('button', { name: 'Open the till' }).waitFor({ timeout: 15_000 }).catch(() => {})
  await b5.getByLabel('Passphrase').fill(TILL_PASSPHRASE)
  await b5.getByRole('button', { name: 'Open the till' }).click()
  const adopted = await b5.waitForFunction((old) => {
    const r = JSON.parse(localStorage.getItem('imani-wallet:terminal') || '{}') as { voucherId?: string; previousToken?: string }
    return !!r.voucherId && r.voucherId !== old && !r.previousToken
  }, b5Old, { timeout: 120_000 }).then(() => true, () => false)
  check('E8 B5 adopts the renewal at unlock, same passphrase, no setup code, and spends its old credential', adopted)
  const renewed = await waitRosterRow(owner, 'Market till', (r) => r.voucherId !== b5Old && !r.renewal, async () => {
    await owner.goto(`${BASE}/settings/terminals`, { waitUntil: 'load' })
  })
  check("E8 A's row shows the new credential (old one in history, revoked)", !!renewed && !!renewed.credentials?.some((c) => c.voucherId === b5Old && typeof c.revokedAt === 'number'),
    JSON.stringify(renewed?.credentials ?? []).slice(0, 300))
  const oldState = b5OldToken ? await tokenState(b5OldToken) : ''
  check('E8 the old credential is SPENT at the mint', oldState === 'SPENT', oldState)
  // Sells with 201: the free slot passed to the new credential (F7).
  await b5.evaluate(() => {
    window.history.pushState({}, '', '/sell')
    window.dispatchEvent(new PopStateEvent('popstate'))
  })
  const statuses: number[] = []
  b5.on('response', (r) => {
    if (new URL(r.url()).pathname === '/api/v1/portal/vouchers' && r.request().method() === 'POST') statuses.push(r.status())
  })
  const sold = await tillSells(b5, customerPubkey, '2.00')
  check('E8 B5 sells to C with 201, not 402 (the free slot followed the renewal)', statuses.includes(201) && !statuses.includes(402), `${statuses.join(',')} ${sold.slice(0, 120)}`)
  const verdict = /It is in their wallet now/.test(sold) ? await couponVerdict(customer, 200) : 'not sold'
  check("E8 C's coupon from the renewed B5 reads `verified`", verdict === 'verified', verdict)

  await finishPhase6(owner, stall, ownerSk, customer, customerPubkey, { b5, b5Key: await tillKey(b5) })
}

/** E9 to E12: refusals, the legacy migration, the home-coming check, and expiry on the till. */
async function finishPhase6(
  owner: Page,
  stall: string,
  ownerSk: string,
  customer: Page,
  customerPubkey: string,
  b5: { b5: Page; b5Key: TillKey } | null,
) {
  if (b5) {
    console.log('\nPhase 6: past its expiry the till opens Redeem only (E12)')
    const page = await (await context(owner.context().browser()!, 'B5-expired')).newPage()
    const state = await b5.b5.context().storageState()
    await page.context().addCookies(state.cookies)
    const origin = state.origins.find((o) => o.origin === BASE)
    await page.goto(`${BASE}/terminal/unlock`, { waitUntil: 'load' })
    await page.evaluate((items) => { for (const { name, value } of items) localStorage.setItem(name, value) }, origin?.localStorage ?? [])
    const token = await page.evaluate(() => (JSON.parse(localStorage.getItem('imani-wallet:terminal') || '{}') as { token?: string }).token ?? '')
    const expiresAt = token ? Number(parseVoucherToken(token).voucher.expiresAt) : 0
    await page.clock.setFixedTime((expiresAt + 3600) * 1000)
    const home = await unlockTill(page)
    check('E12 past its expiry B5 opens Redeem only, with "Ask the owner to renew it", and no Sell', /Redeem/.test(home) && !/\bSell\b/.test(home.replace(/Selling/g, '')) && /authority ran out on .* Ask the owner to renew it/.test(home), home.slice(0, 300))
    await page.evaluate(() => {
      window.history.pushState({}, '', '/sell')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    await page.getByTestId('terminal-name').waitFor({ timeout: 15_000 }).catch(() => {})
    check('E12 an expired B5 has no Sell route', !page.url().endsWith('/sell'), page.url())
    await snap(page, 'p6-e12-expired')
  }

  // The test stall holds no licence, so it has one free terminal, and B5 holds it now that its
  // renewal kept it in service. E9 adds a till and E11 sells from one outside the list: A revokes
  // B5 first (after E12, which needs B5's credential), as an owner without a licence would.
  if (b5) {
    const freed = await revokeOnA(owner, 'Market till')
    check('A revokes B5, freeing the stall\'s one free terminal for E9 and E11', freed)
  }

  if (b5 && b5.b5Key.sk) {
    console.log('\nPhase 6: a renewal that widens the role is refused by the device (E9)')
    // The harness, as a stall gone wrong, mints a REDEEM-ONLY-to-SELL "renewal"? A wider role
    // cannot be minted for a selling till, so the device's rule is exercised the other way round
    // on a redeem-only till: B6 is redeem-only and is offered an issue-and-redeem renewal.
    const b6 = await (await context(owner.context().browser()!, 'B6-door')).newPage()
    const ready = await setUpDevice(owner, b6, 'Side door')
    check('B6 is set up redeem-only', ready)
    if (ready) {
      await unlockTill(b6)
      const k = await tillKey(b6)
      const lock = bytesToHex(schnorr.getPublicKey(hexToBytes(k.sk)))
      const minted = await mintAttested(ownerSk, stall, lock, 'issue-and-redeem', 'Side door')
      check('the harness mints a wider-role credential to B6\'s key', minted.token !== '', minted.error)
      if (minted.token) {
        const sent = await dmAsStall(ownerSk, lock, JSON.stringify({
          type: 'imani-terminal-credential/1', voucher_id: minted.voucherId, token: minted.token,
          stall_pubkey: stall, name: 'Side door', idle_lock_minutes: 10, renews: k.voucherId,
        }))
        check('the wider "renewal" DM reaches B6', sent)
        await b6.getByRole('button', { name: /Lock/ }).click().catch(() => {})
        await b6.getByRole('button', { name: 'Open the till' }).waitFor({ timeout: 15_000 }).catch(() => {})
        await b6.getByLabel('Passphrase').fill(TILL_PASSPHRASE)
        await b6.getByRole('button', { name: 'Open the till' }).click()
        await b6.waitForTimeout(15_000)
        const kept = await b6.evaluate(() => (JSON.parse(localStorage.getItem('imani-wallet:terminal') || '{}') as { voucherId?: string }).voucherId ?? '')
        const home = await text(b6)
        check('E9 B6 refuses the wider role (role-not-renewal) and keeps its old credential, still Redeem only', kept === k.voucherId && !/\bSell\b/.test(home.replace(/Selling/g, '')), `${kept} vs ${k.voucherId}`)
        // The refused credential still holds one of the stall's two pending slots at the gateway.
        // The owner's app would cancel it; the harness minted it, so the harness does.
        await asKey(ownerSk, 'POST', `/api/v1/wallet/terminal-credentials/${minted.voucherId}/cancel`, {})
      }
    }
  }

  console.log('\nPhase 6: a legacy, unattested redeem-only till renews to an attested one (E10)')
  {
    const tillSk = bytesToHex(crypto.getRandomValues(new Uint8Array(32)))
    const lock = bytesToHex(schnorr.getPublicKey(hexToBytes(tillSk)))
    const body = {
      face_value: 1, face_unit: 'sat', face_decimals: 0, backing_strategy: 'PROPORTIONAL',
      issuer_id: stall, memo: 'Imani terminal credential', expires_in_days: 365,
      merchant_metadata: { terminal: true, stall_pubkey: stall, role: 'redeem-only', lock_key: lock, name: 'Legacy door' },
    }
    const minted = await mintAsOwner(ownerSk, body, { 'Idempotency-Key': crypto.randomUUID(), 'X-Imani-Terminal-Enrolment': enrolmentProof(tillSk) })
    const voucherId = (JSON.parse(minted.body || '{}') as { voucher_id?: string }).voucher_id ?? ''
    const token = voucherId ? await fetchToken(ownerSk, voucherId) : ''
    check('a legacy redeem-only credential L is minted the 5a way (no attestation)', token !== '', `${minted.status} ${minted.body.slice(0, 120)}`)
    if (token) {
      // A 5a till confirmed its credential when it took it: confirmed, L holds no pending slot.
      await asKey(tillSk, 'POST', `/api/v1/wallet/terminal-credentials/${voucherId}/confirm`, {})
      await owner.evaluate(({ key, row }) => {
        const rows = JSON.parse(localStorage.getItem(key) ?? '[]') as unknown[]
        localStorage.setItem(key, JSON.stringify([...rows, row]))
      }, { key: `imani-wallet:terminals:${stall}`, row: { terminalPubkey: lock, name: 'Legacy door', role: 'redeem-only', enrolledAt: Date.now(), token, voucherId, status: 'in-service', gatewayState: 'confirmed' } })
      await owner.goto(`${BASE}/settings/terminals`, { waitUntil: 'load' })
      await owner.getByRole('button', { name: 'Renew Legacy door' }).click({ timeout: 30_000 }).catch(() => {})
      const row = await waitRosterRow(owner, 'Legacy door', (r) => !!r.renewal?.token)
      const newToken = row?.renewal?.token ?? ''
      const attested = !!newToken && /owner_attestation/.test(new TextDecoder().decode(Uint8Array.from(atob(newToken.slice(6).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))))
      check('E10 Renew mints L an ATTESTED credential, still redeem-only, to the same key', attested && row?.role === 'redeem-only')
      // L's device is the harness: it adopts as a till does (confirm, enrolled DM), and spends the old.
      if (row?.renewal?.voucherId) {
        await asKey(tillSk, 'POST', `/api/v1/wallet/terminal-credentials/${row.renewal.voucherId}/confirm`, {})
        await dmFrom(tillSk, stall, JSON.stringify({ type: 'imani-terminal-enrolled/1', voucher_id: row.renewal.voucherId, terminal_pubkey: lock }))
        const done = await waitRosterRow(owner, 'Legacy door', (r) => r.voucherId === row.renewal!.voucherId, async () => {
          await owner.goto(`${BASE}/settings/terminals`, { waitUntil: 'load' })
        })
        const oldState = await tokenState(token)
        check('E10 L is now attested, redeem-only, and its old credential is spent', !!done && done.role === 'redeem-only' && oldState === 'SPENT', `${done?.voucherId} ${oldState}`)
      }
    }
  }

  console.log('\nPhase 6: the home-coming check (E11)')
  {
    // A stall-attested credential for a fresh K' minted straight through the API, NOT on the roster.
    const tillSk = bytesToHex(crypto.getRandomValues(new Uint8Array(32)))
    const lock = bytesToHex(schnorr.getPublicKey(hexToBytes(tillSk)))
    const minted = await mintAttested(ownerSk, stall, lock, 'issue-and-redeem', 'Shadow till', tillSk)
    check("the harness mints a stall-attested credential for K' outside the roster", minted.token !== '', minted.error)
    if (minted.token) {
      await asKey(tillSk, 'POST', `/api/v1/wallet/terminal-credentials/${minted.voucherId}/confirm`, {})
      const k: TillKey = { sk: tillSk, voucherId: minted.voucherId, secret: tokenProofs(minted.token)[0]?.secret ?? '', stall }
      // K' sells to the STALL's own key, so it is K's coupon that comes home to A. Paid by C instead,
      // C's wallet picks which of its coupons to spend, and in the gate it spent B5's (found by the
      // local gate: the check then passed for B5's credential, correctly, and E11 saw no alert).
      const sale = await tillPortalSale(k, 100, 'EUR', stall)
      check("K' sells through the portal", sale.status === 201 || sale.status === 200, `${sale.status} ${sale.body.slice(0, 160)}`)
      // The portal mints; the selling device delivers (issue.ts `deliver`). K' does, to the stall.
      const issued = (() => {
        try {
          const b = JSON.parse(sale.body) as { items?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>
          return (Array.isArray(b) ? b : b.items ?? []).filter((v) => typeof v.voucher_id === 'string')
        } catch {
          return []
        }
      })()
      check("K' has a coupon to deliver", issued.length > 0, sale.body.slice(0, 160))
      for (const v of issued) {
        // The portal answers before the coupon is minted; the till polls for its token (issue.ts
        // `waitForToken`). The stall can read its own coupon, so the harness polls as the owner.
        const token = typeof v.token === 'string' && v.token ? v.token : await fetchToken(ownerSk, String(v.voucher_id))
        const sent = await asTillResponse(k, 'POST', '/api/v1/dm/tokens/send', {
          recipient_pubkey: stall, token, memo: v.memo, voucher_id: v.voucher_id,
          face_value: v.face_value, face_unit: v.face_unit, face_decimals: v.face_decimals,
          token_amount: v.token_amount, backing_strategy: v.backing_strategy, issuer_id: stall, sender_pubkey: stall,
          ...(typeof v.expires_at === 'string' ? { expires_at: Math.floor(Date.parse(v.expires_at) / 1000) } : typeof v.expires_at === 'number' ? { expires_at: v.expires_at } : {}),
          relay_urls: ['ws://nostr-relay:7777'],
        })
        check("K' delivers its coupon to the stall", sent.status === 200 || sent.status === 201, `${sent.status} ${sent.body.slice(0, 160)}`)
      }
      // The coupon comes home to A by DM, and A's dm-poll raises the alert.
      const notified = await owner.waitForFunction(() => {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i)!
          if (!key.startsWith('imani-wallet:notifications:')) continue
          if ((localStorage.getItem(key) ?? '').includes('a till that is not on your list')) return true
        }
        return false
      }, undefined, { timeout: 5_000 }).then(() => true, () => false)
      if (!notified) await owner.goto(`${BASE}/`, { waitUntil: 'load' })
      const alerted = await owner.waitForFunction(() => {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i)!
          if (!key.startsWith('imani-wallet:notifications:')) continue
          if ((localStorage.getItem(key) ?? '').includes('a till that is not on your list')) return true
        }
        return false
      }, undefined, { timeout: 180_000 }).then(() => true, () => false)
      check('E11 A raises "a till not on your list" when that coupon comes home', alerted)
      const alerts = await owner.evaluate(() => {
        let n = 0
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i)!
          if (key.startsWith('imani-wallet:notifications:')) n += ((localStorage.getItem(key) ?? '').match(/homecoming:/g) ?? []).length
        }
        return n
      })
      check('E11 a coupon from a till on the list (B3, B5) raises nothing: exactly one alert', alerts === 1, String(alerts))
    }
  }

  await wrongPathCredential(owner, ownerSk, stall, customer, customerPubkey)
  if (NOT_MERCHANT) await notMerchantPhase(owner, ownerSk, stall)
}

/**
 * E13, the wrong path (owner report on wallet 0.19.0): a stall enrols a PERSONAL wallet's key as a
 * till. The credential DM reaches customer C's wallet, whose dm-poll used to regex the `cashuB…`
 * token out of it and swap it as money: 1 sat in the balance, a coupon in the carousel, and
 * "Payment received". Now C must not redeem it (the token stays UNSPENT at the mint), must not
 * book it, and must say "Terminal setup request from <stall>" instead.
 */
async function wrongPathCredential(owner: Page, ownerSk: string, stall: string, customer: Page, customerPubkey: string) {
  console.log('\nE13: a credential sent to a personal wallet is not money')
  // C's home, as money, before anything arrives: the balance line and every "N vouchers" count.
  await customer.goto(`${BASE}/`, { waitUntil: 'load' })
  await customer.getByText('Total balance').waitFor({ timeout: 30_000 }).catch(() => undefined)
  const before = await moneyView(customer)
  // inv-terminal-not-merchant (d): the owner's actual mistake, scanning C's account and minting to it,
  // is refused at mint now. An account key carries no enrolment proof.
  const refused = await mintAttested(ownerSk, stall, customerPubkey, 'redeem-only', 'Wrong path till')
  check('E13 a credential for C\'s personal account key, with no enrolment proof, is refused at mint (422 TERMINAL_KEY_NOT_A_TERMINAL)',
    refused.token === '' && /422/.test(refused.error) && /TERMINAL_KEY_NOT_A_TERMINAL/.test(refused.error), refused.error)
  // rev-option-a R1: C's holder signs the enrolment proof with C's OWN key (the format is public). The
  // proof holds, but C registered through real onboarding (a handle, a NAP session), so gateway-core
  // says C is a personal account, and an account is never a terminal: still 422.
  const cSk = await ownerKey(customer)
  const selfProof = await mintAttested(ownerSk, stall, customerPubkey, 'redeem-only', 'Wrong path till', cSk)
  check('E13 R1: C\'s account key with a proof signed by C\'s OWN key is refused at mint (422 TERMINAL_KEY_NOT_A_TERMINAL)',
    selfProof.token === '' && /422/.test(selfProof.error) && /TERMINAL_KEY_NOT_A_TERMINAL/.test(selfProof.error)
      && /Set this device up as a terminal/.test(selfProof.error), selfProof.error)
  // rev-option-a-r1 A1: the stall has gateway-customer sign an ORDINARY coupon locked to C whose
  // metadata reads like a till (terminal as the TEXT "true", so the mint does not treat it as a
  // credential: no attestation, no key guard), then offers it as C's "predecessor" credential. It
  // proves no enrolment: still 422.
  {
    const lookalike = await mintCoupon(ownerSk, {
      face_value: 1, face_unit: 'sat', face_decimals: 0, backing_strategy: 'PROPORTIONAL',
      issuer_id: stall, memo: 'Not a terminal', expires_in_days: 30,
      merchant_metadata: { terminal: 'true', stall_pubkey: stall, role: 'redeem-only', lock_key: customerPubkey, name: 'Lookalike' },
    })
    check('E13 A1: the stall can mint an ordinary coupon locked to C whose metadata says terminal "true" (text)',
      lookalike.token !== '', lookalike.error)
    const viaLookalike = await mintAttested(ownerSk, stall, customerPubkey, 'redeem-only', 'Wrong path till', undefined, lookalike.token)
    check('E13 A1: that coupon as X-Imani-Terminal-Renews does not make C\'s account a till (422 TERMINAL_KEY_NOT_A_TERMINAL)',
      viaLookalike.token === '' && /422/.test(viaLookalike.error) && /TERMINAL_KEY_NOT_A_TERMINAL/.test(viaLookalike.error),
      viaLookalike.error || `minted ${viaLookalike.voucherId}`)
    if (viaLookalike.voucherId) await asKey(ownerSk, 'POST', `/api/v1/wallet/terminal-credentials/${viaLookalike.voucherId}/cancel`, {})
  }
  // And the owner's app refuses C's personal QR (its npub) before anything is signed or sent.
  {
    await owner.goto(`${BASE}/settings/terminals/add`, { waitUntil: 'networkidle' })
    await owner.getByRole('button', { name: 'Add terminal' }).waitFor({ timeout: 15_000 })
    await owner.getByLabel("Or enter the device's code").fill(nip19.npubEncode(customerPubkey))
    await owner.getByRole('button', { name: 'Continue' }).click()
    const words = await owner.getByText(/personal account, not a terminal/).waitFor({ timeout: 15_000 }).then(() => true, () => false)
    const addDisabled = await owner.getByRole('button', { name: 'Add terminal' }).isDisabled().catch(() => false)
    check('E13 the owner\'s Add terminal refuses C\'s personal QR (npub) in words, and Add stays disabled',
      words && addDisabled && /Set this device up as a terminal/.test(await text(owner)), (await text(owner)).slice(0, 300))
  }
  // To still reach C's not-money path, the stall sends C a credential for a FRESH terminal key T (as a
  // mis-addressed DM would): nothing in C's wallet may treat it as money.
  const tSk = bytesToHex(crypto.getRandomValues(new Uint8Array(32)))
  const minted = await mintAttested(ownerSk, stall, bytesToHex(schnorr.getPublicKey(hexToBytes(tSk))), 'redeem-only',
    'Wrong path till', tSk)
  check('E13 a credential for a fresh terminal key T (with T\'s proof) is minted', minted.token !== '', minted.error)
  if (!minted.token) return
  const sent = await dmAsStall(ownerSk, customerPubkey, JSON.stringify({
    type: 'imani-terminal-credential/1', voucher_id: minted.voucherId, token: minted.token,
    stall_pubkey: stall, name: 'Wrong path till', idle_lock_minutes: 10,
  }))
  check('E13 the credential DM reaches C', sent)
  await customer.goto(`${BASE}/`, { waitUntil: 'load' })
  const noticed = await customer.waitForFunction((vid) => {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)!
      if (!key.startsWith('imani-wallet:notifications:')) continue
      if ((localStorage.getItem(key) ?? '').includes(`terminal-setup:${vid}`)) return true
    }
    return false
  }, minted.voucherId, { timeout: 120_000 }).then(() => true, () => false)
  const rows = await customer.evaluate((vid) => {
    const out: Array<{ id: string; type: string; title: string; url: string }> = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)!
      if (!key.startsWith('imani-wallet:notifications:')) continue
      for (const r of JSON.parse(localStorage.getItem(key) ?? '[]') as typeof out) if (r.id.includes(vid)) out.push(r)
    }
    return out
  }, minted.voucherId)
  const setupRow = rows.find((r) => r.type === 'terminal_setup_request')
  check('E13 C\'s bell reads "Terminal setup request from <stall>", linking to setup', noticed && !!setupRow &&
    /^Terminal setup request from (Test Stall|@|npub1)/.test(setupRow.title) && setupRow.url === '/terminal/setup', JSON.stringify(rows))
  check('E13 C files no "Payment received" for it', !rows.some((r) => r.type === 'voucher_received' || /Payment/.test(r.title)), JSON.stringify(rows))
  // Given the poller every chance to have redeemed it, the mint still holds it unspent.
  await customer.waitForTimeout(5_000)
  const state = await tokenState(minted.token)
  check('E13 C did not swap the credential at the mint (still UNSPENT)', state === 'UNSPENT', state)
  await customer.goto(`${BASE}/`, { waitUntil: 'load' })
  await customer.getByText('Total balance').waitFor({ timeout: 30_000 }).catch(() => undefined)
  const after = await moneyView(customer)
  check('E13 C\'s balance and home carousel are unchanged: no 1 sat, no extra coupon, no "Wrong path till"',
    after.text === before.text && !/Wrong path till/.test(after.text), `before: ${before.text} | after: ${after.text}`)
  await asKey(ownerSk, 'POST', `/api/v1/wallet/terminal-credentials/${minted.voucherId}/cancel`, {})
}

/** The home screen's money, without the toaster: the balance and each carousel card's count. */
async function moneyView(page: Page): Promise<{ text: string }> {
  const t = await page.evaluate(() => {
    // The live DOM (innerText needs layout), minus the toaster and the bell's panel, which may
    // carry the notice's own words.
    const hidden = [...document.querySelectorAll<HTMLElement>('[data-sonner-toaster], details:has(> summary [aria-label^="Notifications"]), details:has(> summary[aria-label^="Notifications"])')]
    const was = hidden.map((n) => n.style.display)
    hidden.forEach((n) => (n.style.display = 'none'))
    const out = document.body.innerText.replace(/\s+/g, ' ')
    hidden.forEach((n, i) => (n.style.display = was[i]))
    return out
  })
  const balance = t.match(/Total balance (\S+ ?\S*)/)?.[1] ?? '?'
  const counts = (t.match(/\b\d+ vouchers?\b/g) ?? []).join(',')
  const sats = /\b1 sat\b/.test(t) ? ' 1 sat' : ''
  return { text: `${balance} [${counts}]${sats}${/Wrong path till/.test(t) ? ' Wrong path till' : ''}` }
}

/**
 * inv-terminal-not-merchant (E2E_TERMINAL_NOT_MERCHANT=1): a terminal is a key created as a
 * terminal, never a merchant and never an existing account. Driven at the gateway, as an API client
 * that bypasses /terminal/setup and the owner's Add terminal would (case e).
 */
async function notMerchantPhase(owner: Page, ownerSk: string, stall: string) {
  console.log('\ninv-terminal-not-merchant: an owner tries to enrol a merchant\'s key, and is refused at mint')
  {
    // Another merchant M, with a live stall record that gateway-core has ingested.
    const mSk = bytesToHex(crypto.getRandomValues(new Uint8Array(32)))
    const m = bytesToHex(schnorr.getPublicKey(hexToBytes(mSk)))
    const opened = await openStallAs(mSk)
    check('N1 merchant M publishes its stall record', opened)
    await waitForMerchant(m)
    // Even WITH M's own enrolment proof (M cooperating): a merchant is never a till.
    const refused = await mintAttested(ownerSk, stall, m, 'issue-and-redeem', 'Borrowed till', mSk)
    check('N1 a credential for a merchant\'s key is refused at mint (409 TERMINAL_KEY_IS_MERCHANT)',
      refused.token === '' && /409/.test(refused.error) && /TERMINAL_KEY_IS_MERCHANT/.test(refused.error), refused.error)
  }

  console.log('\ninv-terminal-not-merchant: an existing account key, with no enrolment proof, is refused')
  {
    const cSk = bytesToHex(crypto.getRandomValues(new Uint8Array(32)))
    const c = bytesToHex(schnorr.getPublicKey(hexToBytes(cSk)))
    const refused = await mintAttested(ownerSk, stall, c, 'issue-and-redeem', 'Somebody\'s phone')
    check('N2 a key with no enrolment proof is refused at mint (422 TERMINAL_KEY_NOT_A_TERMINAL)',
      refused.token === '' && /422/.test(refused.error) && /TERMINAL_KEY_NOT_A_TERMINAL/.test(refused.error), refused.error)
    const own = await mintAttested(ownerSk, stall, stall, 'issue-and-redeem', 'Myself', ownerSk)
    check('N2 the stall\'s own key is refused at mint (409 TERMINAL_KEY_IS_MERCHANT)',
      own.token === '' && /409/.test(own.error) && /TERMINAL_KEY_IS_MERCHANT/.test(own.error), own.error)
  }

  console.log('\ninv-terminal-not-merchant: a till whose key opens a stall loses its terminal rights on its next request')
  {
    const tillSk = bytesToHex(crypto.getRandomValues(new Uint8Array(32)))
    const lock = bytesToHex(schnorr.getPublicKey(hexToBytes(tillSk)))
    const minted = await mintAttested(ownerSk, stall, lock, 'issue-and-redeem', 'Turncoat till', tillSk)
    check('N3 a fresh terminal key T, with its enrolment proof, is minted a credential', minted.token !== '', minted.error)
    if (minted.token) {
      await asKey(tillSk, 'POST', `/api/v1/wallet/terminal-credentials/${minted.voucherId}/confirm`, {})
      const k: TillKey = { sk: tillSk, voucherId: minted.voucherId, secret: tokenProofs(minted.token)[0]?.secret ?? '', stall }
      const sell = async () => tillPortalSale(k, 100, 'EUR', stall)
      const before = await sell()
      // Authorised as a till: 201, or 402 when the stall's one free slot is held by E11's till (the
      // portal's licence gate runs AFTER core granted the terminal). Either way, not 403.
      check('N3 T is authorised as a till at the portal (not 403)', [200, 201, 402].includes(before.status), `${before.status} ${before.body.slice(0, 160)}`)
      const gcSell = async () => asTillResponse(k, 'POST', '/api/v1/wallet/vouchers', {
        face_value: 100, face_unit: 'EUR', face_decimals: 2, backing_strategy: 'PROPORTIONAL',
        issuer_id: stall, expires_in_days: 30, memo: `turncoat-${crypto.randomUUID()}`,
      })
      const gcBefore = await gcSell()
      // Authorised: past resolveIssuer. A mint quota answer (WALLET_002 after the mint's 429) is past it too.
      check('N3 gateway-customer accepts T\'s credential (not 403)', gcBefore.status !== 403 && gcBefore.status !== 0, `${gcBefore.status} ${gcBefore.body.slice(0, 160)}`)
      check('N3 T opens a stall of its own', await openStallAs(tillSk))
      await waitForMerchant(lock)
      // The portal caches a refusal, never a grant: the next request asks core, which asks nostrdb.
      const after = await sell()
      check('N3 T\'s next Sell is refused (403): a merchant key is no till', after.status === 403, `${after.status} ${after.body.slice(0, 160)}`)
      const gc = await gcSell()
      check('N3 and gateway-customer refuses its credential too (403)', gc.status === 403, `${gc.status} ${gc.body.slice(0, 160)}`)
    }
  }
  await legacyTillRenewal(ownerSk, stall)
  void owner
}

/**
 * rev-option-a R2: a till minted before gateway-customer kept a registry row for it (V27/V28) renews.
 * The harness enrols a fresh till T for real, then deletes T's V27/V28 rows from the GATE's
 * throwaway database (what a till minted before those tables looks like), and renews it the way the
 * owner's app does: same K, the stall's attestation, no enrolment proof, and T's current credential
 * as X-Imani-Terminal-Renews. Without the credential it is a first enrolment and refused (422).
 */
async function legacyTillRenewal(ownerSk: string, stall: string) {
  console.log('\nrev-option-a R2: a legacy till with no registry row renews with its own credential')
  const sql = customerSql()
  if (!sql) return check('R2 legacy-till renewal needs the gate database (E2E_PORTAL_SQL_CMD)', false)
  const tSk = bytesToHex(crypto.getRandomValues(new Uint8Array(32)))
  const t = bytesToHex(schnorr.getPublicKey(hexToBytes(tSk)))
  const first = await mintAttested(ownerSk, stall, t, 'redeem-only', 'Legacy counter', tSk)
  check('R2 a till T is enrolled (fresh key, its proof)', first.token !== '', first.error)
  if (!first.token) return
  await asKey(tSk, 'POST', `/api/v1/wallet/terminal-credentials/${first.voucherId}/confirm`, {})
  const deleted = sql(`with a as (delete from terminal_credential where lock_key = '${t}' returning 1), `
    + `b as (delete from terminal_credential_pending where lock_key = '${t}' returning 1) `
    + `select (select count(*) from a) || '/' || (select count(*) from b)`)
  check('R2 T\'s V27/V28 rows are removed on the gate database: T is now a legacy till', /^[1-9]\d*\/[1-9]\d*$/.test(deleted), deleted)
  const bare = await mintAttested(ownerSk, stall, t, 'redeem-only', 'Legacy counter')
  check('R2 renewing T with neither a row nor its credential is a first enrolment: refused (422 TERMINAL_KEY_NOT_A_TERMINAL)',
    bare.token === '' && /422/.test(bare.error) && /TERMINAL_KEY_NOT_A_TERMINAL/.test(bare.error), bare.error)
  const renewed = await mintAttested(ownerSk, stall, t, 'redeem-only', 'Legacy counter', undefined, first.token)
  check('R2 renewing T with T\'s current credential (X-Imani-Terminal-Renews) mints the renewal', renewed.token !== '', renewed.error)
  const forged = await mintAttested(ownerSk, stall, bytesToHex(schnorr.getPublicKey(crypto.getRandomValues(new Uint8Array(32)))),
    'redeem-only', 'Someone else', undefined, first.token)
  check('R2 T\'s credential renews only T: another key presenting it is refused (422)',
    forged.token === '' && /422/.test(forged.error), forged.error)
  if (renewed.voucherId) await asKey(ownerSk, 'POST', `/api/v1/wallet/terminal-credentials/${renewed.voucherId}/cancel`, {})
}

/** psql on the gate's gateway-customer database, from the portal command run.sh passes, or null. */
function customerSql(): ((query: string) => string) | null {
  const portal = process.env.E2E_PORTAL_SQL_CMD ?? ''
  if (!/-d imani_portal\b/.test(portal)) return null
  const cmd = portal.replace(/-d imani_portal\b/, '-d imani_customer')
  return (query: string) => {
    try {
      return execFileSync('sh', ['-c', `${cmd} "$1"`, 'sh', query], { encoding: 'utf8', timeout: 30_000 }).trim()
    } catch (e) {
      return `error: ${String(e).slice(0, 160)}`
    }
  }
}

/** Publish an active `imani:merchant` stall record as `sk` to the gate relay. */
async function openStallAs(sk: string): Promise<boolean> {
  const event = finalizeEvent({
    kind: 30078, created_at: Math.floor(Date.now() / 1000), tags: [['d', 'imani:merchant']],
    content: JSON.stringify({ active: true, name: 'inv-terminal-not-merchant' }),
  }, hexToBytes(sk))
  return new Promise<boolean>((resolve) => {
    const ws = new WebSocket(RELAY_URL)
    const done = (ok: boolean) => { try { ws.close() } catch { /* closed */ } resolve(ok) }
    ws.on('open', () => ws.send(JSON.stringify(['EVENT', event])))
    ws.on('message', (m) => {
      const msg = JSON.parse(m.toString()) as unknown[]
      if (msg[0] === 'OK') done(msg[2] === true)
    })
    ws.on('error', () => done(false))
    setTimeout(() => done(false), 15_000)
  })
}

/** Give gateway-core's relay subscription time to ingest `pubkey`'s stall record into nostrdb. */
async function waitForMerchant(pubkey: string): Promise<void> {
  // StallRecordSync ingests from a standing relay subscription; give it time rather than poll a
  // surface the harness has no credential for.
  await new Promise((ok) => setTimeout(ok, 8_000))
  void pubkey
}

/**
 * `page.evaluate`, retried when a navigation destroys the context mid-call. Only that error is
 * retried (up to 5 times, after the page settles); any other error, and the last one, propagates.
 */
async function evaluateAcrossNavigation<T>(page: Page, fn: () => T): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await page.evaluate(fn)
    } catch (e) {
      if (attempt >= 5 || !/Execution context was destroyed|navigat/i.test(String(e))) throw e
      await page.waitForLoadState('load').catch(() => {})
      await page.waitForTimeout(500)
    }
  }
}

/** A revokes the named till from its Terminals screen. True when the roster records it revoked. */
async function revokeOnA(owner: Page, name: string): Promise<boolean> {
  await owner.goto(`${BASE}/settings/terminals`, { waitUntil: 'load' })
  const row = owner
    .locator('div')
    .filter({ has: owner.getByText(name, { exact: true }) })
    .filter({ has: owner.getByRole('button', { name: 'Revoke', exact: true }) })
    .last()
  const asked = await row.getByRole('button', { name: 'Revoke', exact: true }).click({ timeout: 30_000 }).then(() => true, () => false)
  const confirmed = asked && (await owner.getByRole('button', { name: `Revoke ${name}`, exact: true }).click({ timeout: 30_000 }).then(() => true, () => false))
  return confirmed && (await rosterRevokedAt(owner, name)) !== null
}

/** Whether the opened transaction reads "Handled by" the named till. */
async function handledBy(owner: Page, name: string): Promise<boolean> {
  const id = await owner.evaluate(async () => {
    const dbs = (await indexedDB.databases()).filter((d) => (d.name || '').startsWith('imani-wallet'))
    for (const info of dbs) {
      const db = await new Promise<IDBDatabase>((ok, ko) => { const r = indexedDB.open(info.name!); r.onsuccess = () => ok(r.result); r.onerror = () => ko(r.error) })
      for (const store of Array.from(db.objectStoreNames)) {
        const rows = await new Promise<unknown[]>((ok) => { const r = db.transaction(store).objectStore(store).getAll(); r.onsuccess = () => ok(r.result); r.onerror = () => ok([]) })
        for (const row of rows as Array<Record<string, unknown>>) {
          if (row.type === 'issued' && typeof row.terminalPubkey === 'string') return String(row.id)
        }
      }
    }
    return ''
  }).catch(() => '')
  if (!id) return false
  await owner.goto(`${BASE}/transaction/${encodeURIComponent(id)}`, { waitUntil: 'load' })
  return owner.waitForFunction((n) => new RegExp(`Handled by\\s*${n}`).test(document.body.innerText), name, { timeout: 30_000 }).then(() => true, () => false)
}

/**
 * Waits for a row in A's own history whose fields equal `match` and which carries `present`.
 * Data, not a predicate: a function is stringified into the page, where the closure it reads
 * (the claim code) does not exist, so every evaluate threw (found by the local gate, E3).
 */
async function waitForOwnerRow(owner: Page, match: Record<string, string>, present: string): Promise<boolean> {
  const find = async ({ match, present }: { match: Record<string, string>; present: string }) => {
    const dbs = (await indexedDB.databases()).filter((d) => (d.name || '').startsWith('imani-wallet'))
    for (const info of dbs) {
      const db = await new Promise<IDBDatabase>((ok, ko) => { const r = indexedDB.open(String(info.name)); r.onsuccess = () => ok(r.result); r.onerror = () => ko(r.error) })
      for (const store of Array.from(db.objectStoreNames)) {
        const rows = await new Promise<unknown[]>((ok) => { const r = db.transaction(store).objectStore(store).getAll(); r.onsuccess = () => ok(r.result); r.onerror = () => ok([]) })
        for (const row of rows as Array<Record<string, unknown>>) {
          if (Object.entries(match).every(([k, v]) => row[k] === v) && typeof row[present] === 'string') return true
        }
      }
    }
    return false
  }
  for (let i = 0; i < 40; i++) {
    await owner.goto(`${BASE}/merchant/coupons`, { waitUntil: 'load' })
    if (await owner.evaluate(find, { match, present }).catch(() => false)) return true
    await owner.waitForTimeout(5_000)
  }
  return false
}

interface RosterRowView {
  voucherId?: string
  status?: string
  revokedAt?: number
  role?: string
  attestation?: { expires_at: string }
  renewal?: { token?: string; voucherId?: string; delivered?: boolean }
  credentials?: Array<{ voucherId: string; revokedAt?: number }>
}

async function rosterRow(page: Page, name: string): Promise<RosterRowView | null> {
  const source = `(() => {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key || !key.startsWith('imani-wallet:terminals:')) continue
      const rows = JSON.parse(localStorage.getItem(key) || '[]')
      const row = rows.filter((r) => r.name === ${JSON.stringify(name)}).sort((a, b) => (b.credentialAt ?? b.enrolledAt) - (a.credentialAt ?? a.enrolledAt))[0]
      if (row) return row
    }
    return null
  })()`
  return (await page.evaluate(source).catch(() => null)) as RosterRowView | null
}

/** Polls the roster on `page` for the named row matching `pred`, for up to two minutes. */
async function waitRosterRow(
  page: Page,
  name: string,
  pred: (r: RosterRowView) => boolean,
  between?: () => Promise<void>,
): Promise<RosterRowView | null> {
  for (let i = 0; i < 40; i++) {
    const row = await rosterRow(page, name)
    if (row && pred(row)) return row
    if (between && i % 4 === 3) await between().catch(() => {})
    await page.waitForTimeout(3_000)
  }
  return null
}

/** Copies A's logged-in state into another page, so a moved clock can read A's list. */
async function copyLogin(from: Page, to: Page): Promise<void> {
  const state = await from.context().storageState()
  await to.context().addCookies(state.cookies)
  await to.goto(`${BASE}/onboarding`, { waitUntil: 'load' })
  const origin = state.origins.find((o) => o.origin === BASE)
  await to.evaluate((items) => { for (const { name, value } of items) localStorage.setItem(name, value) }, origin?.localStorage ?? [])
  // The session key is held in memory, so unlock with the passphrase on the copy.
  await to.goto(`${BASE}/`, { waitUntil: 'load' })
  const pass = to.locator('input[placeholder="Passphrase"]')
  if (await pass.waitFor({ timeout: 15_000 }).then(() => true, () => false)) {
    await pass.fill(TEST_PASSPHRASE)
    await to.getByRole('button', { name: /unlock/i }).first().click()
    await to.waitForTimeout(3_000)
  }
}

/** NUT-07 state of a token, through the gateway's public check. */
async function tokenState(token: string): Promise<string> {
  const res = await fetch(`${BASE}/api/v1/wallet/token/validate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
  }).catch(() => null)
  if (!res?.ok) return `http ${res?.status ?? 0}`
  return String(((await res.json()) as { state?: string }).state ?? '')
}

/** The ISSUED token of a voucher the owner minted, polled. */
async function fetchToken(ownerSk: string, voucherId: string): Promise<string> {
  for (let i = 0; i < 30; i++) {
    const got = await asKey(ownerSk, 'GET', `/api/v1/wallet/vouchers/${encodeURIComponent(voucherId)}`)
    const answer = JSON.parse(got.body || '{}') as { status?: string; token?: string }
    if (answer.status === 'ISSUED' && answer.token) return answer.token.trim()
    await new Promise((r) => setTimeout(r, 2_000))
  }
  return ''
}

/** An ordinary coupon (no attestation), minted with the owner's key; its ISSUED token. */
async function mintCoupon(ownerSk: string, body: Record<string, unknown>): Promise<{ token: string; voucherId: string; error: string }> {
  const minted = await mintAsOwner(ownerSk, body, { 'Idempotency-Key': crypto.randomUUID() })
  const voucherId = (JSON.parse(minted.body || '{}') as { voucher_id?: string }).voucher_id ?? ''
  if (!voucherId) return { token: '', voucherId: '', error: `${minted.status} ${minted.body.slice(0, 200)}` }
  return { token: await fetchToken(ownerSk, voucherId), voucherId, error: '' }
}

/** A credential the stall attests, minted with the owner's key, as the app's Add terminal does. */
async function mintAttested(ownerSk: string, stall: string, lock: string, role: string, name: string, tillSk?: string, renews?: string): Promise<{ token: string; voucherId: string; error: string }> {
  const T = Math.floor(Date.now() / 1000) + 365 * 86_400 + 600
  const nonce = bytesToHex(crypto.getRandomValues(new Uint8Array(32)))
  const pre = ['imani-terminal-attestation', '1', stall, lock, role, String(T), nonce].join('\u001f')
  const sig = bytesToHex(schnorr.sign(sha256(new TextEncoder().encode(pre)), hexToBytes(ownerSk)))
  const body = {
    face_value: 1, face_unit: 'sat', face_decimals: 0, backing_strategy: 'PROPORTIONAL',
    issuer_id: stall, memo: 'Imani terminal credential', expires_in_days: 365,
    merchant_metadata: { terminal: true, stall_pubkey: stall, role, lock_key: lock, name, owner_attestation: { v: '1', expires_at: String(T), nonce, sig } },
  }
  const minted = await mintAsOwner(ownerSk, body, {
    'Idempotency-Key': crypto.randomUUID(),
    'X-Idempotency-Expires-At': new Date(T * 1000).toISOString().replace('.000Z', 'Z'),
    ...(tillSk ? { 'X-Imani-Terminal-Enrolment': enrolmentProof(tillSk) } : {}),
    ...(renews ? { 'X-Imani-Terminal-Renews': renews } : {}),
  })
  const voucherId = (JSON.parse(minted.body || '{}') as { voucher_id?: string }).voucher_id ?? ''
  if (!voucherId) return { token: '', voucherId: '', error: `${minted.status} ${minted.body.slice(0, 200)}` }
  return { token: await fetchToken(ownerSk, voucherId), voucherId, error: '' }
}

/** NIP-17/59 gift wrap, as `terminalDelivery.wrapMessage` builds it (inlined: tsx cannot load the app's aliases). */
function wrapMessage(senderKey: Uint8Array, recipient: string, content: string): Event {
  const now = Math.floor(Date.now() / 1000)
  const rumor = { kind: 14, pubkey: getPublicKey(senderKey), created_at: now, content, tags: [['p', recipient]] }
  const seal = finalizeEvent({ kind: 13, created_at: now, tags: [], content: nip44.encrypt(JSON.stringify(rumor), nip44.getConversationKey(senderKey, recipient)) }, senderKey)
  const throwaway = crypto.getRandomValues(new Uint8Array(32))
  return finalizeEvent({ kind: 1059, created_at: now, tags: [['p', recipient]], content: nip44.encrypt(JSON.stringify(seal), nip44.getConversationKey(throwaway, recipient)) }, throwaway)
}

/** A NIP-17 gift wrap from `sk` to `recipient`, mirrored to the gateway (as `devicePublisher` does). */
async function dmFrom(sk: string, recipient: string, content: string): Promise<boolean> {
  const wrap = wrapMessage(hexToBytes(sk), recipient, content)
  const res = await asKey(sk, 'POST', '/api/v1/nostr/events', {
    id: wrap.id, pubkey: wrap.pubkey, createdAt: wrap.created_at, kind: wrap.kind, tags: wrap.tags, content: wrap.content, sig: wrap.sig,
  })
  return res.status >= 200 && res.status < 300
}

const dmAsStall = (ownerSk: string, to: string, content: string) => dmFrom(ownerSk, to, content)

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
  const minted = await mintAsOwner(ownerSk, body, { 'Idempotency-Key': crypto.randomUUID(), 'X-Imani-Terminal-Enrolment': enrolmentProof(tillSk) })
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

/**
 * The owner's own mint call, waiting out the mint's issuance limit (10 a minute per caller, and the
 * gateway is one caller) rather than failing a check on it: the harness mints several credentials
 * back to back on top of the run's own sales (found by the local gate, E10 and E11).
 */
async function mintAsOwner(ownerSk: string, body: unknown, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  for (let attempt = 0; ; attempt++) {
    // A fresh Idempotency-Key each time: the gateway refuses the same key after an attempt that
    // failed (IDEMPOTENCY_PREVIOUS_ATTEMPT_UNRECORDED), and a 429 at the quote minted nothing.
    const sent = attempt === 0 || !headers['Idempotency-Key'] ? headers : { ...headers, 'Idempotency-Key': crypto.randomUUID() }
    const out = await asKey(ownerSk, 'POST', '/api/v1/wallet/vouchers', body, sent)
    if (attempt >= 3 || !/HTTP client error: 429/.test(out.body)) return out
    await new Promise((ok) => setTimeout(ok, 65_000))
  }
}

/**
 * `X-Imani-Terminal-Enrolment` for the key `sk`: the proof its setup screen would show that it was
 * created as a terminal (inv-terminal-not-merchant). The harness holds K, so it signs as the device.
 */
function enrolmentProof(sk: string): string {
  const k = bytesToHex(schnorr.getPublicKey(hexToBytes(sk)))
  const at = Math.floor(Date.now() / 1000)
  const digest = sha256(new TextEncoder().encode(['imani-terminal-enrolment', '1', k, String(at)].join('\u001f')))
  return `1:${at}:${bytesToHex(schnorr.sign(digest, hexToBytes(sk)))}`
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
  return asTillOnce(k, method, path, body)
}

/**
 * A till's portal sale, waiting out the mint's issuance quota (10 a minute, and the gateway is one
 * caller) as mintAsOwner does: the harness's direct mints share it with the run's own sales. Each
 * attempt signs a FRESH warrant, since the portal spends a warrant's nonce before it mints.
 */
async function tillPortalSale(k: TillKey, total: number, unit: string, recipient: string): Promise<{ status: number; body: string }> {
  for (let attempt = 0; ; attempt++) {
    const out = await asTillOnce(k, 'POST', '/api/v1/portal/vouchers', {
      face_value_minor: total, currency: unit, quantity: 1, recipient_pubkey: recipient,
      issuance_warrant: await freshWarrant(k, total, unit),
    })
    if (out.status !== 429 || attempt >= 2) return out
    await new Promise((ok) => setTimeout(ok, 65_000))
  }
}

async function asTillOnce(
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
  const code = device.getByTestId('terminal-enrolment-code')
  if (!(await code.waitFor({ state: 'attached', timeout: 30_000 }).then(() => true, () => false))) return false
  const key = ((await code.textContent()) ?? '').trim()
  await owner.goto(`${BASE}/settings/terminals/add`, { waitUntil: 'load', timeout: 60_000 })
  await owner.getByRole('button', { name: 'Add terminal' }).waitFor({ timeout: 30_000 })
  await owner.getByLabel('Name').fill(name)
  await owner.getByRole('button', { name: role }).click()
  await owner.getByLabel("Or enter the device's code").fill(key)
  await owner.getByRole('button', { name: 'Continue' }).click()
  await owner.getByText('Device scanned').waitFor({ timeout: 15_000 }).catch(() => undefined)
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
