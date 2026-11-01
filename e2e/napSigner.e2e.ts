/**
 * The wallet's NAP signer popup, `/nap/signer` (#411, #410 G10), in a real browser, across two real
 * origins, behind the wallet's REAL nginx config.
 *
 *   npx tsx e2e/napSigner.e2e.ts          (builds the wallet into dist-e2e-signer/; SKIP_BUILD=1 reuses it)
 *
 * - the WALLET: this repo's production build (`vite build`, with the sister-site origins pointed at
 *   the relying origin below), served by `nginx:alpine` with `deploy/nginx.conf` itself, so the
 *   headers checked are the ones that ship;
 * - a RELYING site on another origin, playing gifting.imani.casa: a page that runs nap's real
 *   `connectCrossOrigin` from a click and then asks the grant to sign a login proof.
 *
 * Checks: the popup unlocks the stored key with the passphrase (a wrong one is refused in place),
 * asks once, returns a valid signature for the site's own audience, and refuses one for the
 * gateway. A remembered yes skips the question but never the passphrase. Opened by hand it answers
 * nobody. Its COOP is `unsafe-none` while the wallet's other pages keep `same-origin-allow-popups`.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { build } from 'esbuild'
import { chromium, type Page } from 'playwright'
import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools'
import { bytesToHex } from '@noble/hashes/utils'
import { createWebCryptoKeyStore } from '@imani/nap-client-web'

const WALLET_PORT = Number(process.env.E2E_WALLET_PORT ?? 18931)
const SITE_PORT = Number(process.env.E2E_SITE_PORT ?? 18932)
const WALLET_ORIGIN = `http://127.0.0.1:${WALLET_PORT}`
const SITE_ORIGIN = `http://localhost:${SITE_PORT}`
const CONTAINER = `nap-signer-e2e-${process.pid}`
const PASS = 'correct horse battery staple'
const sk = bytesToHex(generateSecretKey())
const pubkey = getPublicKey(Uint8Array.from(Buffer.from(sk, 'hex')))

const results: Array<[string, boolean]> = []
const check = (name: string, ok: boolean, detail = '') => {
  results.push([name, ok])
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `  (${detail})` : ''}`)
}

/** The relying page: nap's real connectCrossOrigin, bundled for the browser. */
async function relyingSite() {
  const out = await build({
    stdin: {
      contents: `
        import { connectCrossOrigin } from '@imani/nap-client-web'
        const log = (k, v) => { window.__log = window.__log || []; window.__log.push([k, v]) }
        window.__connect = (expectedPubkey) => {
          // Synchronous in the click, as the spec requires: the popup opens inside this call.
          const p = connectCrossOrigin({ keyOrigin: ${JSON.stringify(WALLET_ORIGIN)}, kinds: [27235], audiences: [location.origin], expectedPubkey })
          window.__grant = p.then((g) => { log('connected', g.info); return g }, (e) => { log('error', e.code || String(e)); throw e })
          window.__grant.catch(() => {})
        }
        window.__sign = async (u) => {
          const g = await window.__grant
          try {
            const ev = await g.signer.signEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), content: '', tags: [['u', u], ['method', 'POST'], ['challenge', 'c-' + Math.random()]] })
            return { ok: true, event: ev }
          } catch (e) { return { ok: false, code: e.code || String(e) } }
        }
        window.__disconnect = async () => (await window.__grant).disconnect()
      `,
      resolveDir: process.cwd(),
      loader: 'js',
    },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    write: false,
  })
  const js = out.outputFiles[0].text
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/site.js')) return void res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(js)
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cross-Origin-Opener-Policy': 'same-origin-allow-popups' })
    res.end('<!doctype html><body><button id="signin">Sign in with Imani wallet</button><script type="module" src="/site.js"></script></body>')
  })
  await new Promise<void>((r) => server.listen(SITE_PORT, 'localhost', r))
  return server
}

/** The wallet build behind deploy/nginx.conf, as the container ships it. */
function walletServer() {
  if (!process.env.SKIP_BUILD) {
    execFileSync('npx', ['vite', 'build', '--outDir', 'dist-e2e-signer', '--emptyOutDir'], {
      stdio: 'inherit',
      env: { ...process.env, VITE_GIFTING_SITE_URL: SITE_ORIGIN, VITE_SUBSCRIPTION_SITE_URL: 'http://localhost:1' },
    })
  }
  execFileSync('docker', [
    'run', '-d', '--rm', '--name', CONTAINER, '-p', `127.0.0.1:${WALLET_PORT}:9546`,
    '-v', `${join(process.cwd(), 'dist-e2e-signer')}:/usr/share/nginx/html:ro`,
    '-v', `${join(process.cwd(), 'deploy/nginx.conf')}:/etc/nginx/conf.d/default.conf:ro`,
    'nginx:alpine',
  ])
}

async function headers(path: string) {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${WALLET_ORIGIN}${path}`)
      return r.headers
    } catch {
      await new Promise((res) => setTimeout(res, 200))
    }
  }
  throw new Error('wallet nginx did not come up')
}

/**
 * Put a passphrase-wrapped key in the wallet origin's storage, the way onboarding does: nap's own
 * WebCrypto store writes the envelope here in Node (same WebCrypto), and the page gets that exact
 * localStorage entry before any wallet script runs.
 */
async function seedKey(context: import('playwright').BrowserContext) {
  const mem = new Map<string, string>()
  const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) }
  await createWebCryptoKeyStore('imani-wallet-key', { storage }).save(sk, PASS)
  const entries = [...mem.entries()]
  await context.addInitScript(
    ({ origin, entries }) => {
      if (location.origin !== origin) return
      for (const [k, v] of entries) if (localStorage.getItem(k) === null) localStorage.setItem(k, v)
    },
    { origin: WALLET_ORIGIN, entries },
  )
}

async function openPopup(site: Page, expected?: string) {
  const [popup] = await Promise.all([
    site.context().waitForEvent('page'),
    site.evaluate((e) => {
      const b = document.getElementById('signin')!
      b.onclick = () => (window as unknown as { __connect: (e?: string) => void }).__connect(e)
      b.click()
    }, expected),
  ])
  await popup.waitForLoadState('domcontentloaded')
  return popup
}

const siteLog = (site: Page) => site.evaluate(() => (window as unknown as { __log?: Array<[string, unknown]> }).__log ?? [])

async function main() {
  const site = await relyingSite()
  walletServer()
  const browser = await chromium.launch()
  try {
    // Headers, from the real nginx config.
    const signerH = await headers('/nap/signer')
    const homeH = await headers('/')
    check('signer page: COOP unsafe-none (keeps window.opener)', signerH.get('cross-origin-opener-policy') === 'unsafe-none', String(signerH.get('cross-origin-opener-policy')))
    check('signer page: never framed', /frame-ancestors 'none'/.test(signerH.get('content-security-policy') ?? '') && signerH.get('x-frame-options') === 'DENY')
    check('rest of the wallet keeps COOP same-origin-allow-popups', homeH.get('cross-origin-opener-policy') === 'same-origin-allow-popups', String(homeH.get('cross-origin-opener-policy')))

    const context = await browser.newContext()
    await seedKey(context)
    const errors: string[] = []
    context.on('page', (p) => p.on('pageerror', (e) => errors.push(`${p.url()}: ${e.message}`)))

    const walletTab = await context.newPage()

    // Opened by hand: nobody to answer, and it says so.
    await walletTab.goto(`${WALLET_ORIGIN}/nap/signer`)
    await walletTab.getByText('Open it from the site you want to sign in to').waitFor({ timeout: 10_000 })
    check('opened by hand: says to open it from the site, answers nobody', true)

    const sitePage = await context.newPage()
    await sitePage.goto(SITE_ORIGIN)
    await sitePage.waitForFunction(() => typeof (window as unknown as { __connect?: unknown }).__connect === 'function')

    const popup = await openPopup(sitePage, pubkey)
    await popup.getByRole('heading', { name: 'Unlock your wallet' }).waitFor({ timeout: 15_000 })
    check('the popup asks for the passphrase, naming the site', (await popup.locator('body').innerText()).includes(new URL(SITE_ORIGIN).host))

    await popup.getByLabel('Passphrase').fill('wrong passphrase')
    await popup.getByRole('button', { name: 'Unlock' }).click()
    await popup.getByText('That passphrase is not right').waitFor({ timeout: 10_000 })
    check('a wrong passphrase is refused in the popup', (await siteLog(sitePage)).length === 0)

    await popup.getByLabel('Passphrase').fill(PASS)
    await popup.getByRole('button', { name: 'Unlock' }).click()
    await popup.getByRole('heading', { name: /Sign in to/ }).waitFor({ timeout: 15_000 })
    check('then asks whether the site may sign you in', true)
    await popup.getByRole('button', { name: 'Allow' }).click()
    await sitePage.waitForFunction(() => ((window as unknown as { __log?: unknown[] }).__log ?? []).length > 0, null, { timeout: 15_000 })
    const [kind, info] = (await siteLog(sitePage))[0]
    check('the site is connected as this stall', kind === 'connected' && (info as { pubkey: string }).pubkey === pubkey, JSON.stringify([kind, info]))

    const own = await sitePage.evaluate((u) => (window as unknown as { __sign: (u: string) => Promise<unknown> }).__sign(u), `${SITE_ORIGIN}/api/v1/auth/complete`) as { ok: boolean; event?: Parameters<typeof verifyEvent>[0] }
    check('a login proof for the site itself is signed, validly, by the stall', own.ok && !!own.event && verifyEvent(own.event) && own.event.pubkey === pubkey)
    const gw = await sitePage.evaluate((u) => (window as unknown as { __sign: (u: string) => Promise<unknown> }).__sign(u), `${WALLET_ORIGIN}/api/v1/auth/complete`) as { ok: boolean; code?: string }
    check('a proof for the wallet\'s own gateway is refused', !gw.ok && gw.code === 'REFUSED', JSON.stringify(gw))

    await sitePage.evaluate(() => (window as unknown as { __disconnect: () => Promise<void> }).__disconnect())
    await popup.waitForEvent('close', { timeout: 10_000 }).catch(() => {})

    // A second sign-in: the remembered yes skips the question, not the passphrase.
    await sitePage.reload()
    await sitePage.waitForFunction(() => typeof (window as unknown as { __connect?: unknown }).__connect === 'function')
    const again = await openPopup(sitePage)
    await again.getByRole('heading', { name: 'Unlock your wallet' }).waitFor({ timeout: 15_000 })
    await again.getByLabel('Passphrase').fill(PASS)
    await again.getByRole('button', { name: 'Unlock' }).click()
    await sitePage.waitForFunction(() => ((window as unknown as { __log?: unknown[] }).__log ?? []).length > 0, null, { timeout: 15_000 })
    const asked = await again.getByRole('heading', { name: /Sign in to/ }).isVisible().catch(() => false)
    check('next time: passphrase again, no second question', (await siteLog(sitePage))[0][0] === 'connected' && !asked)
    const stored = await walletTab.evaluate(() => localStorage.getItem('imani-wallet:nap-consent') ?? '')
    check('the remembered yes is under imani-wallet: (logout sweeps it) and holds no key', stored.includes(new URL(SITE_ORIGIN).origin) && !stored.includes(sk))

    check('no uncaught page errors', errors.length === 0, errors.join(' | '))
  } catch (e) {
    check('flow completed', false, String(e).slice(0, 400))
  } finally {
    await browser.close()
    site.close()
    spawnSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' })
  }
  const failed = results.filter(([, ok]) => !ok).length
  console.log(`\n${results.length - failed}/${results.length} passed`)
  process.exit(failed ? 1 : 0)
}

void main()
