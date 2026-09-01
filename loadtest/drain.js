// Draining arrival notifications under load.
//
//   ACCOUNT_URL=http://localhost:28081 k6 run loadtest/drain.js
//
// The gateway-side counterpart to the browser drain scenario: this measures
// the service, that one measures the device.
//
// Draining is a read, so unlike sending it needs nothing issued first. That
// makes it the cheapest scenario here and the one that can push hardest, which
// is also why it is the most likely to find a limit that the others hide
// behind their own setup cost.
//
// WHAT THIS CAN AND CANNOT MEASURE ON A LOCAL STACK
//
// Envelopes are payment RECEIPTS, produced by the payment flow and delivered
// over Artemis. Coupon sends do not produce them, so running the send ramp
// first does NOT populate the queue: measured, 10 sends produced 0 envelopes.
//
// So on this stack every drain comes back empty, and what is measured is the
// cost of answering "nothing waiting" — the endpoint, the signature check and
// the queue poll, but not the work of returning and acknowledging envelopes.
// That is a real measurement of a real path the wallet takes every ten
// seconds, and it is NOT a measurement of draining under arrival load.
//
// The summary says so explicitly when it happens, because an all-empty run
// looks identical to a healthy loaded one in every other number.

import { check, sleep } from 'k6'
import exec from 'k6/execution'
import { Counter } from 'k6/metrics'
import { requireSigner } from './lib/signed-request.js'
import { abortIfInvalid } from './lib/abort.js'
import { drainNotifications, ackNotifications, resolve, ACCOUNT } from './lib/gateway.js'
import {
  iteration_ms,
  succeeded,
  failed,
  outcome_verified,
  signingShare,
} from './lib/metrics.js'

const rate_limited = new Counter('rate_limited')
const drained_empty = new Counter('drained_empty')
const envelopes_drained = new Counter('envelopes_drained')

const POOL = JSON.parse(open('../.loadtest-pool.json'))
const CUSTOMERS = Object.values(POOL).sort((a, b) => a.index - b.index)

const MAX_VUS = Number(__ENV.MAX_VUS || 20)
const DRAIN_LIMIT = Number(__ENV.DRAIN_LIMIT || 50)

export const options = {
  scenarios: {
    baseline: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: 5,
      exec: 'drain',
      tags: { phase: 'baseline' },
    },
    ramp: {
      executor: 'ramping-vus',
      startTime: '30s',
      startVUs: 1,
      stages: [
        { duration: __ENV.RAMP_DURATION || '2m', target: MAX_VUS },
        { duration: __ENV.PLATEAU_DURATION || '1m', target: MAX_VUS },
        { duration: __ENV.DOWN_DURATION || '30s', target: 0 },
      ],
      exec: 'drain',
      tags: { phase: 'ramp' },
      gracefulRampDown: '10s',
    },
  },
  thresholds: {
    outcome_verified: ['rate>0.90'],
  },
}

export function setup() {
  requireSigner()
  if (CUSTOMERS.length === 0) {
    throw new Error('the customer pool is empty; run `node loadtest/pool.mjs --size 50`')
  }

  const probe = resolve('nobody@example.invalid')
  if (probe.status === 0) throw new Error('the gateway did not answer; is the stack up?')

  // Prove the endpoint answers before load, so failures during the ramp can be
  // read as pressure rather than a routing mistake. Drain lives on the account
  // tier and the customer gateway 404s it, which is exactly the confusion this
  // catches early.
  const first = drainNotifications(CUSTOMERS[0], 1)
  const reachable = first.status !== 404 && first.status !== 0

  console.log(`account   ${ACCOUNT}`)
  console.log(`customers ${CUSTOMERS.length}`)
  console.log(`drain     ${reachable ? `reachable (${first.status})` : `NOT reachable (${first.status})`}`)

  if (!reachable) {
    throw new Error(
      `drain is not reachable at ${ACCOUNT} (${first.status}). It lives on the ` +
        'account tier, not the customer gateway. Set ACCOUNT_URL.',
    )
  }

  return { reachable }
}

export function drain() {
  abortIfInvalid()

  const customer = CUSTOMERS[exec.vu.idInTest % CUSTOMERS.length]
  const started = Date.now()

  const res = drainNotifications(customer, DRAIN_LIMIT)

  if (res.status === 429 || (res.status >= 500 && String(res.body).includes('RATE_001'))) {
    rate_limited.add(1)
    iteration_ms.add(Date.now() - started)
    sleep(1)
    return
  }

  // A drain that returns nothing is a correct answer, not a failure: these
  // customers have no arrivals waiting. Counted separately so an empty run is
  // visibly empty rather than looking like a successful measurement of work
  // that never happened.
  let envelopes = null
  try {
    const body = JSON.parse(res.body)
    envelopes = body.envelopes || body.items || body.notifications || []
  } catch {
    envelopes = null
  }

  const answered = res.status === 200 && envelopes !== null
  if (answered) {
    if (envelopes.length === 0) drained_empty.add(1)
    else envelopes_drained.add(envelopes.length)
  }

  const ok = check(res, {
    'drain answered': () => answered,
    'not a server error': (r) => r.status < 500,
  })

  // Acknowledge whatever came back, so the same envelopes are not redelivered
  // to every iteration and measured repeatedly.
  if (answered && envelopes.length > 0) {
    const ids = envelopes.map((e) => e.id || e.envelope_id).filter(Boolean)
    if (ids.length > 0) ackNotifications(customer, ids)
  }

  outcome_verified.add(answered)
  if (answered) succeeded.add(1)
  else failed.add(1)
  iteration_ms.add(Date.now() - started)
  return ok
}

export function handleSummary(data) {
  const m = data.metrics
  const checks = m.checks?.values
  const gateway = m.gateway_ms?.values ?? {}
  const share = signingShare(data)
  const empty = m.drained_empty?.values?.count ?? 0
  const drainedCount = m.succeeded?.values?.count ?? 0

  const lines = [
    '',
    '  Drain ramp',
    `    drains        ${drainedCount}`,
    `    envelopes     ${m.envelopes_drained?.values?.count ?? 0}`,
    `    empty         ${empty}`,
    `    failed        ${m.failed?.values?.count ?? 0}`,
    `    rate limited  ${m.rate_limited?.values?.count ?? 0}`,
    `    checks        ${checks ? `${checks.passes} passed, ${checks.fails} failed` : 'none ran'}`,
    '',
    `    gateway       avg ${(gateway.avg ?? 0).toFixed(0)}ms   ` +
      `p95 ${(gateway['p(95)'] ?? 0).toFixed(0)}ms`,
  ]

  if (share) {
    lines.push(
      `    signing       ${share.signing_avg_ms}ms of ${share.iteration_avg_ms}ms ` +
        `(${share.signing_share_percent}%)`,
      `                  ${share.verdict}`,
    )
  }

  // Said plainly, because an all-empty run looks identical to a healthy one in
  // every other number, and it measures the cost of answering "nothing here"
  // rather than the cost of draining.
  if (empty > 0 && empty === drainedCount) {
    lines.push(
      '',
      '    EVERY drain came back empty, so this measured the cost of answering',
      '    "nothing waiting": the endpoint, the signature check and the queue',
      '    poll, but not the work of returning and acknowledging envelopes.',
      '',
      '    Envelopes are payment receipts delivered over Artemis. Coupon sends',
      '    do NOT produce them, so running the send ramp first will not help',
      '    (measured: 10 sends, 0 envelopes). Populating this queue needs the',
      '    payment flow, which no scenario here drives yet.',
    )
  }

  lines.push(
    '',
    '    This measures THIS deployment on THIS host. It informs planning; it',
    '    is not a production capacity figure.',
    '',
  )

  if (!checks || checks.passes === 0) {
    lines.push('  NO CHECKS RAN. This run proved nothing.', '')
  }

  return {
    stdout: lines.join('\n'),
    'loadtest/results/drain-summary.json': JSON.stringify(data, null, 2),
  }
}
