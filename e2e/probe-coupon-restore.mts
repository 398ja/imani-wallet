/**
 * #203: a fresh browser restores a chunked coupon backup through the real app.
 *
 *   1. IMANI_STRFRY_URL=ws://127.0.0.1:28379 IMANI_RESTORE_KEY_OUT=/tmp/k \
 *        npx vitest run voucherRecordsStrfry      # publishes the 7-proof coupon
 *   2. VITE_RELAY_URL=ws://127.0.0.1:28379 npx vite --port 5181 --strictPort
 *   3. E2E_BASE=http://localhost:5181 RESTORE_KEY_FILE=/tmp/k npx tsx e2e/probe-coupon-restore.mts
 *
 * A new browser context (no IndexedDB, no localStorage) logs in with the key
 * alone; login runs restoreVouchers, and the probe reads the wallet's own
 * IndexedDB for the coupon.
 */
import { readFileSync } from 'node:fs'
import { chromium } from 'playwright'

const BASE = process.env.E2E_BASE ?? 'http://localhost:5181'
const nsec = readFileSync(process.env.RESTORE_KEY_FILE!, 'utf8').trim()
const TOKEN_PREFIX = readFileSync(
  new URL('../src/lib/__tests__/fixtures/terminal-coupon-7-proofs.txt', import.meta.url),
  'utf8',
).trim()

const browser = await chromium.launch()
const context = await browser.newContext()
const page = await context.newPage()
const logs: string[] = []
page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`))

await page.goto(`${BASE}/onboarding`, { waitUntil: 'networkidle' })
await page.getByRole('button', { name: /^Log in$/ }).first().click()
await page.locator('input[placeholder^="nsec1"]').fill(nsec)
await page.locator('input[placeholder="Choose a passphrase"]').fill('correct horse battery')
await page.locator('input[placeholder="Confirm passphrase"]').fill('correct horse battery')
await page.getByRole('button', { name: /^Add key and unlock$/ }).last().click()
for (let i = 0; i < 30 && page.url().includes('onboarding'); i++) await page.waitForTimeout(1000)

let tokens: string[] = []
for (let i = 0; i < 30 && tokens.length === 0; i++) {
  await page.waitForTimeout(1000)
  tokens = await page.evaluate(async () => {
    const out: string[] = []
    for (const info of await indexedDB.databases()) {
      if (!info.name) continue
      const db: IDBDatabase = await new Promise((ok, no) => {
        const r = indexedDB.open(info.name!)
        r.onsuccess = () => ok(r.result)
        r.onerror = () => no(r.error)
      })
      for (const store of Array.from(db.objectStoreNames)) {
        const rows: unknown[] = await new Promise((ok) => {
          const r = db.transaction(store).objectStore(store).getAll()
          r.onsuccess = () => ok(r.result)
          r.onerror = () => ok([])
        })
        for (const row of rows) {
          const t = (row as { token?: unknown })?.token
          if (typeof t === 'string' && t.startsWith('cashuB')) out.push(t)
        }
      }
      db.close()
    }
    return out
  })
}

const ok = tokens.includes(TOKEN_PREFIX)
console.log(ok ? 'PASS  fresh browser restored the 7-proof coupon from the relay' : 'FAIL  coupon not restored')
console.log(`  url=${page.url()} coupons in IndexedDB=${tokens.length}`)
for (const l of logs.filter((l) => process.env.ALL_LOGS || /voucherRecords|restor/i.test(l))) console.log('  ' + l)
await browser.close()
process.exit(ok ? 0 : 1)
