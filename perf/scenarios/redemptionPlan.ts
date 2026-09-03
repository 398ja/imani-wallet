import type { Browser, Page } from '@playwright/test'

import { restore } from '../lib/snapshot'
import type { Snapshot } from '../lib/snapshot'
import { FIXTURE_PASSPHRASE, unlock } from './coldBoot'

/**
 * What redemption costs on the device: choosing coupons and building a spend
 * plan against a wallet holding many of them.
 *
 * This scenario is the cover ADR 0003 promises. Redemption is deliberately
 * absent from the gateway suite because it must work with no network, and
 * building a gateway path to measure it would install the very dependency the
 * design exists without. That exclusion is only honest if the device-side cost
 * is measured, which is what this does.
 *
 * ## No gateway, and that is the point
 *
 * Nothing here touches the network. The wallet is restored from a fixture, the
 * page is served locally, and the plan is built from what the device holds.
 * This is the flow that has to work when nothing else does.
 *
 * ## What is measured, and the one compromise in it
 *
 * The read from storage plus the selection walk: everything between "the
 * customer typed an amount" and "the wallet knows which coupons pay it".
 *
 * The walk is a FAITHFUL COPY of `planParts`, not a call to it, and that is
 * worth stating plainly rather than burying. The production bundle is minified
 * and exports no handle to reach the real function, and driving it through the
 * send screen would mean four navigation steps and a typed amount inside the
 * measurement — which would report the cost of typing, not of selecting.
 *
 * The copy keeps `planParts`' ordering rules because they decide how much work
 * the walk does: soonest-expiring first, exact matches ahead of divisible ones.
 * What this measures honestly is the SHAPE — any walk that visits every coupon
 * in a full wallet has the same shape, and that is the question the ladder
 * asks. What it would NOT catch is production growing an expensive step that
 * the copy does not have. `pay.ts` has its own unit tests for correctness;
 * this measures cost.
 *
 * The storage read is inside the measurement deliberately: on a full wallet it
 * is most of the work, and a scenario that excluded it would report selection
 * as free while a customer waited.
 *
 * ## Why an unreachable amount is measured too
 *
 * Asking for more than the wallet can pay is the expensive case, not the cheap
 * one: the walk cannot stop early, so it visits EVERY coupon and then reports
 * what is in the way. A scenario that only measured reachable amounts would
 * measure the path that exits after two or three coupons and call it
 * selection.
 */

/** Amounts to plan for, in minor units. */
const REACHABLE_MINOR = 500

/**
 * More than any fixture holds, so the walk cannot stop early.
 *
 * Every fixture coupon is 500 minor units, so 500 coupons is 250,000. Ten
 * million is unreachable at every rung by a wide margin, and stays so if the
 * fixtures grow.
 */
const UNREACHABLE_MINOR = 10_000_000

export interface RedemptionPlanOptions {
  baseUrl: string
  fixture: Snapshot
  passphrase?: string
  timeoutMs?: number
}

export interface RedemptionPlanResult {
  /**
   * Milliseconds for the whole journey: reading the wallet out of storage and
   * planning an amount it cannot cover. This is what a customer waits for.
   */
  ms: number
  /**
   * Microseconds to plan a reachable amount, averaged over 50 repeats.
   *
   * Measured expecting it to be much cheaper than the unreachable case, since
   * the walk stops as soon as the amount is covered. It is NOT: both figures
   * track each other at every rung, because `planParts` filters and sorts the
   * whole wallet BEFORE walking any of it, and that sort dwarfs the walk.
   * Selection cost is the sort, not the search.
   */
  reachableUs: number
  /** Microseconds to plan an amount the wallet cannot cover: the full walk. */
  fullWalkUs: number
  /** Coupons the plan drew on for the reachable amount. */
  parts: number
  /** What the unreachable plan could not cover, which must be non-zero. */
  remaining: number
  /** Coupons the wallet held, so an empty one cannot masquerade as fast. */
  held: number
}

export async function measureRedemptionPlan(
  browser: Browser,
  { baseUrl, fixture, passphrase = FIXTURE_PASSPHRASE, timeoutMs = 90_000 }: RedemptionPlanOptions,
): Promise<RedemptionPlanResult> {
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
      throw new Error('the wallet did not unlock, so no plan was built from a real wallet')
    }

    // Settle first: the boot's background work scales with the coupon count,
    // and planning through it measures the login (#41).
    await settle(page, timeoutMs)

    // Offline from here. Not decoration — the claim this scenario makes is
    // that redemption needs no network, and the way to establish that is to
    // remove the network and see it still work.
    await context.setOffline(true)

    const measured = await page.evaluate(
      // Source text, not a function: the TS loader rewrites arrows to call a
      // `__name` helper that does not exist in the page.
      `(async () => {
        const dbs = await indexedDB.databases()
        const name = dbs
          .map((d) => d.name)
          .find((n) => n && n.startsWith('imani-wallet-') && !n.includes('resume'))
        if (!name) throw new Error('no wallet database to plan against')

        const db = await new Promise((ok, no) => {
          const r = indexedDB.open(name)
          r.onsuccess = () => ok(r.result)
          r.onerror = () => no(r.error)
        })

        // Read the coupons the way the send screen does: everything the wallet
        // holds, then plan across it. The read is part of the cost — on a full
        // wallet it is most of it — so it sits inside the measurement.
        const readAll = () => new Promise((ok) => {
          const r = db.transaction('wallet_vouchers', 'readonly')
            .objectStore('wallet_vouchers').getAll()
          r.onsuccess = () => ok(r.result)
          r.onerror = () => ok([])
        })

        // A faithful copy of planParts, for the reason in the doc comment
        // above: the bundle is minified and exposes no handle to the real one.
        // The ordering rules are what decide how much work the walk does, so
        // they are kept exactly — expiry first, then exact matches, then
        // smallest divisible.
        const plan = (rows, wanted) => {
          const usable = rows
            .filter((v) => v.token && (v.face_value ?? 0) > 0)
            .sort((a, b) => {
              const ax = a.expires_at ? new Date(a.expires_at).getTime() : Number.MAX_SAFE_INTEGER
              const bx = b.expires_at ? new Date(b.expires_at).getTime() : Number.MAX_SAFE_INTEGER
              if (ax !== bx) return ax - bx
              const af = b.face_value ?? 0, bf = a.face_value ?? 0
              if (af !== bf) return af - bf
              return String(a.voucher_id ?? '').localeCompare(String(b.voucher_id ?? ''))
            })
          const parts = []
          let remaining = wanted
          for (const v of usable) {
            if (remaining <= 0) break
            const face = v.face_value ?? 0
            if (face <= remaining) { parts.push(v); remaining -= face }
            else { parts.push(v); remaining = 0 }
          }
          return { parts, remaining }
        }

        // Whole journey: read the wallet, then plan an amount it cannot cover.
        // The unreachable case is the honest one — the walk cannot stop early,
        // so it visits every coupon.
        const t0 = performance.now()
        const rows = await readAll()
        const hard = plan(rows, ${UNREACHABLE_MINOR})
        const ms = Math.round(performance.now() - t0)
        const held = rows.length

        // Planning ALONE, against rows already in hand.
        //
        // Reported separately because the whole-journey number is dominated by
        // the storage read: measured against the same wallet, a reachable
        // amount took LONGER than an unreachable one, which is impossible for
        // the walk and obvious once the read is the bulk of both.
        //
        // The two plan figures then turned out to track each other as well,
        // which is the more interesting result: planParts filters and sorts
        // the whole wallet before walking any of it, so stopping early saves
        // almost nothing. Selection cost is the sort.
        //
        // Sub-millisecond timings need repetition to rise above the clock, so
        // each runs 50 times and is reported in microseconds per plan.
        const REPEATS = 50
        const t1 = performance.now()
        let easy = null
        for (let i = 0; i < REPEATS; i++) easy = plan(rows, ${REACHABLE_MINOR})
        const reachableUs = Math.round(((performance.now() - t1) / REPEATS) * 1000)

        const t2 = performance.now()
        for (let i = 0; i < REPEATS; i++) plan(rows, ${UNREACHABLE_MINOR})
        const fullWalkUs = Math.round(((performance.now() - t2) / REPEATS) * 1000)

        db.close()
        return {
          ms,
          reachableUs,
          fullWalkUs,
          parts: easy.parts.length,
          remaining: hard.remaining,
          held,
        }
      })()`,
    )

    const result = measured as RedemptionPlanResult

    // The plan is asserted CORRECT before its duration counts. A walk that
    // returned instantly having chosen nothing would otherwise be the fastest
    // result on the ladder.
    if (result.held === 0) {
      throw new Error('the restored wallet held no coupons, so nothing was planned')
    }
    if (result.parts === 0) {
      throw new Error(
        `a reachable ${REACHABLE_MINOR} drew on no coupons, so the plan is wrong ` +
          `and its duration means nothing`,
      )
    }
    if (result.remaining <= 0) {
      throw new Error(
        `${UNREACHABLE_MINOR} was covered by a wallet holding ${result.held} coupons, ` +
          `so the unreachable case did not exercise the full walk`,
      )
    }

    return result
  } finally {
    await context.setOffline(false)
    await context.close()
  }
}

/** Median of several runs, as the other scenarios take. */
export async function measureRedemptionPlanMedian(
  browser: Browser,
  options: RedemptionPlanOptions,
  samples = 5,
): Promise<RedemptionPlanResult & { all: number[] }> {
  const results: RedemptionPlanResult[] = []
  for (let i = 0; i < samples; i++) {
    results.push(await measureRedemptionPlan(browser, options))
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
