// A market day: three behaviours on one clock.
//
//   node loadtest/signer.mjs &
//   node loadtest/pool.mjs --size 140
//   GATEWAY_URL=http://localhost:28082 PORTAL_URL=http://localhost:28084 \
//     ACCOUNT_URL=http://localhost:28081 \
//     EDGE_SECRET=dev-edge-secret-local-only-32-plus-chars \
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
import crypto from 'k6/crypto'
import { Counter, Trend } from 'k6/metrics'
import { requireSigner, napLogin } from './lib/signed-request.js'
import { abortIfInvalid } from './lib/abort.js'
import {
  issueCouponAsStall,
  readCoupon,
  deliverCoupon,
  deploymentRelayUrl,
  drainNotifications,
  ackNotifications,
  envelopesFrom,
  envelopeIds,
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
// Minted and DELIVERED are different events, and only the second is a sale the
// customer got. Counted apart so a gateway that mints but cannot deliver is
// visible rather than averaged away.
const coupons_delivered = new Counter('coupons_delivered')
// How long the seller waits for the mint. Measured on staging at ~7s, which is
// the bulk of a sale and was entirely unmeasured before.
const mint_wait_ms = new Trend('mint_wait_ms', true)
// The same wait with this loop's own sleeps removed. See the derivation at the
// poll loop: mint_wait_ms measures how often we LOOKED as much as how long the
// mint took, and moved 2.1s when only MINT_POLL_SECONDS changed.
const mint_wait_bound_ms = new Trend('mint_wait_bound_ms', true)
const mint_polls = new Trend('mint_polls')
const mint_timeouts = new Counter('mint_timeouts')
const boot_ticks = new Counter('boot_ticks')
const hidden_ticks = new Counter('hidden_ticks')
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

// The stalls' combined poll rate, expressed as "STALL_COUNT polls per poll
// period" rather than as a per-second figure.
//
// Per-second was wrong and a staging run caught it: rate was
// Math.max(1, Math.round(STALL_COUNT / STALL_POLL_SECONDS)), which for 2
// stalls on a 10s period is max(1, round(0.2)) = 1 PER SECOND, five times the
// intended load. It happened to be right at the default of 10 stalls, so it
// would have survived every run that did not vary the count. Observed: 120
// drains in two minutes where 24 were intended.
//
// k6 takes rate over an arbitrary timeUnit, so the honest statement of "each
// stall polls every 10 seconds" is STALL_COUNT per 10s, with no division and
// nothing to round.
const STALL_POLL_SECONDS = Number(__ENV.STALL_POLL_SECONDS || 10)
const STALL_POLL_RATE = STALL_COUNT
const ISSUER_POLL_SECONDS = Number(__ENV.ISSUER_POLL_SECONDS || 15)

// What one customer does per visit, beyond polling. An estimate, and the one
// that costs the gateway real work.
const COUPONS_PER_CUSTOMER = Number(__ENV.COUPONS_PER_CUSTOMER || 1)
const CUSTOMER_POLL_SECONDS = Number(__ENV.CUSTOMER_POLL_SECONDS || 10)

// The seller's wait for the mint, matching src/lib/issue.ts exactly: 30
// attempts at 2s, a 60s budget. Copied rather than invented, because a load
// test that gives up sooner than the app reports failures the app would not.
const MINT_POLL_ATTEMPTS = Number(__ENV.MINT_POLL_ATTEMPTS || 30)
const MINT_POLL_SECONDS = Number(__ENV.MINT_POLL_SECONDS || 2)

/**
 * The share of customers whose tab is hidden, and so are NOT polling.
 *
 * The wallet pauses its drain loop while the tab is hidden, and catches up on
 * a visibilitychange tick. `incomingNotifications.ts` says why: every tick is
 * a signature, a round trip and a gateway thread, and a background tab has no
 * toast to show for it. Staging logs one forgotten client draining 119 times
 * in 20 minutes.
 *
 * A model where every customer polls forever therefore overstates drain load,
 * and in the one direction that matters: it invents traffic the deployment
 * will never see. 30% is an ESTIMATE, like the populations, and the honest
 * thing is that nobody measured how many market-goers leave the tab open.
 */
const HIDDEN_SHARE = Number(__ENV.HIDDEN_SHARE || 0.3)

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
      timeUnit: `${STALL_POLL_SECONDS}s`,
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

  // Probe issuance AS A STALL, which is the only thing that can issue.
  //
  // This used to probe as a customer over NIP-98 and conclude that staging
  // refuses issuance outright. It does not: it refuses a CUSTOMER, correctly,
  // and the run then reported "no coupons acquired" for a reason that was its
  // own. See `loadtest/stalls.mjs`.
  //
  // The probe still matters for the other reason the issuance ramp has one:
  // the portal flattens a 429 into a bare 500 (#37), so "throttled" and
  // "broken" are indistinguishable unless something is known to have worked.
  const probeStall = napLogin(PORTAL, STALLS[0])
  const stallCanIssue =
    !probeStall.error && probeStall.permissions.includes('coupon:issue')

  const probeIssue = stallCanIssue
    ? issueCouponAsStall(probeStall, {
        faceValueMinor: FACE_VALUE_MINOR,
        currency: CURRENCY,
        expiryDays: 90,
        memo: 'market day probe',
      })
    : { status: 0, body: '' }
  const issuanceWorks =
    (probeIssue.status === 200 || probeIssue.status === 201) &&
    String(probeIssue.body).includes('voucher_id')

  // A 401 aborts issuance.js, because issuance IS that scenario and a ramp
  // that cannot issue has nothing to measure. Here it is one act inside one
  // behaviour, and the drains are the larger part of the day, so aborting
  // would mean the mix could never run against staging at all. Degrade and
  // say so instead: the crowd still polls, and the summary reports that its
  // customers arrived holding coupons they did not acquire here.
  // Not a refusal of the RUN, only of acquiring. The drains are the larger
  // half of the day and run either way, so this degrades rather than aborts.
  const acquiringRefused = !stallCanIssue || probeIssue.status === 401 || probeIssue.status === 403
  if (!stallCanIssue) {
    console.warn(
      `stall #${String(STALLS[0].index).padStart(4, '0')} holds no coupon:issue ` +
        `(${probeStall.error ?? (probeStall.permissions.join(',') || 'no permissions')}), ` +
        'so customers will NOT acquire coupons.\n' +
        '  A pool identity is a customer until it publishes a stall record.\n' +
        `  Run: node loadtest/stalls.mjs --count ${STALL_COUNT} --verify`,
    )
  } else if (acquiringRefused) {
    console.warn(
      `the stall holds coupon:issue but the portal refused it (${probeIssue.status}), ` +
        'so customers will NOT acquire coupons.',
    )
  }

  const issuerConfigured = PURCHASE_API_URL !== '' && PURCHASE_API_TOKEN !== ''

  // Asked once, here, rather than guessed at per VU. A delivered coupon names
  // the relay the gateway should publish its gift wrap to, and the local
  // stack's alias means nothing on staging.
  const relayUrl = deploymentRelayUrl()

  console.log(`gateway    ${GATEWAY}`)
  console.log(`account    ${ACCOUNT}`)
  console.log(`portal     ${PORTAL}`)
  console.log(`relay      ${relayUrl}`)
  console.log(`day        ${DAY}, peak ${CUSTOMER_PEAK} customers, ${STALL_COUNT} stalls`)
  console.log(
    `issuance   ${issuanceWorks ? 'confirmed working, stalls are trading' : acquiringRefused ? 'REFUSED, customers will not acquire' : 'NOT working'}`,
  )
  console.log(
    `issuer     ${issuerConfigured ? `polling ${PURCHASE_API_URL} every ${ISSUER_POLL_SECONDS}s` : 'NOT configured, behaviour will be skipped'}`,
  )

  return { issuanceWorks, issuerConfigured, acquiringRefused, relayUrl }
}

let backoffSeconds = 1

/**
 * The stall session this VU issues through, opened once and reused.
 *
 * A NAP login costs two round trips and a signature, and a session lasts
 * hours, so logging in per iteration would measure the login. Module scope is
 * per-VU in k6, which is exactly the lifetime wanted here.
 *
 * `null` rather than a thrown error when login fails: one stall being
 * unreachable should cost that VU its acquiring, not end the run for the
 * hundred and thirty customers who are only polling.
 */
let myStallSession

/**
 * Whether this VU's tab is hidden, decided once.
 *
 * Per-VU rather than per-iteration: a customer who pockets their phone stays
 * pocketed for a while. Rolling the dice every ten seconds would model
 * something that does not exist.
 */
let hiddenCache

function isHidden() {
  // Resolved on first use, not at init: k6 refuses exec.vu in the init
  // context, and a module-scope read throws before the run starts.
  if (hiddenCache === undefined) {
    // Hashed, not `id % 100 < share * 100`. That form looked right and was
    // wrong at every small VU count: ids 1..4 are all below 30, so a run at
    // four customers hid ALL of them and reported 36 of 40 ticks skipped.
    // Caught by a staging run whose customer drains had collapsed to the boot
    // tick alone.
    const hash = parseInt(crypto.sha256(`hidden-${exec.vu.idInTest}`, 'hex').slice(0, 8), 16)
    hiddenCache = HIDDEN_SHARE > 0 && hash % 100 < HIDDEN_SHARE * 100
  }
  return hiddenCache
}

function stallSessionForThisVu() {
  if (myStallSession !== undefined) return myStallSession

  const stall = STALLS[exec.vu.idInTest % STALLS.length]
  const session = napLogin(PORTAL, stall)

  if (session.error || !session.permissions.includes('coupon:issue')) {
    // Said once per VU, not once per iteration, because at 130 customers the
    // repeat would bury everything else in the log.
    console.warn(
      `stall #${String(stall.index).padStart(4, '0')} cannot issue ` +
        `(${session.error ?? (session.permissions.join(',') || 'no permissions')}). ` +
        'Run: node loadtest/stalls.mjs --count ' + STALL_COUNT + ' --verify',
    )
    myStallSession = null
    return null
  }

  myStallSession = session
  return myStallSession
}

/** The stall this VU sells through. Paired with its session. */
function stallForThisVu() {
  return STALLS[exec.vu.idInTest % STALLS.length]
}

/**
 * One sale, as the wallet performs it.
 *
 * THREE STAGES, not one. `src/lib/issue.ts` issues, then polls
 * `/api/v1/wallet/vouchers/{id}` every 2s until the coupon is ISSUED and
 * carries a token, then delivers it by gift-wrapped DM. An earlier version of
 * this file fired the first POST and counted the sale, which measured about a
 * tenth of the work and produced coupons no customer ever held.
 *
 * Measured against staging: POST ~900ms, ISSUED after 2 polls (~7s), DM 200.
 * The mint wait is the bulk of a sale and nothing here measured it before.
 *
 * The poll is on the WALLET tier with NIP-98, not the portal with the session
 * cookie. Reading the portal instead returns nothing useful and the loop runs
 * its whole budget: measured, 30 polls over 67s and no status at all.
 */
function sellCoupon(session, stall, recipientPubkey, relayUrl) {
  const created = issueCouponAsStall(session, {
    faceValueMinor: FACE_VALUE_MINOR,
    currency: CURRENCY,
    expiryDays: 90,
    memo: 'market day',
  })

  // The same inference the issuance ramp makes, and it is still only sound
  // because setup proved the endpoint works. See #37.
  const opaque = created.status >= 500 && !String(created.body).includes('voucher_id')
  if (
    created.status === 429 ||
    (created.status >= 500 && String(created.body).includes('RATE_001')) ||
    opaque
  ) {
    return { limited: true, issued: false, delivered: false }
  }

  let voucherId = null
  try {
    const items = JSON.parse(created.body).items
    voucherId = items && items[0] && items[0].voucher_id
  } catch {
    voucherId = null
  }
  if (!voucherId) return { limited: false, issued: false, delivered: false }

  // Wait for the mint, as the seller's screen does. Bounded by the same 30
  // attempts the wallet uses, because a sale that never mints must fail rather
  // than hang a VU for the rest of the day.
  const startedWait = Date.now()
  let voucher = null
  let polls = 0
  let pollsRefused = 0
  // When the LAST sleep before the winning poll ended. Everything after this
  // is the only part of the wait the server could still have been working.
  let lastSleepEndedAt = startedWait
  let observedAt = null
  for (let attempt = 0; attempt < MINT_POLL_ATTEMPTS; attempt++) {
    polls++
    const read = readCoupon(stall, voucherId)
    if (read.status === 200) {
      try {
        const body = JSON.parse(read.body)
        if (body.status === 'ISSUED' && body.token) {
          voucher = body
          observedAt = Date.now()
          break
        }
      } catch {
        // Keep polling: a malformed body is not a verdict.
      }
    }

    // A throttled poll learned nothing about the mint. Counted, so a sale that
    // "timed out" while never actually being answered is not reported as the
    // mint being slow. Observed on staging: a 75s wait against a 60s budget,
    // because every poll was refused and slept anyway.
    if (read.status === 429 || read.status >= 500) pollsRefused++

    sleep(MINT_POLL_SECONDS)
    lastSleepEndedAt = Date.now()
  }

  const mintWaitMs = Date.now() - startedWait

  // THE WAIT, WITHOUT THE OBSERVER IN IT.
  //
  // mintWaitMs includes this loop's own sleeps, so it measures how often we
  // looked as much as how long the mint took. Changing only MINT_POLL_SECONDS
  // from 2.0 to 0.25 moved the reported figure from 7731ms to 5626ms on the
  // same system: two seconds of the headline number was the harness sleeping.
  //
  // A number that moves when the observer changes is not a measurement of the
  // system, and this one sent an investigation after the mint, which answers
  // in 62ms.
  //
  // The coupon became ready somewhere between the previous poll and the one
  // that saw it, so all that can be said honestly is an UPPER BOUND: the time
  // from the last sleep ending to the observation. It does not depend on the
  // poll interval, which is the property that was missing.
  const mintWaitBoundMs = observedAt !== null ? observedAt - lastSleepEndedAt : null
  if (!voucher) {
    // Throttled throughout rather than slow: report it as the rate limit it
    // was, not as a mint that could not keep up.
    if (pollsRefused >= polls / 2) {
      return { limited: true, issued: false, delivered: false }
    }
    mint_timeouts.add(1)
    return { limited: false, issued: true, delivered: false, mintWaitMs, mintWaitBoundMs, polls }
  }

  const delivered = deliverCoupon(stall, recipientPubkey, voucher, 'market day', relayUrl)
  return {
    limited: false,
    issued: true,
    delivered: delivered.status === 200 || delivered.status === 201,
    mintWaitMs,
    mintWaitBoundMs,
    polls,
  }
}

/** Close a customer iteration that ended early, so its time is still counted. */
function finishCustomer(me, started) {
  const elapsed = Date.now() - started
  customer_ms.add(elapsed)
  iteration_ms.add(elapsed)
  const remaining = CUSTOMER_POLL_SECONDS - elapsed / 1000
  if (remaining > 0) sleep(remaining)
}

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

  // The boot tick. `startIncomingNotifications` drains IMMEDIATELY on login,
  // before the first interval, so anything already queued surfaces without a
  // ten-second wait. Every real customer therefore does one extra drain the
  // moment they arrive, and a model that waits a full period understates the
  // burst that a crowd arriving together actually produces.
  if (firstIteration) {
    const boot = drainNotifications(me)
    customer_drains.add(1)
    boot_ticks.add(1)
    const bootEnvelopes = envelopesFrom(boot)
    if (bootEnvelopes.length > 0) {
      customer_envelopes.add(bootEnvelopes.length)
      const ids = envelopeIds(bootEnvelopes)
      if (ids.length > 0) ackNotifications(me, ids)
    }
  }

  // Skipped entirely when the portal refused before load. Attempting it would
  // record one failure per customer for a reason setup already established,
  // and drown the drains the run CAN measure.
  const canAcquire = !(data && data.acquiringRefused)

  if (firstIteration && canAcquire && COUPONS_PER_CUSTOMER > 0) {
    // A STALL issues the coupon, not the customer.
    //
    // This was wrong at first and the fix is a domain correction, not a
    // refactor: the earlier version had each customer issue to themselves,
    // which is not a thing that happens. A customer acquires a coupon BECAUSE
    // A STALL ISSUED ONE, and only a stall holds `coupon:issue`.
    //
    // Spread across stalls by VU so the crowd does not queue behind one of
    // them, which would measure a single stall's throughput and call it a
    // market.
    const stallSession = stallSessionForThisVu()
    if (!stallSession) return finishCustomer(me, started)

    for (let i = 0; i < COUPONS_PER_CUSTOMER; i++) {
      const sale = sellCoupon(stallSession, stallForThisVu(), me.pubHex, data && data.relayUrl)

      if (sale.limited) {
        rate_limited.add(1)
        // Back off rather than hammering a closed door. Per ADR 0013 this run
        // REPORTS the limit as its finding rather than raising it, so pacing
        // is the difference between a finding and tens of thousands of
        // identical failures burying everything else the mix measured.
        sleep(backoffSeconds)
        backoffSeconds = Math.min(backoffSeconds * 2, 15)
        break
      }

      if (sale.issued) {
        coupons_acquired.add(1)
        backoffSeconds = 1
        // Only successful waits. A timeout contributes the whole 60s budget,
        // and averaging that into the wait reports the budget rather than the
        // mint: observed, one timeout dragged the p95 to 75s.
        if (sale.delivered) {
          mint_wait_ms.add(sale.mintWaitMs)
          if (sale.mintWaitBoundMs !== null && sale.mintWaitBoundMs !== undefined) {
            mint_wait_bound_ms.add(sale.mintWaitBoundMs)
          }
          mint_polls.add(sale.polls)
        }
      }
      if (sale.delivered) coupons_delivered.add(1)

      // The sale is verified by DELIVERY, not by the mint. A coupon minted and
      // never delivered is a sale the customer did not get, and counting the
      // 201 alone would report it as a success.
      outcome_verified.add(sale.delivered)
      if (sale.delivered) succeeded.add(1)
      else failed.add(1)
    }
  }

  // A hidden tab does not poll. The wallet's drain loop returns early while
  // document.visibilityState is 'hidden', so a customer whose tab is in the
  // background costs the gateway nothing until they look at it again.
  //
  // Deterministic per VU rather than random per iteration: a customer who put
  // the phone in their pocket is hidden for a WHILE, and flipping a coin every
  // ten seconds would model a hummingbird instead.
  if (isHidden()) {
    hidden_ticks.add(1)
    return finishCustomer(me, started)
  }

  // The poll the wallet makes every ten seconds.
  const drained = drainNotifications(me)
  customer_drains.add(1)

  const envelopes = envelopesFrom(drained)

  check(drained, {
    'customer drain answered': (r) => r.status === 200,
    'customer drain not refused': (r) => r.status !== 401 && r.status !== 403,
  })
  outcome_verified.add(drained.status === 200)

  if (envelopes.length > 0) {
    customer_envelopes.add(envelopes.length)
    const ids = envelopeIds(envelopes)
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

  const envelopes = envelopesFrom(drained)

  check(drained, {
    'stall drain answered': (r) => r.status === 200,
    'stall drain not refused': (r) => r.status !== 401 && r.status !== 403,
  })
  outcome_verified.add(drained.status === 200)

  if (envelopes.length > 0) {
    stall_envelopes.add(envelopes.length)
    const ids = envelopeIds(envelopes)
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
    `      coupons minted    ${n('coupons_acquired')}`,
    `      coupons DELIVERED ${n('coupons_delivered')}${n('mint_timeouts') > 0 ? `, ${n('mint_timeouts')} never minted` : ''}`,
    `      mint wait         avg ${ms('mint_wait_ms', 'avg')}ms   p95 ${ms('mint_wait_ms', 'p(95)')}ms   ` +
      `(${(m.mint_polls?.values?.avg ?? 0).toFixed(1)} polls @ ${MINT_POLL_SECONDS}s)`,
    // Reported beside it rather than instead of it, because both are true and
    // neither alone is honest: the first is what the SELLER experiences, the
    // second is the most the SERVER can be blamed for.
    `      of which server    <= ${ms('mint_wait_bound_ms', 'avg')}ms avg   <= ${ms('mint_wait_bound_ms', 'p(95)')}ms p95` +
      `  (the rest is this harness sleeping)`,
    `      drains            ${n('customer_drains')}, ${n('customer_envelopes')} envelopes`,
    `                        ${n('boot_ticks')} boot ticks, ${n('hidden_ticks')} skipped as hidden`,
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
  )

  // Only claim this when it is true. The warning was printed unconditionally
  // while every queue in the run was empty, which made it advice about a
  // situation that had not arisen. It is now a statement about THIS run.
  const drainedEnvelopes = n('customer_envelopes') + n('stall_envelopes')
  if (drainedEnvelopes > 0) {
    lines.push(
      `    ${drainedEnvelopes} envelopes were drained, so these drain numbers are NOT`,
      '    comparable with drain.js: that ramp measures an empty queue, and this one',
      '    measures the work of returning and acknowledging what the day delivered.',
      '',
    )
  } else {
    lines.push(
      '    Every drain came back EMPTY, so this measures the cost of answering',
      '    "nothing waiting" and not the work of delivering envelopes. Same',
      '    measurement drain.js makes, and comparable with it.',
      '',
    )
  }

  // A sale that mints and never delivers is the failure most likely to read as
  // success, because the 201 already happened and the coupon exists. Said
  // plainly whenever the two counts disagree.
  const minted = n('coupons_acquired')
  const delivered = n('coupons_delivered')
  if (minted > delivered) {
    lines.push(
      `    ${minted - delivered} of ${minted} coupons were MINTED BUT NOT DELIVERED.`,
      '    Those are coupons no customer holds. A sale is delivery, not issuance,',
      '    so they are counted as failures here however clean the 201 looked.',
      '',
    )
  }

  // A day with no coupons acquired is a different day, and a reader who missed
  // the setup warning would otherwise see a zero and assume issuance broke.
  if (n('coupons_acquired') === 0 && n('customer_drains') > 0) {
    lines.push(
      '    NO COUPONS WERE ACQUIRED, so only the polling half of the customer',
      '    behaviour ran and this measures a crowd that arrived already holding',
      '    what it holds. The usual cause is that the pool stalls have not',
      '    published a stall record and so hold no coupon:issue.',
      `    Run: node loadtest/stalls.mjs --count ${STALL_COUNT} --verify`,
      '',
    )
  }

  // A p95 far above the median is either a heavy tail or two populations, and
  // those want opposite responses: a tail is load, a step is a fixed cost that
  // load will not explain. Observed on staging 2026-09-23, where ten slow
  // drains landed within 172ms of each other at ~2.2s against a 150ms median.
  // Reported as a question rather than a verdict, because this run cannot tell
  // them apart on its own.
  for (const [label, metric] of [
    ['customers', 'customer_ms'],
    ['stalls', 'stall_ms'],
  ]) {
    const med = m[metric]?.values?.med ?? 0
    const p95 = m[metric]?.values?.['p(95)'] ?? 0
    if (med === 0 || p95 <= med * 5) continue

    // A customer's first iteration includes a whole sale, and a sale waits
    // seconds for the mint. That is EXPECTED and is not a latency finding, so
    // saying "look at the distribution" about it would train the reader to
    // ignore the warning when it means something. Named as the sale when the
    // sale accounts for it.
    const mintWait = m.mint_wait_ms?.values?.['p(95)'] ?? 0
    if (label === 'customers' && mintWait > 0 && p95 < mintWait * 3) {
      lines.push(
        `    customers: p95 ${p95.toFixed(0)}ms against a median of ${med.toFixed(0)}ms, because the`,
        `    first iteration of each VU makes a SALE and waits ${mintWait.toFixed(0)}ms at p95 for`,
        '    the mint. Expected, and not a drain latency finding.',
        '',
      )
      continue
    }

    lines.push(
      `    ${label}: p95 ${p95.toFixed(0)}ms is ${(p95 / med).toFixed(0)}x the median ${med.toFixed(0)}ms.`,
      '    That is a step rather than a tail, so look at the distribution before',
      '    reading the p95 as load. Confirm with drain.js, which is isolated.',
      '',
    )
  }

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
