/**
 * The LOCAL DEPLOYMENT (deploy/subscription-local) driven like a stall would, against REAL Stripe
 * test mode and STAGING gateway-customer (#411):
 *
 *   ./deploy/subscription-local/up.sh          # the site + service on http://localhost:18910
 *   npx tsx --tsconfig tsconfig.services.json e2e/subscription-local.e2e.ts
 *
 * A fresh stall publishes its stall record to staging (so the service sees a merchant), then its
 * "wallet" tab (the wallet's REAL `openSisterSite`, bundled, over an unlocked session) taps Upgrade.
 * The site opens in a new tab on its own origin, signed in by the wallet with no login page; Basic
 * monthly is paid on Stripe's hosted Checkout with the 4242 test card; the forwarded invoice.paid
 * mints through staging; the licence in the stall's staging inbox is verified with the wallet's
 * own code.
 */
import { createServer } from 'node:http'
import { join } from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import WebSocket from 'ws'
import { finalizeEvent, generateSecretKey, getPublicKey, nip17, nip19, SimplePool } from 'nostr-tools'

import { BUNDLED_CATALOG, entitlementOf, verifyLicence } from '../packages/licence/src/index.ts'
import { licenceOf } from '../packages/licence/src/read.ts'
import { parseVoucherToken, verifyVoucher } from '../src/lib/voucherToken.ts'

/** The site (the subscription-local container). Its own origin, as subscription.imani.casa is. */
const SITE = process.env.SUB_ORIGIN ?? 'http://localhost:18910'
/** A stand-in wallet origin on this machine. The container must be built with this VITE_WALLET_ORIGIN. */
const WALLET_PORT = Number(process.env.WALLET_PORT ?? 18924)
const WALLET_ORIGIN = `http://127.0.0.1:${WALLET_PORT}`
const GATEWAY = process.env.GATEWAY ?? 'https://wallet.staging.398ja.xyz'
const RELAY = process.env.RELAY ?? 'wss://relay.staging.398ja.xyz'
const SELLER = '62dd912f098cb439e97e0bfe3e6513b27b0cecc9f262a1778635c6fe18545c01'
const sk = generateSecretKey()
const stall = getPublicKey(sk)

const results: Array<[string, boolean]> = []
const check = (name: string, ok: boolean, detail = '') => {
  results.push([name, ok])
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `  (${detail})` : ''}`)
}

/**
 * Publish the stall's signed merchant record to staging's RELAY, the way the wallet's Become-a-stall
 * does (`relay.publish`), and wait until the gateway's query (what the service reads the role from)
 * finds it by author.
 *
 * Not `POST /api/v1/nostr/events`: on staging (2026-10-28) an event mirrored that way is stored and
 * shows up in a kind/`#d` query, but NEVER in an `authors` query (watched for 7 minutes), so the
 * service could not see the stall. Relay-published events are found by author within a second.
 */
async function publishStallRecord(): Promise<boolean> {
  const record = finalizeEvent(
    { kind: 30078, created_at: Math.floor(Date.now() / 1000), tags: [['d', 'imani:merchant']], content: JSON.stringify({ active: true, issuanceCurrency: 'GBP' }) },
    sk,
  )
  ;(globalThis as { WebSocket?: unknown }).WebSocket ??= WebSocket
  const pool = new SimplePool()
  try {
    await Promise.any(pool.publish([RELAY], record))
  } finally {
    pool.close([RELAY])
  }
  for (let i = 0; i < 20; i++) {
    const r = await fetch(`${GATEWAY}/api/v1/nostr/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kinds: [30078], authors: [stall], tags: { '#d': ['imani:merchant'] }, limit: 5 }),
    })
    const events = ((await r.json()) as { events?: Array<{ id: string }> }).events ?? []
    if (events.some((e) => e.id === record.id)) return true
    await new Promise((res) => setTimeout(res, 1000))
  }
  return false
}

async function fillStripe(page: import('playwright').Page) {
  await page.waitForURL(/checkout\.stripe\.com/, { timeout: 30_000 })
  await page.locator('#email').fill(`stall-${stall.slice(0, 8)}@example.com`)
  await page.locator('#cardNumber').fill('4242424242424242')
  await page.locator('#cardExpiry').fill('12 / 34')
  await page.locator('#cardCvc').fill('123')
  await page.locator('#billingName').fill('Test Stall')
  const country = page.locator('#billingCountry')
  if (await country.count()) await country.selectOption('GB')
  const postal = page.locator('#billingPostalCode')
  if (await postal.isVisible().catch(() => false)) await postal.fill('SW1A 1AA')
  for (const id of ['#billingAddressLine1', '#billingLocality']) {
    const f = page.locator(id)
    if (await f.isVisible().catch(() => false)) await f.fill(id.includes('Line1') ? '1 Test Street' : 'London')
  }
  await page.locator('button[type=submit], .SubmitButton').first().click()
}

async function inbox(): Promise<unknown[]> {
  const r = await fetch(`${GATEWAY}/api/v1/nostr/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kinds: [1059], pTags: [stall], limit: 10 }),
  })
  return ((await r.json()) as { events?: unknown[] }).events ?? []
}

/** The wallet's real sister-site code over an unlocked session (see e2e/subscription.e2e.ts). */
async function walletServer() {
  const out = await build({
    stdin: { contents: `import { openSisterSite } from './src/lib/sisterSiteSigner.ts'; window.__open = (u) => openSisterSite(u, 'imani-subscription')`, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    write: false,
    define: { 'import.meta.env.VITE_SUBSCRIPTION_SITE_URL': JSON.stringify(SITE), 'import.meta.env.VITE_GIFTING_SITE_URL': JSON.stringify('http://localhost:1') },
    plugins: [
      {
        name: 'unlocked-wallet-session',
        setup(b) {
          b.onResolve({ filter: /^\.\/nap$/ }, () => ({ path: 'nap-stub', namespace: 'stub' }))
          b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
            resolveDir: join(process.cwd(), 'src/lib'),
            loader: 'ts',
            contents: `import { createWalletSigner } from './signer'
              const signer = createWalletSigner(new URLSearchParams(location.search).get('key'))
              const session = { getSession: () => ({ pubkey: signer.pubkey }), isLocked: () => false }
              export const getSigner = () => signer
              export const getSession = () => session`,
          }))
        },
      },
    ],
  })
  const bundle = out.outputFiles[0].text
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/wallet.js')) return void res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(bundle)
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cross-Origin-Opener-Policy': 'same-origin-allow-popups' })
    res.end('<!doctype html><body><button id="upgrade">Upgrade my plan</button><script type="module" src="/wallet.js"></script></body>')
  })
  await new Promise<void>((r) => server.listen(WALLET_PORT, '127.0.0.1', r))
  return server
}

async function main() {
  const wallet = await walletServer()
  const browser = await chromium.launch()
  const context = await browser.newContext()
  // On failure, what the site said and logged: the service log alone cannot tell a refused handshake
  // from a page that never loaded.
  const logs: string[] = []
  context.on('page', (p) => {
    p.on('console', (m) => logs.push(`[${new URL(p.url() || 'about:blank').host}] ${m.type()}: ${m.text()}`))
    p.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
  })
  try {
    check('the stall record is on staging, found by author', await publishStallRecord())
    const walletPage = await context.newPage()
    await walletPage.goto(`${WALLET_ORIGIN}/?key=${Buffer.from(sk).toString('hex')}`)
    await walletPage.waitForFunction(() => typeof (window as unknown as { __open?: unknown }).__open === 'function')
    const [page] = await Promise.all([
      context.waitForEvent('page'),
      walletPage.evaluate(
        (url) =>
          new Promise<void>((resolve) => {
            const b = document.getElementById('upgrade')!
            b.addEventListener('click', () => {
              ;(window as unknown as { __open: (u: string) => boolean }).__open(url)
              resolve()
            })
            b.click()
          }),
        SITE,
      ),
    ])
    await page.getByRole('button', { name: 'Choose Basic' }).waitFor({ timeout: 30_000 })
    check('opened from the wallet, signed in with no login page', true)
    await page.getByRole('button', { name: 'Choose Basic' }).click()
    await fillStripe(page)
    check('real Stripe Checkout loaded and accepted the test card', true)
    await page.waitForURL(new RegExp(`${SITE.replace(/[/.:]/g, '\\$&')}/done`), { timeout: 60_000 })
    await page.getByText(/you are subscribed/i).waitFor({ timeout: 15_000 })
    check('Stripe returned to the site, still signed in', true)

    // The webhook mints through staging (about 10 s): wait for it, up to two minutes.
    let wraps: unknown[] = []
    for (let i = 0; i < 60 && !wraps.length; i++) {
      wraps = await inbox()
      if (!wraps.length) await page.waitForTimeout(2000)
    }
    check('the licence reached the stall inbox on staging', wraps.length > 0, String(wraps.length))
    if (wraps.length) {
      const rumor = nip17.unwrapEvent(wraps[0] as never, sk) as { content: string }
      const token = (JSON.parse(rumor.content) as { token: string }).token
      const v = parseVoucherToken(token).voucher
      const l = licenceOf(v as never)!
      const now = Math.floor(Date.now() / 1000) + 60
      const verdict = verifyLicence(l, { issuerPublicKey: v.issuerPublicKey, sellerPublicKey: SELLER, now, presenter: stall, verifySignature: () => verifyVoucher(v).signatureValid })
      check('it verifies for this stall, sold by the staging seller', verdict.granted)
      if (verdict.granted) {
        const e = entitlementOf({ catalog: BUNDLED_CATALOG, grants: [verdict.grant], currency: 'GBP', now })
        check('the wallet reads it as Basic: unlimited issuance, 3 tills', e.tier === 'basic' && e.terminals === 3 && e.sales === null, JSON.stringify(e))
      }
    }

    await page.getByRole('link', { name: 'See my plan' }).click()
    await page.getByText('Active').waitFor({ timeout: 15_000 })
    const account = await page.locator('body').innerText()
    check('account page: Basic, active, sent', /Basic/.test(account) && /Active/.test(account) && /Sent/.test(account), account.slice(0, 300))
    check('Stripe portal offered for the card subscription', await page.getByRole('button', { name: 'Card, invoices and cancellation' }).isVisible())
  } catch (e) {
    check('flow completed', false, String(e).slice(0, 300))
    for (const p of context.pages()) {
      console.log(`--- ${p.url()}\n${(await p.locator('body').innerText().catch(() => '')).slice(0, 600)}`)
    }
    if (logs.length) console.log(`--- console\n${logs.slice(-30).join('\n')}`)
  } finally {
    await browser.close()
    wallet.close()
  }
  console.log(`\nstall ${nip19.npubEncode(stall)}\n${results.filter(([, ok]) => ok).length}/${results.length} passed`)
  process.exit(results.every(([, ok]) => ok) ? 0 : 1)
}

void main()
