/**
 * Screenshots of the gifting form (#410), against the built site and fake APIs.
 *
 *   npx vite build --config apps/gifting/vite.config.ts && npx tsx e2e/gifting-shots.ts <outDir> [label]
 *
 * Before/after shots for #410 live in docs/screenshots/410-rework.
 * Two stalls: `alice` (cards only) and `olive` (cards plus an online shop with checkout codes).
 */
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { chromium } from 'playwright'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools'

const PORT = 18931
const ORIGIN = `http://localhost:${PORT}`
const DIST = 'apps/gifting/dist'
const [outDir = '.', label = 'shot'] = process.argv.slice(2)

const aliceSk = generateSecretKey()
const oliveSk = generateSecretKey()
const shopKey = getPublicKey(generateSecretKey())
const handles: Record<string, string> = { 'alice@imani.casa': getPublicKey(aliceSk), 'olive@imani.casa': getPublicKey(oliveSk) }
const now = () => Math.floor(Date.now() / 1000)
const ev = (sk: Uint8Array, kind: number, content: Record<string, unknown>) =>
  finalizeEvent({ kind, created_at: now() - 60, tags: kind === 30078 ? [['d', 'imani:merchant']] : [], content: JSON.stringify(content) }, sk)
const base = { active: true, categories: [], issuanceCurrency: 'EUR', voucherValidityDays: 90, acceptsCards: true }
const events = [
  ev(aliceSk, 30078, base),
  ev(aliceSk, 0, { name: 'Alice Bakery', about: 'Bread and cakes' }),
  ev(oliveSk, 30078, { ...base, online_shop: { url: 'https://olive.example', redeem_key: shopKey, platform: 'woocommerce', since: now() - 86400 } }),
  ev(oliveSk, 0, { name: 'Olive Grove', about: 'Oil, olives and preserves' }),
]
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', ORIGIN)
  const send = (s: number, o: unknown) => res.writeHead(s, { 'Content-Type': 'application/json' }).end(JSON.stringify(o))
  let body = ''
  for await (const c of req) body += c
  if (url.pathname.startsWith('/api/v1/resolve/')) {
    const hex = handles[decodeURIComponent(url.pathname.slice(16))]
    return hex ? send(200, { hex_pubkey: hex }) : send(404, {})
  }
  if (url.pathname === '/api/v1/nostr/query') {
    const f = JSON.parse(body) as { kinds: number[]; authors: string[] }
    return send(200, { events: events.filter((e) => f.kinds.includes(e.kind) && f.authors.includes(e.pubkey)) })
  }
  const safe = normalize(url.pathname).replace(/^(\.\.[/\\])+/, '')
  let file = join(DIST, safe)
  try {
    if (!(await stat(file)).isFile()) throw new Error('dir')
  } catch {
    file = join(DIST, 'index.html')
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' }).end(await readFile(file))
})

async function main() {
  await new Promise<void>((r) => server.listen(PORT, r))
  const browser = await chromium.launch()
  try {
    for (const [shop, scheme] of [['alice', 'light'], ['olive', 'light'], ['olive', 'dark']] as const) {
      const page = await browser.newPage({ viewport: { width: 420, height: 900 }, deviceScaleFactor: 2, colorScheme: scheme })
      await page.goto(`${ORIGIN}/shop/${shop}`)
      await page.locator('form').waitFor()
      await page.getByLabel(/^Amount/).fill('25')
      await page.screenshot({ path: `${outDir}/${label}-${shop}-${scheme}.png`, fullPage: true })
      const code = page.getByRole('radio', { name: /shop code/i })
      if (await code.count()) {
        await page.getByText('Shop code', { exact: true }).click()
      await page.waitForTimeout(400)
        await page.screenshot({ path: `${outDir}/${label}-${shop}-${scheme}-code.png`, fullPage: true })
      }
      await page.close()
    }
  } finally {
    await browser.close()
    server.close()
  }
}
void main()
