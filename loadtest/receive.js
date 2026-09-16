// Receiving under load: an arrival is enqueued, then the recipient drains it.
//
//   INTERNAL_URL=http://gateway-core:8081 SERVICE_TOKEN=... \
//     ACCOUNT_URL=... k6 run loadtest/receive.js
//
// WHY THIS EXISTS
//
// drain.js measures the drain endpoint against an EMPTY queue — 9118 drains on
// staging, 9118 empty. That is a real measurement of the poll the wallet makes
// every ten seconds, and it is not a measurement of receiving anything. The
// work of matching a selector against a populated queue, serialising envelopes
// and acknowledging them was entirely unmeasured, and it is the half that
// scales with load.
//
// This closes that gap: each iteration puts a real envelope on the queue for a
// real recipient, drains it, and confirms THAT envelope came back.
//
// WHAT IT MEASURES, AND WHAT IT DOES NOT
//
// Measured, end to end, per iteration:
//   publish -> queue -> selector match -> drain -> ack
//
// NOT measured: the send that would normally produce the envelope. A real
// arrival originates in the atomic-send saga, which needs a coupon, which needs
// issuance, which needs the portal — and the portal is gated behind a session
// cookie a NIP-98 client cannot obtain (results/staging-2026-09-16.md). So this
// publishes the same envelope the saga publishes, through the same service
// method, onto the same queue.
//
// That makes it an honest measurement of RECEIVING and a substitute for
// SENDING. The distinction matters: a green run here says the recipient side
// holds up under arrival load. It says nothing about whether sends keep up.
//
// THE LATENCY THAT MATTERS
//
// `arrival_to_drain_ms` is the number to watch: enqueue to the recipient
// holding it. imani-apps' plan set a receive SLO of 99% inbound-to-redeemed
// within 8s; this measures the gateway's share of that budget, which is a floor
// under it rather than the whole thing.

import { check } from 'k6'
import exec from 'k6/execution'
import { Counter, Trend } from 'k6/metrics'
import { requireSigner } from './lib/signed-request.js'
import { abortIfInvalid } from './lib/abort.js'
import {
  publishArrival,
  drainNotifications,
  ackNotifications,
  resolve,
  ACCOUNT,
  INTERNAL,
} from './lib/gateway.js'
import {
  iteration_ms,
  succeeded,
  failed,
  outcome_verified,
  signingShare,
} from './lib/metrics.js'

const published = new Counter('published')
const publish_refused = new Counter('publish_refused')
const matched = new Counter('matched')
const unmatched = new Counter('unmatched')
const rate_limited = new Counter('rate_limited')
/** Enqueue to the recipient holding it. The receive latency. */
const arrival_to_drain_ms = new Trend('arrival_to_drain_ms', true)

const CUSTOMERS = JSON.parse(open('../.loadtest-pool.json') || '{}')
const POOL = Object.values(CUSTOMERS)

/**
 * Ceiling deliberately lower than the other ramps.
 *
 * This scenario is usually driven through an SSH tunnel, because `/internal/v1`
 * has no public route. A tunnel is a single TCP connection multiplexing every
 * VU, and it saturates long before the service does: measured at 20 VUs, 4192
 * of 4432 publishes never left the laptop while gateway-core logged only 241
 * arrivals and no errors at all.
 *
 * That is the load generator being the bottleneck — the failure mode the README
 * warns about for every other scenario — and it produces numbers that describe
 * the tunnel. Keep this low, and raise it only when running WHERE the service
 * is, with INTERNAL_URL pointed at the container directly.
 */
const MAX_VUS = Number(__ENV.MAX_VUS || 5)
const CURRENCY = __ENV.CURRENCY || 'EUR'
const MINOR_UNITS = Number(__ENV.MINOR_UNITS || 500)

export const options = {
  scenarios: {
    baseline: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: 5,
      maxDuration: '2m',
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
      gracefulRampDown: '10s',
      tags: { phase: 'ramp' },
    },
  },
  thresholds: {
    // Correctness only, as with every other scenario here: this is capacity
    // discovery, and inventing a latency pass mark before a baseline exists
    // would produce a number nobody could defend.
    outcome_verified: ['rate>0.90'],
  },
}

export function setup() {
  requireSigner()

  if (POOL.length < 2) {
    throw new Error(
      'the customer pool needs at least 2 customers; run `node loadtest/pool.mjs --size 50`',
    )
  }

  const probe = resolve('nobody@example.invalid')
  if (probe.status === 0) {
    throw new Error(`${ACCOUNT} did not answer; is the stack up?`)
  }

  // Prove the internal tier is reachable and the credential works BEFORE the
  // ramp. Without this the run would publish nothing, drain nothing, and report
  // a clean empty result — which is exactly the failure mode drain.js warns
  // about, arrived at from the other direction.
  const sender = POOL[0]
  const recipient = POOL[1]
  const probePublish = publishArrival({
    recipientPubkey: recipient.pubHex,
    senderPubkey: sender.pubHex,
    deliveryEventId: `setup-probe-${Date.now()}`,
    currencyUnit: CURRENCY,
    minorUnits: MINOR_UNITS,
  })

  if (probePublish.status === 401 || probePublish.status === 403) {
    throw new Error(
      `the internal tier refused the credential (${probePublish.status}).\n` +
        '  /internal/v1 needs X-Service-Id + X-Service-Token, bcrypt-checked against\n' +
        '  service_credentials and row-scoped to this one path. Set SERVICE_ID and\n' +
        '  SERVICE_TOKEN to a provisioned pair.\n' +
        '  Not retrying: an auth refusal will not become a success under load.',
    )
  }
  if (probePublish.status === 405) {
    throw new Error(
      `405 from ${probePublish.url}.\n` +
        '  That is the EDGE answering, not gateway-core: nginx declares /internal as\n' +
        '  an internal location, so there is no route to it from outside — by design.\n' +
        '  Run this where the service is and set INTERNAL_URL, e.g.\n' +
        '  INTERNAL_URL=http://gateway-core:8081.',
    )
  }
  if (probePublish.status === 0) {
    throw new Error(
      `nothing answered at ${INTERNAL}.\n` +
        '  /internal/v1 is not reachable from outside the deployment — nginx declares\n' +
        '  /internal as an internal location and there is no public route to it, by\n' +
        '  design. Run this where the service is and set INTERNAL_URL:\n' +
        '    on the host:   INTERNAL_URL=http://gateway-core:8081\n' +
        '    local stack:   INTERNAL_URL=http://localhost:8081\n' +
        '  Note 8081, not 8080: the actuator is on a separate management port.',
    )
  }
  if (probePublish.status !== 202) {
    throw new Error(
      `publish probe answered ${probePublish.status}, expected 202: ` +
        `${String(probePublish.body).slice(0, 200)}`,
    )
  }

  console.log(`account   ${ACCOUNT}`)
  console.log(`customers ${POOL.length}`)
  console.log(`ramp      1 -> ${MAX_VUS} VUs`)
  console.log('publish   confirmed working before load')

  return { ready: true }
}

export default function () {
  abortIfInvalid()

  // Pair by position, so a run is reproducible and a recipient is never also
  // the sender of the envelope it drains.
  const recipient = POOL[exec.vu.idInTest % POOL.length]
  const sender = POOL[(exec.vu.idInTest + 1) % POOL.length]
  const started = Date.now()

  // Unique per iteration: this is what proves the envelope drained is the
  // envelope published, rather than some leftover from an earlier run.
  const deliveryEventId = `lt-${exec.vu.idInTest}-${exec.scenario.iterationInTest}-${Date.now()}`

  const pub = publishArrival({
    recipientPubkey: recipient.pubHex,
    senderPubkey: sender.pubHex,
    deliveryEventId,
    currencyUnit: CURRENCY,
    minorUnits: MINOR_UNITS,
  })

  if (pub.status !== 202) {
    publish_refused.add(1)
    outcome_verified.add(false)
    failed.add(1)
    iteration_ms.add(Date.now() - started)
    return
  }
  published.add(1)
  const publishedAt = Date.now()

  const res = drainNotifications(recipient, 50)

  if (res.status === 429 || (res.status >= 500 && String(res.body).includes('RATE_001'))) {
    rate_limited.add(1)
    iteration_ms.add(Date.now() - started)
    return
  }

  let envelopes = null
  try {
    const body = JSON.parse(res.body)
    envelopes = body.envelopes || body.items || body.notifications || []
  } catch {
    envelopes = null
  }

  const answered = res.status === 200 && envelopes !== null

  // The assertion that makes this scenario worth running: OUR envelope came
  // back, not merely SOME envelope. A queue that returns stale entries under
  // load would otherwise read as healthy.
  //
  // deliveryEventId lives under `correlation`, NOT at the top level — see
  // IncomingNotificationEnvelope.Correlation. Looking for it at the top matches
  // nothing, and the failure is quiet: every drain succeeds, every envelope is
  // ignored, and the run reports `matched 0` as though the queue were broken.
  const ours = answered
    ? envelopes.find((e) => e.correlation?.deliveryEventId === deliveryEventId)
    : undefined

  if (ours) {
    matched.add(1)
    // From the moment the queue accepted it to the moment the recipient holds
    // it. NOT the whole iteration: the publish is a stand-in for a send that
    // would otherwise have happened elsewhere, so charging its cost to receive
    // latency would flatter or blame the wrong half.
    arrival_to_drain_ms.add(Date.now() - publishedAt)
  } else if (answered) {
    // Published and drained cleanly, but our envelope was not in the batch.
    // Usually the queue is deeper than DRAIN_LIMIT under load, which is a real
    // finding rather than an error, so it is counted apart from failures.
    unmatched.add(1)
  }

  const ok = check(res, {
    'drain answered': () => answered,
    'not a server error': (r) => r.status < 500,
    'our envelope came back': () => Boolean(ours),
  })

  // Acknowledge whatever came back, so the queue does not grow without bound
  // across a run and later iterations do not re-drain earlier envelopes.
  if (answered && envelopes.length > 0) {
    const ids = envelopes.map((e) => e.notificationId).filter(Boolean)
    if (ids.length > 0) ackNotifications(recipient, ids)
  }

  outcome_verified.add(Boolean(ours))
  if (ours) succeeded.add(1)
  else failed.add(1)
  iteration_ms.add(Date.now() - started)
  return ok
}

export function handleSummary(data) {
  const m = data.metrics
  // signingShare takes the WHOLE data object, not data.metrics, and returns an
  // OBJECT (or null when a run made no iterations, as when setup() aborts).
  // Passing m crashed handleSummary and buried the real setup error under a
  // TypeError; interpolating the result directly printed "[object Object]".
  const share = signingShare(data)
  const count = (k) => m[k]?.values?.count ?? 0
  const trend = (k, s) => m[k]?.values?.[s]

  const matchedN = count('matched')
  const unmatchedN = count('unmatched')

  const lines = [
    '',
    '  Receive ramp',
    `    published     ${count('published')}`,
    `    matched       ${matchedN}`,
    `    unmatched     ${unmatchedN}`,
    `    refused       ${count('publish_refused')}`,
    `    rate limited  ${count('rate_limited')}`,
    `    checks        ${m.checks?.values?.passes ?? 0} passed, ${m.checks?.values?.fails ?? 0} failed`,
    '',
    `    arrival->drain  avg ${fmt(trend('arrival_to_drain_ms', 'avg'))}  p95 ${fmt(trend('arrival_to_drain_ms', 'p(95)'))}`,
    `    gateway         avg ${fmt(trend('gateway_ms', 'avg'))}  p95 ${fmt(trend('gateway_ms', 'p(95)'))}`,
    ...(share
      ? [
          `    signing         ${share.signing_avg_ms}ms of ${share.iteration_avg_ms}ms ` +
            `(${share.signing_share_percent}%)`,
          `                    ${share.verdict}`,
        ]
      : []),
    '',
  ]

  // Publishes that never reached the gateway mean the GENERATOR ran out, not
  // the service. Said plainly, because every other number here would otherwise
  // describe the tunnel rather than the deployment.
  const refusedN = count('publish_refused')
  if (refusedN > count('published')) {
    lines.push(
      `    ${refusedN} publishes never reached the gateway, against ${count('published')} that did.`,
      '    That is the LOAD GENERATOR saturating, not the service: an SSH tunnel',
      '    multiplexes every VU onto one connection. Lower MAX_VUS, or run where',
      '    the service is and point INTERNAL_URL at it directly.',
      '',
    )
  }

  if (matchedN === 0) {
    lines.push(
      '    NOT ONE envelope came back. Publishing reported success, so the',
      '    queue accepted them and the drain did not return them: check the',
      '    selector (envelopes are grouped by recipient pubkey) before reading',
      '    any latency number here as meaningful.',
      '',
    )
  } else if (unmatchedN > matchedN * 0.1) {
    lines.push(
      `    ${unmatchedN} drains did not contain the envelope just published, against`,
      `    ${matchedN} that did. Usually the queue is deeper than the drain limit`,
      '    under this load, which is a capacity finding rather than an error.',
      '',
    )
  }

  lines.push(
    '    This measures RECEIVING: an envelope is enqueued through the same',
    '    service method the atomic-send saga uses, then drained by its',
    '    recipient. The SEND that would normally produce it is NOT exercised,',
    '    because issuance needs the portal and the portal needs a session',
    '    cookie a NIP-98 client cannot obtain.',
    '',
    '    This measures THIS deployment on THIS host. It informs planning; it',
    '    is not a production capacity figure.',
    '',
  )

  return { stdout: lines.join('\n') + '\n' }
}

function fmt(v) {
  return v == null ? 'n/a' : `${Math.round(v)}ms`
}
