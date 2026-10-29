/**
 * Local end-to-end for the subscription site (#411), in a real browser, across two real origins.
 *
 *   npx tsx --tsconfig tsconfig.services.json e2e/subscription.e2e.ts      (builds the site first)
 *
 * Two origins on this machine: the WALLET at http://127.0.0.1:<W> and the SUBSCRIPTION site at
 * http://localhost:<S> (different hosts, so different origins, as wallet.imani.casa and
 * subscription.imani.casa are). Starts:
 *
 * - a fake gateway-customer + Stripe API (the only external services), which also answers the
 *   public nostr query the service reads the merchant role from;
 * - the REAL subscription service, serving the REAL built site;
 * - a "wallet" page that runs the wallet's REAL `openSisterSite` (src/lib/sisterSiteSigner.ts) and
 *   signer policy, bundled with esbuild, over an unlocked wallet session (the only stand-in).
 *
 * Then drives Chromium: the stall taps Upgrade in its wallet, the site opens in a new tab and is
 * signed in with no login page and no passphrase; it buys Basic; the licence the service minted is
 * read back with the wallet's own reader. Also: opened directly (not from the wallet) the site asks
 * to be opened from the wallet; a customer key (no stall record) is refused; no page has a sign-in
 * route; the session cookie is HttpOnly.
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { chromium, type Page } from 'playwright'
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from 'nostr-tools'

import { BUNDLED_CATALOG, entitlementOf, licenceOf } from '../packages/licence/src/index.ts'
import { stripeSignatureHeader } from '../services/subscription/stripe.ts'

// Overridable: other local stacks (deploy/subscription-local on 18910) often hold the old numbers.
const FAKE = Number(process.env.E2E_FAKE_PORT ?? 18921)
const SITE = Number(process.env.E2E_SITE_PORT ?? 18922)
const WALLET = Number(process.env.E2E_WALLET_PORT ?? 18923)
const SITE_ORIGIN = `http://localhost:${SITE}`
const WALLET_ORIGIN = `http://127.0.0.1:${WALLET}`
const WEBHOOK_SECRET = 'whsec_e2e'
const stallSk = generateSecretKey()
const stall = getPublicKey(stallSk)
const customerSk = generateSecretKey()
const customer = getPublicKey(customerSk)
const admin = getPublicKey(generateSecretKey())

const delivered: Array<Record<string, unknown>> = []
const minted: Array<Record<string, unknown>> = []
let pendingCheckout: Record<string, string> | null = null

const results: Array<[string, boolean, string?]> = []
const check = (name: string, ok: boolean, detail?: string) => {
  results.push([name, ok, detail])
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? `  (${detail})` : ''}`)
}

const readBody = (req: import('node:http').IncomingMessage) =>
  new Promise<string>((res) => {
    let b = ''
    req.on('data', (c) => (b += c))
    req.on('end', () => res(b))
  })

/** The stall's own signed public merchant record, as the relay would hold it. */
const stallRecord = finalizeEvent(
  { kind: 30078, created_at: Math.floor(Date.now() / 1000), tags: [['d', 'imani:merchant']], content: JSON.stringify({ active: true, issuanceCurrency: 'GBP' }) },
  stallSk,
)

const fake = createServer(async (req, res) => {
  const body = await readBody(req)
  const send = (status: number, obj: unknown) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(obj))
  if (req.url === '/api/v1/nostr/query') {
    const q = JSON.parse(body) as { authors?: string[] }
    return send(200, { events: q.authors?.includes(stall) ? [stallRecord] : [] })
  }
  // GET /v1/prices/:id: the published plan, in GBP (www.imani.casa/pricing).
  const priceMatch = /^\/v1\/prices\/([A-Za-z0-9_]+)$/.exec(req.url ?? '')
  if (req.method === 'GET' && priceMatch) {
    const amounts: Record<string, [number, string]> = { price_basicM: [800, 'month'], price_basicA: [7000, 'year'], price_proM: [1100, 'month'] }
    const p = amounts[priceMatch[1]]
    if (!p) return send(404, { error: { message: 'No such price' } })
    return send(200, { id: priceMatch[1], unit_amount: p[0], currency: 'gbp', recurring: { interval: p[1] } })
  }
  if (req.url === '/v1/checkout/sessions') {
    const p = new URLSearchParams(body)
    pendingCheckout = {
      stall: p.get('metadata[stall_pubkey]') ?? '',
      tier: p.get('metadata[tier]') ?? '',
      term: p.get('metadata[term]') ?? '',
      tax: p.get('automatic_tax[enabled]') ?? '',
      pm: p.get('payment_method_types[0]') ?? '',
    }
    return send(200, { id: 'cs_e2e', url: `http://localhost:${FAKE}/pay?return=${encodeURIComponent(p.get('success_url') ?? '')}` })
  }
  if (req.url?.startsWith('/pay')) {
    const ret = new URL(req.url, 'http://x').searchParams.get('return') ?? SITE_ORIGIN
    const now = Math.floor(Date.now() / 1000)
    const event = JSON.stringify({
      type: 'invoice.paid',
      data: {
        object: {
          id: 'in_e2e_1',
          subscription: 'sub_e2e',
          customer: 'cus_e2e',
          amount_paid: 1500,
          currency: 'gbp',
          subscription_details: { metadata: { stall_pubkey: pendingCheckout?.stall, tier: pendingCheckout?.tier, term: pendingCheckout?.term } },
          lines: { data: [{ period: { start: now, end: now + 30 * 86_400 } }] },
        },
      },
    })
    const hook = await fetch(`${SITE_ORIGIN}/v1/stripe/webhook`, { method: 'POST', body: event, headers: { 'Stripe-Signature': stripeSignatureHeader(event, WEBHOOK_SECRET) } })
    check('the service accepted the signed invoice.paid', hook.status === 200, String(hook.status))
    res.writeHead(302, { Location: ret.replace('{CHECKOUT_SESSION_ID}', 'cs_e2e') }).end()
    return
  }
  if (req.url === '/api/v1/wallet/vouchers') {
    const b = JSON.parse(body) as Record<string, unknown>
    minted.push(b)
    return send(201, { voucher_id: `v${minted.length}`, status: 'ISSUED', token: JSON.stringify(b.merchant_metadata), memo: b.memo, face_value: b.face_value })
  }
  if (req.url === '/api/v1/dm/tokens/send') {
    delivered.push(JSON.parse(body) as Record<string, unknown>)
    return send(200, { event_id: 'e' })
  }
  send(404, { error: 'fake: no route ' + req.url })
})

/**
 * The wallet page: the wallet's real sister-site code, over an unlocked session for `sk`. `nap.ts`
 * is replaced by a tiny stand-in that holds a real `createWalletSigner` (the wallet's own signer).
 */
async function walletBundle(): Promise<string> {
  const entry = `
    import { openSisterSite } from './src/lib/sisterSiteSigner.ts'
    window.__open = (url) => openSisterSite(url, 'imani-subscription')
  `
  const out = await build({
    stdin: { contents: entry, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    write: false,
    define: {
      'import.meta.env.VITE_SUBSCRIPTION_SITE_URL': JSON.stringify(SITE_ORIGIN),
      'import.meta.env.VITE_GIFTING_SITE_URL': JSON.stringify('http://localhost:1'),
    },
    plugins: [
      {
        name: 'unlocked-wallet-session',
        setup(b) {
          b.onResolve({ filter: /^\.\/nap$/ }, () => ({ path: 'nap-stub', namespace: 'stub' }))
          b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
            resolveDir: join(process.cwd(), 'src/lib'),
            loader: 'ts',
            contents: `
              import { createWalletSigner } from './signer'
              const key = new URLSearchParams(location.search).get('key')
              const signer = createWalletSigner(key)
              let locked = new URLSearchParams(location.search).get('locked') === '1'
              window.__lock = (v) => { locked = v }
              const session = { getSession: () => ({ pubkey: signer.pubkey }), isLocked: () => locked }
              export const getSigner = () => signer
              export const getSession = () => session
            `,
          }))
        },
      },
    ],
  })
  return out.outputFiles[0].text
}

async function main() {
  // The site trusts exactly one wallet origin, baked in at build time (VITE_WALLET_ORIGIN), so it is
  // built here for THIS wallet origin rather than relying on a build lying around.
  const vite = spawn('npx', ['vite', 'build', '--config', 'apps/subscription/vite.config.ts', '--logLevel', 'warn'], {
    env: { ...process.env, VITE_WALLET_ORIGIN: WALLET_ORIGIN, SUBSCRIPTION_BASE: '/' },
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  if ((await new Promise<number | null>((r) => vite.on('exit', r))) !== 0) throw new Error('site build failed')

  await new Promise<void>((r) => fake.listen(FAKE, r))
  const bundle = await walletBundle()
  const wallet = createServer((req, res) => {
    if (req.url?.startsWith('/wallet.js')) {
      res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(bundle)
      return
    }
    // The wallet's real COOP (deploy/nginx.conf).
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cross-Origin-Opener-Policy': 'same-origin-allow-popups' })
    res.end('<!doctype html><body><button id="upgrade">Upgrade my plan</button><script type="module" src="/wallet.js"></script></body>')
  })
  await new Promise<void>((r) => wallet.listen(WALLET, '127.0.0.1', r))

  const dir = await mkdtemp(join(tmpdir(), 'sub-e2e-'))
  const service = spawn('npx', ['tsx', '--tsconfig', 'tsconfig.services.json', 'services/subscription/server.ts'], {
    env: {
      ...process.env,
      PORT: String(SITE),
      SUBSCRIPTION_PUBLIC_ORIGIN: SITE_ORIGIN,
      SUBSCRIPTION_BASE_PATH: '',
      SUBSCRIPTION_WALLET_URL: `http://localhost:${FAKE}`,
      STRIPE_API_BASE: `http://localhost:${FAKE}`,
      EDGE_SECRET: 'edge',
      IMANI_SUBSCRIPTIONS_SELLER_NSEC: nip19.nsecEncode(generateSecretKey()),
      STRIPE_SECRET_KEY: 'sk_test_e2e',
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      SUBSCRIPTION_PRICES: 'basic:monthly=price_basicM,basic:annual=price_basicA,pro:monthly=price_proM',
      SUBSCRIPTION_ADMIN_PUBKEYS: admin,
      SUBSCRIPTION_LEDGER_PATH: join(dir, 'ledger.json'),
      SUBSCRIPTION_CATALOG_PATH: 'services/subscription/catalog.json',
      SUBSCRIPTION_STATIC_DIR: 'apps/subscription/dist',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Its own process group, so `npx` -> `tsx` -> node all go when we stop it (a bare kill() left the
    // grandchild node holding the port after a failed run).
    detached: true,
  })
  const stopService = () => {
    try {
      if (service.pid) process.kill(-service.pid, 'SIGTERM')
    } catch {
      /* already gone */
    }
  }
  process.on('exit', stopService)
  process.on('uncaughtException', (e) => {
    console.error(e)
    stopService()
    process.exit(1)
  })
  process.on('unhandledRejection', (e) => {
    console.error(e)
    stopService()
    process.exit(1)
  })
  service.stderr.on('data', (d) => process.stderr.write(`[service] ${d}`))
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${SITE_ORIGIN}/health`)).ok) break
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 200))
  }

  const browser = await chromium.launch()
  const errors: string[] = []
  const watch = (p: Page) => p.on('pageerror', (e) => errors.push(`${new URL(p.url()).host}: ${e.message}`))

  /** The stall's wallet tab, unlocked, and the site tab it opens with the Upgrade tap. */
  async function openFromWallet(sk: Uint8Array, opts: { locked?: boolean } = {}) {
    const context = await browser.newContext()
    const walletPage = await context.newPage()
    watch(walletPage)
    const hex = Buffer.from(sk).toString('hex')
    await walletPage.goto(`${WALLET_ORIGIN}/settings/subscription?key=${hex}${opts.locked ? '&locked=1' : ''}`)
    await walletPage.waitForFunction(() => typeof (window as unknown as { __open?: unknown }).__open === 'function')
    const [site] = await Promise.all([
      context.waitForEvent('page'),
      // The real tap: openSisterSite runs inside the click, as SubscriptionPage's onClick does.
      walletPage.evaluate(
        (url) =>
          new Promise<void>((resolve) => {
            const button = document.getElementById('upgrade')!
            button.addEventListener('click', () => {
              ;(window as unknown as { __open: (u: string) => boolean }).__open(url)
              resolve()
            })
            button.click()
          }),
        SITE_ORIGIN,
      ),
    ])
    watch(site)
    return { context, walletPage, site }
  }

  try {
    // ---- 1. Opened directly, not from the wallet: no session, no login page, just the way in.
    {
      const context = await browser.newContext()
      const page = await context.newPage()
      watch(page)
      await page.goto(`${SITE_ORIGIN}/plans`, { waitUntil: 'load' })
      await page.getByText('Open this from your wallet').waitFor({ timeout: 10_000 }).catch(() => undefined)
      const text = await page.locator('body').innerText()
      check('opened directly, the site asks to be opened from the wallet', /Open this from your wallet/.test(text), text.slice(0, 200))
      check('and shows no plans or buy buttons without a session', !/Choose Basic/.test(text))
      await page.goto(`${SITE_ORIGIN}/sign-in`, { waitUntil: 'load' })
      await page.getByText('Open this from your wallet').waitFor({ timeout: 10_000 }).catch(() => undefined)
      check('there is no sign-in page: /sign-in is not a route', !/passphrase/i.test(await page.locator('body').innerText()))
      const me = await page.evaluate(async () => (await fetch('/v1/me')).status)
      check('the API refuses /v1/me without a session (401)', me === 401, String(me))
      await context.close()
    }

    // ---- 2. A customer key (no stall record), from its wallet: refused, with a sentence.
    {
      const { context, site } = await openFromWallet(customerSk)
      await site.getByText('Plans are for stalls').waitFor({ timeout: 15_000 })
      check('a customer is refused: "Plans are for stalls"', true)
      const cookies = await context.cookies(SITE_ORIGIN)
      check('and holds no session cookie', !cookies.some((c) => c.name === 'imani_subscription_session'), JSON.stringify(cookies))
      await context.close()
      void customer
    }

    // ---- 3. A locked wallet: the site says so, and does not sign in.
    {
      const { context, site } = await openFromWallet(stallSk, { locked: true })
      await site.getByText('Your wallet is locked').waitFor({ timeout: 15_000 })
      check('a locked wallet: the site says "Your wallet is locked"', true)
      await context.close()
    }

    // ---- 4. The stall, from its wallet: signed in, buys Basic, sees it on the account page.
    {
      const { context, walletPage, site } = await openFromWallet(stallSk)
      await site.getByRole('button', { name: 'Choose Basic' }).waitFor({ timeout: 15_000 })
      check('opened from the wallet, the site is signed in with no login page and no passphrase', true)
      check('the site is on its own origin, not the wallet’s', new URL(site.url()).origin === SITE_ORIGIN, site.url())
      const plans = await site.locator('main').innerText()
      check('plans list Starter, Basic and Pro, and no Town / BID partnership', /Starter/.test(plans) && /Basic/.test(plans) && /Pro/.test(plans) && !/Town|BID|Partner/.test(plans), plans.slice(0, 300))
      check('yearly by default: Basic £70/year, from the Stripe price', /£70\/year/.test(plans), plans.slice(0, 400))
      check('Basic: unlimited voucher issuance and 3 tills', /Unlimited voucher issuance/.test(plans) && /plus 3 tills/.test(plans), plans.slice(0, 400))
      await site.getByRole('radio', { name: /Monthly/ }).click()
      const monthly = await site.locator('main').innerText()
      check('monthly: Basic £8/month and Pro £11/month, in pounds', /£8\/month/.test(monthly) && /£11\/month/.test(monthly), monthly.slice(0, 400))

      const cookies = await context.cookies(SITE_ORIGIN)
      const session = cookies.find((c) => c.name === 'imani_subscription_session')
      check('the session is an HttpOnly, SameSite=Lax cookie', !!session && session.httpOnly && session.sameSite === 'Lax', JSON.stringify(session))
      check('script on the site cannot read it', !(await site.evaluate(() => document.cookie)).includes('imani_subscription_session'))
      check('the wallet tab is still open', !walletPage.isClosed())

      await site.getByRole('button', { name: 'Choose Basic' }).click()
      await site.waitForURL(/\/done/, { timeout: 15_000 })
      check(
        'checkout carried the stall key, tier, term, card only, tax on',
        pendingCheckout?.stall === stall && pendingCheckout?.tier === 'basic' && pendingCheckout?.term === 'monthly' && pendingCheckout?.pm === 'card' && pendingCheckout?.tax === 'true',
        JSON.stringify(pendingCheckout),
      )
      // A full page load back from Stripe: the app checks its session cookie, then renders /done.
      await site.getByText(/you are subscribed/i).waitFor({ timeout: 10_000 }).catch(() => undefined)
      check('back from Stripe the session survived: thank-you page, signed in', /you are subscribed/i.test(await site.locator('body').innerText()))
      check('exactly one licence minted and delivered to the stall', minted.length === 1 && delivered.length === 1 && delivered[0].recipient_pubkey === stall, `${minted.length}/${delivered.length}`)
      const exp = Number(delivered[0]?.expires_at)
      const licence = licenceOf({ issuerPublicKey: 'g', issuerSignature: 's', merchantMetadata: String(delivered[0]?.token), expiresAt: exp } as never)
      const ent =
        licence &&
        entitlementOf({
          catalog: BUNDLED_CATALOG,
          grants: [{ features: licence.features ?? [], expiresAt: exp, pilot: false, tier: licence.tier, validFrom: licence.validFrom }],
          currency: 'GBP',
          now: Math.floor(Date.now() / 1000) + 5,
        })
      check('the wallet reads it as Basic: unlimited issuance, 3 tills', ent?.tier === 'basic' && ent.terminals === 3 && ent.sales === null, JSON.stringify(ent))

      await site.getByRole('link', { name: 'See my plan' }).click()
      await site.getByText('Active').waitFor({ timeout: 10_000 })
      const account = await site.locator('body').innerText()
      check('account page shows Basic, active, sent to the wallet', /Basic/.test(account) && /Active/.test(account) && /Sent/.test(account), account.slice(0, 400))
      await site.getByRole('button', { name: 'Send my plan to my wallet again' }).click()
      await site.getByText(/Sent to your wallet again/).waitFor()
      check('re-send delivers again without a second mint', minted.length === 1 && delivered.length === 2)
      check('no admin link for a stall', !(await site.locator('header').first().innerText()).includes('Admin'))

      // A reload keeps the session (the cookie), no second sign-in needed.
      await site.reload({ waitUntil: 'load' })
      await site.getByText('Active').waitFor({ timeout: 10_000 })
      check('a reload keeps the session', true)

      // Signing out ends the session; the way back is the wallet.
      await site.getByRole('button', { name: 'Sign out' }).click()
      await site.getByText('Open this from your wallet').waitFor()
      const after = await site.evaluate(async () => (await fetch('/v1/me')).status)
      check('signing out ends the session on the service', after === 401, String(after))
      await context.close()
    }

    check('no uncaught page errors on either origin', errors.length === 0, errors.join('; '))
  } finally {
    await browser.close()
    stopService()
    fake.close()
    wallet.close()
  }
  const failed = results.filter(([, ok]) => !ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  process.exit(failed.length ? 1 : 0)
}

void main()
