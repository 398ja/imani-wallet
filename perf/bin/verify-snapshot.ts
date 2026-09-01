#!/usr/bin/env node
/**
 * Prove a snapshot survives a round trip through a real browser.
 *
 *   ./deploy/up.sh && ./deploy/check.sh
 *   npm run build
 *   npx tsx perf/bin/verify-snapshot.ts
 *
 * Capture and hashing are checked elsewhere. This checks the boundary nothing
 * else touches: whether state written back into a FRESH browser context
 * actually reconstitutes the wallet.
 *
 * That boundary is where a snapshot stops being a file and starts being a
 * measurement. If restore silently drops a store, an index or a localStorage
 * key, every scenario built on it measures a wallet that never existed, and
 * the numbers stay plausible. So this runs against a real browser and a real
 * schema rather than asserting on the JSON.
 *
 * Deliberately independent of how many coupons the wallet holds, so it works
 * while issue #36 keeps a wallet from filling: whatever state exists is
 * captured, restored, and compared. A wallet holding one record proves the
 * mechanism exactly as well as one holding a thousand.
 */

import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

import { chromium, type Browser } from '@playwright/test'

import { serve } from '../lib/serve'
import { capture, restore, countRecords, type Snapshot } from '../lib/snapshot'
import { sourceHash } from '../lib/sources'

const ROOT = process.cwd()
const results: Array<{ name: string; pass: boolean; detail: string }> = []

function record(name: string, pass: boolean, detail: string) {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`)
}

/** Everything the wallet has stored, as a comparable shape. */
async function readState(browser: Browser, url: string, seed?: Snapshot, nsec?: string) {
  const context = await browser.newContext()
  const page = await context.newPage()
  try {
    // Land on the origin before touching storage: IndexedDB and localStorage
    // are partitioned by origin, so writing from about:blank would populate
    // nothing the app can see.
    await page.goto(url, { waitUntil: 'domcontentloaded' })

    if (nsec) {
      // Log in the way a customer does, so the state captured is state the
      // wallet actually writes rather than anything invented here.
      await page.goto(`${url}/onboarding`, { waitUntil: 'domcontentloaded' })
      await page.getByRole('button', { name: 'Log in' }).click()
      await page.getByPlaceholder(/nsec/i).fill(nsec)
      await page.getByPlaceholder('Choose a passphrase').fill('snapshot-passphrase')
      await page.getByPlaceholder('Confirm passphrase').fill('snapshot-passphrase')
      await page.getByRole('button', { name: 'Add key and unlock' }).click()
      await page
        .waitForFunction(() => /Total balance|Scan/.test(document.body.innerText), undefined, {
          timeout: 90_000,
        })
        .catch(() => {})
      // Let the wallet settle whatever it writes on first unlock.
      await page.waitForTimeout(15_000)
    }

    if (seed) await restore(page, seed, context)
    return await capture(page, seed ? seed.coupons : 0, context)
  } finally {
    await context.close()
  }
}

function summarise(snapshot: Pick<Snapshot, 'databases' | 'localStorage'>) {
  const stores = snapshot.databases
    .flatMap((db) => db.stores.map((s) => `${db.name}/${s.name}:${s.records.length}`))
    .sort()
  return {
    stores,
    localStorageKeys: Object.keys(snapshot.localStorage).sort(),
  }
}

async function main() {
  const site = await serve(join(ROOT, 'dist'), { withGateway: true })
  const browser = await chromium.launch()

  try {
    // A wallet with real state in it, produced by the real issuing flow.
    //
    // A first visit alone leaves nothing stored, and every check below then
    // passes vacuously: six of seven "passed" against an empty wallet on the
    // first run of this file, comparing nothing to nothing. So the state is
    // made real first, and the guard below stays as the thing that catches it
    // if that ever stops working.
    const customer = `snapshot-${Date.now().toString(36)}`
    const seeded = execFileSync(
      'node',
      ['scripts/seed-merchant.mjs', '--quantity', '2', '--customer', customer],
      { cwd: ROOT, encoding: 'utf8' },
    )
    const nsec = seeded.match(/nsec\s+(nsec1\w+)/)?.[1]
    if (!nsec) throw new Error('no customer key from the seeder')

    const original = {
      ...(await readState(browser, site.url, undefined, nsec)),
      sourceHash: sourceHash(ROOT),
    }
    record(
      'there is real state to round trip',
      countRecords(original) > 0 && Object.keys(original.localStorage).length > 0,
      `${countRecords(original)} records, ${Object.keys(original.localStorage).length} localStorage keys ` +
        '(a wallet logged in through the real onboarding form)',
    )

    // A FRESH context: nothing carried over, so anything present afterwards
    // was put there by restore.
    const roundTripped = await readState(browser, site.url, original)

    const before = summarise(original)
    const after = summarise(roundTripped)

    record(
      'every database and store comes back',
      JSON.stringify(before.stores) === JSON.stringify(after.stores),
      `before ${JSON.stringify(before.stores)}\n      after  ${JSON.stringify(after.stores)}`,
    )

    record(
      'every localStorage key comes back',
      JSON.stringify(before.localStorageKeys) === JSON.stringify(after.localStorageKeys),
      `${before.localStorageKeys.length} keys before, ${after.localStorageKeys.length} after`,
    )

    record(
      'record counts match exactly',
      countRecords(original) === countRecords(roundTripped),
      `${countRecords(original)} before, ${countRecords(roundTripped)} after`,
    )

    // Content, not just shape. A restore that wrote the right number of empty
    // objects would pass every check above.
    const originalRecords = JSON.stringify(
      original.databases.flatMap((db) => db.stores.flatMap((s) => s.records)),
    )
    const restoredRecords = JSON.stringify(
      roundTripped.databases.flatMap((db) => db.stores.flatMap((s) => s.records)),
    )
    record(
      'record contents survive, not just their count',
      originalRecords === restoredRecords,
      originalRecords === restoredRecords
        ? 'byte-identical after a round trip through IndexedDB'
        : 'contents differ after restore',
    )

    // Schema, not just data. A store restored without its indexes would read
    // back identically and then behave differently under the wallet's own
    // queries, which is the kind of drift a snapshot exists to avoid.
    const versionsMatch = original.databases.every((db) => {
      const other = roundTripped.databases.find((d) => d.name === db.name)
      return other && other.version === db.version
    })
    record(
      'database versions survive',
      versionsMatch,
      original.databases.map((d) => `${d.name} v${d.version}`).join(', '),
    )

    // The negative case: restoring must REPLACE, not merge. Otherwise a
    // scenario measuring 100 coupons after one measuring 1000 would silently
    // measure 1100.
    const polluted = await browser.newContext()
    const pollutedPage = await polluted.newPage()
    await pollutedPage.goto(site.url, { waitUntil: 'domcontentloaded' })
    await pollutedPage.evaluate(() => {
      localStorage.setItem('a-key-from-a-previous-run', 'stale')
    })
    await restore(pollutedPage, original, polluted)
    const afterPollution = await capture(pollutedPage, original.coupons, polluted)
    await polluted.close()

    record(
      'restore replaces stored databases rather than merging into them',
      countRecords(afterPollution) === countRecords(original),
      `${countRecords(afterPollution)} records after restoring over a dirty context, ` +
        `expected ${countRecords(original)}`,
    )
  } finally {
    await browser.close()
    await site.close()
  }

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length > 0) {
    console.log(`failed: ${failed.map((f) => f.name).join(', ')}`)
    process.exit(1)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
