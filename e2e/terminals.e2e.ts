/**
 * Terminals, driven through the REAL built app in a real browser.
 *
 * Every other test in this repo mounts a component in jsdom. That proves the
 * component, not the product: it cannot catch a broken route, a page that
 * throws on mount, a missing import that only the bundler resolves, or CSS that
 * does not apply. This drives `vite build` output served over HTTP, clicking
 * what a stall owner would click.
 *
 * Run separately from the unit suite because it needs a browser and a server.
 */
import { chromium, type Browser, type Page } from 'playwright'
import { registerMerchant } from './register.mts'

/**
 * The dev server, not `vite preview`: the API proxy that registration needs
 * lives in vite.config.ts and preview does not apply it.
 */
const BASE = process.env.E2E_BASE ?? 'http://localhost:5177'

/** Filled in by registration — the real stall pubkey the roster is keyed on. */
let STALL = ''

let browser: Browser
let page: Page
const failures: string[] = []

/**
 * `page.goto` with a retry, because the dev server intermittently answers
 * `net::ERR_NETWORK_CHANGED` on this host.
 *
 * Observed failing one run in roughly three, always on navigation and never on
 * an assertion — the run before this was added died after 19 of 49 checks and
 * the run after passed 49/49 with no code change. A harness that reports the
 * host's networking as a product failure trains everyone to re-run it, which
 * is how a real regression gets waved through.
 */
async function goto(p: Page, url: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await p.goto(url, { waitUntil: 'domcontentloaded' })
      return
    } catch (e) {
      if (attempt === 3) throw e
      console.log(`  (navigation retry ${attempt}: ${(e as Error).message.split('\n')[0]})`)
      await p.waitForTimeout(500)
    }
  }
}

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`  PASS  ${name}`)
  } else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
    failures.push(name)
  }
}

/**
 * Seed a roster the way enrolment does, then load the page.
 *
 * The storage key and record shape are the real ones from `terminalRoster.ts`.
 * If either changes, this fails — which is the point: it is checking the app as
 * shipped, not a copy of its logic.
 */
async function seedAndOpen(path: string, terminals: unknown[]) {
  await goto(page, BASE)
  await page.evaluate(
    ([stall, rows]) => {
      localStorage.setItem(`imani-wallet:terminals:${stall}`, JSON.stringify(rows))
    },
    [STALL, terminals] as const,
  )
  await goto(page, `${BASE}${path}`)
  await page.waitForTimeout(1200)
}


/** Back to the stall's own device. */
async function beTheOwner() {
  await goto(page, BASE)
  await page.evaluate(() => localStorage.removeItem('imani-wallet:terminal'))
}

async function main() {
  browser = await chromium.launch()
  page = await browser.newPage()

  // Any uncaught error in the real app is a failure, whatever the assertions
  // below say. jsdom tests routinely miss these.
  const pageErrors: string[] = []
  page.on('pageerror', (e) => pageErrors.push(e.message))

  console.log('\nA real merchant registers against the live gateway')
  const handle = await registerMerchant(page, BASE)
  check('registration completes and lands in the wallet', !page.url().includes('onboarding'), page.url())
  const home = await page.locator('body').innerText()
  // The OWNER's device, freshly registered: it holds the stall key and can
  // sign a merchant warrant, so Sell stays. Terminals lose it (#159), below.
  check(
    'the till shows Sell and Redeem',
    home.includes('Sell') && home.includes('Redeem'),
    // Say what the till DID show. Without this the failure is the word
    // "false", and the next person cannot tell a missing button from a
    // screen that never rendered.
    home.replace(/\s+/g, ' ').slice(0, 160),
  )
  check('no uncaught errors during registration', pageErrors.length === 0, pageErrors.join('; '))

  // The stall's own pubkey, which is what the roster is keyed on in real use.
  STALL = await page.evaluate(() => {
    for (const k of Object.keys(localStorage)) {
      const v = localStorage.getItem(k) ?? ''
      const m = v.match(/[0-9a-f]{64}/)
      if (k.toLowerCase().includes('pub') && m) return m[0]
    }
    const all = Object.keys(localStorage).map((k) => localStorage.getItem(k) ?? '').join(' ')
    return all.match(/[0-9a-f]{64}/)?.[0] ?? ''
  })
  check('found the stall pubkey to key the roster on', /^[0-9a-f]{64}$/.test(STALL), STALL)
  console.log(`   registered @${handle}, stall ${STALL.slice(0, 12)}…`)

  console.log('\nThe terminals screen renders from a real roster')
  /**
   * Seeded rows, as an owner's phone holds them. `Front counter` carries a
   * token (a placeholder, which no mint will take), so Revoke is offered. `Old
   * till` predates #160 and holds none, so it cannot be revoked from here and
   * says so. The real, successful revocation is clicked in the phase 1 block
   * below, against a credential this run actually mints.
   */
  await seedAndOpen('/settings/terminals', [
    {
      terminalPubkey: 'c'.repeat(64),
      name: 'Front counter',
      role: 'redeem-only',
      enrolledAt: 1_000_000,
      lastUsedAt: 1_700_000_000_000,
      token: 'cashuB-seeded-placeholder',
    },
    {
      terminalPubkey: 'e'.repeat(64),
      name: 'Old till',
      role: 'redeem-only',
      enrolledAt: 950_000,
    },
    {
      terminalPubkey: 'd'.repeat(64),
      name: 'Door',
      role: 'redeem-only',
      enrolledAt: 900_000,
      revokedAt: 1_700_000_000_000,
    },
  ])

  const body = await page.locator('body').innerText()
  check('shows the live terminal by name', body.includes('Front counter'))
  check('shows the revoked terminal, not hidden', body.includes('Door'))
  check('separates them into sections', body.includes('No longer in service'))
  check('names the role', body.toLowerCase().includes('redemption only'))
  check('offers a way to add another', body.includes('Add a terminal'))
  check('a row set up before revocation existed says so', /Set up before revocation existed/.test(body))
  check('no uncaught errors', pageErrors.length === 0, pageErrors.join('; '))

  console.log('\nRevocation, clicked for real')
  const revoke = page.getByRole('button', { name: 'Revoke' })
  check('only the row holding a credential offers Revoke', (await revoke.count()) === 1)
  await revoke.first().click()

  const confirming = await page.locator('body').innerText()
  check('the delay is stated before the decision', /12 hours/.test(confirming))
  check('and says what to do if that is too long', /close your stall/.test(confirming))
  check('offers a way out', confirming.includes('Keep it'))

  const revokedAt = () =>
    page.evaluate(
      (stall) =>
        JSON.parse(localStorage.getItem(`imani-wallet:terminals:${stall}`)!).find(
          (t: { name: string }) => t.name === 'Front counter',
        ).revokedAt,
      STALL,
    )
  check('the first tap does not revoke', (await revokedAt()) === undefined)

  // #160 phase 1: confirming spends the credential at the mint, and the row is
  // marked only if that landed. This placeholder cannot be spent, so the row
  // must stay in service and the screen must say the revocation did not land.
  await page.getByRole('button', { name: /Revoke Front counter/ }).click()
  await page.waitForTimeout(1500)
  const afterRevoke = await page.locator('body').innerText()
  check('a spend that did not land leaves the row in service', (await revokedAt()) === undefined)
  check('and says so', /cannot be revoked from here|did not reach the mint/.test(afterRevoke), afterRevoke.slice(0, 200))
  check('nothing anywhere offers a pause', !/pause|suspend/i.test(afterRevoke))

  console.log('\nThe enrolment screen')
  await seedAndOpen('/settings/terminals/add', [])
  // Wait for the form itself rather than a flat timeout. One run in three
  // reached this with the screen still blank and failed four checks plus the
  // harness — the app was fine and the sleep was simply too short. Waiting on
  // the thing being asserted makes the check about the app again.
  await page
    .getByRole('button', { name: 'Add terminal' })
    .waitFor({ state: 'visible', timeout: 15_000 })
  const enrol = await page.locator('body').innerText()
  check('renders', enrol.includes('Add a terminal') || enrol.includes('terminal'))
  check('asks for a name', enrol.includes('Name'))
  check('offers both roles', /Redemption only/i.test(enrol) && /Sell and redeem/i.test(enrol))
  // #160 phase 5: a full till sells under the terminal warrant form.
  check('says a full till sells', /sells and honours/i.test(enrol))

  const add = page.getByRole('button', { name: 'Add terminal' })
  check('will not enrol an empty form', await add.isDisabled())
  check('no uncaught errors', pageErrors.length === 0, pageErrors.join('; '))

  console.log('\nThe label fix, in a real browser')
  // The Input defect this work fixed: clicking a label must focus its field.
  // jsdom cannot show this; a real browser can.
  await page.getByText('Name', { exact: true }).click()
  const focused = await page.evaluate(() => document.activeElement?.tagName)
  check('clicking the label focuses the input', focused === 'INPUT', `focused ${focused}`)

  console.log('\n#160 phase 0: an off-curve key is refused, a real one says Waiting')
  // Typed into the manual field, which is the same path a scan takes
  // (`resolveRecipient` then `onFound`). 'c' x 64 is 64 hex characters that
  // are no point on secp256k1, so nobody's key.
  await page.getByLabel('Name').fill('Front counter')
  await page.getByRole('button', { name: /Redemption only/ }).click()
  const enterKey = async (hex: string) => {
    await page.getByLabel("Or enter the device's key").fill(hex)
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.waitForTimeout(800)
  }
  await enterKey('c'.repeat(64))
  const offCurve = await page.locator('body').innerText()
  check('an off-curve key is refused in words', /not a terminal code/.test(offCurve), offCurve.slice(0, 200))
  check('and cannot be added', await add.isDisabled())

  await page.getByRole('button', { name: 'Rescan' }).click()
  // A real x-only key, generated here so no fixture key is reused.
  const { getPublicKey, generateSecretKey } = await import('nostr-tools')
  const devicePubkey = getPublicKey(generateSecretKey())
  await enterKey(devicePubkey)

  // #160 phase 1: Add makes exactly one minting call, to the owner's gateway.
  const mintCalls: string[] = []
  const onRequest = (r: { method(): string; url(): string }) => {
    if (r.method() === 'POST' && /\/api\/v1\/wallet\/vouchers$/.test(r.url())) mintCalls.push(r.url())
  }
  page.on('request', onRequest)
  await add.click()
  await page
    .getByRole('heading', { name: /Waiting for the device/ })
    .waitFor({ state: 'visible', timeout: 90_000 })
    .catch(() => {})
  page.off('request', onRequest)
  const added = await page.locator('body').innerText()
  check(
    'the screen says Waiting for the device',
    /Waiting for the device/.test(added),
    // Say what the screen DID show: the refusal is the useful part.
    added.replace(/\s+/g, ' ').slice(-300),
  )
  check('and never says it can trade', !/can now trade|can trade for your stall/i.test(added))
  check('phase 1: exactly one minting call on Add', mintCalls.length === 1, `saw ${mintCalls.length}`)
  check('phase 1: a check code is shown', /\d{3} \d{3}/.test(added))

  // The token on the owner's row decodes as the spec requires: P2PK_VOUCHER,
  // data = 02||K, pubkeys = [02||S], the signed metadata intact.
  const row = await page.evaluate(
    ([stall, device]) => {
      const rows = JSON.parse(localStorage.getItem(`imani-wallet:terminals:${stall}`) ?? '[]')
      return rows.find((r: { terminalPubkey: string }) => r.terminalPubkey === device) ?? null
    },
    [STALL, devicePubkey] as const,
  )
  if (row?.token) {
    const { tokenProofs, parseVoucherToken } = await import('../src/lib/voucherToken')
    const secret = JSON.parse(tokenProofs(row.token)[0].secret)
    const pubkeys = (secret[1].tags as string[][]).find((t) => t[0] === 'pubkeys')?.slice(1) ?? []
    const meta = JSON.parse(String(parseVoucherToken(row.token).voucher.merchantMetadata))
    check('phase 1: the credential is a P2PK_VOUCHER', secret[0] === 'P2PK_VOUCHER')
    check('phase 1: locked to the device', secret[1].data === `02${devicePubkey}`)
    check('phase 1: the stall is co-spender', pubkeys.includes(`02${STALL}`), JSON.stringify(pubkeys))
    check('phase 1: metadata intact', meta.lock_key === devicePubkey && meta.stall_pubkey === STALL)
  } else {
    check('phase 1: the roster row holds the credential token', false, added.slice(0, 200))
  }

  await goto(page, `${BASE}/settings/terminals`)
  await page.waitForTimeout(1200)
  const roster = await page.locator('body').innerText()
  check('the roster row reads Waiting for the device', /Waiting for the device/.test(roster))

  // Cancelling the waiting row spends the credential: NUT-07 then says SPENT.
  if (row?.token) {
    await page.getByRole('button', { name: 'Cancel' }).first().click()
    await page.getByRole('button', { name: /^Cancel Front counter/ }).click()
    await page.getByText('No longer in service').waitFor({ timeout: 60_000 }).catch(() => {})
    const state = await page.evaluate(async (token) => {
      const r = await fetch('/api/v1/wallet/token/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      return r.ok ? ((await r.json()) as { state?: string; valid?: boolean }) : { state: `http ${r.status}` }
    }, row.token)
    check('phase 1: cancelling spends it (NUT-07 SPENT)', state.state === 'SPENT' || state.valid === false, JSON.stringify(state))
  }
  check('no uncaught errors adding a terminal', pageErrors.length === 0, pageErrors.join('; '))

  console.log('\nWhat an unsubscribed stall sees when it runs two tills')
  /**
   * Subscriptions ticket 08, on the real screen.
   *
   * A freshly registered stall holds no licence, so `grants()` is false and the
   * free allowance applies — the same code path a LAPSE takes, and the only one
   * reachable without minting a licence into this wallet. What it demonstrates
   * is the property the ticket turns on: the allowance lands on exactly one
   * till, the oldest, and the extra one is marked rather than removed.
   *
   * The narrower claim, that a genuine EXPIRY behaves this way, is covered by
   * lapseService.test.ts against a real gateway-minted licence.
   */
  await seedAndOpen('/settings/terminals', [
    { terminalPubkey: 'c'.repeat(64), name: 'Oldest till', role: 'issue-and-redeem', enrolledAt: 1_000 },
    { terminalPubkey: 'e'.repeat(64), name: 'Second till', role: 'redeem-only', enrolledAt: 2_000 },
  ])
  await page.waitForTimeout(1500)

  const lapse = await page.locator('body').innerText()
  const marks = (lapse.match(/subscription is inactive/g) ?? []).length
  check('marks exactly one of the two tills', marks === 1, `found ${marks}`)
  check('promises renewal needs nothing done on the device',
    /nothing needs setting up on the device/.test(lapse))
  check('keeps the stopped till in service, not retired',
    lapse.includes('In service') && !lapse.includes('No longer in service'))
  check('never calls it paused', !/paused|suspended/i.test(lapse))

  /**
   * The free allowance must land on the OLDEST till, not just on "one of them".
   *
   * Asserted on the rendered text order rather than by walking ancestors: the
   * marker paragraph belongs to the row above it, so the marked name is
   * whichever name most recently preceded the sentence. My first attempt
   * climbed the DOM and matched a wrapper containing BOTH rows, which reported
   * the oldest as marked when the screen plainly showed otherwise — a wrong
   * assertion, not a wrong app.
   */
  const marked = lapse.slice(0, lapse.indexOf('subscription is inactive'))
  const lastNamed = marked.lastIndexOf('Second till') > marked.lastIndexOf('Oldest till')
    ? 'Second till'
    : 'Oldest till'
  check('the newest till is the one stopped', lastNamed === 'Second till', `marked ${lastNamed}`)
  check('and the oldest keeps serving', lapse.includes('Oldest till'))
  check('no uncaught errors', pageErrors.length === 0, pageErrors.join('; '))

  // `beATerminal()` is retired (#160 phase 3, spec 8). It injected a terminal record into the
  // owner's browser; the real two-browser flow in `terminalSetup.e2e.ts` now sets a device up,
  // opens its till, redeems and is revoked with no injected state. The injected-record case it
  // covered (an owner's key beside a record for another device) is a unit test:
  // `terminalUnlock.test.ts`, "a wallet key beside a terminal record is not a terminal".

  console.log('\nThe owner is unaffected by all of it')
  await beTheOwner()
  await goto(page, `${BASE}/settings/security`)
  await page.waitForTimeout(1500)
  const ownerSecurity = await page.locator('body').innerText()

  check('the owner still gets the existing logout copy', /backup key/i.test(ownerSecurity))
  check('and is not offered decommissioning', !/out of service/i.test(ownerSecurity))

  await goto(page, `${BASE}/`)
  await page.waitForTimeout(2000)
  const ownerTill = await page.locator('body').innerText()
  check(
    'the owner’s till still offers both actions',
    /Sell/.test(ownerTill) && /Redeem/.test(ownerTill),
    ownerTill.replace(/\s+/g, ' ').slice(0, 160),
  )

  console.log('\nSubscriptions: the diagnostics screen a support call reads')
  await goto(page, `${BASE}/settings/subscription`)
  await page.waitForTimeout(2500)
  const sub = await page.locator('body').innerText()

  check('renders rather than 404ing', sub.includes('Subscription'))
  check('states a verdict', /Not active|Active|Working/.test(sub), sub.slice(0, 160))
  check('says what to do about it', /get in touch|Get in touch/i.test(sub))
  check('no uncaught errors anywhere', pageErrors.length === 0, pageErrors.join('; '))

  console.log('\nReduced motion is honoured, in a real browser')
  /**
   * Re-uses the SAME page with an emulated preference rather than a fresh
   * context, because a new context has no registered stall and would never
   * reach this screen. `emulateMedia` is what a user's OS setting actually
   * looks like to the page.
   */
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await seedAndOpen('/settings/terminals', [
    {
      terminalPubkey: 'c'.repeat(64),
      name: 'Front counter',
      role: 'redeem-only',
      enrolledAt: 1_000_000,
      token: 'cashuB-seeded-placeholder',
    },
  ])
  await page.getByRole('button', { name: 'Revoke' }).first().click()
  await page.waitForTimeout(300)
  const anim = await page
    .locator('.expand-row')
    .evaluate((el) => getComputedStyle(el).animationName)
  check('the confirmation does not animate under reduced motion', anim === 'none', `got ${anim}`)

  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await seedAndOpen('/settings/terminals', [
    {
      terminalPubkey: 'c'.repeat(64),
      name: 'Front counter',
      role: 'redeem-only',
      enrolledAt: 1_000_000,
      token: 'cashuB-seeded-placeholder',
    },
  ])
  await page.getByRole('button', { name: 'Revoke' }).first().click()
  await page.waitForTimeout(300)
  const anim2 = await page
    .locator('.expand-row')
    .evaluate((el) => getComputedStyle(el).animationName)
  // The other direction, so "does not animate" cannot pass by the class simply
  // never being applied.
  check('and DOES animate otherwise', anim2 === 'expand-row', `got ${anim2}`)

  await browser.close()

  console.log(
    failures.length === 0
      ? `\nAll checks passed.\n`
      : `\n${failures.length} FAILED: ${failures.join(', ')}\n`,
  )
  process.exit(failures.length === 0 ? 0 : 1)
}

main().catch(async (e) => {
  console.error('E2E harness error:', e)
  await browser?.close()
  process.exit(1)
})
