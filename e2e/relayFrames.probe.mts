// #428 probe: a real browser on staging with the given bundle; counts websocket frames to the relay.
import { chromium } from 'playwright'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { registerCustomer } from './register.mts'
const BASE = process.env.E2E_BASE!, BUNDLE = process.env.E2E_BUNDLE_DIR
const CT: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' }
const b = await chromium.launch(); const ctx = await b.newContext({ serviceWorkers: 'block' })
if (BUNDLE) { const root = normalize(BUNDLE); const shell = join(root, 'index.html')
  await ctx.route(`${BASE}/**`, async (r) => { const p = new URL(r.request().url()).pathname
    if (p.startsWith('/api/') || p.startsWith('/.well-known/') || p.startsWith('/fcaptcha/')) return r.continue()
    const c = normalize(join(root, p)); const f = c.startsWith(root) && extname(c) ? await readFile(c).then(() => c, () => shell) : shell
    return r.fulfill({ status: 200, body: await readFile(f), contentType: CT[extname(f)] ?? 'application/octet-stream' }) }) }
const frames = { REQ: 0, EVENT: 0, sockets: 0 }
const page = await ctx.newPage()
page.on('websocket', (ws) => { frames.sockets++; ws.on('framesent', (f) => { const t = String(f.payload).slice(0, 8); if (t.startsWith('["REQ"')) frames.REQ++; else if (t.startsWith('["EVENT"')) frames.EVENT++ }) })
await registerCustomer(page, BASE)
for (const path of ['/', '/history', '/send', '/settings', '/']) { await page.goto(BASE + path, { waitUntil: 'load' }); await page.waitForTimeout(6000) }
console.log(JSON.stringify(frames)); await b.close()
