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
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { nip19 } from 'nostr-tools'
import { hexToBytes } from '@noble/hashes/utils'
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

/**
 * Record from a customer that already holds coupons, instead of issuing.
 *
 *   npm run perf:record -- --coupons 5 --customer ladder-src
 *
 * Issuing needs the whole settlement chain healthy. Recording needs only that
 * the wallet can READ what it already holds, which is a much smaller ask and a
 * different code path. Separating them means a fixture can still be captured
 * when issuance is blocked — as it is whenever the gateway and mint images are
 * out of step — and it lets one seeded customer serve several rungs of the
 * ladder without re-issuing for each.
 */
const EXISTING_CUSTOMER = flag('customer', '')

/**
 * Currencies to issue in, cycled over the coupons.
 *
 * Every fourth coupon is USD so that a recorded wallet holds more than one
 * currency. `--currencies EUR` restores the single-currency behaviour.
 */
const CURRENCIES = flag('currencies', 'EUR,EUR,EUR,USD').split(',')

/** Issue real coupons to a fresh customer, and return their key. */
/** Poll the gateway until it serves the gift wraps this customer holds. */
async function waitForGatewayToServe(npub: string, expected: number): Promise<void> {
  const pubHex = nip19.decode(npub).data as string
  const gateway = process.env.GATEWAY_URL ?? 'http://localhost:28082'
  const deadline = Date.now() + 120_000

  process.stdout.write('Waiting for the gateway to serve them')
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${gateway}/api/v1/nostr/query`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kinds: [1059], pTags: [pubHex], limit: 100 }),
        signal: AbortSignal.timeout(10_000),
      })
      const body = (await res.json()) as { events?: unknown[] }
      const served = body.events?.length ?? 0
      if (served >= expected) {
        console.log(` ${served}/${expected}`)
        return
      }
    } catch {
      // Keep waiting: a transient failure here is not a verdict.
    }
    process.stdout.write('.')
    await new Promise((r) => setTimeout(r, 2000))
  }
  console.log(' timed out')
  console.warn(
    'the gateway never served all the gift wraps. If it serves fewer than were ' +
      'issued, the gateway image predates the frame-ordering fix (issue #36).',
  )
}

/** Read a customer the seeder created earlier, rather than issuing new coupons. */
function keysForSeededCustomer(name: string): { nsec: string; npub: string } {
  const keys = JSON.parse(readFileSync(join(ROOT, '.seed-keys.json'), 'utf8')) as Record<
    string,
    { sk: string; pk: string }
  >
  const entry = keys[name]
  if (!entry) {
    throw new Error(
      `no seeded customer named "${name}". Create one with:\n\n` +
        `  node scripts/seed-merchant.mjs --quantity 1 --customer ${name}\n`,
    )
  }
  console.log(`Recording from the existing customer "${name}" (no new issuance)`)
  return {
    nsec: nip19.nsecEncode(hexToBytes(entry.sk)),
    npub: nip19.npubEncode(entry.pk),
  }
}

function issueTo(count: number): { nsec: string; npub: string } {
  // A fresh customer every recording. The seeder's default identity
  // (`demo-customer`) is stable across runs by design, so it accumulates
  // coupons from every previous recording and the wallet under measurement
  // would hold an unknown number of them. A recording has to know exactly what
  // it recorded.
  const customer = `perf-${Date.now().toString(36)}`

  // A unique customer per run, so two recordings cannot read each other's
  // coupons: the wait counts what the customer holds, and a shared name would
  // count coupons from every previous recording.
  //
  // That makes runs independent in what they READ, but not in what they spend.
  // Issuance goes through the GATEWAY's single cashu wallet, so concurrent
  // recordings make the mint reject proofs it has already spent (11001) —
  // surfacing here as "never produced a token", and leaving the gateway broken
  // for later runs until its H2 file is cleared. Run one at a time.
  //
  // Two at once sometimes both succeed, which is the awkward part: it looks
  // supported right up until a longer run collides.

  // One coupon per call, repeated, rather than one call for the whole batch.
  //
  // `--quantity N` issues N vouchers inside a single run and the mint's
  // settlement saga does not reliably keep up: the seeder gives up with
  // "never produced a token" well before the last one lands. Issuing singly is
  // slower and it works, which is the trade a fixture recording wants — this
  // runs rarely by design.
  console.log(`Issuing ${count} coupon${count === 1 ? '' : 's'} through the real flow…`)
  let nsec: string | undefined
  let npub: string | undefined
  let delivered = 0

  for (let i = 0; i < count; i++) {
    // A second currency, for the scenarios that total a balance.
    //
    // Adding EUR to USD would be a confident lie, so the wallet keeps one
    // figure per currency and aggregation has to walk them separately. A
    // single-currency fixture would measure the easy path and call it done.
    //
    // A minority rather than a half: the realistic shape is a customer whose
    // coupons are mostly from one place, and it keeps the primary total
    // stable enough to assert on.
    const currency = CURRENCIES[i % CURRENCIES.length]
    const out = execFileSync(
      'node',
      [
        'scripts/seed-merchant.mjs',
        '--quantity',
        '1',
        '--customer',
        customer,
        '--currency',
        currency,
      ],
      { cwd: ROOT, encoding: 'utf8' },
    )
    nsec = out.match(/nsec\s+(nsec1\w+)/)?.[1] ?? nsec
    npub = out.match(/customer\s+(npub1\w+)/)?.[1] ?? npub
    delivered += Number(out.match(/delivered (\d+)/)?.[1] ?? '0')
    process.stdout.write(`  ${delivered}/${count}\r`)
  }
  console.log(`  ${delivered}/${count} delivered`)

  if (!nsec || !npub) {
    throw new Error('could not read the customer key from the seeder')
  }
  if (delivered < count) {
    throw new Error(`only ${delivered} of ${count} coupons were delivered; the stack may be unwell`)
  }
  return { nsec, npub }
}

/** How many coupons the wallet is holding right now. */
async function countCoupons(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(async () => {
    const dbs = await indexedDB.databases()
    let coupons = 0
    for (const { name } of dbs) {
      if (!name) continue
      const db = await new Promise<IDBDatabase>((ok, no) => {
        const r = indexedDB.open(name)
        r.onsuccess = () => ok(r.result)
        r.onerror = () => no(r.error)
      })
      if (db.objectStoreNames.contains('wallet_vouchers')) {
        coupons += await new Promise<number>((ok) => {
          const r = db.transaction('wallet_vouchers', 'readonly')
            .objectStore('wallet_vouchers')
            .count()
          r.onsuccess = () => ok(r.result)
          r.onerror = () => ok(0)
        })
      }
      db.close()
    }
    return coupons
  })
}

async function main() {
  if (!existsSync(join(DIST, 'index.html'))) {
    console.error('No build to record against. Run `npm run build` first.')
    process.exit(2)
  }

  const { nsec, npub } = EXISTING_CUSTOMER ? keysForSeededCustomer(EXISTING_CUSTOMER) : issueTo(COUPONS)

  // Wait for the GATEWAY to serve the gift wraps before opening the wallet.
  //
  // The wallet fetches its DMs once at startup and then waits for a live
  // subscription. The gateway ingests from the relay asynchronously, so a
  // wallet opened seconds after delivery fetches zero, finds nothing, and
  // never asks again — the recorder then sat through its whole 120s wait
  // holding a wallet that had already given up. Observed:
  //
  //   [DmPollService] Fetched 0 gift wrap events
  //   wallet holds 0 coupons (wanted 1)
  //
  // while the relay had the wrap and the gateway began serving it moments
  // later. Waiting here, before the wallet opens, removes the race rather than
  // papering over it with a longer wait afterwards.
  await waitForGatewayToServe(npub, COUPONS)
  const site = await serve(DIST, { withGateway: true })
  const browser = await chromium.launch()

  try {
    const context = await browser.newContext()
    const page = await context.newPage()
    if (process.env.DEBUG_RECORD) {
      page.on('console', (m) => {
        const t = m.text()
        if (m.type() === 'error' || /DmPoll|gift|wrap|redeem|SSE|sse|coupon|voucher|store/i.test(t))
          console.log(`   [browser:${m.type()}]`, t.slice(0, 190))
      })
      // Correlate request with response: interleaved logs made an empty answer
      // to a DIFFERENT query look like the answer to the 1059 one.
      // Correlate the gift-wrap query with its answer. Interleaved logs once
      // made an empty response to a DIFFERENT query look like the answer to
      // this one, which sent an investigation down the wrong path.
      page.on('pageerror', (e) => console.log(`   [pageerror] ${String(e).slice(0, 200)}`))
      page.on('framenavigated', (f) => {
        if (f === page.mainFrame()) console.log(`   [navigated] ${f.url().slice(0, 120)}`)
      })
      page.on('requestfailed', (r) => {
        console.log(`   [failed] ${r.url().slice(0, 110)} :: ${r.failure()?.errorText}`)
      })
      page.on('response', async (r) => {
        if (r.status() === 401 || r.status() === 404)
          console.log(`   [${r.status()}] ${r.request().method()} ${r.url().slice(0, 130)}`)
        if (/keyset|\/v1\//.test(r.url())) console.log(`   [mint] ${r.status()} ${r.url().slice(0, 100)}`)
        if (!r.url().includes('nostr/query')) return
        const req = r.request().postData() ?? ''
        if (!req.includes('1059')) return
        const body = await r.text().catch(() => '')
        console.log(`   [gift wraps] ${req.slice(0, 120)}`)
        console.log(`               -> ${r.status()} ${body.slice(0, 100)}`)
      })
    }

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

    // Wait until the wallet has actually stored the coupons, RELOADING when it
    // has not.
    //
    // The wallet fetches its DMs once at startup and then relies on a live
    // subscription. If that one fetch lands while the gateway is still
    // ingesting, it gets zero and never asks again — waiting longer changes
    // nothing, because nothing is going to ask a second time.
    //
    // Observed: the gateway confirmed 1/1 served, the wallet's very next query
    // (same filter, same pubkey) returned 0, and a passive 120s wait then sat
    // there holding a wallet that had already given up. That is issue #36's
    // non-determinism reaching the wallet, so the recorder retries the only
    // way a customer could: by reopening the app.
    // Wait, and do not touch the page.
    //
    // Reloading used to be the recovery here, a workaround for the gateway
    // serving zero gift wraps (#36). That bug is fixed, and the reload is now
    // purely destructive: DmPollService redeems its wraps in ONE sequential
    // loop, so a reload part-way through kills the loop where it stands — and
    // it lands on /login, because the resume key is scoped to the tab and the
    // gateway session does not survive. From there the wallet can never finish,
    // and it recorded 1 of 5, then 5 of 20, looking each time like a delivery
    // fault rather than an interrupted loop.
    //
    // The budget scales with the count: redemption is per-coupon work, and
    // each coupon is a full swap against the mint — measured at ~12s each on
    // this stack, so 20 coupons take four minutes. A fixed timeout silently
    // truncated the larger ladder rungs (20 recorded as 15, still climbing).
    // The stall check below is what actually catches a hang, so this only has
    // to be generous.
    const budgetMs = Math.max(180_000, COUPONS * 20_000)
    const deadline = Date.now() + budgetMs
    let stored = 0
    let lastProgress = Date.now()
    let lastCount = 0

    while (Date.now() < deadline) {
      stored = await countCoupons(page)
      if (stored >= COUPONS) break

      if (stored > lastCount) {
        lastCount = stored
        lastProgress = Date.now()
        process.stdout.write(`\r  redeemed ${stored}/${COUPONS}`)
      }

      // Stalled, not slow. Report it rather than reloading: the guard below
      // refuses the snapshot anyway, and saying WHERE it stopped is worth more
      // than a retry that cannot succeed.
      if (Date.now() - lastProgress > 90_000) {
        console.log(`\n  no progress for 90s at ${stored}/${COUPONS}`)
        break
      }

      await new Promise((r) => setTimeout(r, 2000))
    }
    if (lastCount > 0) process.stdout.write('\n')

    console.log(`  wallet holds ${stored} coupons (wanted ${COUPONS})`)

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
