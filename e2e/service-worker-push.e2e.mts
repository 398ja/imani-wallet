/**
 * Does sw.js behave correctly inside a REAL service worker?
 *
 *   npx tsx e2e/service-worker-push.e2e.mts     (needs the dev server on 5177)
 *
 * HEADED on purpose. Headless Chromium reports Notification.permission as
 * "denied" whatever you grant it — context permissions, a seeded profile
 * preference file, both — so every display assertion below fails for a harness
 * reason rather than a real one. Measured that twice before switching.
 *
 * The 25 unit tests read public/sw.js and evaluate it against a hand-built
 * scope whose `showNotification` is a vi.fn(). That proves the logic, and it
 * cannot prove the browser accepts the notification it builds: an invalid
 * option, a bad icon path or a malformed data object would pass the mock and
 * fail on a phone.
 *
 * CDP's ServiceWorker.deliverPushMessage delivers a genuine push event to a
 * genuinely installed worker, so what runs here is the real thing.
 */
import { chromium } from '@playwright/test'

const BASE = 'http://localhost:5177'
const failures: string[] = []
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(name)
}

// Headless Chromium reports notification permission as "denied" whatever you
// grant (the repo already knows this; see notifications.e2e.ts). Seed the
// profile's own preference file instead, which is what a user clicking
// "Allow" writes, then launch against that profile.
import { mkdirSync, writeFileSync } from 'node:fs'
const PROFILE = '/tmp/sw-real-profile'
mkdirSync(`${PROFILE}/Default`, { recursive: true })
writeFileSync(
  `${PROFILE}/Default/Preferences`,
  JSON.stringify({
    profile: {
      content_settings: {
        exceptions: {
          notifications: { [`${BASE},*`]: { setting: 1, last_modified: String(Date.now() * 1000) } },
        },
      },
    },
  }),
)

const ctx = await chromium.launchPersistentContext(PROFILE, {
  // HEADED. Headless Chromium refuses notification permission whatever you
  // grant, so the display checks below can only run in a real window.
  headless: false,
  args: ['--no-first-run'],
  permissions: ['notifications'],
})
// Awaited, and granted at the CONTEXT. A fire-and-forget grant raced the first
// navigation, leaving Notification.permission "denied" — which made every
// display check fail for a harness reason rather than a real one.
await ctx.grantPermissions(['notifications'], { origin: BASE })
const page = ctx.pages()[0] ?? (await ctx.newPage())
await page.goto(BASE, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => (document.getElementById('root')?.children.length ?? 0) > 0, undefined, { timeout: 15_000 })

const scope = await page.evaluate(async () => {
  const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' })
  await navigator.serviceWorker.ready
  return reg.scope
})
check('a real service worker installs and controls the origin', scope.endsWith('/'), scope)

const perm = await page.evaluate(() => Notification.permission)
check('notifications are permitted in this browser', perm === 'granted', perm)

// Collect what the worker posts to the page, which is how the bell fills.
await page.evaluate(() => {
  ;(window as unknown as { __pushes: unknown[] }).__pushes = []
  navigator.serviceWorker.addEventListener('message', (e) => {
    ;(window as unknown as { __pushes: unknown[] }).__pushes.push(e.data)
  })
})

const client = await ctx.newCDPSession(page)

// registrationId is not exposed to JS. CDP announces it on
// ServiceWorker.workerVersionUpdated, so listen BEFORE enabling.
let registrationId = ''
client.on('ServiceWorker.workerVersionUpdated', (e: { versions?: Array<{ registrationId?: string; status?: string }> }) => {
  for (const v of e.versions ?? []) {
    if (v.registrationId && (v.status === 'activated' || !registrationId)) registrationId = v.registrationId
  }
})
await client.send('ServiceWorker.enable')
for (let i = 0; i < 40 && !registrationId; i++) await page.waitForTimeout(100)
check('CDP reports a registration id for the installed worker', registrationId !== '', registrationId)

const delivered = await client
  .send('ServiceWorker.deliverPushMessage', {
    origin: BASE,
    registrationId,
    data: JSON.stringify({
      type: 'voucher_claimed',
      title: 'Coupon claimed',
      body: 'A coupon you sent was claimed.',
      data: { url: '/merchant/transactions' },
    }),
  })
  .then(() => 'ok')
  .catch((e: Error) => e.message)
check('the browser accepted a real push event', delivered === 'ok', String(delivered).slice(0, 90))

await page.waitForTimeout(1500)
const pushes = await page.evaluate(() => (window as unknown as { __pushes: unknown[] }).__pushes)
check('the worker told the page about the push', Array.isArray(pushes) && pushes.length > 0, JSON.stringify(pushes).slice(0, 120))

// Did the BROWSER actually display one? This is the half the unit tests
// cannot reach: showNotification is a vi.fn() there, so an option Chrome
// rejects would pass the mock and fail on a phone.
const shown = await page.evaluate(async () => {
  const reg = await navigator.serviceWorker.getRegistration()
  const list = (await reg?.getNotifications()) ?? []
  return list.map((n) => ({
    title: n.title,
    body: n.body,
    tag: n.tag,
    url: (n.data as { url?: string } | undefined)?.url,
    type: (n.data as { type?: string } | undefined)?.type,
  }))
})
check('the browser really displayed a notification', shown.length > 0, JSON.stringify(shown[0] ?? {}))
check('with the title sw.js built', shown[0]?.title === 'Coupon claimed', shown[0]?.title)
check('and the sanitised route, not the raw payload url', shown[0]?.url === '/merchant/transactions', shown[0]?.url)
check('tagged so a burst collapses', shown[0]?.tag === 'imani-voucher_claimed', shown[0]?.tag)

// And the security property, against a real browser rather than a harness.
await client.send('ServiceWorker.deliverPushMessage', {
  origin: BASE,
  registrationId,
  data: JSON.stringify({ type: 'voucher_received', data: { url: '/\\evil.example/steal' } }),
})
await page.waitForTimeout(1200)
const after = await page.evaluate(async () => {
  const reg = await navigator.serviceWorker.getRegistration()
  const list = (await reg?.getNotifications()) ?? []
  return list.map((n) => (n.data as { url?: string } | undefined)?.url)
})
const escaped = after.filter((u) => {
  try { return new URL(String(u), 'https://wallet.example').origin !== 'https://wallet.example' } catch { return true }
})
check('a backslash url cannot escape the origin, in a real browser', escaped.length === 0, JSON.stringify(after))

// ── Does TAPPING it actually navigate, and only within the origin? ──
//
// The unit test asserts openWindow was CALLED with '/receive' on a mock. That
// proves intent, not that a browser goes anywhere. Playwright exposes the real
// worker, so dispatch a genuine notificationclick INSIDE it and watch where
// the page lands.
const [worker] = ctx.serviceWorkers()
check('playwright sees the real service worker', !!worker, worker?.url() ?? 'none')

// Park the page somewhere else first, so a navigation is observable.
await page.goto(`${BASE}/settings`, { waitUntil: 'domcontentloaded' })

// A hostile payload: this is the open redirect, dispatched through the click
// path rather than the push path, because the click handler sanitises
// separately (event.notification.data.url is attacker-influenced too).
// Passed as a STRING, not a function. tsx compiles arrow functions through
// esbuild, which injects a `__name` helper that does not exist inside a
// service worker, so the function form dies with "__name is not defined".
await worker.evaluate(
  "(async () => {" +
    "const ev = new Event('notificationclick');" +
    "ev.notification = { data: { url: '/\\\\evil.example/steal', type: 'voucher_received' }, close: function () {} };" +
    "ev.waitUntil = function (p) { void p; };" +
    "self.dispatchEvent(ev);" +
    "await new Promise(function (r) { setTimeout(r, 400); });" +
  "})()",
)

await page.waitForTimeout(1200)
const url = page.url()
check(
  'a tapped notification never leaves the origin',
  new URL(url).origin === BASE,
  url,
)
// The worker navigates to the sanitised '/receive'; a logged-out wallet then
// redirects that to '/onboarding' (verified: /receive -> /onboarding when no
// session). Either is correct here. What would NOT be correct is evil.example,
// and the origin check above is what rules that out.
//
// Be honest about what this pair does and does not prove. Measured by putting
// the OLD vulnerable walletRoute back: these two still passed. The reason is
// that this path reaches `client.navigate()`, which the browser itself refuses
// cross-origin, and sw.js swallows that rejection — so the page stays put
// whether or not the sanitiser works. Real defence in depth, and a blunt test.
//
// The sanitiser is what guards the OTHER branch, `clients.openWindow()`, taken
// when no wallet window is open; that one the browser will happily follow
// anywhere. The check below covers it, and it DOES fail against the old code.
check(
  'and a hostile url lands on a wallet route, not the attacker one',
  ['/receive', '/onboarding'].includes(new URL(url).pathname),
  new URL(url).pathname,
)

// The unprotected branch: no window open, so the worker calls openWindow(),
// which is NOT origin-restricted. What it receives is the url the push handler
// stored on the notification, so that value is the thing worth checking.
// Read what the worker ACTUALLY stored on the notifications it built for those
// payloads — that value is what openWindow would receive.
const storedUrls = await page.evaluate(async () => {
  const reg = await navigator.serviceWorker.getRegistration()
  const list = (await reg?.getNotifications()) ?? []
  return list.map((n) => (n.data as { url?: string } | undefined)?.url)
})
const leaks = storedUrls.filter((u) => {
  try {
    return new URL(String(u), 'https://wallet.example').origin !== 'https://wallet.example'
  } catch {
    return true
  }
})
check(
  'nothing openWindow could receive points off-origin',
  leaks.length === 0,
  JSON.stringify(storedUrls),
)

console.log(failures.length ? `\n${failures.length} FAILED` : '\nAll checks passed.')
await ctx.close()
process.exit(failures.length ? 1 : 0)
