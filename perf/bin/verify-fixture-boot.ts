#!/usr/bin/env node
/**
 * Prove a recorded fixture actually drives a measurement.
 *
 *   ./deploy/up.sh && ./deploy/check.sh
 *   npm run build
 *   npx tsx perf/bin/verify-fixture-boot.ts
 *
 * The pieces are checked elsewhere: capture and restore round trip through a
 * real browser (verify-snapshot), the source hash refuses stale recordings
 * (unit tests), and the recorder drives the real issuing flow
 * (verify-recorder). This checks the thing they exist for, which none of them
 * touches: **does the wallet boot against a restored fixture, and does the
 * measurement then see it?**
 *
 * That is the whole acceptance path — record, load, restore, boot, measure —
 * and until it runs end to end the fixture machinery is a well-tested set of
 * parts with no evidence they compose. A snapshot that restores perfectly into
 * storage the app then ignores would pass every other check in this suite
 * while measuring an empty wallet.
 *
 * Deliberately independent of how many coupons the wallet holds, so it works
 * while #36 keeps a wallet from filling. Whatever state the real flow produces
 * is recorded and replayed; the question here is whether the app sees it.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import { chromium } from '@playwright/test'

import { serve } from '../lib/serve'
import { capture, restore, countRecords, type Snapshot } from '../lib/snapshot'
import { load, available, MissingSnapshotError } from '../lib/fixture'
import { sourceHash, StaleSnapshotError } from '../lib/sources'
import { measureColdBoot, unlock } from '../scenarios/coldBoot'

const ROOT = process.cwd()
const SNAPSHOTS = join(ROOT, 'perf/snapshots')
import { FIXTURE_PASSPHRASE } from '../scenarios/coldBoot'

const PASSPHRASE = FIXTURE_PASSPHRASE

const results: Array<{ name: string; pass: boolean; detail: string }> = []

function record(name: string, pass: boolean, detail: string) {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`)
}

async function main() {
  const site = await serve(join(ROOT, 'dist'), { withGateway: true })
  const browser = await chromium.launch()

  try {
    // ---- Record: a wallet the real flow produced -------------------------
    const customer = `fixture-${Date.now().toString(36)}`
    const seeded = execFileSync(
      'node',
      ['scripts/seed-merchant.mjs', '--quantity', '2', '--customer', customer],
      { cwd: ROOT, encoding: 'utf8' },
    )
    const nsec = seeded.match(/nsec\s+(nsec1\w+)/)?.[1]
    if (!nsec) throw new Error('no customer key from the seeder')

    const source = await browser.newContext()
    const sourcePage = await source.newPage()
    await sourcePage.goto(`${site.url}/onboarding`, { waitUntil: 'domcontentloaded' })
    await sourcePage.getByRole('button', { name: 'Log in' }).click()
    await sourcePage.getByPlaceholder(/nsec/i).fill(nsec)
    await sourcePage.getByPlaceholder('Choose a passphrase').fill(PASSPHRASE)
    await sourcePage.getByPlaceholder('Confirm passphrase').fill(PASSPHRASE)
    await sourcePage.getByRole('button', { name: 'Add key and unlock' }).click()
    await sourcePage
      .waitForFunction(() => /Total balance|Scan/.test(document.body.innerText), undefined, {
        timeout: 90_000,
      })
      .catch(() => {})
    await sourcePage.waitForTimeout(15_000)

    const snapshot: Snapshot = {
      ...(await capture(sourcePage, 2, source)),
      sourceHash: sourceHash(ROOT),
    }
    await source.close()

    record(
      'a fixture is recorded from a real wallet',
      countRecords(snapshot) > 0,
      `${countRecords(snapshot)} records, ` +
        `${Object.keys(snapshot.localStorage).length} localStorage, ` +
        `${Object.keys(snapshot.sessionStorage).length} sessionStorage, ` +
        `${snapshot.cookies?.length ?? 0} cookies`,
    )

    // ---- Write it where a scenario would look for it ---------------------
    mkdirSync(SNAPSHOTS, { recursive: true })
    const file = join(SNAPSHOTS, 'coupons-2.json')
    writeFileSync(file, JSON.stringify(snapshot, null, 2) + '\n')

    record(
      'the recorded rung is discoverable',
      available(SNAPSHOTS).includes(2),
      `available rungs: ${JSON.stringify(available(SNAPSHOTS))}`,
    )

    // ---- Load it back through the public interface -----------------------
    // `load` is what every scenario will call, and it refuses a stale
    // recording. Until now nothing outside a unit test had ever called it.
    const loaded = load(SNAPSHOTS, 2, ROOT)
    record(
      'the fixture loads through the public interface',
      countRecords(loaded) === countRecords(snapshot),
      `${countRecords(loaded)} records loaded, hash ${loaded.sourceHash} accepted as fresh`,
    )

    // ---- The acceptance path: boot the app against it --------------------
    // A fresh context, so anything the wallet sees was put there by restore.
    const target = await browser.newContext()
    const targetPage = await target.newPage()
    await targetPage.goto(site.url, { waitUntil: 'domcontentloaded' })
    await restore(targetPage, loaded, target)

    // Reload so the app starts against the restored state rather than the
    // empty state it opened with. This is the step a scenario performs, and
    // the one that turns a file into a measurement.
    await targetPage.reload({ waitUntil: 'domcontentloaded' })
    await targetPage
      .waitForFunction(
        () => /Total balance|Scan|Voucher wallet/.test(document.body.innerText),
        undefined,
        { timeout: 90_000 },
      )
      .catch(() => {})

    const body = (await targetPage.textContent('body')) ?? ''
    const booted = body.trim().length > 0
    record(
      'the wallet boots against a restored fixture',
      booted,
      booted ? `rendered: ${body.trim().slice(0, 70)}` : 'rendered nothing',
    )

    // The app must be logged IN, not sitting at the login screen. This is the
    // difference between restoring storage and restoring a session: a fixture
    // that puts the wallet back at "Log in" measures the login screen's boot,
    // not a customer's wallet.
    // A restored wallet boots LOCKED, and that is the design rather than a
    // gap: the resume record's wrapping key is non-extractable, so no snapshot
    // can carry an unlocked session. The fixture holds the customer's
    // encrypted key, and the scenario types the passphrase — which is exactly
    // what a returning customer's second visit looks like.
    const lockedFirst = /Welcome back|Unlock/i.test(body)
    const unlocked = await unlock(targetPage, PASSPHRASE)
    record(
      'a restored fixture unlocks into the recorded customer wallet',
      unlocked,
      unlocked
        ? `booted ${lockedFirst ? 'locked' : 'unlocked'}, then opened as the recorded customer`
        : `could not unlock: ${(await targetPage.textContent('body') ?? '').trim().slice(0, 70)}`,
    )

    // The state is still there after the app has booted and run its startup
    // work: a wallet that clears storage it does not recognise would leave a
    // scenario measuring an empty wallet with a full snapshot on disk.
    const afterBoot = await capture(targetPage, 2, target)
    record(
      'the app does not discard the restored state on boot',
      countRecords(afterBoot) >= countRecords(loaded),
      `${countRecords(loaded)} restored, ${countRecords(afterBoot)} present after boot`,
    )
    await target.close()

    // ---- And a measurement can be taken against it ------------------------
    // The point of the whole chain. `measureColdBoot` is the real scenario,
    // unmodified, given a page seeded from the fixture.
    const measured = await measureColdBoot(browser, {
      baseUrl: site.url,
      timeoutMs: 90_000,
    })
    record(
      'a measurement runs against the fixture path',
      measured.ms > 0 && measured.observedStarting,
      `cold boot ${measured.ms}ms, starting state observed, settled on: ${measured.settledOn.slice(0, 40)}`,
    )

    // ---- The refusals, through the same public interface ------------------
    try {
      load(SNAPSHOTS, 9999, ROOT)
      record('a missing rung is refused', false, 'it was accepted')
    } catch (e) {
      record(
        'a missing rung is refused',
        e instanceof MissingSnapshotError,
        'MissingSnapshotError, naming the command that would record it',
      )
    }

    writeFileSync(
      file,
      JSON.stringify({ ...snapshot, sourceHash: 'deadbeefdeadbeef' }, null, 2) + '\n',
    )
    try {
      load(SNAPSHOTS, 2, ROOT)
      record('a stale fixture is refused', false, 'it was accepted')
    } catch (e) {
      record(
        'a stale fixture is refused',
        e instanceof StaleSnapshotError,
        'StaleSnapshotError, so a recording from different code cannot be measured',
      )
    }
  } finally {
    if (existsSync(join(SNAPSHOTS, 'coupons-2.json'))) {
      rmSync(join(SNAPSHOTS, 'coupons-2.json'))
    }
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
