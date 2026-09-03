/**
 * The drain scenario's heartbeat.
 *
 * A responsiveness measurement that always reports zero is indistinguishable
 * from a wallet that never blocks — and the first is far more likely than the
 * second. The drain currently reports stalls of 0-1ms, which is the answer we
 * want to be true; this is what makes it evidence rather than a hope.
 *
 * Runs in a real browser, because the thing under test is `requestAnimationFrame`
 * against a blocked main thread and there is no honest way to fake that.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { chromium, type Browser } from '@playwright/test'

import { HEARTBEAT_SOURCE } from '../notificationDrain'

let browser: Browser

beforeAll(async () => {
  browser = await chromium.launch()
}, 60_000)

afterAll(async () => {
  await browser?.close()
})

/** Run the heartbeat while the page does `work`, and report the worst stall. */
async function stallDuring(work: string): Promise<number> {
  const page = await (await browser.newContext()).newPage()
  try {
    await page.goto('about:blank')
    return (await page.evaluate(`
      (async () => {
        ${HEARTBEAT_SOURCE}
        await new Promise((r) => setTimeout(r, 100))
        ${work}
        await new Promise((r) => setTimeout(r, 200))
        beating = false
        return Math.round(worst)
      })()
    `)) as number
  } finally {
    await page.context().close()
  }
}

describe('the drain heartbeat', () => {
  it('sees a blocked main thread', async () => {
    // The measurement that matters. A synchronous loop is exactly what a
    // freeze is: the thread cannot service a frame, or a tap, until it ends.
    const stall = await stallDuring(`
      const until = performance.now() + 250
      while (performance.now() < until) {}
    `)

    expect(stall).toBeGreaterThan(200)
  }, 60_000)

  it('scales with how long the thread was blocked', async () => {
    // Not just "non-zero when blocked": the number has to mean something, or a
    // 500ms freeze and a 50ms one would read the same.
    const short = await stallDuring(`
      const until = performance.now() + 60
      while (performance.now() < until) {}
    `)
    const long = await stallDuring(`
      const until = performance.now() + 400
      while (performance.now() < until) {}
    `)

    expect(long).toBeGreaterThan(short * 2)
  }, 60_000)

  it('reports nothing when the thread stays free', async () => {
    // The counterpart. Without this, a heartbeat that always reported a large
    // stall would pass both tests above.
    const stall = await stallDuring(`await new Promise((r) => setTimeout(r, 300))`)

    // One frame of slack: a browser under no load still misses the odd frame.
    expect(stall).toBeLessThan(50)
  }, 60_000)
})
