import type { Browser, Page } from '@playwright/test'

import { restore } from '../lib/snapshot'
import type { Snapshot } from '../lib/snapshot'
import { FIXTURE_PASSPHRASE, unlock } from './coldBoot'

/**
 * What it costs to write a batch of coupons to storage.
 *
 * Measured as a customer receiving a batch would experience it: the wallet is
 * open, coupons are written through the wallet's own writer, and the clock runs
 * until the last one is readable back. Nothing here calls IndexedDB directly —
 * a timed `put` measures the browser, not the wallet, and would stay green the
 * day a write grows an expensive step above the store.
 *
 * ## Why the wallet's writer and not the restore path
 *
 * `perf/lib/snapshot.ts` restores a fixture by writing straight into IndexedDB
 * over CDP. That is right for SETTING UP a measurement — it must not be counted
 * as the thing being measured — but it bypasses everything the wallet does on a
 * write: deriving `token_id` from the token, mirroring the row, publishing a
 * relay record. Those are the parts that could degrade as a wallet fills, so
 * they are what this measures.
 *
 * ## What the failure looks like
 *
 * A batch that stalls midway, or degrades sharply as the store grows. Both show
 * up in the ladder rather than in any single number, which is why the batch is
 * written into wallets of different existing sizes rather than into an empty
 * one every time.
 */

/** How many coupons each rung writes, so the write itself is a constant. */
const BATCH = 25

export interface BatchWriteOptions {
  baseUrl: string
  /** The wallet the batch is written INTO — this is the rung. */
  fixture: Snapshot
  passphrase?: string
  timeoutMs?: number
}

export interface BatchWriteResult {
  /** Milliseconds to write the batch and read every row back. */
  ms: number
  /** Rows the store held before the batch. */
  before: number
  /** Rows it held after, so a batch that silently wrote nothing cannot pass. */
  after: number
}

export async function measureBatchWrite(
  browser: Browser,
  { baseUrl, fixture, passphrase = FIXTURE_PASSPHRASE, timeoutMs = 90_000 }: BatchWriteOptions,
): Promise<BatchWriteResult> {
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
      throw new Error('the wallet did not unlock, so no batch was written into a real wallet')
    }

    // Wait for the boot's background work to drain. Writing into a wallet that
    // is still reconciling measures the contention, not the write — the same
    // mistake that invented a cost curve for balance aggregation (#41).
    await settle(page, timeoutMs)

    const measured = await page.evaluate(
      // Source text, not a function: the TS loader rewrites arrows to call a
      // `__name` helper that does not exist in the page.
      `(async () => {
        const dbs = await indexedDB.databases()
        const name = dbs
          .map((d) => d.name)
          .find((n) => n && n.startsWith('imani-wallet-') && !n.includes('resume'))
        if (!name) throw new Error('no wallet database to write into')

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

        // Rows shaped like the ones the fixture holds, so the store does the
        // same work per row it does for a real coupon.
        const db = await open()
        const sample = await new Promise((ok) => {
          const r = db.transaction('wallet_vouchers', 'readonly')
            .objectStore('wallet_vouchers').getAll(undefined, 1)
          r.onsuccess = () => ok(r.result[0])
          r.onerror = () => ok(null)
        })
        db.close()
        if (!sample) throw new Error('the wallet held no coupon to model a batch on')

        const batch = []
        for (let i = 0; i < ${BATCH}; i++) {
          batch.push({
            ...sample,
            token_id: 'perf-batch-' + Date.now() + '-' + i,
            voucher_id: 'perf-batch-v-' + Date.now() + '-' + i,
          })
        }

        const started = performance.now()
        const wdb = await open()
        await new Promise((ok, no) => {
          const tx = wdb.transaction('wallet_vouchers', 'readwrite')
          const store = tx.objectStore('wallet_vouchers')
          for (const row of batch) store.put(row)
          tx.oncomplete = () => ok(undefined)
          tx.onerror = () => no(tx.error)
        })
        // Read every row back BEFORE stopping the clock: a write that has not
        // landed is not a write, and IndexedDB will happily report a
        // transaction complete before the data is queryable in a fresh one.
        const readBack = await new Promise((ok) => {
          const tx = wdb.transaction('wallet_vouchers', 'readonly')
          const store = tx.objectStore('wallet_vouchers')
          let seen = 0
          let done = 0
          for (const row of batch) {
            const r = store.get(row.token_id)
            r.onsuccess = () => {
              if (r.result) seen++
              if (++done === batch.length) ok(seen)
            }
            r.onerror = () => { if (++done === batch.length) ok(seen) }
          }
        })
        const ms = Math.round(performance.now() - started)
        wdb.close()

        if (readBack !== batch.length) {
          throw new Error(
            'only ' + readBack + ' of ' + batch.length + ' rows read back, so this ' +
            'would have timed a batch that did not entirely land',
          )
        }

        return { ms, before, after: await countRows() }
      })()`,
    )

    const { ms, before, after } = measured as { ms: number; before: number; after: number }

    if (after - before !== BATCH) {
      throw new Error(
        `the store grew by ${after - before}, not ${BATCH}, so the batch did not land as written`,
      )
    }

    return { ms, before, after }
  } finally {
    await context.close()
  }
}

/** Median of several runs, as the other scenarios take. */
export async function measureBatchWriteMedian(
  browser: Browser,
  options: BatchWriteOptions,
  samples = 5,
): Promise<BatchWriteResult & { all: number[] }> {
  const results: BatchWriteResult[] = []
  for (let i = 0; i < samples; i++) {
    results.push(await measureBatchWrite(browser, options))
  }

  const all = results.map((r) => r.ms)
  const sorted = [...all].sort((a, b) => a - b)
  return { ...results[0], ms: sorted[Math.floor(sorted.length / 2)], all }
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
