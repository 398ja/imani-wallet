/**
 * First-run questions on Home, through the real app: notifications asked once, the answer kept
 * across a reload. Run with the dev server up: E2E_BASE=http://localhost:5199 npx tsx e2e/first-run-prompts.e2e.mts
 */
import { chromium } from 'playwright'
import { registerCustomer } from './register.mts'

const BASE = process.env.E2E_BASE ?? 'http://localhost:5177'
const failures: string[] = []
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` (${detail})`}`)
  if (!ok) failures.push(name)
}

const browser = await chromium.launch()
const context = await browser.newContext({ permissions: [] })
const page = await context.newPage()
try {
  const pubkey = await registerCustomer(page, BASE)
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })

  const notify = page.getByRole('heading', { name: 'Turn on notifications?' })
  const shown = await notify.waitFor({ timeout: 15000 }).then(() => true, () => false)
  check('Home asks "Turn on notifications?" on the first visit', shown)

  if (shown) {
    await page.getByRole('button', { name: 'Not now' }).click()
    await page.waitForTimeout(500)
    check('Not now hides the question', !(await notify.isVisible()))
    const kept = await page.evaluate((k) => localStorage.getItem(k), `imani-first-run:notifications:${pubkey}`)
    check('the answer is kept per account', kept === 'no', String(kept))

    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForTimeout(2000)
    check('not asked again after a reload', !(await notify.isVisible()))

    await page.goto(`${BASE}/settings/notifications`, { waitUntil: 'networkidle' })
    const off = await page.getByText('Turn on notifications').first().isVisible()
    check('Settings shows notifications off, changeable there', off)
  }
} finally {
  await browser.close()
}
console.log(failures.length ? `\n${failures.length} FAILED` : '\nall passed')
process.exit(failures.length ? 1 : 0)
