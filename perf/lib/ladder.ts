/**
 * Asserting the SHAPE of a cost curve, rather than any single number.
 *
 * A lone measurement tells you a value that hardware noise moves, and it hides
 * accidental quadratic behaviour behind a fast machine. Measured at several
 * coupon counts, the same scenario answers a better question: does the cost
 * per coupon stay flat as the count grows, or does it climb?
 *
 * That question survives moving to different hardware. A slower laptop shifts
 * every rung up together and the shape is unchanged; a quadratic regression
 * bends the curve on any hardware at all.
 *
 * ## Why not fit a curve
 *
 * Fitting an exponent to three or four points and comparing it to 1.0 sounds
 * more rigorous and is worse. With few points and real noise the exponent
 * swings widely, so the threshold ends up loose enough to admit the quadratic
 * it exists to catch. Comparing marginal cost at the ends is cruder, and it
 * says something a reader can check by looking at the printed ladder.
 *
 * ## Why marginal cost, and not total divided by count
 *
 * Opening the wallet costs something before a single coupon is read: process
 * start, parse, paint, and the unlock. On this stack that fixed cost dominates
 * a small rung's total, so `ms / coupons` FALLS steeply as the count rises —
 * the fixed cost is merely being spread thinner — and every curve looks
 * sublinear no matter how the per-coupon work actually behaves. A quadratic
 * hides in there completely.
 *
 * Marginal cost, the DIFFERENCE between two rungs divided by the difference in
 * their counts, cancels the fixed cost instead of estimating it: whatever it
 * is, it is in both totals and subtracts away. That is why the comparison is
 * between two differences rather than between two averages.
 */

import type { Snapshot } from './snapshot'

/** One measured point on the ladder. */
export interface Rung {
  coupons: number
  ms: number
}

export interface ShapeVerdict {
  /** Did the curve stay flat enough to pass? */
  flat: boolean
  /** Marginal ms per coupon between the two smallest rungs. */
  earlySlope: number
  /** Marginal ms per coupon between the two largest rungs. */
  lateSlope: number
  /**
   * lateSlope / earlySlope. 1.0 is perfectly linear, 2.0 means each coupon
   * costs twice what it did at the small end.
   */
  ratio: number
  /** Human-readable account, for a report or a failure message. */
  explanation: string
}

/**
 * How much the marginal cost may grow across the ladder before it fails.
 *
 * Generous on purpose. These are wall-clock browser measurements on a laptop,
 * and the ratio divides two differences, so it amplifies noise from four
 * numbers rather than two. The failure being caught is quadratic growth, which
 * over two orders of magnitude does not arrive as a 2.5x drift — it arrives as
 * tens or hundreds. A threshold tight enough to catch a 3x would fire on a
 * busy machine, and a check people learn to ignore catches nothing.
 */
export const MAX_SLOPE_GROWTH = 2.5

/**
 * The smallest number of rungs that can express a shape.
 *
 * Two points define a line and can only ever look flat, so a ladder of two
 * would pass unconditionally: it could not distinguish linear from quadratic
 * even in principle. Three is the minimum that has an early slope and a late
 * slope to compare.
 */
export const MIN_RUNGS = 3

/**
 * Below this, a per-coupon cost is not worth calling a cost.
 *
 * Wall-clock browser measurements on a laptop carry a few milliseconds of
 * jitter, and spread across the gap between two rungs that is fractions of a
 * millisecond per coupon. A floor keeps the "no early baseline" branch from
 * firing on noise, while staying far below anything a customer could feel:
 * at 1ms per coupon a 500-coupon wallet spends half a second, which is
 * already worth knowing about.
 */
export const NOISE_FLOOR_MS_PER_COUPON = 0.5

export function assessShape(
  rungs: Rung[],
  maxGrowth = MAX_SLOPE_GROWTH,
): ShapeVerdict {
  if (rungs.length < MIN_RUNGS) {
    throw new Error(
      `a shape needs at least ${MIN_RUNGS} rungs to be visible, got ${rungs.length}. ` +
        `Two points always look flat, so a shorter ladder would pass without ` +
        `having checked anything. Record another rung: npm run perf:record -- --coupons N`,
    )
  }

  const sorted = [...rungs].sort((a, b) => a.coupons - b.coupons)

  const marginal = (a: Rung, b: Rung) => (b.ms - a.ms) / (b.coupons - a.coupons)

  const earlySlope = marginal(sorted[0], sorted[1])
  const lateSlope = marginal(sorted[sorted.length - 2], sorted[sorted.length - 1])

  // A LATE slope at or below zero means the biggest rung measured no slower
  // than the one before it: the per-coupon cost is lost in noise at the scale
  // that matters most. That is the healthiest possible result, and it must not
  // divide into a misleading ratio.
  if (lateSlope <= 0) {
    return {
      flat: true,
      earlySlope,
      lateSlope,
      ratio: 0,
      explanation:
        `flat: cost per coupon is not measurable above noise at the large end ` +
        `(early ${earlySlope.toFixed(3)}ms, late ${lateSlope.toFixed(3)}ms per coupon). ` +
        `A larger wallet costing no more than a smaller one is the healthiest ` +
        `result there is.`,
    }
  }

  // An early slope at or below zero is a different matter entirely, and
  // treating it as "flat" was a real bug here.
  //
  // It means the small rungs are indistinguishable from each other — the work
  // is too cheap at that size to measure — while the late slope says the cost
  // is now real. Dividing by it gives a negative or infinite ratio, so the
  // guard above reported FLAT for balance aggregation climbing from 0.200 to
  // 1.686 ms per coupon: an 8.4x rise, reported as healthy.
  //
  // With no measurable early cost there is no baseline to compare against, so
  // the late slope is judged on its own: measurable per-coupon cost that
  // appears only at the large end is exactly the signature of superlinear
  // work, and is worth a human looking at rather than a silent pass.
  if (earlySlope <= 0) {
    const flat = lateSlope < NOISE_FLOOR_MS_PER_COUPON
    return {
      flat,
      earlySlope,
      lateSlope,
      ratio: Number.POSITIVE_INFINITY,
      explanation: flat
        ? `flat: the small rungs are too cheap to measure and the large end ` +
          `costs ${lateSlope.toFixed(3)}ms per coupon, below the ` +
          `${NOISE_FLOOR_MS_PER_COUPON}ms floor where a difference means anything.`
        : `CLIMBING: cost per coupon was unmeasurable across the small rungs ` +
          `(${earlySlope.toFixed(3)}ms) and is ${lateSlope.toFixed(3)}ms at the ` +
          `large end. Work that only becomes measurable as the wallet grows is ` +
          `the signature of superlinear cost, and there is no early figure to ` +
          `compare it against — so this is reported rather than divided away.`,
    }
  }

  const ratio = lateSlope / earlySlope
  const flat = ratio <= maxGrowth

  return {
    flat,
    earlySlope,
    lateSlope,
    ratio,
    explanation: flat
      ? `flat: each coupon costs ${lateSlope.toFixed(3)}ms at the large end ` +
        `versus ${earlySlope.toFixed(3)}ms at the small end (${ratio.toFixed(2)}x, ` +
        `within ${maxGrowth}x). Cost grows with the number of coupons, not faster.`
      : `CLIMBING: each coupon costs ${lateSlope.toFixed(3)}ms at the large end ` +
        `versus ${earlySlope.toFixed(3)}ms at the small end — ${ratio.toFixed(2)}x more, ` +
        `beyond the ${maxGrowth}x allowed. The work is superlinear in the coupon ` +
        `count, so the absolute numbers being comfortable today says nothing ` +
        `about a wallet twice this size.`,
  }
}

/** The ladder as a table, so a climbing cost is visible rather than inferred. */
export function formatLadder(rungs: Rung[]): string {
  const sorted = [...rungs].sort((a, b) => a.coupons - b.coupons)
  const lines = ['| coupons | ms | ms per coupon | marginal ms per coupon |', '| --- | --- | --- | --- |']

  for (const [i, rung] of sorted.entries()) {
    const perCoupon = (rung.ms / rung.coupons).toFixed(3)
    // Marginal cost is the honest column: total/count is dominated by the
    // fixed cost of opening the wallet and falls whatever the shape does.
    const marginal =
      i === 0
        ? '—'
        : ((rung.ms - sorted[i - 1].ms) / (rung.coupons - sorted[i - 1].coupons)).toFixed(3)
    lines.push(`| ${rung.coupons} | ${rung.ms} | ${perCoupon} | ${marginal} |`)
  }

  return lines.join('\n')
}

/** What a scenario must provide to be measured across a ladder. */
export interface LadderScenario {
  /** Base name, e.g. `cold-boot`. Rungs become `cold-boot-5`, `cold-boot-50`. */
  name: string
  /**
   * Measure this scenario against a wallet holding `coupons` coupons.
   *
   * The snapshot is loaded and its freshness checked before this is called,
   * so an implementation never has to think about staleness.
   */
  measure(coupons: number, fixture: Snapshot): Promise<LadderMeasurement>
}

export interface LadderMeasurement {
  /** The measurement itself, already reduced to one number (a median). */
  ms: number
  /** Individual samples, for a reader who wants to see the spread. */
  all: number[]
  /**
   * How many records the wallet actually held.
   *
   * Reported rather than assumed: a scenario that measured an empty wallet by
   * accident is the failure mode this whole suite keeps rediscovering, and a
   * count is what makes it visible.
   */
  held: number
  /**
   * Anything else the scenario proved about what it measured, printed beside
   * the record count — balance aggregation reports how many currencies the
   * balance actually rendered, since measuring one is the easy path.
   */
  note?: string
}

export interface LadderRun {
  rungs: Rung[]
  shape?: ShapeVerdict
  table?: string
}

/**
 * Measure one scenario at every recorded coupon count, and assess the shape.
 *
 * Shared so that every scenario gets the same treatment: the same freshness
 * check, the same refusal to report a shape from too few rungs, the same
 * table. A scenario that rolled its own would drift from the others, and the
 * whole point of a ladder is that rungs are comparable.
 */
export async function runLadder(
  scenario: LadderScenario,
  options: {
    counts: number[]
    loadFixture: (coupons: number) => Snapshot
    onRung?: (rung: Rung, measurement: LadderMeasurement) => void
  },
): Promise<LadderRun> {
  const rungs: Rung[] = []

  for (const coupons of [...options.counts].sort((a, b) => a - b)) {
    const fixture = options.loadFixture(coupons)
    const measurement = await scenario.measure(coupons, fixture)
    const rung = { coupons, ms: measurement.ms }
    rungs.push(rung)
    options.onRung?.(rung, measurement)
  }

  if (rungs.length < MIN_RUNGS) return { rungs }

  const shape = assessShape(rungs)
  return { rungs, shape, table: formatLadder(rungs) }
}
