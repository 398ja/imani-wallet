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
  await page.waitForTimeout(800)

  const bell = page.locator('summary[aria-label^="Notifications"]')
  check('bell is in the shipped header', (await bell.count()) === 1)

  // ── REQUIREMENT: it shows there is something new ────────────────────
  check(
    'no unread marker when the inbox is empty',
    (await bell.getAttribute('aria-label')) === 'Notifications',
  )

  await seedInbox(pubkey, [notification('e2e-1', 'First coupon'), notification('e2e-2', 'Second coupon')])
  await goto(page, BASE)
  await page.waitForTimeout(800)
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
  await page.waitForTimeout(800)
  check(
    'read state survives a reload',
    (await page.locator('summary[aria-label="Notifications, 1 unread"]').count()) === 1,
  )

  // ── REQUIREMENT: mark them as read collectively ─────────────────────
  await page.locator('summary[aria-label^="Notifications"]').click()
  await page.waitForTimeout(300)
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
  await page.waitForTimeout(800)
  check(
    'mark-all survives a reload too',
    (await page.locator('summary[aria-label="Notifications"]').count()) === 1,
  )

  // ── REQUIREMENT: an empty inbox says what will appear ───────────────
  await seedInbox(pubkey, [])
  await goto(page, BASE)
  await page.waitForTimeout(800)
  await page.locator('summary[aria-label^="Notifications"]').click()
  await page.waitForTimeout(300)
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

  // ── REQUIREMENT: the PWA pieces push depends on ─────────────────────
  console.log('\nDelivery')
  const manifest = await page.evaluate(async () => {
    const link = document.querySelector('link[rel="manifest"]')
    if (!link) return null
    return fetch(link.getAttribute('href')!).then((r) => (r.ok ? r.json() : null))
  })
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
