#!/usr/bin/env node
/**
 * Watch the services during a run, and stop the run when one of them fails.
 *
 *   node loadtest/abort-watch.mjs &            # writes a sentinel the run reads
 *   node loadtest/abort-watch.mjs --check      # one pass, print and exit
 *
 * A run that keeps going after a subsystem has failed is generating data that
 * is already invalid. Worse, it buries the moment things went wrong under
 * minutes of consequences.
 *
 * WHY THESE SIGNALS AND NOT OTHERS
 *
 * Every pattern below is marked `observed` or `unproven`, and the distinction
 * is the entire point of this file.
 *
 * The retired imani-apps project's plan predicted a connection pool would fail
 * with `Connection is not available, request timed out`. Under real load it
 * failed with `HikariDataSource has been closed` — a *closed* pool, not a
 * timeout waiting for a slot. Its own run report records the outcome: "Hikari
 * `Connection is not available`: 0 observations". The predicted signal never
 * fired, and the run produced hours of worthless data while a poller watched
 * for a string that was never going to appear.
 *
 * So `observed` means a real run saw this exact text. `unproven` means it is a
 * reasonable guess and has never fired, and should be treated as decoration
 * until it does. Adding a pattern here is cheap; believing an unproven one is
 * what costs a run.
 */

import { execFile } from 'node:child_process'
import { writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { promisify } from 'node:util'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const SENTINEL = process.env.ABORT_SENTINEL || join(HERE, '.abort-sentinel')
const INTERVAL_MS = Number(process.env.ABORT_POLL_MS || 5000)
const CHECK_ONLY = process.argv.includes('--check')
const PORT = Number(process.env.ABORT_WATCH_PORT || 8766)

/**
 * The current verdict, served over HTTP.
 *
 * k6 has no filesystem access, so a sentinel file alone cannot reach the run.
 * The file is still written, because it is what an operator reads afterwards
 * to see why a run stopped.
 */
let verdict = { breaches: [] }

/**
 * What a failing subsystem actually says.
 *
 * `confidence: 'observed'` — seen in a real run, with the count that was seen.
 * `confidence: 'unproven'` — plausible, never yet fired. Do not trust it.
 */
const SIGNALS = [
  {
    name: 'connection pool closed mid-request',
    container: 'gateway-customer-test',
    pattern: 'HikariDataSource has been closed',
    confidence: 'observed',
    note: '316 occurrences in imani-apps run 002, while the predicted "Connection is not available" never appeared once',
  },
  {
    name: 'relay subscription failing',
    container: 'gateway-core-test',
    pattern: 'relay_subscription_failed',
    confidence: 'observed',
    note: '332 occurrences in imani-apps run 002, starting ~564ms before the pool closures',
  },
  {
    name: 'proof repository write failing',
    container: 'gateway-customer-test',
    pattern: 'proof_repository persist_failed',
    confidence: 'observed',
    note: '243 occurrences in imani-apps run 002, downstream of the closed pool',
  },
  {
    name: 'coupon check failing',
    container: 'gateway-customer-test',
    pattern: 'check_pending_voucher_failed',
    confidence: 'observed',
    note: '117 occurrences in imani-apps run 002',
  },
  {
    name: 'connection pool exhausted',
    container: 'gateway-customer-test',
    pattern: 'Connection is not available',
    confidence: 'unproven',
    note: 'imani-apps PLAN predicted this and its runs recorded 0 observations. Kept because a genuinely exhausted pool would say it, but it has never fired.',
  },
  {
    name: 'coupon proofs unbound',
    container: 'imani-mint-rest-test',
    pattern: 'proofs_not_bound',
    confidence: 'unproven',
    note: 'A correctness failure worth catching. Never observed.',
  },
]

/**
 * Rate limiting is NOT an abort signal.
 *
 * It is the deployment defending itself, and on this stack it is the expected
 * finding rather than a fault. Aborting on it would end every issuance run at
 * the moment it discovered the thing it went looking for.
 */

async function countSince(container, pattern, since) {
  try {
    const { stdout, stderr } = await run(
      'docker',
      ['logs', '--since', since, container],
      { maxBuffer: 64 * 1024 * 1024 },
    )
    const haystack = stdout + stderr
    let count = 0
    let at = haystack.indexOf(pattern)
    while (at !== -1) {
      count++
      at = haystack.indexOf(pattern, at + pattern.length)
    }
    return count
  } catch {
    // A container that is not running is not a breach: a run against staging
    // has no local containers at all, and this poller simply has nothing to
    // watch. Reporting that as a failure would abort every remote run.
    return null
  }
}

async function poll(since) {
  const breaches = []
  for (const signal of SIGNALS) {
    const count = await countSince(signal.container, signal.pattern, since)
    if (count === null) continue
    if (count > 0) breaches.push({ ...signal, count })
  }
  return breaches
}

function describe(breach) {
  return (
    `${breach.name}: ${breach.count} occurrence(s) of "${breach.pattern}" ` +
    `in ${breach.container} [${breach.confidence}]`
  )
}

async function main() {
  if (CHECK_ONLY) {
    const breaches = await poll('1h')
    if (breaches.length === 0) {
      console.log('No subsystem failures in the last hour.')
      const watched = SIGNALS.filter((s) => s.confidence === 'observed').length
      console.log(`Watching ${SIGNALS.length} signals (${watched} observed, ${SIGNALS.length - watched} unproven).`)
      return
    }
    for (const breach of breaches) console.log(`BREACH  ${describe(breach)}`)
    process.exit(1)
  }

  if (existsSync(SENTINEL)) unlinkSync(SENTINEL)

  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(verdict))
  })
  server.listen(PORT, '127.0.0.1')

  console.log(`watching ${SIGNALS.length} signals every ${INTERVAL_MS}ms`)
  console.log(`serving  http://127.0.0.1:${PORT}`)
  console.log(`sentinel ${SENTINEL}`)

  for (;;) {
    const breaches = await poll(`${Math.ceil(INTERVAL_MS / 1000) + 2}s`)
    if (breaches.length > 0) {
      const report = {
        at: new Date().toISOString(),
        breaches: breaches.map((b) => ({
          name: b.name,
          pattern: b.pattern,
          container: b.container,
          count: b.count,
          confidence: b.confidence,
          note: b.note,
        })),
      }
      verdict = report
      writeFileSync(SENTINEL, JSON.stringify(report, null, 2))
      console.error('\nABORT')
      for (const breach of breaches) console.error(`  ${describe(breach)}`)
      console.error(`\nWrote ${SENTINEL}. The run will stop at its next iteration.`)
      // Stay up briefly so the run can read the verdict before this exits.
      setTimeout(() => process.exit(1), 30_000)
      return
    }
    await new Promise((r) => setTimeout(r, INTERVAL_MS))
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
