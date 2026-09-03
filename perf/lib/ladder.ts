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
 * How far a rung may sit from a straight line before the curve counts as bent.
 *
 * Measured, not chosen: a constructed quadratic misses its fitted line by 113%
 * at the worst rung, while four consecutive batch-write runs on identical code
 * missed by 8%, 17%, 20% and 51%. 70% sits clear of the noise and well under
 * the thing being caught.
 *
 * The gap is wide because these are wall-clock browser measurements on a
 * laptop, and one rung in the batch-write ladder swings ±57% between runs on
 * its own. A threshold tight enough to catch a 2x bend would fire on that, and
 * a check people learn to ignore catches nothing. What this exists to catch —
 * quadratic growth over two orders of magnitude — does not arrive as a 2x
 * bend; it arrives as tens or hundreds.
 */
export const MAX_RESIDUAL = 0.7

/**
 * How much the marginal cost may grow across a SHORT ladder before it fails.
 *
 * Used only below five rungs, where a fitted line cannot tell a quadratic from
 * a straight one. Generous because the ratio divides two differences and so
 * amplifies noise from four numbers.
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
  maxResidual = MAX_RESIDUAL,
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

  // Fit a LINE through every rung, and judge the curve by how badly it fits.
  //
  // Three earlier versions compared two slopes, and all three were too fragile
  // — each found by a real ladder rather than by reasoning:
  //
  // 1. Adjacent END GAPS. The narrowest pair on the ladder, so a millisecond
  //    of jitter between two small rungs swung the ratio from negative to 1.0.
  //    Batch write measured 37ms then 38ms and produced a 2.9x "climb" out of
  //    that 1ms while its middle slopes were declining.
  //
  // 2. HALVES split at the midpoint. That makes one rung — whichever lands on
  //    the split — the denominator of one slope and the numerator of the other.
  //    Batch write's 50-coupon rung swings ±57% run to run, and the verdict
  //    swung with it: 2.63x, 1.49x, 1.34x, 2.02x on identical code.
  //
  // 3. OVERLAPPING halves. Better, and still hostage to whichever rung sat at
  //    the boundary: 3.40x on one of the same four runs.
  //
  // The trouble is common to all three: a ratio of two differences amplifies
  // noise from four numbers, and on a five-rung ladder each difference rests on
  // one or two measurements. A least-squares line uses EVERY rung, so a single
  // noisy one moves it a little instead of pivoting the verdict.
  //
  // Cost that grows linearly with the coupon count fits a line; cost that grows
  // faster cannot, and its residuals are both large and systematically shaped.
  // Measured: a constructed quadratic misses the line by 113% at its worst
  // rung, while four real batch-write runs missed by 8-51%.
  const n = sorted.length
  const sumX = sorted.reduce((a, r) => a + r.coupons, 0)
  const sumY = sorted.reduce((a, r) => a + r.ms, 0)
  const sumXX = sorted.reduce((a, r) => a + r.coupons * r.coupons, 0)
  const sumXY = sorted.reduce((a, r) => a + r.coupons * r.ms, 0)
  const denominator = n * sumXX - sumX * sumX
  const perCoupon = denominator === 0 ? 0 : (n * sumXY - sumX * sumY) / denominator
  const fixedMs = (sumY - perCoupon * sumX) / n

  /** How far the worst rung sits from the line, as a fraction of its own cost. */
  const worstResidual = sorted.reduce((worst, r) => {
    const predicted = fixedMs + perCoupon * r.coupons
    return Math.max(worst, Math.abs(r.ms - predicted) / Math.max(r.ms, 1))
  }, 0)

  // Reported as slopes so the explanation stays readable: the fitted per-coupon
  // cost, and what the largest rung would cost if the fit held exactly.
  const earlySlope = perCoupon
  const lateSlope = perCoupon

  // A fitted per-coupon cost at or below zero means the larger wallets cost no
  // more than the small ones: the work is lost in the fixed cost of whatever
  // the scenario does before it touches a coupon. That is the healthiest
  // possible result and there is no curve to judge.
  if (perCoupon <= 0) {
    return {
      flat: true,
      earlySlope,
      lateSlope,
      ratio: 0,
      explanation:
        `flat: cost per coupon is not measurable above noise ` +
        `(fitted ${perCoupon.toFixed(3)}ms per coupon). A larger wallet costing ` +
        `no more than a smaller one is the healthiest result there is.`,
    }
  }

  // Below the floor, a "cost per coupon" is not worth calling a cost, and the
  // residual test would be judging the shape of noise.
  if (perCoupon < NOISE_FLOOR_MS_PER_COUPON && worstResidual <= maxResidual) {
    return {
      flat: true,
      earlySlope,
      lateSlope,
      ratio: 1,
      explanation:
        `flat: ${perCoupon.toFixed(3)}ms per coupon, below the ` +
        `${NOISE_FLOOR_MS_PER_COUPON}ms floor where a difference means anything, ` +
        `and every rung within ${Math.round(worstResidual * 100)}% of a straight line.`,
    }
  }

  // Which test applies depends on how many rungs there are, and neither works
  // at both sizes.
  //
  // A straight line has two free parameters, so through THREE points it can
  // almost always be drawn: a genuine quadratic on a 3-rung ladder misses its
  // fitted line by as little as 12%, which no usable threshold would catch.
  // Comparing the end slopes does catch it there, because with few rungs the
  // gaps are wide and a bend shows up as one slope dwarfing the other.
  //
  // Past four rungs that reverses. The slope comparison starts resting on
  // individual noisy measurements — measured at 2.63x, 1.49x, 1.34x and 2.02x
  // on four runs of identical code — while the line has enough points to be
  // pinned down, and a quadratic misses it by 113% against 8-51% for real runs.
  if (sorted.length >= 5) {
    const flat = worstResidual <= maxResidual
    return {
      flat,
      earlySlope,
      lateSlope,
      // A number a reader can weigh: 1.0 is a perfect straight line.
      ratio: 1 + worstResidual,
      explanation: flat
        ? `flat: ${perCoupon.toFixed(3)}ms per coupon, and every rung sits within ` +
          `${Math.round(worstResidual * 100)}% of a straight line through all of ` +
          `them. Cost grows with the number of coupons, not faster.`
        : `CLIMBING: no straight line fits these rungs — the worst sits ` +
          `${Math.round(worstResidual * 100)}% away from one, beyond the ` +
          `${Math.round(maxResidual * 100)}% allowed. Cost is superlinear in the ` +
          `coupon count, so the absolute numbers being comfortable today says ` +
          `nothing about a wallet twice this size.`,
    }
  }

  // Three or four rungs: compare the first gap against the last.
  const firstGap = marginal(sorted[0], sorted[1])
  const lastGap = marginal(sorted[sorted.length - 2], sorted[sorted.length - 1])
  const gapRatio = firstGap > 0 ? lastGap / firstGap : Number.POSITIVE_INFINITY
  const gapFlat = firstGap > 0 ? gapRatio <= MAX_SLOPE_GROWTH : lastGap < NOISE_FLOOR_MS_PER_COUPON

  return {
    flat: gapFlat,
    earlySlope: firstGap,
    lateSlope: lastGap,
    ratio: gapRatio,
    explanation: gapFlat
      ? `flat: each coupon costs ${lastGap.toFixed(3)}ms at the large end versus ` +
        `${firstGap.toFixed(3)}ms at the small end. Cost grows with the number ` +
        `of coupons, not faster.`
      : `CLIMBING: each coupon costs ${lastGap.toFixed(3)}ms at the large end ` +
        `versus ${firstGap.toFixed(3)}ms at the small end, beyond the ` +
        `${MAX_SLOPE_GROWTH}x allowed. Cost is superlinear in the coupon count, ` +
        `so the absolute numbers being comfortable today says nothing about a ` +
        `wallet twice this size.`,
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
