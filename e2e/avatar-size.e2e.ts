/**
 * Does an avatar with a picture still occupy its declared size?
 *
 * `Avatar` now wraps the <img> in a positioning span so a skeleton can sit
 * behind it. A wrapper is easy to get subtly wrong — `inline-block` with a
 * size class is not the same box as the img it replaced — and every screen in
 * the wallet puts an avatar next to text, so a few pixels here is a few pixels
 * everywhere.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { chromium } from 'playwright'

const dir = 'dist/assets'
const file = readdirSync(dir).find((f) => f.endsWith('.css'))
if (!file) throw new Error('No built CSS. Run `npm run build` first.')
const css = readFileSync(`${dir}/${file}`, 'utf8')

// A 1x1 transparent gif, so the image loads without a network.
const PIXEL =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

// The `sm` avatar: w-8 h-8 = 32px.
const WRAPPED = `<span id="a" class="relative inline-block w-8 h-8 shrink-0">
  <img src="${PIXEL}" class="rounded-full object-cover w-8 h-8 transition-opacity duration-200 opacity-100">
</span>`
const PLAIN = `<span id="a" class="w-8 h-8 rounded-full bg-mono-200 inline-block"></span>`

const measure = async (html: string) => {
  const browser = await chromium.launch()
  const page = await browser.newPage()
  await page.setContent(`<style>${css}</style><div style="width:380px">${html}</div>`)
  await page.waitForTimeout(100)
  const box = await page.locator('#a').boundingBox()
  await browser.close()
  return box
}

const wrapped = await measure(WRAPPED)
const plain = await measure(PLAIN)
console.log('wrapped:', wrapped?.width, 'x', wrapped?.height)
console.log('plain:  ', plain?.width, 'x', plain?.height)

const bad =
  !wrapped || !plain || wrapped.width !== plain.width || wrapped.height !== plain.height
if (bad) {
  console.error('FAIL: a pictured avatar is not the same box as an initials one')
  process.exit(1)
}
console.log('PASS: same box either way')
