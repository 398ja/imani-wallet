/**
 * Local end-to-end for subscription.imani.casa, in a real browser.
 *
 *   npx vite build --config apps/subscription/vite.config.ts
 *   npx tsx e2e/subscription.e2e.ts
 *
 * Starts a fake gateway-customer + Stripe API on one port (the only external services), the REAL
 * subscription service serving the REAL built site on another, then drives Chromium:
 * sign in with a stall key, open checkout for Basic, "pay" (the fake fires a Stripe-signed
 * invoice.paid at the service, as Stripe would), and see the plan on the account page. The licence
 * the service minted is read back with the wallet's own reader and entitlement.
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools'

import { BUNDLED_CATALOG, entitlementOf, licenceOf } from '../packages/licence/src/index.ts'
import { stripeSignatureHeader } from '../services/subscription/stripe.ts'

const FAKE = 18901
const SITE = 18902
const ORIGIN = `http://localhost:${SITE}`
const WEBHOOK_SECRET = 'whsec_e2e'
const stallSk = generateSecretKey()
const stall = getPublicKey(stallSk)
const adminSk = generateSecretKey()
const admin = getPublicKey(adminSk)

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

const fake = createServer(async (req, res) => {
  const body = await readBody(req)
  const send = (status: number, obj: unknown) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(obj))
  if (req.url === '/v1/checkout/sessions') {
    const p = new URLSearchParams(body)
    pendingCheckout = { stall: p.get('metadata[stall_pubkey]') ?? '', tier: p.get('metadata[tier]') ?? '', term: p.get('metadata[term]') ?? '', tax: p.get('automatic_tax[enabled]') ?? '', pm: p.get('payment_method_types[0]') ?? '' }
    // "Checkout" is a page on the fake that, when visited, pays and returns to success_url.
    return send(200, { id: 'cs_e2e', url: `http://localhost:${FAKE}/pay?return=${encodeURIComponent(p.get('success_url') ?? '')}` })
  }
  if (req.url?.startsWith('/pay')) {
    const ret = new URL(req.url, 'http://x').searchParams.get('return') ?? ORIGIN
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
    const hook = await fetch(`${ORIGIN}/v1/stripe/webhook`, { method: 'POST', body: event, headers: { 'Stripe-Signature': stripeSignatureHeader(event, WEBHOOK_SECRET) } })
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

async function main() {
  await new Promise<void>((r) => fake.listen(FAKE, r))
  const dir = await mkdtemp(join(tmpdir(), 'sub-e2e-'))
  const service = spawn('npx', ['tsx', '--tsconfig', 'tsconfig.services.json', 'services/subscription/server.ts'], {
    env: {
      ...process.env,
      PORT: String(SITE),
      SUBSCRIPTION_PUBLIC_ORIGIN: ORIGIN,
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
  })
  service.stderr.on('data', (d) => process.stderr.write(`[service] ${d}`))
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${ORIGIN}/health`)).ok) break
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 200))
  }

  const browser = await chromium.launch()
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  try {
    await page.goto(`${ORIGIN}/plans`, { waitUntil: 'networkidle' })
    const plans = await page.locator('main').innerText()
    check('plans page lists Free, Basic and Pro from the catalog', /Free/.test(plans) && /Basic/.test(plans) && /Pro/.test(plans), plans.slice(0, 200))
    check('Basic says 1,000 a month and 3 tills', /£1,000 a month/.test(plans) && /plus 3 tills/.test(plans), plans.slice(0, 300))
    check('Pro lists API access and online shop', /API access/.test(plans) && /Online shop/.test(plans))

    await page.getByRole('button', { name: 'Choose Basic' }).click()
    await page.waitForURL(/sign-in/)
    check('buying while signed out goes to sign-in', page.url().includes('/sign-in'))
    await page.getByText('Use my secret key instead').click()
    await page.getByLabel('Stall secret key').fill(nip19.nsecEncode(stallSk))
    await page.getByRole('button', { name: 'Sign in' }).click()
    await page.waitForURL(/\/plans/)
    await page.waitForLoadState('networkidle')
    check('signed in as the stall', (await page.locator('header').first().innerText()).includes(nip19.npubEncode(stall).slice(0, 12)))

    await page.getByRole('button', { name: 'Choose Basic' }).click()
    await page.waitForURL(/\/done/, { timeout: 15_000 })
    check('checkout carried the stall key, tier, term, card only, tax on', pendingCheckout?.stall === stall && pendingCheckout?.tier === 'basic' && pendingCheckout?.term === 'monthly' && pendingCheckout?.pm === 'card' && pendingCheckout?.tax === 'true', JSON.stringify(pendingCheckout))
    check('back from checkout, the site says thank you', /you are subscribed/i.test(await page.locator('body').innerText()))

    check('exactly one licence minted and delivered to the stall', minted.length === 1 && delivered.length === 1 && delivered[0].recipient_pubkey === stall, `${minted.length}/${delivered.length}`)
    const exp = Number(delivered[0]?.expires_at)
    const licence = licenceOf({ issuerPublicKey: 'g', issuerSignature: 's', merchantMetadata: String(delivered[0]?.token), expiresAt: exp } as never)
    const ent = licence && entitlementOf({ catalog: BUNDLED_CATALOG, grants: [{ features: licence.features ?? [], expiresAt: exp, pilot: false, tier: licence.tier, validFrom: licence.validFrom }], currency: 'GBP', now: Math.floor(Date.now() / 1000) + 5 })
    check('the wallet reads it as Basic: 1,000/month, 3 tills', ent?.tier === 'basic' && ent.terminals === 3 && ent.sales?.amount === 100000, JSON.stringify(ent))

    await page.getByRole('link', { name: 'Sign in to see my plan' }).click()
    await page.getByText('Use my secret key instead').click()
    await page.getByLabel('Stall secret key').fill(nip19.nsecEncode(stallSk))
    await page.getByRole('button', { name: 'Sign in' }).click()
    await page.waitForURL(/\/account/)
    await page.getByText('Active').waitFor({ timeout: 10_000 })
    const account = await page.locator('body').innerText()
    check('account page shows Basic, active, sent to the wallet', /Basic/.test(account) && /Active/.test(account) && /Sent/.test(account), account.slice(0, 400))

    await page.getByRole('button', { name: 'Send my plan to my wallet again' }).click()
    await page.getByText(/Sent to your wallet again/).waitFor()
    check('re-send delivers again without a second mint', minted.length === 1 && delivered.length === 2)
    check('no admin link for a stall', !(await page.locator('header').first().innerText()).includes('Admin'))
    check('no uncaught page errors', errors.length === 0, errors.join('; '))
  } finally {
    await browser.close()
    service.kill()
    fake.close()
  }
  const failed = results.filter(([, ok]) => !ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  process.exit(failed.length ? 1 : 0)
}

void main()
