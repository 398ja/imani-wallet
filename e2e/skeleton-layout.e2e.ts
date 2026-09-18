/**
 * Does the row actually stay put when the name lands?
 *
 * This is the one claim in the change that a jsdom test cannot make. jsdom does
 * not do layout — every `getBoundingClientRect` is zeros — so the assertion that
 * a skeleton occupies EXACTLY the line box of the text it replaces is only true
 * if a real engine, with the real compiled Tailwind, says so. That is the whole
 * justification for `SkeletonLine` over a hand-picked pixel height, and an
 * untested justification is a guess.
 *
 * Run against the built CSS: `npm run build` first, then `npx tsx e2e/skeleton-layout.e2e.ts`.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { chromium } from 'playwright'

const css = (() => {
  const dir = 'dist/assets'
  const file = readdirSync(dir).find((f) => f.endsWith('.css'))
  if (!file) throw new Error('No built CSS. Run `npm run build` first.')
  return readFileSync(`${dir}/${file}`, 'utf8')
})()

/** The identity block from `IdentityInline`, in each of its two states. */
const row = (inner: string) => `
  <span class="flex min-w-0 items-center gap-3">
    <span class="w-8 h-8 rounded-full bg-mono-200"></span>
    <span class="min-w-0 flex-1">${inner}</span>
  </span>
  <p id="below">the thing underneath</p>
`

const LOADING = row(
  `<span class="block text-sm"><span class="inline-block h-[0.72em] max-w-full align-middle w-32 animate-pulse rounded-md bg-mono-200"></span></span>`,
)
const RESOLVED = row(`<span class="block truncate text-sm text-mono-900">Rosa Green Farm</span>`)

const measure = async (html: string) => {
  const browser = await chromium.launch()
  const page = await browser.newPage()
  await page.setContent(`<style>${css}</style><div style="width:380px">${html}</div>`)
  const box = await page.locator('#below').boundingBox()
  await browser.close()
  if (!box) throw new Error('nothing to measure')
  return box.y
}

const loading = await measure(LOADING)
const resolved = await measure(RESOLVED)
const shift = Math.abs(loading - resolved)

console.log(`below-the-row y: loading=${loading} resolved=${resolved} shift=${shift}px`)

// Sub-pixel is the honest bar. Anything a person could see is a failure, and a
// whole pixel on a list of twenty rows is twenty pixels of the page jumping.
if (shift > 0.5) {
  console.error(`FAIL: the row moves by ${shift}px when the name arrives`)
  process.exit(1)
}
console.log('PASS: nothing moves when the name arrives')
