/**
 * Opening the wallet, measured the way a customer experiences it.
 *
 * Drives the real built bundle in a real browser. Deliberately not modules
 * imported into Node behind a shim: the retired imani-apps project tried that
 * in `scripts/bench-wallet-sync.mjs`, and its own header admits it "does NOT
 * drive a real browser". Such a benchmark cannot observe the storage engine,
 * the render pipeline or a contended event loop, which is most of what makes
 * opening a wallet slow. It reports green while blind.
 */

import { chromium, type Browser, type Page } from '@playwright/test'

/**
 * The customer-visible states the wallet passes through while starting.
 *
 * `App.tsx` renders one of these while it works, and replaces it with
 * something usable when it is done. The wallet is usable at the moment none of
 * them is on screen and real content is.
 *
 * Deliberately rendered strings and not a test hook. No production module
 * gains an attribute, an export or a flag for the benefit of this suite, so
 * there is nothing here to accidentally ship or to quietly rot.
 *
 * The rot risk is real and is handled by asserting, not by hoping: an earlier
 * version of this file waited for `Opening wallet` to disappear, a state that
 * a logged-out boot never enters. It "passed" in 31ms by observing the absence
 * of a string that was never there. `assertBootWasObserved` below exists so
 * that this failure is loud rather than fast.
 */
const STARTING = [
  'Opening wallet',
  'Restoring your session',
  'Signing in',
  'Reading identity',
  'Checking',
]

/** How the wallet says it failed, which must never read as a fast boot. */
const FATAL = 'Could not open the wallet'

export interface ColdBootOptions {
  /** Where the built bundle is being served. */
  baseUrl: string
  /** Give up rather than hang, so a broken build fails as a failure. */
  timeoutMs?: number
}

export interface ColdBootResult {
  ms: number
  /**
   * What the wallet showed once it was usable, so a run can prove it measured
   * a wallet that opened rather than one that died quietly.
   */
  settledOn: string
  /**
   * Whether a starting state was actually seen before the wallet settled.
   *
   * False means the measurement never observed the wallet working, so the
   * duration describes nothing.
   */
  observedStarting: boolean
}

/**
 * Measure one cold boot, from navigation to a usable app.
 *
 * A fresh context every time: a warm cache measures the second visit, and the
 * first visit is the one that hurts.
 */
export async function measureColdBoot(
  browser: Browser,
  { baseUrl, timeoutMs = 30_000 }: ColdBootOptions,
): Promise<ColdBootResult> {
  const context = await browser.newContext()
  const page: Page = await context.newPage()

  try {
    const failures: string[] = []
    page.on('pageerror', (e) => failures.push(String(e)))

    const started = Date.now()
    await page.goto(baseUrl, { waitUntil: 'commit', timeout: timeoutMs })

    // Watch for the app to settle: real content on screen, and no starting
    // state left. Reported alongside whether a starting state was ever seen,
    // so a boot that skipped straight to content cannot masquerade as fast.
    const outcome = await page.waitForFunction(
      ({ starting, fatal }) => {
        const text = document.body?.innerText?.trim() ?? ''
        const w = window as unknown as { __sawStarting?: boolean }
        if (starting.some((s: string) => text.includes(s))) {
          w.__sawStarting = true
          return null
        }
        if (text.includes(fatal)) return { failed: true, text, saw: !!w.__sawStarting }
        if (text.length === 0) return null
        return { failed: false, text, saw: !!w.__sawStarting }
      },
      { starting: STARTING, fatal: FATAL },
      { timeout: timeoutMs, polling: 4 },
    )
    const ms = Date.now() - started
    const { failed, text, saw } = (await outcome.jsonValue()) as {
      failed: boolean
      text: string
      saw: boolean
    }

    // A wallet that failed to open would otherwise be the fastest boot ever
    // recorded. Assert the outcome before the duration is allowed to count.
    if (failed) {
      throw new Error(`the wallet failed to open, so there is no boot to measure: ${text}`)
    }
    if (failures.length > 0) {
      throw new Error(`the wallet errored while opening: ${failures.join('; ')}`)
    }

    return { ms, settledOn: text.slice(0, 80), observedStarting: saw }
  } finally {
    await context.close()
  }
}

/**
 * Refuse a measurement that never saw the wallet start.
 *
 * If no starting state was observed across any sample, the scenario is no
 * longer watching the states the app actually renders, and its numbers are
 * meaningless. Failing here is the difference between a suite that catches
 * regressions and one that reports green while blind.
 */
export function assertBootWasObserved(results: ColdBootResult[]): void {
  if (!results.some((r) => r.observedStarting)) {
    throw new Error(
      'no starting state was ever observed, so this measured the absence of a string ' +
        'rather than a boot. The states in STARTING have probably drifted from what ' +
        'App.tsx renders; check them before trusting any number from this scenario.',
    )
  }
}

/**
 * Measure several times and take the median.
 *
 * A single sample on a laptop is mostly noise. The median resists the one
 * unlucky run where something else woke up on the machine, which a mean does
 * not.
 */
export async function measureColdBootMedian(
  browser: Browser,
  options: ColdBootOptions,
  samples = 5,
): Promise<{ ms: number; all: number[]; settledOn: string }> {
  const results: ColdBootResult[] = []
  for (let i = 0; i < samples; i++) {
    results.push(await measureColdBoot(browser, options))
  }
  assertBootWasObserved(results)
  const all = results.map((r) => r.ms)
  const sorted = [...all].sort((a, b) => a - b)
  return {
    ms: sorted[Math.floor(sorted.length / 2)],
    all,
    settledOn: results[0].settledOn,
  }
}

export async function withBrowser<T>(fn: (browser: Browser) => Promise<T>): Promise<T> {
  const browser = await chromium.launch()
  try {
    return await fn(browser)
  } finally {
    await browser.close()
  }
}
