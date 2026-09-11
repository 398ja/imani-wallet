/**
 * Notifications, driven through the REAL built app in a real browser.
 *
 * The unit suite proves each module. It cannot prove the FEATURE: that the bell
 * appears in the shipped header, that clicking it opens the panel, that marking
 * read survives a reload, that the settings route renders and its switches
 * work. Two specific blind spots this closes:
 *
 *  - Every bell unit test forces `<details open>` because jsdom does not
 *    implement the disclosure. So the one interaction a user actually performs
 *    — clicking the bell — was never executed anywhere until this file.
 *  - Nothing checked that /settings/notifications routes at all, or that the
 *    Notifications row in Settings leads to it.
 *
 * Each check below names the requirement it covers, so a reader can map the
 * feature to its evidence rather than counting green ticks.
 *
 * Run: npm run e2e:notifications  (needs the dev server on 5177)
 */
import { chromium, type Browser, type Page } from 'playwright'
import { registerCustomer } from './register.mts'

const BASE = process.env.E2E_BASE ?? 'http://localhost:5177'

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

async function goto(p: Page, url: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await p.goto(url, { waitUntil: 'domcontentloaded' })
      // `domcontentloaded` fires when the HTML is parsed, which for a SPA is
      // before React has rendered anything: the document is an empty #root.
      // Returning there made every later locator race the first render, and
      // it failed roughly one run in five with a bare 30s locator timeout
      // that pointed at the element rather than at the navigation.
      //
      // Waiting for React to MOUNT, not for networkidle (this app holds
      // long-lived connections, so networkidle may never settle) and not for
      // any particular element: the routes here render different chrome, and
      // a logged-out wallet has no <header> at all — checked, it is 0 on both
      // / and /settings, so waiting for one would hang every run.
      //
      // `#root` gaining a child is the one signal that means the same thing on
      // every route: React has rendered something.
      await p.waitForFunction(
        () => (document.getElementById('root')?.children.length ?? 0) > 0,
        undefined,
        { timeout: 15_000 },
      )
      return
    } catch (e) {
      if (attempt === 3) throw e
      await p.waitForTimeout(500)
    }
  }
}

/**
 * Put a notification in the inbox the way the app does.
 *
 * The storage key and row shape are the REAL ones from
 * `src/lib/notifications/inbox.ts`. If either changes, this fails — which is
 * the point of seeding through the browser rather than mocking the module.
 */
async function seedInbox(pubkey: string, rows: unknown[]) {
  await page.evaluate(
    ([key, value]) => localStorage.setItem(key as string, value as string),
    [`imani-wallet:notifications:${pubkey}`, JSON.stringify(rows)] as const,
  )
}

function notification(id: string, title: string, readAt: number | null = null) {
  return {
    id,
    type: 'voucher_received',
    title,
    body: 'A coupon arrived in your wallet.',
    url: '/receive',
    receivedAt: Date.now() - 60_000,
    readAt,
  }
}


/**
 * Wait for the wallet to finish booting, then open the bell.
 *
 * A fixed `waitForTimeout` after navigation was the source of a real flake:
 * three consecutive runs scored 22, 8 and 18 checks. Boot does relay work
 * whose duration is not fixed, so any constant is either too short sometimes
 * or wasted always. Waiting for the bell ITSELF is the honest condition —
 * it only renders once the authed app has mounted.
 */
async function openBell(): Promise<void> {
  const bell = page.locator('summary[aria-label^="Notifications"]')
  await bell.waitFor({ state: 'visible', timeout: 30_000 })
  await bell.click()
  // The panel is a <details>; give it the frame it needs to paint.
  await page.locator('nav').first().waitFor({ state: 'visible', timeout: 10_000 })
}

async function main() {
  browser = await chromium.launch()
  const context = await browser.newContext()
  page = await context.newPage()

  const consoleErrors: string[] = []
  page.on('pageerror', (e) => consoleErrors.push(e.message))

  console.log('\nRegistering a customer…')
  const pubkey = await registerCustomer(page, BASE)
  console.log(`  customer ${pubkey.slice(0, 12)}…\n`)

  // ── REQUIREMENT: a notification icon in the header ──────────────────
  console.log('The bell')
  await goto(page, BASE)

  const bell = page.locator('summary[aria-label^="Notifications"]')
  // The first check is also the boot wait: if the bell never appears, this
  // fails as "bell is in the shipped header", which is the truth.
  await bell.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {})
  // Report what the page DID show when the bell is missing. A bare 30s
  // timeout says only that something was slow; the failing runs here turned
  // out to be the wallet not finishing its boot at all, which this names.
  if ((await bell.count()) === 0) {
    const shown = (await page.locator('body').innerText()).slice(0, 200)
    console.log(`  (no bell at ${page.url()} — page shows: ${JSON.stringify(shown)})`)
  }
  check('bell is in the shipped header', (await bell.count()) === 1)

  // ── REQUIREMENT: it shows there is something new ────────────────────
  check(
    'no unread marker when the inbox is empty',
    (await bell.getAttribute('aria-label')) === 'Notifications',
  )

  await seedInbox(pubkey, [notification('e2e-1', 'First coupon'), notification('e2e-2', 'Second coupon')])
  await goto(page, BASE)
  await page.locator('summary[aria-label^="Notifications"]').waitFor({ state: 'visible', timeout: 30_000 })
  check(
    'unread count reaches a screen reader',
    (await page.locator('summary[aria-label="Notifications, 2 unread"]').count()) === 1,
  )

  // ── REQUIREMENT: clicking the icon shows recent notifications ───────
  // The interaction no unit test could run: jsdom has no <details> disclosure.
  await page.locator('summary[aria-label^="Notifications"]').click()
  await page.waitForTimeout(400)

  const panelOpen = await page.evaluate(() => {
    const d = document.querySelector('summary[aria-label^="Notifications"]')?.closest('details')
    return d?.hasAttribute('open') ?? false
  })
  check('clicking the bell opens the panel', panelOpen)
  check('the panel lists what arrived', await page.getByText('First coupon').isVisible())
  check('and lists all of it', await page.getByText('Second coupon').isVisible())

  // ── REQUIREMENT: mark them as read individually ─────────────────────
  await page.getByRole('button', { name: /First coupon/ }).click()
  await page.waitForTimeout(600)

  check(
    'opening one marks that one read',
    (await page.locator('summary[aria-label="Notifications, 1 unread"]').count()) === 1,
  )
  check('and routes to what it was about', page.url().endsWith('/receive'))

  // The read state has to survive a reload, or "read" means nothing.
  await goto(page, BASE)
  await page.locator('summary[aria-label^="Notifications"]').waitFor({ state: 'visible', timeout: 30_000 })
  check(
    'read state survives a reload',
    (await page.locator('summary[aria-label="Notifications, 1 unread"]').count()) === 1,
  )

  // ── REQUIREMENT: mark them as read collectively ─────────────────────
  await openBell()
  await page.getByRole('button', { name: /mark all read/i }).click()
  await page.waitForTimeout(500)

  check(
    'mark all read clears every unread',
    (await page.locator('summary[aria-label="Notifications"]').count()) === 1,
  )
  check(
    'and mark-all disappears once there is nothing to mark',
    (await page.getByRole('button', { name: /mark all read/i }).count()) === 0,
  )

  await goto(page, BASE)
  await page.locator('summary[aria-label^="Notifications"]').waitFor({ state: 'visible', timeout: 30_000 })
  check(
    'mark-all survives a reload too',
    (await page.locator('summary[aria-label="Notifications"]').count()) === 1,
  )

  // ── REQUIREMENT: an empty inbox says what will appear ───────────────
  await seedInbox(pubkey, [])
  await goto(page, BASE)
  await openBell()
  check(
    'empty state says what WILL appear here',
    await page.getByText(/coupons you receive/i).isVisible(),
  )

  // ── REQUIREMENT: settings to choose what notifies ───────────────────
  console.log('\nSettings')
  await goto(page, `${BASE}/settings`)
  await page.waitForTimeout(600)

  const row = page.getByRole('link', { name: /Notifications/ })
  check('Settings offers a Notifications row', (await row.count()) >= 1)

  await row.first().click()
  await page.waitForTimeout(900)
  check('the row leads to the notification settings', page.url().includes('/settings/notifications'))
  check(
    'the page renders rather than throwing',
    await page.getByRole('heading', { name: 'Notifications' }).isVisible(),
  )

  // Headless Chromium reports notification permission as "denied" by default,
  // so what must be shown is the honest blocked state, not a dead switch.
  const bodyText = (await page.locator('body').innerText()).toLowerCase()
  check(
    'it explains itself rather than showing a control that cannot work',
    bodyText.includes('turn on notifications') || bodyText.includes('blocked'),
    bodyText.slice(0, 120),
  )
  check(
    'it says the in-app toast keeps working regardless',
    bodyText.includes('while the app is open'),
  )

  // ── REQUIREMENT: apple-design on the new components ─────────────────
  // Claimed in review; checked here rather than by reading class names,
  // because a token can be present and still not apply.
  console.log('\nCraft')
  await goto(page, BASE)
  const target = page.locator('summary[aria-label^="Notifications"]')
  await target.waitFor({ state: 'visible', timeout: 30_000 })
  const box = await target.boundingBox()
  check(
    'the bell is a 44px touch target',
    (box?.width ?? 0) >= 44 && (box?.height ?? 0) >= 44,
    `${Math.round(box?.width ?? 0)}x${Math.round(box?.height ?? 0)}`,
  )

  await openBell()
  const material = await page
    .locator('nav')
    .first()
    .evaluate((el) => getComputedStyle(el).backdropFilter)
  check(
    'the panel is a translucent material, not an opaque slab',
    material !== 'none' && material.includes('blur'),
    material,
  )

  // ── REQUIREMENT: the PWA pieces push depends on ─────────────────────
  console.log('\nDelivery')

  // Let the SPA settle first. The checks above click the bell, which routes,
  // and everything below talks to the page (service worker registration in
  // particular). Starting that work mid-navigation is what made this section
  // flaky.
  await page.waitForLoadState('networkidle').catch(() => {})
  // Read the href in the page (that is the thing under test: the document
  // really does declare a manifest) but fetch it OUT of the page.
  //
  // An in-page fetch() here was flaky, and the reason is this step's position:
  // the checks above click the bell, which routes the SPA, and a fetch issued
  // while a navigation is in flight is aborted — surfacing as a bare
  // "TypeError: Failed to fetch" that says nothing about manifests. Playwright's
  // request context does not share the page's lifetime, so it cannot lose that
  // race.
  const manifestHref = await page.evaluate(
    () => document.querySelector('link[rel="manifest"]')?.getAttribute('href') ?? null,
  )
  const manifest = manifestHref
    ? await page.request
        .get(new URL(manifestHref, BASE).href)
        .then((r) => (r.ok() ? r.json() : null))
        .catch(() => null)
    : null
  check('the app is installable (iOS grants Push only to an installed PWA)', manifest !== null)
  check('the manifest is standalone', manifest?.display === 'standalone')

  const swScope = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' })
    await navigator.serviceWorker.ready
    return reg.scope
  })
  check('the service worker controls the whole origin', swScope.endsWith('/'))

  check('no uncaught page errors throughout', consoleErrors.length === 0, consoleErrors[0])

  console.log(
    failures.length === 0
      ? `\nAll checks passed.\n`
      : `\n${failures.length} FAILED:\n${failures.map((f) => `  - ${f}`).join('\n')}\n`,
  )
  await browser.close()
  process.exit(failures.length === 0 ? 0 : 1)
}

main().catch(async (e) => {
  console.error('\nHarness error:', e)
  await browser?.close()
  process.exit(2)
})
