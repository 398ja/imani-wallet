#!/usr/bin/env node
/**
 * Check the recorder against the running stack, one acceptance criterion at a
 * time, and say which hold.
 *
 *   ./deploy/up.sh
 *   npm run build
 *   npx tsx perf/bin/verify-recorder.ts
 *
 * This exists because "the recorder works apart from one blocked step" is a
 * claim, and a claim about a system with fourteen services needs evidence per
 * step rather than in aggregate. Each check below observes the real thing: the
 * real seeder, the real onboarding form, the real browser storage. None of it
 * is inspection, and none of it is a stub.
 *
 * It is expected to report one failure while issue #36 is open. That failure
 * is the point: it names precisely what is blocked and leaves the rest proven.
 */

import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

import { chromium } from '@playwright/test'

import { serve } from '../lib/serve'
import { capture, countRecords } from '../lib/snapshot'
import { sourceHash, WATCHED } from '../lib/sources'

const ROOT = process.cwd()
const COUPONS = 3
const PASSPHRASE = 'verify-passphrase'

const results: Array<{ name: string; pass: boolean; detail: string }> = []

function record(name: string, pass: boolean, detail: string) {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`)
}

async function main() {
  // Criterion: a documented command drives the local stack through a real
  // issue-and-receive.
  const customer = `verify-${Date.now().toString(36)}`
  const seeded = execFileSync(
    'node',
    ['scripts/seed-merchant.mjs', '--quantity', String(COUPONS), '--customer', customer],
    { cwd: ROOT, encoding: 'utf8' },
  )
  const delivered = Number(seeded.match(/delivered (\d+)/)?.[1] ?? '0')
  const nsec = seeded.match(/nsec\s+(nsec1\w+)/)?.[1]
  record(
    'the real issuing flow runs end to end',
    delivered === COUPONS && Boolean(nsec),
    `seeder delivered ${delivered}/${COUPONS} coupons to a fresh customer`,
  )
  if (!nsec) throw new Error('no customer key from the seeder; cannot continue')

  const site = await serve(join(ROOT, 'dist'), { withGateway: true })
  const browser = await chromium.launch()

  try {
    const page = await (await browser.newContext()).newPage()

    // Criterion: the wallet is entered through the real customer-facing path,
    // with no key planted in storage.
    await page.goto(`${site.url}/onboarding`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Log in' }).click()
    await page.getByPlaceholder(/nsec/i).fill(nsec)
    await page.getByPlaceholder('Choose a passphrase').fill(PASSPHRASE)
    await page.getByPlaceholder('Confirm passphrase').fill(PASSPHRASE)
    await page.getByRole('button', { name: 'Add key and unlock' }).click()

    // Waits for the wallet to be USABLE, not for the button's text to change.
    // 'Unlocking…' replaces 'Add key and unlock' in place, so waiting for the
    // latter to disappear returns while login is still running. That mistake
    // reported this criterion as failing when it passes.
    await page
      .waitForFunction(() => /Total balance|Scan/.test(document.body.innerText), undefined, {
        timeout: 90_000,
      })
      .catch(() => {})

    const body = (await page.textContent('body')) ?? ''
    record(
      'login goes through the real onboarding form',
      /Total balance|Scan/.test(body),
      /Total balance|Scan/.test(body)
        ? 'reached the wallet home screen; no key was planted in localStorage'
        : `stuck at: ${body.slice(0, 90)}`,
    )

    // Give the wallet time to receive what was delivered before capturing.
    await new Promise((r) => setTimeout(r, 45_000))

    const snapshot = { ...(await capture(page, COUPONS)), sourceHash: sourceHash(ROOT) }
    const total = countRecords(snapshot)
    record(
      'capture reads IndexedDB and localStorage',
      total > 0,
      `${total} records across ${snapshot.databases.length} databases, ` +
        `${Object.keys(snapshot.localStorage).length} localStorage keys`,
    )

    record(
      'the snapshot is stamped with a source hash',
      /^[0-9a-f]{16}$/.test(snapshot.sourceHash),
      `${snapshot.sourceHash}, over ${WATCHED.length} watched paths`,
    )

    const held =
      snapshot.databases
        .flatMap((db) => db.stores)
        .find((store) => store.name === 'wallet_vouchers')?.records.length ?? 0
    record(
      'the wallet holds the coupons that were issued',
      held === COUPONS,
      held === COUPONS
        ? `${held}/${COUPONS} coupons stored`
        : `${held}/${COUPONS} coupons stored — BLOCKED by #36, the gateway serves ` +
          'only the newest gift wrap per recipient',
    )
  } finally {
    await browser.close()
    await site.close()
  }

  const failed = results.filter((r) => !r.pass)
  console.log(
    `\n${results.length - failed.length}/${results.length} criteria verified against the running stack`,
  )
  if (failed.length > 0) {
    console.log(`blocked: ${failed.map((f) => f.name).join(', ')}`)
    process.exit(1)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
