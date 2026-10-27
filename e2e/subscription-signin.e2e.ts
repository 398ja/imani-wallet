/**
 * The subscription site's sign-in, every path and the ways it fails, in a real browser against the
 * real built site (mounted under /subscription) and the real service. Google is stubbed at the
 * network: its script (accounts.google.com/gsi/client) and the Drive files API, so the site's own
 * Drive code runs unmodified.
 *
 *   npx vite build --config apps/subscription/vite.config.ts   (with VITE_GOOGLE_CLIENT_ID set)
 *   npx tsx e2e/subscription-signin.e2e.ts
 */
import { spawn } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Page } from 'playwright'
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from 'nostr-tools'

import { walletBackupFile, walletKeyEnvelope, walletLocalStorage } from './walletKeyFixture.ts'

const SITE = 18903
const ORIGIN = `http://localhost:${SITE}`
const BASE = `${ORIGIN}/subscription`
const PASSPHRASE = 'correct horse battery'
const sk = generateSecretKey()
const stall = getPublicKey(sk)
const npub = nip19.npubEncode(stall)
const PROFILE = { name: 'Mama Njeri', nip05: 'njeri@imani.casa', picture: 'https://example.invalid/njeri.png' }

/** The gateway's profile read, answered with the stall's signed kind-0, as the wallet sees it. */
async function stubProfile(page: Page) {
  const kind0 = finalizeEvent({ kind: 0, created_at: Math.floor(Date.now() / 1000), tags: [], content: JSON.stringify(PROFILE) }, sk)
  await page.route('**/api/v1/nostr/query', async (r) => {
    const body = JSON.parse(r.request().postData() ?? '{}') as { kinds?: number[]; authors?: string[] }
    const hit = body.kinds?.includes(0) && (!body.authors || body.authors.includes(stall))
    await r.fulfill({ json: { events: hit ? [kind0] : [] } })
  })
  await page.route('https://example.invalid/**', (r) => r.fulfill({ status: 404 }))
}

/** The header and sign-in show the wallet's identity row: name and NIP-05, never the npub. */
async function showsProfile(page: Page, where: 'header' | 'main') {
  const el = page.locator(where).first()
  await el.getByText(PROFILE.name).first().waitFor({ timeout: 10_000 }).catch(() => {})
  const t = await el.innerText()
  return { ok: t.includes(PROFILE.name) && /@njeri/.test(t) && !t.includes('npub1'), t }
}

const results: Array<[string, boolean]> = []
const check = (name: string, ok: boolean, detail = '') => {
  results.push([name, ok])
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `  (${detail})` : ''}`)
}

/** Stub Google Identity Services and Drive. `drive` decides what the account holds. */
async function stubGoogle(page: Page, drive: { file: string | null; grant: boolean }) {
  const seen = { scope: '', auth: '' }
  await page.route('https://accounts.google.com/gsi/client', (r) =>
    r.fulfill({
      contentType: 'text/javascript',
      body: `window.google = { accounts: { oauth2: { initTokenClient: (c) => { window.__gisScope = c.scope; return {
        requestAccessToken: () => ${drive.grant ? "c.callback({ access_token: 'tok-e2e' })" : 'c.error_callback()'} } } } } }`,
    }),
  )
  await page.route('https://www.googleapis.com/drive/v3/files**', (r) => {
    seen.auth = r.request().headers().authorization ?? ''
    const url = new URL(r.request().url())
    if (url.pathname.endsWith('/files')) {
      return r.fulfill({ json: { files: drive.file ? [{ id: 'f1' }] : [] }, headers: { 'Access-Control-Allow-Origin': '*' } })
    }
    return r.fulfill({ body: drive.file ?? '', headers: { 'Access-Control-Allow-Origin': '*' } })
  })
  return seen
}

const mainText = (page: Page) => page.locator('main').innerText()
const header = (page: Page) => page.locator('header').first().innerText()

async function signInPage(page: Page) {
  await page.goto(`${BASE}/sign-in?next=/account`, { waitUntil: 'networkidle' })
  await page.getByRole('heading', { name: 'Sign in with your wallet' }).waitFor()
}

async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'sub-signin-'))
  const service = spawn('npx', ['tsx', '--tsconfig', 'tsconfig.services.json', 'services/subscription/server.ts'], {
    env: {
      ...process.env,
      PORT: String(SITE),
      SUBSCRIPTION_PUBLIC_ORIGIN: ORIGIN,
      SUBSCRIPTION_BASE_PATH: '/subscription',
      SUBSCRIPTION_WALLET_URL: 'http://127.0.0.1:9',
      STRIPE_API_BASE: 'http://127.0.0.1:9',
      EDGE_SECRET: 'edge',
      IMANI_SUBSCRIPTIONS_SELLER_NSEC: nip19.nsecEncode(generateSecretKey()),
      STRIPE_SECRET_KEY: 'sk_test_e2e',
      STRIPE_WEBHOOK_SECRET: 'whsec_e2e',
      SUBSCRIPTION_PRICES: 'basic:monthly=price_basicM',
      SUBSCRIPTION_LEDGER_PATH: join(dir, 'ledger.json'),
      SUBSCRIPTION_CATALOG_PATH: 'services/subscription/catalog.json',
      SUBSCRIPTION_STATIC_DIR: 'apps/subscription/dist',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${ORIGIN}/health`)).ok) break
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 200))
  }

  const envelope = await walletKeyEnvelope(sk, PASSPHRASE)
  const backup = walletBackupFile(stall, envelope, 'Test Stall')
  const browser = await chromium.launch()
  const errors: string[] = []
  const fresh = async () => {
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    await stubProfile(page)
    page.on('pageerror', (e) => {
      errors.push(e.message)
      console.log(`  page error: ${e.message.slice(0, 300)}`)
    })
    return { ctx, page }
  }

  try {
    // Mount: the service only answers under /subscription, and serves the site's assets there.
    check('service: site served under /subscription', (await fetch(`${BASE}/plans`)).ok)
    check('service: API under /subscription/v1', (await fetch(`${BASE}/v1/catalog`)).ok)
    check('service: nothing outside the mount but /health', (await fetch(`${ORIGIN}/v1/catalog`)).status === 404)

    // No key anywhere: the site says so and offers only Drive and a file. No extension/bunker/nsec.
    {
      const { ctx, page } = await fresh()
      await signInPage(page)
      const t = await mainText(page)
      check('no key in browser: says it is not on this device', /not on this device/.test(t), t.slice(0, 200))
      check('offers Google Drive and a backup file', /Use my backup from Google Drive/.test(t) && /Use a backup file from this device/.test(t))
      check('no extension, bunker or secret-key sign-in', !/extension|bunker|nsec|secret key/i.test(t), t)
      check('no passphrase box until a key is found', (await page.getByLabel('Wallet passphrase').count()) === 0)
      await ctx.close()
    }

    // 1. The browser's own key (the wallet's localStorage on this origin).
    {
      const { ctx, page } = await fresh()
      await page.goto(`${ORIGIN}/health`)
      await page.evaluate((items) => {
        for (const [k, v] of Object.entries(items)) localStorage.setItem(k, v)
      }, walletLocalStorage(stall, envelope, 'Test Stall'))
      const before = await page.evaluate(() => localStorage.getItem('imani-wallet-key'))
      await signInPage(page)
      const shown = await showsProfile(page, 'main')
      check('browser key: shows the stall profile (name, NIP-05), no npub', shown.ok, shown.t.slice(0, 200))
      check('browser key: says where the key came from', /From your wallet on this device/i.test(shown.t))
      await page.getByLabel('Wallet passphrase').fill('nope')
      await page.getByRole('button', { name: 'Continue' }).click()
      await page.getByText('That passphrase does not open this key.').waitFor()
      check('browser key: wrong passphrase refused, still on sign-in', page.url().includes('/sign-in'))
      await page.getByLabel('Wallet passphrase').fill(PASSPHRASE)
      await page.getByRole('button', { name: 'Continue' }).click()
      await page.waitForURL((u) => u.pathname === '/subscription/account')
      await page.getByText(/plan/i).first().waitFor()
      const head = await showsProfile(page, 'header')
      check('browser key: signed in, header shows the profile not the npub, sent to ?next', head.ok, head.t)
      // The key the wallet wrote is unchanged (the shared profile cache may add its usual entries).
      const after = await page.evaluate(() => localStorage.getItem('imani-wallet-key'))
      check("browser key: the wallet's stored key is left untouched", before === after)
      check('signed-in API call accepted (NIP-98 under the mount)', !/Sign in/.test(await header(page)))
      await page.getByRole('button', { name: 'Sign out' }).click()
      check('sign out forgets the key', /Sign in/.test(await header(page)))
      await ctx.close()
    }

    // 2. Google Drive.
    {
      const { ctx, page } = await fresh()
      const seen = await stubGoogle(page, { file: backup, grant: true })
      await signInPage(page)
      await page.getByRole('button', { name: 'Use my backup from Google Drive' }).click()
      await page.getByText('From Google Drive', { exact: true }).waitFor()
      check('Drive: asks only for the app-data scope', (await page.evaluate(() => (window as unknown as { __gisScope: string }).__gisScope)) === 'https://www.googleapis.com/auth/drive.appdata')
      check('Drive: reads with the granted token', seen.auth === 'Bearer tok-e2e', seen.auth)
      await page.getByLabel('Wallet passphrase').fill(PASSPHRASE)
      await page.getByRole('button', { name: 'Continue' }).click()
      await page.waitForURL((u) => u.pathname === '/subscription/account')
      check('Drive: signed in as the stall', (await showsProfile(page, 'header')).ok)
      check('Drive: no key written to this browser', (await page.evaluate(() => localStorage.getItem('imani-wallet-key'))) === null)
      await ctx.close()
    }
    for (const [name, drive, msg] of [
      ['Drive: no backup in the account', { file: null, grant: true }, 'There is no Imani wallet backup in this Google account.'],
      ['Drive: Google sign-in cancelled', { file: backup, grant: false }, 'Google sign-in was cancelled.'],
    ] as const) {
      const { ctx, page } = await fresh()
      await stubGoogle(page, drive)
      await signInPage(page)
      await page.getByRole('button', { name: 'Use my backup from Google Drive' }).click()
      const ok = await page.getByText(msg).waitFor({ timeout: 5000 }).then(() => true, () => false)
      check(`${name}: says so plainly`, ok)
      await ctx.close()
    }

    // 3. A backup file, and the files it must refuse.
    const upload = async (page: Page, body: string) =>
      page.getByLabel('Wallet backup file').setInputFiles({ name: 'imani-wallet-backup.json', mimeType: 'application/json', buffer: Buffer.from(body) })
    {
      const { ctx, page } = await fresh()
      await signInPage(page)
      await upload(page, backup)
      await page.getByText('From your backup file', { exact: true }).waitFor()
      await page.getByLabel('Wallet passphrase').fill(PASSPHRASE)
      await page.getByRole('button', { name: 'Continue' }).click()
      await page.waitForURL((u) => u.pathname === '/subscription/account')
      check('file: signed in as the stall', (await showsProfile(page, 'header')).ok)
      await ctx.close()
    }
    const other = getPublicKey(generateSecretKey())
    for (const [name, body, msg] of [
      ['file: not JSON', 'hello', 'That file is not an Imani wallet backup.'],
      ['file: some other JSON', '{"format":"other"}', 'That file is not an Imani wallet backup.'],
      ['file: backup with no key', JSON.stringify({ format: 'imani-wallet-backup', version: 1 }), 'That backup is missing its key, or is damaged.'],
      ['file: key does not match the account it names', walletBackupFile(other, envelope, 'X'), 'This backup is damaged: its key does not match the account it names.'],
    ] as const) {
      const { ctx, page } = await fresh()
      await signInPage(page)
      await upload(page, body)
      if (name.includes('does not match')) {
        await page.getByLabel('Wallet passphrase').fill(PASSPHRASE)
        await page.getByRole('button', { name: 'Continue' }).click()
      }
      const ok = await page.getByText(msg).waitFor({ timeout: 5000 }).then(() => true, () => false)
      check(`${name}: refused plainly`, ok && page.url().includes('/sign-in'))
      await ctx.close()
    }

    check('no uncaught page errors', errors.length === 0, errors.join('; '))
  } finally {
    await browser.close()
    service.kill()
  }
  const failed = results.filter(([, ok]) => !ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  process.exit(failed.length ? 1 : 0)
}

void main()
