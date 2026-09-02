import type { Browser, Page } from '@playwright/test'

import { restore } from '../lib/snapshot'
import type { Snapshot } from '../lib/snapshot'
import { FIXTURE_PASSPHRASE, unlock } from './coldBoot'

/**
 * What it costs to total a balance across currencies.
 *
 * Measured as a customer waiting for their balance to appear: from arriving on
 * the screen that shows it, to the figure being on screen. Nothing here calls
 * `walletTotals` directly — an internal function timed in isolation measures an
 * implementation detail, and it will report green the day that detail moves
 * behind something slower.
 *
 * ## Why this scenario is worth isolating
 *
 * Aggregation touches every coupon held, by construction: it walks each
 * merchant's groups and sums them per unit. That makes it the scenario most
 * likely to hide quadratic behaviour, and the one where a shape assertion earns
 * the most.
 *
 * ## Why more than one currency
 *
 * Adding EUR to USD would be a confident lie, so the wallet keeps one figure
 * per currency and the aggregation has to walk them separately. A
 * single-currency fixture would exercise the easy path — one bucket, no
 * per-unit branching — and call the scenario covered. The recorded fixtures
 * issue every fourth coupon in USD for this reason.
 *
 * ## What is deliberately NOT measured
 *
 * Not cold boot. That is `coldBoot.ts`, and it is measured from a cold page
 * load through the unlock. This scenario starts from an already-open wallet, so
 * a regression here names aggregation rather than anything that happens before
 * it.
 */

/** The balance is rendered under this label, on the merchants screen. */
const BALANCE_LABEL = 'Total balance'

/** A boot that never got past the lock screen has not measured aggregation. */
const LOCKED = 'Unlock'

export interface AggregationOptions {
  baseUrl: string
  fixture: Snapshot
  passphrase?: string
  timeoutMs?: number
}

export interface AggregationResult {
  /** Milliseconds from arriving on the balance screen to the figure showing. */
  ms: number
  /** The totals as rendered, so a measurement cannot claim a balance it never showed. */
  rendered: string
  /** How many currencies the balance actually reported. */
  currencies: number
  /** Records the wallet held, so an empty one cannot masquerade as fast. */
  held: number
}

/**
 * Measure one aggregation, on a wallet restored from `fixture`.
 *
 * The wallet is opened and unlocked BEFORE the clock starts: those costs belong
 * to cold boot, and counting them here would bury the number this scenario
 * exists to report.
 */
export async function measureAggregation(
  browser: Browser,
  { baseUrl, fixture, passphrase = FIXTURE_PASSPHRASE, timeoutMs = 60_000 }: AggregationOptions,
): Promise<AggregationResult> {
  const context = await browser.newContext()
  const page: Page = await context.newPage()

  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
    await restore(page, fixture, context)

    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
    await page.waitForFunction(
      () => (document.body?.innerText?.trim().length ?? 0) > 0,
      undefined,
      { timeout: timeoutMs },
    )
    await unlock(page, passphrase)

    // A wallet still on its lock screen has measured nothing. Checked before
    // the clock starts rather than after, so the failure names the unlock.
    const text = await page.evaluate(() => document.body?.innerText ?? '')
    if (text.includes(LOCKED)) {
      throw new Error(
        'the wallet did not unlock, so aggregation was never reached. ' +
          'The fixture carries the customer’s encrypted key; check the passphrase.',
      )
    }

    const held = await countRecords(page)
    if (held === 0) {
      throw new Error(
        'the restored wallet held no records, so this would have measured an ' +
          'empty balance. A fixture that restores nothing is the failure this ' +
          'suite keeps rediscovering.',
      )
    }

    // Leave the balance screen, then return to it. Navigating away and back is
    // what a customer does, and it re-runs the load-and-aggregate effect
    // without a full page load — which is exactly the cost being measured.
    await page.evaluate(() => {
      window.history.pushState({}, '', '/settings')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    await page.waitForFunction(
      (label) => !(document.body?.innerText ?? '').includes(label),
      BALANCE_LABEL,
      { timeout: timeoutMs },
    )

    const started = Date.now()
    await page.evaluate(() => {
      window.history.pushState({}, '', '/')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })

    // Settled when the figure is on screen, not when the label is. The label
    // renders immediately with a zero beside it while the coupons are still
    // being read, so waiting on it would measure the paint and call it
    // aggregation.
    const outcome = await page.waitForFunction(
      (label) => {
        const body = document.body?.innerText ?? ''
        if (!body.includes(label)) return null
        // Just the balance panel: the label, the primary total, and one line
        // per further currency. Reading further would sweep up the merchant
        // rows below and count their amounts as currencies.
        const from = body.indexOf(label) + label.length
        const lines = body
          .slice(from, from + 200)
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)

        // A figure with a unit on it — `formatFace` always renders one — and
        // the panel prints exactly one line per currency. Counting matches
        // within a line instead would double-count a thousands separator.
        //
        // Written as one expression rather than a named helper: this body is
        // serialised into the page, and a declared function inside it is
        // rewritten by the TS loader into something the browser cannot resolve
        // (`__name is not defined`).
        const amounts = lines
          .slice(0, 6)
          .filter(
            (l) =>
              /^\+?\s*([A-Z]{2,3}|[£$€])\s?[\d.,]+$/.test(l) ||
              /^[\d.,]+\s?[A-Z]{2,3}$/.test(l),
          )
        if (amounts.length === 0) return null
        return { rendered: amounts.join(' | '), currencies: amounts.length }
      },
      BALANCE_LABEL,
      { timeout: timeoutMs, polling: 4 },
    )
    const ms = Date.now() - started

    const { rendered, currencies } = (await outcome.jsonValue()) as {
      rendered: string
      currencies: number
    }

    return { ms, rendered, currencies, held }
  } finally {
    await context.close()
  }
}

/** Median of several runs, for the same reason cold boot takes one. */
export async function measureAggregationMedian(
  browser: Browser,
  options: AggregationOptions,
  samples = 5,
): Promise<AggregationResult & { all: number[] }> {
  const results: AggregationResult[] = []
  for (let i = 0; i < samples; i++) {
    results.push(await measureAggregation(browser, options))
  }

  const all = results.map((r) => r.ms)
  const sorted = [...all].sort((a, b) => a - b)
  return { ...results[0], ms: sorted[Math.floor(sorted.length / 2)], all }
}

/** How many records the restored wallet actually holds. */
async function countRecords(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const dbs = await indexedDB.databases()
    let total = 0
    for (const { name, version } of dbs) {
      if (!name || !name.startsWith('imani-wallet-')) continue
      const db = await new Promise<IDBDatabase>((ok, no) => {
        const req = indexedDB.open(name, version)
        req.onsuccess = () => ok(req.result)
        req.onerror = () => no(req.error)
      })
      for (const store of [...db.objectStoreNames]) {
        total += await new Promise<number>((ok) => {
          const req = db.transaction(store, 'readonly').objectStore(store).count()
          req.onsuccess = () => ok(req.result)
          req.onerror = () => ok(0)
        })
      }
      db.close()
    }
    return total
  })
}
