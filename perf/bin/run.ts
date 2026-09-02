#!/usr/bin/env node
/**
 * Run the browser performance suite.
 *
 *   npm run perf              measure, compare to baseline, fail on regression
 *   npm run perf -- --accept  measure, and write the result as the new baseline
 *   npm run perf -- --require-fixtures   fail if there are no fixtures to measure
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
import { runLadder, MIN_RUNGS, type Rung, type LadderScenario } from '../lib/ladder'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(HERE, '../..')
const DIST = join(ROOT, 'dist')
const BASELINE_FILE = join(ROOT, 'perf/baselines/browser.json')
const SNAPSHOTS = join(ROOT, 'perf/snapshots')
const RESULTS = join(ROOT, 'perf/results')

const accept = process.argv.includes('--accept')

/**
 * Refuse to run without fixtures, rather than quietly measuring less.
 *
 * On a laptop, missing fixtures are ordinary: they are gitignored, and a
 * developer may not have recorded any yet. Degrading to the empty wallet and
 * saying so is the right answer there.
 *
 * In CI it is the wrong answer entirely. An empty wallet boots fast no matter
 * how badly storage scales, so a runner with no fixtures measures the one case
 * that cannot fail, reports green, and the populated rungs and the whole cost
 * shape assertion silently stop running. That is the failure this suite exists
 * to prevent, wearing the suite's own clothes.
 */
const requireFixtures = process.argv.includes('--require-fixtures')

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
      if (requireFixtures) {
        throw new Error(
          'no fixtures recorded, and --require-fixtures was passed.\n\n' +
            'Without them this run measures an empty wallet, which boots fast ' +
            'however badly storage scales — so it would report green having ' +
            'checked nothing that matters.\n\n' +
            '  npm run perf:record -- --coupons 5',
        )
      }
      console.log('\nNo fixtures recorded, so only the empty wallet was measured.')
      console.log('  npm run perf:record -- --coupons 5')
    }
    // Driven through the shared ladder runner rather than a loop of its own.
    //
    // Every remaining scenario (#23-#26) measures across the same rungs, and a
    // scenario that rolled its own loop would drift from the others — a
    // different freshness check, a different idea of how few rungs is too few.
    // The whole point of a ladder is that its rungs are comparable.
    const coldBoot: LadderScenario = {
      name: 'cold-boot',
      measure: async (_coupons, fixture) => {
        const r = await withBrowser((browser) =>
          measureColdBootMedian(browser, {
            baseUrl: site.url,
            fixture,
            passphrase: FIXTURE_PASSPHRASE,
            timeoutMs: 90_000,
          }),
        )
        return { ms: r.ms, all: r.all, held: r.couponsHeld }
      },
    }

    const result = await runLadder(coldBoot, {
      counts: rungs,
      loadFixture: (coupons) => load(SNAPSHOTS, coupons, ROOT),
      onRung: (rung, measurement) => {
        const scenario = `${coldBoot.name}-${rung.coupons}`
        console.log(`\n${scenario}: ${rung.ms}ms (samples ${measurement.all.join(', ')})`)
        console.log(`  holding ${measurement.held} records`)

        summary.scenarios.push({
          scenario,
          measurements: [{ coupons: rung.coupons, ms: rung.ms }],
        })
        comparisons.push(compare(scenario, rung.ms, baselines[scenario]))
      },
    })
    ladder.push(...result.rungs)

    // The SHAPE is a different question from every comparison above. Those ask
    // whether a number moved since last time; this asks whether the cost per
    // coupon is flat or climbing, which is what survives moving to different
    // hardware. A slower laptop shifts every rung up together.
    //
    // Too few rungs is not a failure on a laptop — it means the ladder has not
    // been recorded yet, and naming the command that records it is more useful
    // than a red run. Under --require-fixtures it IS a failure; see below.
    if (result.shape) {
      const shape = result.shape
      console.log(`\n${coldBoot.name} cost shape: ${shape.explanation}`)
      console.log(result.table)

      summary.ladders = [
        {
          scenario: coldBoot.name,
          table: result.table ?? '',
          flat: shape.flat,
          explanation: shape.explanation,
        },
      ]

      if (!shape.flat) {
        comparisons.push({
          scenario: `${coldBoot.name} cost shape`,
          measuredMs: Math.round(shape.lateSlope * 1000) / 1000,
          verdict: 'regressed',
          note: shape.explanation,
        })
      }
    } else if (rungs.length > 0) {
      const message =
        `Cost shape needs ${MIN_RUNGS} rungs to be visible, have ${ladder.length}.` +
        ` Record another: npm run perf:record -- --coupons 500`
      // Same reasoning as above: a ladder too short to have a shape is a
      // developer's ordinary state and CI's silent failure.
      if (requireFixtures) throw new Error(message)
      console.log(`\n${message}`)
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
