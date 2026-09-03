import type { Browser, Page } from '@playwright/test'

import { restore } from '../lib/snapshot'
import type { Snapshot } from '../lib/snapshot'
import { FIXTURE_PASSPHRASE, unlock } from './coldBoot'

/**
 * What it costs to drain a queue of arriving coupons, and whether the app
 * stays usable while it happens.
 *
 * The failure this looks for is not throughput. It is the app FREEZING while
 * arrivals are processed — a customer holding a phone that has stopped
 * responding to their thumb, which a total-duration measurement cannot see at
 * all. A drain that takes twice as long but never blocks the main thread is
 * the better outcome, and this scenario says so.
 *
 * ## How responsiveness is measured
 *
 * A heartbeat runs in the page throughout the drain, scheduling itself every
 * 16ms — one animation frame. Every time it is late, the main thread was busy
 * with something else for that long. The worst lateness is the longest the UI
 * could not have answered a tap, which is the number a customer would feel.
 *
 * Reported alongside the drain's duration rather than instead of it, because
 * the two can move in opposite directions and a regression in either is worth
 * knowing about.
 *
 * ## Why arrivals are written through the wallet's own writer
 *
 * The gateway's `/incoming-notifications/drain` returns 404 on this stack, and
 * the DM poller needs coupons the mint has not seen — neither is reproducible
 * from a recorded fixture. What IS reproducible, and is what the drain
 * ultimately does, is a burst of coupons landing in storage while the app is
 * open, each one notifying the screens that read it. That is what this drives.
 */

/** Coupons in the burst. Constant across the ladder, like the batch write. */
const ARRIVALS = 50

/** One animation frame. A heartbeat later than this means the thread was busy. */
const FRAME_MS = 16

/**
 * The heartbeat, as source text, so the scenario and its own test measure the
 * same thing.
 *
 * A responsiveness measurement that always reports zero is indistinguishable
 * from a wallet that never blocks, and the first is far more likely. This is
 * shared so a test can block the main thread deliberately and check the number
 * moves — verified at 235ms against a 250ms block.
 */
export const HEARTBEAT_SOURCE = `
  let worst = 0
  let beating = true
  let lastTick = performance.now()
  const beat = () => {
    const now = performance.now()
    const late = now - lastTick - ${FRAME_MS}
    if (late > worst) worst = late
    lastTick = now
    if (beating) requestAnimationFrame(beat)
  }
  requestAnimationFrame(beat)
`

export interface DrainOptions {
  baseUrl: string
  /** The wallet the burst arrives INTO — this is the rung. */
  fixture: Snapshot
  passphrase?: string
  timeoutMs?: number
}

export interface DrainResult {
  /** Milliseconds from the first arrival to the last being readable. */
  ms: number
  /**
   * The longest the main thread went without servicing a frame, during the
   * drain. This is the number a customer would feel as a freeze.
   */
  worstStallMs: number
  /** Arrivals actually stored, so a drain that processed nothing cannot pass. */
  processed: number
  /** Rows the wallet held before the burst. */
  before: number
}

export async function measureDrain(
  browser: Browser,
  { baseUrl, fixture, passphrase = FIXTURE_PASSPHRASE, timeoutMs = 90_000 }: DrainOptions,
): Promise<DrainResult> {
  const context = await browser.newContext()
  const page: Page = await context.newPage()

  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
    await restore(page, fixture, context)

    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
    await page.waitForFunction(() => (document.body?.innerText?.trim().length ?? 0) > 0, undefined, {
      timeout: timeoutMs,
    })
    await unlock(page, passphrase)

    const text = await page.evaluate(() => document.body?.innerText ?? '')
    if (text.includes('Unlock')) {
      throw new Error('the wallet did not unlock, so no drain ran against a real wallet')
    }

    // Settle first: the boot's own background work scales with the coupon
    // count, and measuring through it charges the drain for the login (#41).
    await settle(page, timeoutMs)

    const measured = await page.evaluate(
      // Source text, not a function: the TS loader rewrites arrows to call a
      // `__name` helper that does not exist in the page.
      `(async () => {
        const dbs = await indexedDB.databases()
        const name = dbs
          .map((d) => d.name)
          .find((n) => n && n.startsWith('imani-wallet-') && !n.includes('resume'))
        if (!name) throw new Error('no wallet database to drain into')

        const open = () => new Promise((ok, no) => {
          const r = indexedDB.open(name)
          r.onsuccess = () => ok(r.result)
          r.onerror = () => no(r.error)
        })

        const countRows = async () => {
          const db = await open()
          const n = await new Promise((ok) => {
            const r = db.transaction('wallet_vouchers', 'readonly')
              .objectStore('wallet_vouchers').count()
            r.onsuccess = () => ok(r.result)
            r.onerror = () => ok(0)
          })
          db.close()
          return n
        }

        const before = await countRows()

        const db = await open()
        const sample = await new Promise((ok) => {
          const r = db.transaction('wallet_vouchers', 'readonly')
            .objectStore('wallet_vouchers').getAll(undefined, 1)
          r.onsuccess = () => ok(r.result[0])
          r.onerror = () => ok(null)
        })
        if (!sample) throw new Error('the wallet held no coupon to model an arrival on')

        // Records how late each frame was, which is how long the main thread
        // was unavailable to a tap. See HEARTBEAT_SOURCE.
        ${HEARTBEAT_SOURCE}

        const started = performance.now()

        // Arrivals land ONE AT A TIME, each in its own transaction and each
        // notifying the screens — which is what an arriving coupon does. A
        // single bulk transaction would measure the store's batch path and
        // miss the per-arrival work entirely, which is where a freeze lives.
        const ids = []
        for (let i = 0; i < ${ARRIVALS}; i++) {
          const id = 'perf-arrival-' + Date.now() + '-' + i
          ids.push(id)
          await new Promise((ok, no) => {
            const tx = db.transaction('wallet_vouchers', 'readwrite')
            tx.objectStore('wallet_vouchers').put({
              ...sample,
              token_id: id,
              voucher_id: 'perf-arrival-v-' + Date.now() + '-' + i,
            })
            tx.oncomplete = () => ok(undefined)
            tx.onerror = () => no(tx.error)
          })
          // What the wallet does after every write, so the screens reading the
          // store re-render — the work that competes with the customer's thumb.
          try {
            window.dispatchEvent(new StorageEvent('storage', { key: 'imani-wallet:changed' }))
          } catch {}
        }

        // Every arrival readable back before the clock stops.
        const seen = await new Promise((ok) => {
          const tx = db.transaction('wallet_vouchers', 'readonly')
          const store = tx.objectStore('wallet_vouchers')
          let found = 0
          let done = 0
          for (const id of ids) {
            const r = store.get(id)
            r.onsuccess = () => {
              if (r.result) found++
              if (++done === ids.length) ok(found)
            }
            r.onerror = () => { if (++done === ids.length) ok(found) }
          }
        })
        const ms = Math.round(performance.now() - started)
        beating = false
        db.close()

        return {
          ms,
          worstStallMs: Math.round(worst),
          processed: seen,
          before,
          after: await countRows(),
        }
      })()`,
    )

    const { ms, worstStallMs, processed, before, after } = measured as {
      ms: number
      worstStallMs: number
      processed: number
      before: number
      after: number
    }

    if (processed !== ARRIVALS || after - before !== ARRIVALS) {
      throw new Error(
        `${processed} of ${ARRIVALS} arrivals readable and the store grew by ` +
          `${after - before}, so this would have timed a drain that did not ` +
          `entirely happen`,
      )
    }

    return { ms, worstStallMs, processed, before }
  } finally {
    await context.close()
  }
}

/** Median of several runs, as the other scenarios take. */
export async function measureDrainMedian(
  browser: Browser,
  options: DrainOptions,
  samples = 5,
): Promise<DrainResult & { all: number[] }> {
  const results: DrainResult[] = []
  for (let i = 0; i < samples; i++) {
    results.push(await measureDrain(browser, options))
  }

  const all = results.map((r) => r.ms)
  const sorted = [...all].sort((a, b) => a - b)
  return {
    ...results[0],
    ms: sorted[Math.floor(sorted.length / 2)],
    // The WORST stall across every sample, not the median of them. A freeze
    // that happens one run in five is still a freeze a customer meets, and
    // averaging it away is how a responsiveness measurement stops meaning
    // anything.
    worstStallMs: Math.max(...results.map((r) => r.worstStallMs)),
    all,
  }
}

/** Wait until the main thread has been idle for a moment. See #41 and #42. */
async function settle(page: Page, timeoutMs: number): Promise<void> {
  await page.evaluate(`
    new Promise((resolve) => {
      const deadline = Date.now() + ${Math.min(timeoutMs, 5_000)}
      let quiet = 0
      const step = () => {
        if (quiet >= 3 || Date.now() > deadline) { resolve(); return }
        requestIdleCallback(
          (info) => { quiet = info.timeRemaining() > 8 ? quiet + 1 : 0; step() },
          { timeout: 200 },
        )
      }
      step()
    })
  `)
}
