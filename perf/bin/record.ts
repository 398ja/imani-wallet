#!/usr/bin/env node
/**
 * Record a fixture snapshot from the real issuing flow.
 *
 *   npm run perf:record -- --coupons 10
 *
 * Slow, and needs the whole local stack up (`./deploy/up.sh`). That is the
 * point: this is the honest path into wallet state, and it runs rarely so the
 * per-commit check can be fast.
 *
 * The alternative was writing invented records straight into storage, which
 * would take a second and reach any size. It was rejected because invented
 * state drifts from what the wallet actually writes, and a suite measuring a
 * shape production never produces reports green while telling you nothing.
 */

import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { serve } from '../lib/serve'
import { capture, countRecords, type Snapshot } from '../lib/snapshot'
import { FIXTURE_PASSPHRASE } from '../scenarios/coldBoot'
import { sourceHash } from '../lib/sources'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..')
const DIST = join(ROOT, 'dist')
const SNAPSHOTS = join(ROOT, 'perf/snapshots')

function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}

const COUPONS = Number(flag('coupons', '10'))

/** Issue real coupons to a fresh customer, and return their key. */
function issueTo(count: number): { nsec: string; npub: string } {
  console.log(`Issuing ${count} coupons through the real flow…`)
  // A fresh customer every recording. The seeder's default identity
  // (`demo-customer`) is stable across runs by design, so it accumulates
  // coupons from every previous recording and the wallet under measurement
  // would hold an unknown number of them. A recording has to know exactly what
  // it recorded.
  const customer = `perf-${Date.now().toString(36)}`
  const out = execFileSync(
    'node',
    ['scripts/seed-merchant.mjs', '--quantity', String(count), '--customer', customer],
    { cwd: ROOT, encoding: 'utf8' },
  )
  const nsec = out.match(/nsec\s+(nsec1\w+)/)?.[1]
  const npub = out.match(/customer\s+(npub1\w+)/)?.[1]
  if (!nsec || !npub) {
    throw new Error(`could not read the customer key from the seeder:\n${out}`)
  }
  const delivered = Number(out.match(/delivered (\d+)/)?.[1] ?? '0')
  if (delivered < count) {
    throw new Error(`only ${delivered} of ${count} coupons were delivered; the stack may be unwell`)
  }
  console.log(`  ${delivered} delivered to ${npub.slice(0, 16)}…`)
  return { nsec, npub }
}

async function main() {
  if (!existsSync(join(DIST, 'index.html'))) {
    console.error('No build to record against. Run `npm run build` first.')
    process.exit(2)
  }

  const { nsec } = issueTo(COUPONS)
  const site = await serve(DIST, { withGateway: true })
  const browser = await chromium.launch()

  try {
    const context = await browser.newContext()
    const page = await context.newPage()

    console.log('Opening the wallet and waiting for the coupons to arrive…')

    // Sign in through the onboarding import form, exactly as a customer would.
    //
    // Deliberately not by writing a key into localStorage: the wallet holds
    // the key PBKDF2 + AES-GCM encrypted, and `nap.ts` notes that RFC §1181
    // forbids plaintext key material at rest. A recording that planted a
    // plaintext key would be starting the wallet from a state it is designed
    // never to be in, and whatever it then measured would not be the real
    // startup path.
    // The shared fixture passphrase, so a scenario can unlock what this
    // records. A restored wallet always boots locked: the resume record's
    // wrapping key is non-extractable by design, so no snapshot can carry an
    // unlocked session.
    const PASSPHRASE = FIXTURE_PASSPHRASE
    await page.goto(`${site.url}/onboarding`, { waitUntil: 'domcontentloaded' })

    await page.getByRole('button', { name: 'Log in' }).click()
    await page.getByPlaceholder(/nsec/i).fill(nsec)
    await page.getByPlaceholder('Choose a passphrase').fill(PASSPHRASE)
    await page.getByPlaceholder('Confirm passphrase').fill(PASSPHRASE)
    await page.getByRole('button', { name: 'Add key and unlock' }).click()

    // Wait until the wallet has actually stored the coupons.
    //
    // An explicit loop rather than `page.waitForFunction`, because that helper
    // treats an ASYNC predicate's return value as the result: a Promise is
    // always truthy, so it resolves on the first tick without ever polling.
    // Counting IndexedDB records requires await, so the predicate has to be
    // async, so the helper cannot be used here. An earlier version did use it
    // and reported "stored null" instantly.
    const deadline = Date.now() + 120_000
    let stored = 0
    while (Date.now() < deadline) {
      stored = await page.evaluate(async () => {
        const dbs = await indexedDB.databases()
        let total = 0
        for (const { name } of dbs) {
          if (!name) continue
          const db = await new Promise<IDBDatabase>((ok, no) => {
            const r = indexedDB.open(name)
            r.onsuccess = () => ok(r.result)
            r.onerror = () => no(r.error)
          })
          for (const store of Array.from(db.objectStoreNames)) {
            total += await new Promise<number>((ok) => {
              const r = db.transaction(store, 'readonly').objectStore(store).count()
              r.onsuccess = () => ok(r.result)
              r.onerror = () => ok(0)
            })
          }
          db.close()
        }
        return total
      })
      if (stored >= COUPONS) break
      await new Promise((r) => setTimeout(r, 1000))
    }

    console.log(`  stored ${stored} records (wanted ${COUPONS})`)

    const recorded = await capture(page, COUPONS, context)
    const snapshot: Snapshot = { ...recorded, sourceHash: sourceHash(ROOT) }

    // Refuse to record a wallet holding fewer coupons than were issued.
    //
    // An empty wallet was already refused, but a PARTIAL one is the more
    // dangerous case: it writes a plausible snapshot that every later scenario
    // trusts, and the ladder then measures 1 coupon while claiming 1000. The
    // count is the fixture's entire meaning.
    const couponStore = snapshot.databases
      .flatMap((db) => db.stores)
      .find((store) => store.name === 'wallet_vouchers')
    const held = couponStore ? couponStore.records.length : 0

    if (held < COUPONS) {
      throw new Error(
        `the wallet holds ${held} of the ${COUPONS} coupons that were issued, so ` +
          'this snapshot would misrepresent what it contains. Refusing to write it.\n\n' +
          'If the gateway is serving only the newest gift wrap per recipient, that ' +
          'is issue #36 and this is the expected symptom.',
      )
    }

    mkdirSync(SNAPSHOTS, { recursive: true })
    const file = join(SNAPSHOTS, `coupons-${COUPONS}.json`)
    writeFileSync(file, JSON.stringify(snapshot, null, 2) + '\n')

    console.log(`\nRecorded ${countRecords(snapshot)} records to ${file}`)
    console.log(`  source hash ${snapshot.sourceHash}`)
    console.log(`  databases: ${snapshot.databases.map((d) => `${d.name} v${d.version}`).join(', ')}`)
    for (const db of snapshot.databases) {
      for (const store of db.stores) {
        if (store.records.length) console.log(`    ${store.name}: ${store.records.length}`)
      }
    }
  } finally {
    await browser.close()
    await site.close()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
