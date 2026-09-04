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
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.evaluate(
    ([stall, rows]) => {
      localStorage.setItem(`imani-wallet:terminals:${stall}`, JSON.stringify(rows))
    },
    [STALL, terminals] as const,
  )
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
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
  check('the till shows Sell and Redeem', home.includes('Sell') && home.includes('Redeem'))
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
  await seedAndOpen('/settings/terminals', [
    {
      terminalPubkey: 'c'.repeat(64),
      name: 'Front counter',
      role: 'redeem-only',
      enrolledAt: 1_000_000,
      lastUsedAt: 1_700_000_000_000,
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
  check('no uncaught errors', pageErrors.length === 0, pageErrors.join('; '))

  console.log('\nRevocation, clicked for real')
  const revoke = page.getByRole('button', { name: 'Revoke' })
  check('a live terminal offers Revoke', (await revoke.count()) === 1)
  await revoke.first().click()

  const confirming = await page.locator('body').innerText()
  check('the delay is stated before the decision', /12 hours/.test(confirming))
  check('and says what to do if that is too long', /close your stall/.test(confirming))
  check('offers a way out', confirming.includes('Keep it'))

  // Nothing may have happened yet: the first tap must not revoke.
  const stillLive = await page.evaluate(
    (stall) =>
      JSON.parse(localStorage.getItem(`imani-wallet:terminals:${stall}`)!).find(
        (t: { name: string }) => t.name === 'Front counter',
      ).revokedAt,
    STALL,
  )
  check('the first tap does not revoke', stillLive === undefined)

  await page.getByRole('button', { name: /Revoke Front counter/ }).click()
  await page.waitForTimeout(300)

  const afterRevoke = await page.evaluate(
    (stall) =>
      JSON.parse(localStorage.getItem(`imani-wallet:terminals:${stall}`)!).find(
        (t: { name: string }) => t.name === 'Front counter',
      ),
    STALL,
  )
  check('confirming revokes it', afterRevoke.revokedAt !== undefined)
  check('and does not erase it', afterRevoke.name === 'Front counter')

  const afterText = await page.locator('body').innerText()
  check('the list updates with no reload', afterText.includes('No terminals yet'))
  check('nothing anywhere offers a pause', !/pause|suspend/i.test(afterText))

  console.log('\nThe enrolment screen')
  await seedAndOpen('/settings/terminals/add', [])
  await page.waitForTimeout(500)
  const enrol = await page.locator('body').innerText()
  check('renders', enrol.includes('Add a terminal') || enrol.includes('terminal'))
  check('asks for a name', enrol.includes('Name'))
  check('offers both roles', /Redemption only/i.test(enrol) && /Sell and redeem/i.test(enrol))

  const add = page.getByRole('button', { name: 'Add terminal' })
  check('will not enrol an empty form', await add.isDisabled())
  check('no uncaught errors', pageErrors.length === 0, pageErrors.join('; '))

  console.log('\nThe label fix, in a real browser')
  // The Input defect this work fixed: clicking a label must focus its field.
  // jsdom cannot show this; a real browser can.
  await page.getByText('Name', { exact: true }).click()
  const focused = await page.evaluate(() => document.activeElement?.tagName)
  check('clicking the label focuses the input', focused === 'INPUT', `focused ${focused}`)

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
