#!/usr/bin/env node
/**
 * Run the browser performance suite.
 *
 *   npm run perf              measure, compare to baseline, fail on regression
 *   npm run perf -- --accept  measure, and write the result as the new baseline
 *
 * Accepting a slowdown is deliberately a separate flag that edits a tracked
 * file, so it lands in a diff and someone sees it in review.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { hostname } from 'node:os'
import { fileURLToPath } from 'node:url'

import { withBrowser, measureColdBootMedian, FIXTURE_PASSPHRASE } from '../scenarios/coldBoot'
import { load, available } from '../lib/fixture'
import { serve } from '../lib/serve'
import { compare, type Baselines } from '../lib/baseline'
import { runName, regenerateReport, isFailure, type RunSummary, type Comparison } from '../lib/run'
import { assessShape, formatLadder, MIN_RUNGS, type Rung } from '../lib/ladder'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(HERE, '../..')
const DIST = join(ROOT, 'dist')
const BASELINE_FILE = join(ROOT, 'perf/baselines/browser.json')
const SNAPSHOTS = join(ROOT, 'perf/snapshots')
const RESULTS = join(ROOT, 'perf/results')

const accept = process.argv.includes('--accept')

/** Serve the built bundle. A real static server, because a file:// URL is not
 *  how the app is ever loaded and would measure a different thing. */

function commit(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT })
      .toString()
      .trim()
  } catch {
    return 'unknown'
  }
}

function loadBaselines(): Baselines {
  if (!existsSync(BASELINE_FILE)) return {}
  return JSON.parse(readFileSync(BASELINE_FILE, 'utf8')) as Baselines
}

async function main() {
  if (!existsSync(join(DIST, 'index.html'))) {
    console.error('No build to measure. Run `npm run build` first.')
    process.exit(2)
  }

  // withGateway serves the app AND the proxy table from vite.config.ts.
  //
  // Not a backend: nothing here needs the stack running, and the populated
  // rungs were measured with gateway-customer stopped to prove it. But the
  // wallet's unlock posts to /api/v1/auth/*, and without a rule for that path
  // the SPA fallback answers with index.html — the unlock then fails, and the
  // measurement silently becomes a locked wallet rather than a customer's.
  // The guard in measureColdBoot catches exactly that.
  //
  // Shared with the recorder rather than reimplemented. This file had its own
  // copy, which carried the same fallback bug: a missing build asset served as
  // HTML instead of 404.
  const site = await serve(DIST, { withGateway: true })
  const comparisons: Comparison[] = []
  const baselines = loadBaselines()

  const summary: RunSummary = {
    run: runName('cold-boot'),
    commit: commit(),
    host: hostname(),
    startedAt: new Date().toISOString(),
    scenarios: [],
  }

  try {
    const boot = await withBrowser((browser) =>
      measureColdBootMedian(browser, { baseUrl: site.url }),
    )
    console.log(`cold-boot: ${boot.ms}ms (samples ${boot.all.join(', ')})`)
    console.log(`  settled on: ${boot.settledOn}`)

    summary.scenarios.push({ scenario: 'cold-boot', measurements: [{ coupons: 0, ms: boot.ms }] })
    comparisons.push(compare('cold-boot', boot.ms, baselines['cold-boot']))

    // Then the same boot against a wallet that is actually holding coupons.
    //
    // An empty wallet boots fast no matter how badly storage scales, so the
    // empty measurement alone cannot see the cost that matters. Each recorded
    // rung is measured as its own scenario, `cold-boot-5` and so on, because
    // they are different questions and a single number would hide which count
    // moved.
    //
    // Rungs are whatever has been recorded — no fixture, nothing to measure,
    // and that is not a failure of this run. `load` throws on a snapshot taken
    // from different source code, and that IS a failure: measuring it would
    // produce a number that looks fine and means nothing.
    const ladder: Rung[] = []
    const rungs = available(SNAPSHOTS)
    if (rungs.length === 0) {
      console.log('\nNo fixtures recorded, so only the empty wallet was measured.')
      console.log('  npm run perf:record -- --coupons 5')
    }
    for (const coupons of rungs) {
      const fixture = load(SNAPSHOTS, coupons, ROOT)
      const populated = await withBrowser((browser) =>
        measureColdBootMedian(browser, {
          baseUrl: site.url,
          fixture,
          passphrase: FIXTURE_PASSPHRASE,
          timeoutMs: 90_000,
        }),
      )
      const scenario = `cold-boot-${coupons}`
      console.log(
        `\n${scenario}: ${populated.ms}ms (samples ${populated.all.join(', ')})`,
      )
      console.log(`  holding ${populated.couponsHeld} records`)

      summary.scenarios.push({
        scenario,
        measurements: [{ coupons, ms: populated.ms }],
      })
      comparisons.push(compare(scenario, populated.ms, baselines[scenario]))
      ladder.push({ coupons, ms: populated.ms })
    }

    // Assert the SHAPE, once there are enough rungs to have one.
    //
    // This is a different question from every comparison above. Those ask
    // whether a number moved since last time; this asks whether the cost per
    // coupon is flat or climbing, which is the question that survives moving
    // to different hardware. A slower laptop shifts every rung up together and
    // the shape is unchanged.
    //
    // Fewer than MIN_RUNGS is not a failure — it means the ladder has not been
    // recorded yet, and saying which command records it is more useful than a
    // red run.
    if (ladder.length >= MIN_RUNGS) {
      const shape = assessShape(ladder)
      console.log(`\ncold-boot cost shape: ${shape.explanation}`)
      console.log(formatLadder(ladder))

      summary.ladders = [
        {
          scenario: 'cold-boot',
          table: formatLadder(ladder),
          flat: shape.flat,
          explanation: shape.explanation,
        },
      ]

      if (!shape.flat) {
        comparisons.push({
          scenario: 'cold-boot cost shape',
          measuredMs: Math.round(shape.lateSlope * 1000) / 1000,
          verdict: 'regressed',
          note: shape.explanation,
        })
      }
    } else if (rungs.length > 0) {
      console.log(
        `\nCost shape needs ${MIN_RUNGS} rungs to be visible, have ${ladder.length}.` +
          ` Record another: npm run perf:record -- --coupons 500`,
      )
    }
  } finally {
    await site.close()
  }

  if (accept) {
    const next: Baselines = { ...baselines }
    for (const s of summary.scenarios) {
      const ms = s.measurements[0].ms
      next[s.scenario] = {
        ...(next[s.scenario] ?? { tolerancePercent: 25 }),
        ms,
      }
    }
    mkdirSync(join(ROOT, 'perf/baselines'), { recursive: true })
    writeFileSync(BASELINE_FILE, JSON.stringify(next, null, 2) + '\n')
    console.log(`\nBaseline written to ${BASELINE_FILE}. Commit it deliberately.`)
    return
  }

  mkdirSync(RESULTS, { recursive: true })
  const summaryFile = join(RESULTS, `${summary.run}.json`)
  const reportFile = join(RESULTS, `${summary.run}.md`)
  writeFileSync(summaryFile, JSON.stringify(summary, null, 2) + '\n')
  const existing = existsSync(reportFile) ? readFileSync(reportFile, 'utf8') : undefined
  writeFileSync(reportFile, regenerateReport(existing, summary, comparisons))

  const failures = comparisons.filter(isFailure)
  for (const c of comparisons) {
    console.log(`${c.scenario}: ${c.verdict}${c.note ? ` (${c.note})` : ''}`)
  }
  if (failures.length > 0) {
    console.error(`\n${failures.length} scenario(s) regressed. See ${reportFile}`)
    process.exit(1)
  }
  console.log(`\nNo regression. ${reportFile}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
