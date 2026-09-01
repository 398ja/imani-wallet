// What a run measures, named once so every scenario agrees.
//
// The names are also what the run report reads, so changing one here changes
// what every recorded result means. Renamed from the retired imani-apps
// vocabulary (voucher, merchant, user) to this repository's (coupon, stall,
// customer), because that project is retired, nothing will be merged back, and
// a port is the one moment renaming is free.

import { Trend, Counter, Rate } from 'k6/metrics'

/** Time spent obtaining a signature, which is load-generator cost, not gateway. */
export const signing_ms = new Trend('signing_ms', true)

/** Time spent in the gateway, which is what a run is actually about. */
export const gateway_ms = new Trend('gateway_ms', true)

/**
 * The whole iteration, so signing's share of it can be computed.
 *
 * Reported rather than inferred: the sidecar is fast but not free, and once
 * its share grows large the run has stopped measuring the gateway. Without
 * this ratio that transition is invisible, and the numbers keep looking
 * plausible while describing the wrong thing.
 */
export const iteration_ms = new Trend('iteration_ms', true)

/** Iterations that reached the outcome they were testing for. */
export const succeeded = new Counter('succeeded')

/** Iterations that did not, whatever the reason. */
export const failed = new Counter('failed')

/**
 * Whether an iteration's outcome was actually verified.
 *
 * A fast failure otherwise reads as excellent performance. The retired
 * project's early runs proved a load script can be confidently wrong: it
 * mistook a terminal state for an intermediate one and reported failures that
 * were its own fault. So every scenario asserts its outcome before its
 * duration is allowed to count, and this records that it did.
 */
export const outcome_verified = new Rate('outcome_verified')

/** Run `fn`, recording how long it took even when it throws. */
export function timed(trend, fn) {
  const started = Date.now()
  try {
    return fn()
  } finally {
    trend.add(Date.now() - started)
  }
}

/**
 * Print signing's share of an iteration at the end of a run.
 *
 * Called from `handleSummary` so it lands in the operator's terminal rather
 * than only in a JSON file nobody opens.
 */
export function signingShare(data) {
  const sign = data.metrics.signing_ms?.values
  const iter = data.metrics.iteration_ms?.values
  if (!sign || !iter || !iter.avg) return null

  const share = (sign.avg / iter.avg) * 100

  // A short iteration makes signing look dominant no matter how cheap it is:
  // a smoke run doing one trivial call is mostly signing by construction, and
  // warning about it there would be noise that teaches people to ignore the
  // warning when it matters. The threshold only means something once an
  // iteration is doing real work.
  const meaningful = iter.avg >= 500

  return {
    signing_avg_ms: Number(sign.avg.toFixed(1)),
    iteration_avg_ms: Number(iter.avg.toFixed(1)),
    signing_share_percent: Number(share.toFixed(1)),
    // A judgement, not just a number, so an operator does not have to
    // remember the threshold to know whether the run is trustworthy.
    verdict: !meaningful
      ? 'iterations too short for this share to mean anything'
      : share > 25
        ? 'signing dominates: this run measured the load generator more than the gateway'
        : 'signing is a small share of the iteration',
  }
}
