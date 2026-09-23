// A market day: three behaviours on one clock.
//
//   node loadtest/signer.mjs &
//   node loadtest/pool.mjs --size 140
//   GATEWAY_URL=http://localhost:28082 PORTAL_URL=http://localhost:28084 \
//     ACCOUNT_URL=http://localhost:28081 \
//     EDGE_SECRET=dev-edge-secret-local-only \
//     k6 run loadtest/market-day.js
//
// Settled in ADR 0013. The short version, because the numbers here are only
// defensible alongside their reasons:
//
// WHAT THIS IS
//
// A MIX, not a scenario. The other files in this directory each measure one
// subsystem in isolation, so a regression names its own cause. This one
// deliberately gives that up to answer the question isolation cannot: can
// these actors coexist. A regression here names a SUSPECT, and the isolated
// scenarios are what confirm it.
//
// WHAT IT CANNOT MEASURE, AND WHY THAT IS NOT A GAP
//
// A customer's day is: acquire coupons, receive some, SEND some, REDEEM at a
// stall. The last two have no gateway path at all:
//
//   redemption  ADR 0003, happens on the device
//   splitting   ADR 0004, likewise
//   sending     needs issuance through the cookie-gated portal, so a
//               NIP-98 client cannot originate one
//
// so what runs here is the GATEWAY'S SHARE of a day, and the summary says so
// in its own words rather than letting a green run imply more. The send and
// redemption halves are modelled device-side in perf/, on their own clock.
//
// WHY THE POLLERS ARE NOT VUs
//
// Only customers are a crowd. A stall's takings poll and the Purchase Issuer's
// debt poll are fixed-period processes: their load does not grow because more
// people arrived, and modelling them as VUs would encode a fiction. They use
// constant-arrival-rate, which HOLDS THE RATE when latency moves. ramping-vus
// does not (a VU that is waiting is a VU not applying load), so a slowing
// gateway would quietly receive less work at the exact moment the measurement
// matters most.
//
// THE POPULATION FIGURES ARE ESTIMATES
//
// 130 customers, 10 stalls, 10 purchases an hour. Nobody measured a market to
// get these. They are written here as estimates so they do not harden into
// folklore, and every one is an env knob.

import { check, sleep } from 'k6'
import exec from 'k6/execution'
import { Counter, Trend } from 'k6/metrics'
import { requireSigner } from './lib/signed-request.js'
import { abortIfInvalid } from './lib/abort.js'
import {
  issueCoupon,
  drainNotifications,
  ackNotifications,
  resolve,
  GATEWAY,
  PORTAL,
  ACCOUNT,
} from './lib/gateway.js'
import { iteration_ms, gateway_ms, succeeded, failed, outcome_verified, signingShare } from './lib/metrics.js'
import http from 'k6/http'

const rate_limited = new Counter('rate_limited')

// Per behaviour, because a mix whose numbers are pooled cannot answer the
// question it exists for. Contention shows up as one behaviour's latency
// moving while another's does not, and that is invisible in an average.
const customer_ms = new Trend('customer_ms', true)
const stall_ms = new Trend('stall_ms', true)
const issuer_ms = new Trend('issuer_ms', true)

const coupons_acquired = new Counter('coupons_acquired')
const customer_drains = new Counter('customer_drains')
const customer_envelopes = new Counter('customer_envelopes')
const stall_drains = new Counter('stall_drains')
const stall_envelopes = new Counter('stall_envelopes')

// The Purchase Issuer's poll is mostly a heartbeat: ~240 polls an hour, ~10 of
// which find work. Counted apart on purpose. loadtest/README.md records the
// opposite case as the mistake worth not repeating: the drain ramp measured
// 9118 drains against 9118 empty queues and read as a measurement of
// receiving. A total alone would say nothing here either.
const issuer_polls_empty = new Counter('issuer_polls_empty')
const issuer_polls_with_work = new Counter('issuer_polls_with_work')
const issuer_debts_seen = new Counter('issuer_debts_seen')

const POOL = JSON.parse(open('../.loadtest-pool.json'))
const IDENTITIES = Object.values(POOL).sort((a, b) => a.index - b.index)

const CUSTOMER_PEAK = Number(__ENV.CUSTOMER_PEAK || 130)
const STALL_COUNT = Number(__ENV.STALL_COUNT || 10)

// The day, compressed to an hour. Compression is what makes this runnable, and
// it is also what makes the rate limiter bite harder than it would in a real
// day, since the limiter's window is a real minute either way.
const DAY = __ENV.DAY_DURATION || '1h'

/** Minutes and hours and seconds, as seconds. k6 parses these; a script must too. */
function durationSeconds(text) {
  let total = 0
  const parts = String(text).match(/\d+(\.\d+)?\s*[hms]/g)
  if (!parts) throw new Error(`DAY_DURATION "${text}" is not a k6 duration, e.g. 1h or 90s`)
  for (const part of parts) {
    const value = parseFloat(part)
    if (part.endsWith('h')) total += value * 3600
    else if (part.endsWith('m')) total += value * 60
    else total += value
  }
  return total
}

const DAY_SECONDS = durationSeconds(DAY)

// Stalls take the top of the pool, customers the bottom, so a customer index
// and a stall index never collide. The pool is indexed by position and stable
// across runs, which is what makes that assignment reproducible.
const STALLS = IDENTITIES.slice(0, STALL_COUNT)
const CUSTOMERS = IDENTITIES.slice(STALL_COUNT)

// Polls per second, from the periods the real clients use.
const STALL_POLL_SECONDS = Number(__ENV.STALL_POLL_SECONDS || 10)
const STALL_POLL_RATE = Math.max(1, Math.round(STALL_COUNT / STALL_POLL_SECONDS))
const ISSUER_POLL_SECONDS = Number(__ENV.ISSUER_POLL_SECONDS || 15)

// What one customer does per visit, beyond polling. An estimate, and the one
// that costs the gateway real work.
const COUPONS_PER_CUSTOMER = Number(__ENV.COUPONS_PER_CUSTOMER || 1)
const CUSTOMER_POLL_SECONDS = Number(__ENV.CUSTOMER_POLL_SECONDS || 10)

const FACE_VALUE_MINOR = Number(__ENV.FACE_VALUE_MINOR || 500)
const CURRENCY = __ENV.CURRENCY || 'EUR'

// Where the Purchase Issuer looks for what is owed. services/purchase-issuer
// reads these as PURCHASE_API_URL and PURCHASE_API_TOKEN, and the names are
// kept so an operator configures one thing, not two.
const PURCHASE_API_URL = (__ENV.PURCHASE_API_URL || '').replace(/\/$/, '')
const PURCHASE_API_TOKEN = __ENV.PURCHASE_API_TOKEN || ''

/**
 * The day's curve, as fractions of peak and fractions of the day.
 *
 * A shaped day rather than a plateau, because the question is realism. The
 * cost is comparability: two runs match only where their curves do, so this is
 * weaker evidence of a regression than a scenario is. That trade is accepted
 * here and nowhere else in the suite (ADR 0013).
 *
 * Both axes are FRACTIONS, not minutes. Writing the stages as '18m' pinned the
 * crowd to a real hour while DAY_DURATION shortened only the pollers, so a
 * short run was impossible and nobody would ever have smoke-tested this before
 * committing an hour to it. Found by trying exactly that.
 */
function stage(ofPeak, ofDay) {
  return {
    target: Math.max(1, Math.round(CUSTOMER_PEAK * ofPeak)),
    duration: `${Math.max(1, Math.round(DAY_SECONDS * ofDay))}s`,
  }
}

const DAY_STAGES = [
  stage(0.2, 1 / 30), // opens quiet
  stage(1.0, 3 / 10), // builds through the morning
  stage(1.0, 1 / 3), // the middle of the day, at peak
  stage(0.3, 3 / 10), // falls away towards close
  stage(0.3, 1 / 30), // the last stragglers
]

export const options = {
  scenarios: {
    // The crowd. VUs are the honest unit here: this really is "how many people
    // are in the market", and each one polls on its own period.
    customers: {
      executor: 'ramping-vus',
      startVUs: Math.max(1, Math.round(CUSTOMER_PEAK * 0.2)),
      stages: DAY_STAGES,
      exec: 'customer',
      tags: { behaviour: 'customer' },
      gracefulRampDown: '15s',
    },
    // Stalls trade all day. Flat on purpose: a stall does not leave at
    // lunchtime, so its poll is a constant while the crowd around it moves.
    stalls: {
      executor: 'constant-arrival-rate',
      rate: STALL_POLL_RATE,
      timeUnit: '1s',
      duration: DAY,
      preAllocatedVUs: Math.max(2, STALL_COUNT),
      maxVUs: Math.max(4, STALL_COUNT * 2),
      exec: 'stall',
      tags: { behaviour: 'stall' },
    },
    // One process, one fixed period. Not a crowd in any sense, and its load
    // comes from the debt rows waiting for it rather than from its own rate.
    purchase_issuer: {
      executor: 'constant-arrival-rate',
      rate: 1,
      timeUnit: `${ISSUER_POLL_SECONDS}s`,
      duration: DAY,
      preAllocatedVUs: 1,
      maxVUs: 2,
      exec: 'purchaseIssuer',
      tags: { behaviour: 'purchase-issuer' },
    },
  },
  thresholds: {
    // Correctness only, as everywhere in this directory. A mix has no pass
    // mark: inventing one before a baseline exists produces a number nobody
    // could defend, and this run's whole point is that its curve makes
    // run-to-run comparison weak anyway.
    outcome_verified: ['rate>0.90'],
  },
}

export function setup() {
  requireSigner()

  if (IDENTITIES.length < STALL_COUNT + 2) {
    throw new Error(
      `the pool holds ${IDENTITIES.length} identities, and this mix needs ` +
        `${STALL_COUNT} stalls plus customers.\n` +
        `  Run: node loadtest/pool.mjs --size ${CUSTOMER_PEAK + STALL_COUNT}`,
    )
  }

  if (CUSTOMERS.length < CUSTOMER_PEAK) {
    console.warn(
      `pool holds ${CUSTOMERS.length} customers but the day peaks at ${CUSTOMER_PEAK}. ` +
        'VUs will share identities, so per-customer contention is understated. ' +
        `Run: node loadtest/pool.mjs --size ${CUSTOMER_PEAK + STALL_COUNT}`,
    )
  }

  const probe = resolve('nobody@example.invalid')
  if (probe.status === 0) {
    throw new Error(`${GATEWAY} did not answer; is the stack up?`)
  }

  // Same probe the issuance ramp does, for the same reason: the portal
  // flattens a 429 into a bare 500 (#37), so "throttled" and "broken" are
  // indistinguishable unless something is known to have worked first.
  const probeIssue = issueCoupon(CUSTOMERS[0], {
    faceValueMinor: FACE_VALUE_MINOR,
    currency: CURRENCY,
    expiryDays: 90,
    memo: 'market day probe',
  })
  const issuanceWorks =
    (probeIssue.status === 200 || probeIssue.status === 201) &&
    String(probeIssue.body).includes('voucher_id')

  if (probeIssue.status === 401) {
    throw new Error(
      `issuance is refused at ${PORTAL} with 401.\n` +
        '  An authentication refusal, not throttling, so no amount of load ' +
        'produces a measurement. Staging gates /api/v1/portal/ behind ' +
        'nap_auth.lua and demands a session cookie.\n' +
        '  Point PORTAL_URL at a local stack.',
    )
  }

  const issuerConfigured = PURCHASE_API_URL !== '' && PURCHASE_API_TOKEN !== ''

  console.log(`gateway    ${GATEWAY}`)
  console.log(`account    ${ACCOUNT}`)
  console.log(`portal     ${PORTAL}`)
  console.log(`day        ${DAY}, peak ${CUSTOMER_PEAK} customers, ${STALL_COUNT} stalls`)
  console.log(`issuance   ${issuanceWorks ? 'confirmed working before load' : 'NOT working'}`)
  console.log(
    `issuer     ${issuerConfigured ? `polling ${PURCHASE_API_URL} every ${ISSUER_POLL_SECONDS}s` : 'NOT configured, behaviour will be skipped'}`,
  )

  return { issuanceWorks, issuerConfigured }
}

let backoffSeconds = 1

/**
 * A customer's day, gateway-side: acquire, then poll for arrivals.
 *
 * The acquiring happens once per VU rather than every iteration, because a
 * customer tops up on arrival and then spends the visit polling. Issuing every
 * ten seconds would make the crowd an issuance ramp wearing a customer's name,
 * and there is already an issuance ramp.
 */
export function customer(data) {
  abortIfInvalid()

  const me = CUSTOMERS[exec.vu.idInTest % CUSTOMERS.length]
  const started = Date.now()
  const firstIteration = exec.vu.iterationInInstance === 0

  if (firstIteration && COUPONS_PER_CUSTOMER > 0) {
    for (let i = 0; i < COUPONS_PER_CUSTOMER; i++) {
      const res = issueCoupon(me, {
        faceValueMinor: FACE_VALUE_MINOR,
        currency: CURRENCY,
        expiryDays: 90,
        memo: 'market day',
      })

      // The same inference the issuance ramp makes, and it is still only sound
      // because setup proved the endpoint works. See #37.
      const opaque = res.status >= 500 && !String(res.body).includes('voucher_id')
      const limited =
        res.status === 429 ||
        (res.status >= 500 && String(res.body).includes('RATE_001')) ||
        (opaque && data && data.issuanceWorks)

      if (limited) {
        rate_limited.add(1)
        // Back off rather than hammering a closed door. Per ADR 0013 this run
        // REPORTS the limit as its finding rather than raising it, so pacing
        // is the difference between a finding and tens of thousands of
        // identical failures burying everything else the mix measured.
        sleep(backoffSeconds)
        backoffSeconds = Math.min(backoffSeconds * 2, 15)
        break
      }

      const issued = String(res.body).includes('voucher_id')
      if (issued) {
        coupons_acquired.add(1)
        backoffSeconds = 1
      }
      outcome_verified.add(issued)
      if (issued) succeeded.add(1)
      else failed.add(1)
    }
  }

  // The poll the wallet makes every ten seconds.
  const drained = drainNotifications(me)
  customer_drains.add(1)

  let envelopes = []
  if (drained.status === 200) {
    try {
      const body = JSON.parse(drained.body)
      envelopes = body.notifications || body.items || []
    } catch {
      envelopes = []
    }
  }

  check(drained, {
    'customer drain answered': (r) => r.status === 200,
    'customer drain not refused': (r) => r.status !== 401 && r.status !== 403,
  })
  outcome_verified.add(drained.status === 200)

  if (envelopes.length > 0) {
    customer_envelopes.add(envelopes.length)
    const ids = envelopes.map((e) => e.id || e.notificationId).filter(Boolean)
    if (ids.length > 0) ackNotifications(me, ids)
  }

  const elapsed = Date.now() - started
  customer_ms.add(elapsed)
  iteration_ms.add(elapsed)

  // Hold the customer's own period, minus what the work already cost, so a
  // slow gateway does not silently reduce the crowd's polling rate.
  const remaining = CUSTOMER_POLL_SECONDS - elapsed / 1000
  if (remaining > 0) sleep(remaining)
}

/**
 * A stall collecting its takings.
 *
 * Takings are gift-wrapped to the stall's own key, never to the terminal that
 * collected them, so this is the stall draining its own queue and not a
 * terminal doing it on the stall's behalf.
 */
export function stall() {
  abortIfInvalid()

  const me = STALLS[exec.scenario.iterationInTest % STALLS.length]
  const started = Date.now()

  const drained = drainNotifications(me)
  stall_drains.add(1)

  let envelopes = []
  if (drained.status === 200) {
    try {
      const body = JSON.parse(drained.body)
      envelopes = body.notifications || body.items || []
    } catch {
      envelopes = []
    }
  }

  check(drained, {
    'stall drain answered': (r) => r.status === 200,
    'stall drain not refused': (r) => r.status !== 401 && r.status !== 403,
  })
  outcome_verified.add(drained.status === 200)

  if (envelopes.length > 0) {
    stall_envelopes.add(envelopes.length)
    const ids = envelopes.map((e) => e.id || e.notificationId).filter(Boolean)
    if (ids.length > 0) ackNotifications(me, ids)
  }

  const elapsed = Date.now() - started
  stall_ms.add(elapsed)
  iteration_ms.add(elapsed)
}

/**
 * The Purchase Issuer asking what is owed.
 *
 * A bearer token, not NIP-98: this is a service calling a service, and
 * services/purchase-issuer/purchasesApi.ts sends exactly this. Skipped rather
 * than faked when unconfigured, because a poll against a URL that does not
 * exist measures nothing and would still fill the summary with numbers.
 */
export function purchaseIssuer(data) {
  if (!data || !data.issuerConfigured) return
  abortIfInvalid()

  const started = Date.now()
  const res = http.get(`${PURCHASE_API_URL}/api/v1/purchases/owed`, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${PURCHASE_API_TOKEN}`,
    },
    tags: { name: 'purchases owed' },
  })
  gateway_ms.add(res.timings.duration)

  let owed = []
  if (res.status === 200) {
    try {
      const body = JSON.parse(res.body)
      owed = Array.isArray(body) ? body : []
    } catch {
      owed = []
    }
  }

  check(res, {
    'owed answered': (r) => r.status === 200,
    'owed not refused': (r) => r.status !== 401 && r.status !== 403,
  })
  outcome_verified.add(res.status === 200)

  if (owed.length > 0) {
    issuer_polls_with_work.add(1)
    issuer_debts_seen.add(owed.length)
  } else {
    issuer_polls_empty.add(1)
  }

  // The minting itself is NOT performed. Issuing here would mean this load
  // test minting real coupons against a stall's credential, and a run that
  // mints value is a run nobody can safely repeat. What is measured is the
  // poll, which is the part that runs 240 times an hour.

  const elapsed = Date.now() - started
  issuer_ms.add(elapsed)
  iteration_ms.add(elapsed)
}

export function handleSummary(data) {
  const m = data.metrics
  const checks = m.checks?.values
  const share = signingShare(data)
  const n = (metric, key = 'count') => m[metric]?.values?.[key] ?? 0
  const ms = (metric, key) => (m[metric]?.values?.[key] ?? 0).toFixed(0)

  const lines = [
    '',
    '  A market day',
    `    ${DAY}, peaking at ${CUSTOMER_PEAK} customers and ${STALL_COUNT} stalls`,
    '',
    '    Customers',
    `      coupons acquired  ${n('coupons_acquired')}`,
    `      drains            ${n('customer_drains')}, ${n('customer_envelopes')} envelopes`,
    `      per iteration     avg ${ms('customer_ms', 'avg')}ms   p95 ${ms('customer_ms', 'p(95)')}ms`,
    '',
    '    Stalls',
    `      takings drains    ${n('stall_drains')}, ${n('stall_envelopes')} envelopes`,
    `      per iteration     avg ${ms('stall_ms', 'avg')}ms   p95 ${ms('stall_ms', 'p(95)')}ms`,
    '',
    '    Purchase Issuer',
  ]

  // Zeros are ambiguous: "polled and found nothing" and "never polled" look
  // identical in a counter, and only one of them is a measurement. Said apart.
  const issuerRan = n('issuer_polls_with_work') + n('issuer_polls_empty') > 0
  if (issuerRan) {
    lines.push(
      `      polls finding work  ${n('issuer_polls_with_work')} (${n('issuer_debts_seen')} debts)`,
      `      polls finding none  ${n('issuer_polls_empty')}`,
      `      per iteration       avg ${ms('issuer_ms', 'avg')}ms   p95 ${ms('issuer_ms', 'p(95)')}ms`,
    )
  } else {
    lines.push(
      '      NOT MEASURED. PURCHASE_API_URL and PURCHASE_API_TOKEN were unset,',
      '      so this behaviour never ran. It is absent from the day, not idle',
      '      within it, and nothing here describes minting under load.',
    )
  }

  lines.push(
    '',
    `    checks        ${checks ? `${checks.passes} passed, ${checks.fails} failed` : 'none ran'}`,
  )

  if (share) {
    lines.push(
      `    signing       ${share.signing_avg_ms}ms of ${share.iteration_avg_ms}ms (${share.signing_share_percent}%)`,
      `                  ${share.verdict}`,
    )
  }

  // Said every run, not only when something looks wrong. A mix's numbers are
  // the most quotable in the suite and the least safe to quote.
  lines.push(
    '',
    '    THIS IS THE GATEWAY\'S SHARE OF A DAY, NOT A DAY.',
    '    Sending and redemption have no gateway path (ADR 0003, 0004), so a',
    '    customer here acquires and polls and does neither. The device-side',
    '    halves live in perf/, on their own clock.',
    '',
    '    A regression here names a SUSPECT, not a cause. Confirm it with the',
    '    isolated scenarios: issuance.js, drain.js, receive.js.',
    '',
    '    Drain numbers are NOT comparable with drain.js. That ramp measures an',
    '    empty queue; here the queues hold what the day put in them.',
    '',
  )

  const limited = n('rate_limited')
  if (limited > 0) {
    lines.push(
      `    FINDING: ${limited} issuance requests were rate-limited after`,
      `    ${n('coupons_acquired')} coupons. The limit is per client IP and one k6`,
      '    process is one IP, so the whole crowd shared one budget and the day',
      '    applied less issuance load than it intended (ADR 0013).',
      '',
    )
  }

  if (n('issuer_polls_with_work') === 0 && n('issuer_polls_empty') > 0) {
    lines.push(
      `    The Purchase Issuer polled ${n('issuer_polls_empty')} times and never found a debt.`,
      '    Expected without card purchases arriving: no webhook, no debt, no work.',
      '    It measures the heartbeat, and says nothing about minting under load.',
      '',
    )
  }

  return {
    stdout: lines.join('\n'),
    'loadtest/results/market-day-summary.json': JSON.stringify(data, null, 2),
  }
}
