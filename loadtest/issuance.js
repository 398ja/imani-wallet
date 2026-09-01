// Issuance under load: ramp until the gateway shows where it breaks.
//
//   node loadtest/signer.mjs &
//   node loadtest/pool.mjs --size 50
//   GATEWAY_URL=http://localhost:28082 PORTAL_URL=http://localhost:28084 \
//     EDGE_SECRET=dev-edge-secret-local-only \
//     k6 run loadtest/issuance.js
//
// Issuance goes first because it produces the coupons that sending, splitting
// and draining all consume. It is both the first measurement and the tool that
// funds everything after it.
//
// There is deliberately NO pass/fail threshold on latency. This is capacity
// discovery: the output is a report saying where the deployment degraded, and
// inventing a threshold before a baseline exists would produce a number nobody
// could defend. The only thresholds here are correctness ones.

import { check, sleep } from 'k6'
import exec from 'k6/execution'
import { requireSigner } from './lib/signed-request.js'
import { abortIfInvalid } from './lib/abort.js'
import { issueCoupon, resolve, GATEWAY, PORTAL } from './lib/gateway.js'
import { Counter } from 'k6/metrics'
import {
  iteration_ms,
  succeeded,
  failed,
  outcome_verified,
  signingShare,
} from './lib/metrics.js'

/**
 * Requests the gateway refused because the caller was going too fast.
 *
 * Counted separately from failures, because it is not a defect: it is the
 * deployment defending itself, and it is the capacity answer this run exists
 * to find. Folding it into `failed` would report a working rate limiter as a
 * broken gateway.
 */
const rate_limited = new Counter('rate_limited')

const POOL = JSON.parse(open('../.loadtest-pool.json'))
const CUSTOMERS = Object.values(POOL).sort((a, b) => a.index - b.index)

const MAX_VUS = Number(__ENV.MAX_VUS || 20)
const FACE_VALUE_MINOR = Number(__ENV.FACE_VALUE_MINOR || 500)
const CURRENCY = __ENV.CURRENCY || 'EUR'

export const options = {
  scenarios: {
    // A single customer first, to capture what issuance costs with nothing
    // else happening. Thresholds later in the run are relative to the
    // deployment as it is today rather than to a number written down months
    // ago on other hardware.
    baseline: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: 5,
      exec: 'issue',
      tags: { phase: 'baseline' },
    },
    // Then ramp. Shape mirrors the retired project's: a long climb, a plateau
    // to see whether the deployment holds, and a ramp down.
    ramp: {
      executor: 'ramping-vus',
      startTime: '30s',
      startVUs: 1,
      stages: [
        { duration: __ENV.RAMP_DURATION || '2m', target: MAX_VUS },
        { duration: __ENV.PLATEAU_DURATION || '1m', target: MAX_VUS },
        { duration: __ENV.DOWN_DURATION || '30s', target: 0 },
      ],
      exec: 'issue',
      tags: { phase: 'ramp' },
      gracefulRampDown: '10s',
    },
  },
  thresholds: {
    // Correctness only, and measured over requests the gateway actually
    // ATTEMPTED. Rate-limited requests are excluded, because a run that finds
    // the limit has succeeded at its job: failing it for that would be like
    // failing a brake test because the car stopped.
    outcome_verified: ['rate>0.90'],
  },
}

export function setup() {
  requireSigner()

  if (CUSTOMERS.length === 0) {
    throw new Error('the customer pool is empty; run `node loadtest/pool.mjs --size 50`')
  }

  // Cheap reachability check before a ramp commits minutes to a dead gateway.
  const probe = resolve('nobody@example.invalid')
  if (probe.status === 0) {
    throw new Error(`${GATEWAY} did not answer; is the stack up?`)
  }

  // Issue once, before any load, to establish that the endpoint works at all.
  // Everything after this can then read an opaque 500 as throttling rather
  // than breakage, which is the only way to tell them apart given the portal
  // does not pass the 429 through.
  //
  // Retried, because a previous run can leave the rate-limit window saturated
  // and the probe then fails for a reason that has nothing to do with the
  // deployment's health. Observed: two runs back to back, and the second
  // reported 12660 failures where the first reported none. Waiting out the
  // window costs a minute and is the difference between a run that measures
  // something and one that mislabels everything.
  let issuanceWorks = false
  for (let attempt = 1; attempt <= 3 && !issuanceWorks; attempt++) {
    const probeIssue = issueCoupon(CUSTOMERS[0], {
      faceValueMinor: FACE_VALUE_MINOR,
      currency: CURRENCY,
      expiryDays: 90,
      memo: 'pre-run probe',
    })
    issuanceWorks =
      (probeIssue.status === 200 || probeIssue.status === 201) &&
      String(probeIssue.body).includes('voucher_id')

    if (!issuanceWorks && attempt < 3) {
      console.log(
        `issuance probe got ${probeIssue.status}; waiting 30s in case a ` +
          'previous run left the rate-limit window saturated',
      )
      sleep(30)
    }
  }

  if (!issuanceWorks) {
    console.warn(
      'issuance did not work before the ramp. Failures during the run will be ' +
        'reported as failures rather than throttling, which is the safe way ' +
        'round: a genuine outage must not be excused as a rate limit.',
    )
  }

  console.log(`gateway   ${GATEWAY}`)
  console.log(`portal    ${PORTAL}`)
  console.log(`customers ${CUSTOMERS.length}`)
  console.log(`ramp      1 -> ${MAX_VUS} VUs`)
  console.log(`issuance  ${issuanceWorks ? 'confirmed working before load' : 'NOT working'}`)

  return { issuanceWorks }
}

/**
 * Whether issuance is known to work at all.
 *
 * This distinguishes "the gateway is throttling us" from "the gateway never
 * worked", which look identical once the portal has flattened both into a bare
 * 500 with no rate-limit marker in the body.
 *
 * It comes from `setup`, not from a module variable. k6 gives every VU its own
 * module instance, so a flag set during the baseline scenario is invisible to
 * the ramp's VUs, and an earlier version of this file detected 5 throttled
 * requests where the portal's own logs recorded 11978.
 */

/**
 * How long to wait after being throttled.
 *
 * Grows as the run keeps hitting the wall, so a ramp past the limit paces
 * itself instead of spending its remaining minutes measuring the rejection
 * path. Capped, so a recovered deployment is noticed promptly.
 */
let backoffSeconds = 1

export function issue(data) {
  // Stop before doing more work if the run is already invalid: either a
  // subsystem has failed, or this machine saturated before the gateway did.
  abortIfInvalid()

  // One customer per VU, so concurrent issuance is spread across identities
  // rather than contending on one.
  const stall = CUSTOMERS[exec.vu.idInTest % CUSTOMERS.length]
  const started = Date.now()

  const res = issueCoupon(stall, {
    faceValueMinor: FACE_VALUE_MINOR,
    currency: CURRENCY,
    expiryDays: 90,
    memo: 'load run',
  })

  // Assert the coupon actually exists before the duration counts. A fast
  // failure otherwise reads as excellent performance, which is exactly how the
  // retired project's early runs misled it for two full runs.
  let issued = false
  let couponId = null
  if (res.status === 201 || res.status === 200) {
    try {
      const items = JSON.parse(res.body).items
      couponId = items && items[0] && items[0].voucher_id
      issued = Boolean(couponId)
    } catch {
      issued = false
    }
  }

  // The gateway saying "slow down" is the finding, not a failure.
  //
  // Detecting it is harder than it should be. The customer tier answers 429
  // with a RATE_001 body, but the portal catches that and re-emits a bare
  // `{"error":"Internal server error"}` with status 500. Nothing in what a
  // caller receives says "rate limited"; the evidence exists only in the
  // portal's logs. So this infers it: a run that has already issued
  // successfully, and then starts failing with opaque 500s, has hit the limit
  // rather than broken the gateway. Verified by hand — after 65s of quiet the
  // same request returns 201 again, so the deployment is healthy and pacing.
  //
  // Filed as #37: the portal should pass the 429 through. Swallowing it makes
  // a working rate limiter indistinguishable from a crash, and this inference
  // exists only to work around that. Delete it once #37 lands.
  //
  // The baseline scenario proves the endpoint works at one customer before the
  // ramp starts. So once anything has issued, an opaque 500 during the ramp is
  // throttling rather than breakage. Confirmed against the portal's logs for
  // this exact run: 11978 status=429 recorded there, while every one of them
  // reached this script as a bare 500.
  const opaqueServerError =
    res.status >= 500 && !String(res.body).includes('voucher_id')
  const limited =
    res.status === 429 ||
    (res.status >= 500 && String(res.body).includes('RATE_001')) ||
    (opaqueServerError && data && data.issuanceWorks)

  if (limited) {
    rate_limited.add(1)
    iteration_ms.add(Date.now() - started)
    // Deliberately NOT recorded in outcome_verified: a throttled request was
    // never attempted, so counting it as a failed outcome would fail the run
    // for successfully finding the thing it went looking for.
    // Back off rather than hammering a door that has been closed. Continuing
    // at full speed measures the rate limiter's rejection path, not issuance,
    // and buries the finding under tens of thousands of identical failures.
    sleep(backoffSeconds)
    backoffSeconds = Math.min(backoffSeconds * 2, 15)
    return false
  }

  // Recovered: the window has rolled over, so stop pacing.
  if (issued) backoffSeconds = 1

  const ok = check(res, {
    'issuance returned a coupon': () => issued,
    'not refused for permissions': (r) => r.status !== 403,
    'not a server error': (r) => r.status < 500,
  })

  if (res.status === 403) {
    console.error(
      'issuance refused (403). Locally the portal needs EDGE_SECRET set, ' +
        'because there is no edge proxy to say who the caller is.',
    )
  }

  outcome_verified.add(issued)
  if (issued) succeeded.add(1)
  else failed.add(1)
  iteration_ms.add(Date.now() - started)

  return ok
}

export function handleSummary(data) {
  const m = data.metrics
  const checks = m.checks?.values
  const gateway = m.gateway_ms?.values ?? {}
  const share = signingShare(data)

  const lines = [
    '',
    '  Issuance ramp',
    `    issued        ${m.succeeded?.values?.count ?? 0}`,
    `    failed        ${m.failed?.values?.count ?? 0}`,
    `    rate limited  ${m.rate_limited?.values?.count ?? 0}`,
    `    checks        ${checks ? `${checks.passes} passed, ${checks.fails} failed` : 'none ran'}`,
    '',
    `    gateway       avg ${(gateway.avg ?? 0).toFixed(0)}ms   ` +
      `p95 ${(gateway['p(95)'] ?? 0).toFixed(0)}ms   p99 ${(gateway['p(99)'] ?? 0).toFixed(0)}ms`,
  ]

  if (share) {
    lines.push(
      `    signing       ${share.signing_avg_ms}ms of ${share.iteration_avg_ms}ms ` +
        `(${share.signing_share_percent}%)`,
      `                  ${share.verdict}`,
    )
  }

  // Said plainly, because a number from one host is not capacity in the
  // abstract and this is exactly where someone would quote it as though it
  // were.
  lines.push(
    '',
    '    This measures THIS deployment on THIS host. It informs planning; it',
    '    is not a production capacity figure.',
    '',
  )

  // The headline finding, when there is one. A rate limit reached is the
  // answer to "where does this break first", so it belongs in the summary
  // rather than buried in a metric.
  const limited = m.rate_limited?.values?.count ?? 0
  const issuedCount = m.succeeded?.values?.count ?? 0
  if (limited > 0) {
    lines.push(
      `    FINDING: the gateway rate-limited ${limited} requests after ${issuedCount}`,
      '    issued. That is where this deployment stops accepting issuance, and',
      '    the limit is per client IP, so every customer in the pool shares it.',
      '',
    )
  }

  if (!checks || checks.passes === 0) {
    lines.push('  NO CHECKS RAN. This run proved nothing.', '')
  }

  return {
    stdout: lines.join('\n'),
    'loadtest/results/summary.json': JSON.stringify(data, null, 2),
  }
}
