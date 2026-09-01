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
import { createServer } from 'node:http'
import { join, extname, resolve } from 'node:path'
import { hostname } from 'node:os'
import { fileURLToPath } from 'node:url'

import { withBrowser, measureColdBootMedian } from '../scenarios/coldBoot'
import { compare, type Baselines } from '../lib/baseline'
import { runName, regenerateReport, isFailure, type RunSummary, type Comparison } from '../lib/run'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(HERE, '../..')
const DIST = join(ROOT, 'dist')
const BASELINE_FILE = join(ROOT, 'perf/baselines/browser.json')
const RESULTS = join(ROOT, 'perf/results')

const accept = process.argv.includes('--accept')

/** Serve the built bundle. A real static server, because a file:// URL is not
 *  how the app is ever loaded and would measure a different thing. */
function serve(dir: string): Promise<{ url: string; close: () => Promise<void> }> {
  const types: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
  }
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]
    let file = join(dir, path === '/' ? 'index.html' : path)
    // A single-page app: unknown paths are routes, not missing files.
    if (!existsSync(file) || extname(file) === '') file = join(dir, 'index.html')
    try {
      const body = readFileSync(file)
      res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' })
      res.end(body)
    } catch {
      res.writeHead(404).end('not found')
    }
  })
  return new Promise((ok) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      ok({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      })
    })
  })
}

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

  const site = await serve(DIST)
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
