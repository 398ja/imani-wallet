// A multi-part payment through transient relay failures (imani-wallet#552).
//
// LOCAL STACK ONLY. It needs the DM fault proxy (loadtest/stub/dm-fault-proxy.mjs) between
// gateway-core and customer-wallet, which drops real deliveries on purpose:
//
//   node loadtest/signer.mjs &
//   node loadtest/pool.mjs --size 60
//   GATEWAY_URL=http://localhost:28082 PORTAL_URL=http://localhost:28084 RELAY_URL=ws://localhost:27778 \
//     EDGE_SECRET=dev-edge-secret-local-only-32-plus-chars node loadtest/stalls.mjs --count 4 --verify
//   # start the proxy and point gateway-core at it: see "The bundle under relay failure" in README.md
//   GATEWAY_URL=http://localhost:5173 PORTAL_URL=http://localhost:28084 ACCOUNT_URL=http://localhost:28081 \
//     EDGE_SECRET=dev-edge-secret-local-only-32-plus-chars FAULT_STATS_URL=http://localhost:28099/__fault/stats \
//     VUS=20 k6 run loadtest/bundle-retry.js
//
// GATEWAY_URL is the WALLET origin, not :28082: see issueCouponWithWarrant.
//
// WHAT ONE ITERATION IS
//
// The 2026-11-07 incident, on purpose. A stall issues PARTS coupons to a customer; the customer
// pays them all back to that stall as ONE bundle of PARTS atomic sends, with the bundle fields
// the wallet sends (src/lib/pay.ts buildSendParams), one after another as the wallet's
// deliverCounted does. The fault proxy fails the first DM publish of a share of those sends with
// 502 RELAY_PUBLISH_FAILED, which is what customer-wallet answers when no relay took the gift wrap:
// gateway-core moves the part to DM_ERROR and retries it on its own.
//
// Each part is then followed the way the FIXED wallet follows it (#552): a retry state is NOT the
// end. The run reads the part's status until it is terminal (COMPLETED, RECLAIMED, FAILED, ...)
// or until PART_WAIT_SECONDS, and only then moves to the next part.
//
// WHAT IT ASSERTS
//
//   bundle_complete       rate: every part of the bundle COMPLETED. The thing #552 is about.
//                         A bundle that stopped part-paid fails this.
//   part_recovered        rate: of the parts that went through DM_ERROR, those that ended
//                         COMPLETED. Vacuous if the proxy injected nothing, which the summary
//                         says instead of reporting a clean 100%.
//   reclaim_refused_while_retrying
//                         rate: a sender reclaim of a part in a retry state is either refused
//                         (409, the retry won) or answered with the token (the reclaim won,
//                         and the part must then END RECLAIMED, never COMPLETED). Never 422.
//                         Probed on a RECLAIM_SHARE of parts seen in DM_ERROR; a probed part
//                         that the reclaim won is excluded from bundle_complete, since the
//                         customer took it back.
//   no_double_handout     rate: no part both handed a reclaimed_token AND ended COMPLETED.
//
// Latency is reported, not gated: capacity discovery, as everywhere in this directory.

import { check, sleep } from 'k6'
import exec from 'k6/execution'
import http from 'k6/http'
import crypto from 'k6/crypto'
import { Counter, Rate, Trend } from 'k6/metrics'
import { requireSigner } from './lib/signed-request.js'
import { abortIfInvalid } from './lib/abort.js'
import { merchantWarrant, readCoupon, sendCoupons, signed, ACCOUNT, PORTAL } from './lib/gateway.js'
import { iteration_ms, succeeded, failed, outcome_verified } from './lib/metrics.js'

const POOL = JSON.parse(open('../.loadtest-pool.json'))
const IDENTITIES = Object.values(POOL).sort((a, b) => a.index - b.index)

const STALL_COUNT = Number(__ENV.STALL_COUNT || 4)
const STALLS = IDENTITIES.slice(0, STALL_COUNT)
const CUSTOMERS = IDENTITIES.slice(STALL_COUNT)
const VUS = Number(__ENV.VUS || 20)
const DURATION = __ENV.DURATION || '5m'
const PARTS = Number(__ENV.PARTS || 4)
const FACE_VALUE_MINOR = Number(__ENV.FACE_VALUE_MINOR || 200)
const CURRENCY = __ENV.CURRENCY || 'EUR'
const MINT_POLL_ATTEMPTS = Number(__ENV.MINT_POLL_ATTEMPTS || 30)
// The fixed wallet waits up to 150s on a part the gateway is retrying (RETRY_WAIT_MS).
const PART_WAIT_SECONDS = Number(__ENV.PART_WAIT_SECONDS || 150)
const STATUS_POLL_SECONDS = Number(__ENV.STATUS_POLL_SECONDS || 2)
const RECLAIM_SHARE = Number(__ENV.RECLAIM_SHARE || 0.25)
const FAULT_STATS_URL = __ENV.FAULT_STATS_URL || ''

/** gateway-core's SendState.isTerminal(), the same list the fixed wallet uses. */
const TERMINAL = ['COMPLETED', 'FAILED', 'EXPIRED', 'RECLAIMED', 'CANCELLED']
const RETRYING = ['SPLIT_ERROR', 'DM_ERROR', 'DM_RETRY_PENDING']

const bundles_attempted = new Counter('bundles_attempted')
const bundle_complete = new Rate('bundle_complete')
const parts_sent = new Counter('parts_sent')
const parts_completed = new Counter('parts_completed')
const parts_seen_retrying = new Counter('parts_seen_retrying')
const part_recovered = new Rate('part_recovered')
const parts_unfinished = new Counter('parts_unfinished')
const part_end_ms = new Trend('part_end_ms', true)
const retried_part_end_ms = new Trend('retried_part_end_ms', true)
const bundle_ms = new Trend('bundle_ms', true)
const reclaims_probed = new Counter('reclaims_probed')
const reclaims_won = new Counter('reclaims_won')
const reclaims_refused = new Counter('reclaims_refused')
const reclaim_refused_while_retrying = new Rate('reclaim_refused_while_retrying')
const no_double_handout = new Rate('no_double_handout')
const setup_failures = new Counter('setup_failures')
const rate_limited = new Counter('rate_limited')
/** Why a coupon could not be minted for a bundle, so a setup miss names its cause. */
const mint_misses = new Counter('mint_misses')
let loggedMisses = 0
function mintMiss(reason, res) {
  mint_misses.add(1, { reason })
  if (loggedMisses++ < 5) console.warn(`mint miss (${reason}): ${res ? `${res.status} ${String(res.body).slice(0, 160)}` : ''}`)
}

export const options = {
  scenarios: {
    bundles: {
      executor: 'constant-vus',
      vus: VUS,
      duration: DURATION,
      exec: 'bundle',
      gracefulStop: `${PART_WAIT_SECONDS + 30}s`,
    },
  },
  thresholds: {
    bundle_complete: ['rate>0.95'],
    part_recovered: ['rate>0.95'],
    reclaim_refused_while_retrying: ['rate==1.0'],
    no_double_handout: ['rate==1.0'],
  },
}

function faultStats() {
  if (!FAULT_STATS_URL) return null
  const r = http.get(FAULT_STATS_URL, { tags: { name: 'fault stats' } })
  try {
    return r.status === 200 ? JSON.parse(r.body) : null
  } catch {
    return null
  }
}

export function setup() {
  requireSigner()
  if (STALLS.length < 1 || CUSTOMERS.length < VUS) {
    throw new Error(
      `need ${STALL_COUNT} stalls and ${VUS} customers; the pool holds ${IDENTITIES.length}. ` +
        `Run: node loadtest/pool.mjs --size ${STALL_COUNT + VUS}`,
    )
  }
  const probe = issueCouponWithWarrant(STALLS[0])
  if (!String(probe.body).includes('voucher_id')) {
    throw new Error(`stall #0 cannot issue at ${PORTAL} (${probe.status}). Run loadtest/stalls.mjs --verify and set EDGE_SECRET.`)
  }
  const before = faultStats()
  console.log(`account   ${ACCOUNT}`)
  console.log(`portal    ${PORTAL}`)
  console.log(`bundles   ${VUS} VUs x ${DURATION}, ${PARTS} parts of ${FACE_VALUE_MINOR} ${CURRENCY}`)
  console.log(`faults    ${before ? `proxy fail_share=${before.fail_share} fail_attempts=${before.fail_attempts}` : 'NO FAULT PROXY STATS (FAULT_STATS_URL unset or unreachable)'}`)
  return { faultsBefore: before }
}

/**
 * Issue one coupon from `stall`, with the stall's merchant warrant as the wallet's Sell sends it
 * (the portal refuses nothing without one, but every receiving wallet would). Edge auth on the
 * portal, as send.js.
 *
 * A quote-backed coupon comes back ISSUED without its token; the token appears on the next read
 * of `/api/v1/wallet/vouchers/{id}`, which is NIP-98 signed against GATEWAY_URL. On the local
 * stack gateway-customer checks the signature's `u` against the wallet origin
 * (http://localhost:5173), so GATEWAY_URL must be that origin: signed for :28082, every read is
 * 401 "URL mismatch" and no coupon ever looks backed (a first 20-VU run lost 138 iterations to it).
 */
function issueCouponWithWarrant(stall) {
  return signed(
    PORTAL,
    '/api/v1/portal/vouchers',
    'POST',
    {
      face_value_minor: FACE_VALUE_MINOR,
      currency: CURRENCY,
      quantity: 1,
      expiry_days: 90,
      memo: '#552 bundle',
      issuance_warrant: merchantWarrant(stall, FACE_VALUE_MINOR, CURRENCY),
    },
    stall,
    'issue coupon',
    'coupon:issue',
  )
}

function issueToken(stall) {
  const issued = issueCouponWithWarrant(stall)
  if (issued.status === 429) {
    rate_limited.add(1)
    mintMiss('429', issued)
    return null
  }
  let id = null
  let item = null
  try {
    item = JSON.parse(issued.body).items[0]
    id = item.voucher_id
  } catch {
    mintMiss(`issue_${issued.status}`, issued)
    return null
  }
  if (item && item.token && item.status === 'ISSUED') return item
  let lastRead = null
  for (let i = 0; i < MINT_POLL_ATTEMPTS; i++) {
    const read = readCoupon(stall, id)
    lastRead = read
    try {
      const body = JSON.parse(read.body)
      if (body.status === 'ISSUED' && body.token) return body
    } catch {
      // keep polling
    }
    sleep(1)
  }
  mintMiss(`never_issued_${item && item.status}_read_${lastRead && lastRead.status}`, lastRead)
  return null
}

function status(customer, sendId) {
  const r = signed(ACCOUNT, `/api/v1/atomic-send/${sendId}`, 'GET', undefined, customer, 'send status')
  try {
    return r.status === 200 ? JSON.parse(r.body) : { status: `HTTP_${r.status}` }
  } catch {
    return { status: `HTTP_${r.status}` }
  }
}

function reclaim(customer, sendId) {
  return signed(ACCOUNT, `/api/v1/atomic-send/${sendId}/reclaim`, 'POST', undefined, customer, 'reclaim')
}

/** One part, initiated and followed to its end, as the fixed wallet follows it. */
function sendPart(customer, stall, coupon, bundleId, index, count, total) {
  const started = Date.now()
  const res = sendCoupons(customer, {
    token: coupon.token,
    amount: FACE_VALUE_MINOR,
    recipient_pubkey: stall.pubHex,
    memo: '#552 bundle pay-back',
    face_value: FACE_VALUE_MINOR,
    face_unit: coupon.face_unit || CURRENCY,
    face_decimals: coupon.face_decimals != null ? coupon.face_decimals : 2,
    voucher_id: coupon.voucher_id,
    issuer_id: stall.pubHex,
    bundle_id: bundleId,
    bundle_total: total,
    bundle_part_index: index,
    bundle_part_count: count,
    bundle_part_id: `${bundleId}:${index}`,
    bundle_attempt: 0,
  })
  let sendId = null
  try {
    const body = JSON.parse(res.body)
    sendId = body.send_id || body.sendId
  } catch {
    sendId = null
  }
  if (!sendId) {
    if (__ENV.DEBUG_SEND) console.error(`initiate ${res.status}: ${String(res.body).slice(0, 300)}`)
    return { ended: 'NOT_INITIATED', reclaimedByUs: false }
  }
  parts_sent.add(1)

  let last = { status: 'INITIATED' }
  let sawRetry = false
  // Decided ONCE per part, not per status read. Rolling on every 2s read turned a 25% probe
  // into ~100% over a two-minute retry window, so the gateway's own retry was never observed.
  const willProbe = Math.random() < RECLAIM_SHARE
  let probed = false
  let tokenHandedOut = false
  const deadline = started + PART_WAIT_SECONDS * 1000
  while (Date.now() < deadline) {
    last = status(customer, sendId)
    const state = String(last.status)
    if (TERMINAL.includes(state)) break
    if (RETRYING.includes(state)) {
      sawRetry = true
      // Probe the race the gateway fix closes: a reclaim while the gateway retries.
      if (state === 'DM_ERROR' && willProbe && !probed) {
        probed = true
        reclaims_probed.add(1)
        const r = reclaim(customer, sendId)
        let body = {}
        try {
          body = JSON.parse(r.body)
        } catch {
          body = {}
        }
        if (r.status === 200 && body.reclaimed_token) {
          reclaims_won.add(1)
          tokenHandedOut = true
          reclaim_refused_while_retrying.add(true)
        } else if (r.status === 409) {
          reclaims_refused.add(1)
          reclaim_refused_while_retrying.add(true)
        } else {
          // 422 "not yet available" is the pre-#552 answer. Anything else is a defect.
          console.error(`reclaim of ${sendId} in DM_ERROR answered ${r.status}: ${String(r.body).slice(0, 200)}`)
          reclaim_refused_while_retrying.add(false)
        }
      }
    }
    sleep(STATUS_POLL_SECONDS)
  }
  const ended = String(last.status)
  const elapsed = Date.now() - started
  part_end_ms.add(elapsed)
  if (sawRetry) {
    parts_seen_retrying.add(1)
    retried_part_end_ms.add(elapsed)
    // A part the probe took back is the customer's choice, not a recovery failure.
    if (!tokenHandedOut) part_recovered.add(ended === 'COMPLETED')
  }
  if (tokenHandedOut) {
    // The bearer token went to the sender: the part must never also be delivered.
    no_double_handout.add(ended !== 'COMPLETED')
    if (ended === 'RECLAIMED') {
      // Acknowledge, as a client holding the token must, so the gateway clears it.
      signed(ACCOUNT, `/api/v1/atomic-send/${sendId}/ack-keep-token`, 'POST', undefined, customer, 'ack')
    }
  }
  if (ended === 'COMPLETED') parts_completed.add(1)
  if (!TERMINAL.includes(ended)) parts_unfinished.add(1)
  return { ended, reclaimedByUs: tokenHandedOut }
}

export function bundle() {
  abortIfInvalid()
  const started = Date.now()
  const stall = STALLS[exec.vu.idInTest % STALLS.length]
  const customer = CUSTOMERS[exec.vu.idInTest % CUSTOMERS.length]

  // Coupons from the stall; the customer pays them back (self-issued, as T9 and the incident).
  // Issued to the stall's own key by edge auth, then sent customer->stall: the gateway does
  // not hold coupons, so the customer's sends carry the tokens themselves.
  const coupons = []
  for (let i = 0; i < PARTS; i++) {
    const c = issueToken(stall)
    if (!c) break
    coupons.push(c)
  }
  if (coupons.length < PARTS) {
    setup_failures.add(1)
    iteration_ms.add(Date.now() - started)
    sleep(2)
    return
  }

  bundles_attempted.add(1)
  const bundleId = crypto.sha256(`${exec.vu.idInTest}-${exec.vu.iterationInInstance}-${Date.now()}`, 'hex').slice(0, 32)
  const total = PARTS * FACE_VALUE_MINOR
  let completed = 0
  let reclaimedByUs = 0
  let stoppedAt = null
  for (let i = 0; i < PARTS; i++) {
    const part = sendPart(customer, stall, coupons[i], bundleId, i, PARTS, total)
    if (part.reclaimedByUs) reclaimedByUs++
    if (part.ended === 'COMPLETED') {
      completed++
      continue
    }
    if (part.reclaimedByUs && part.ended === 'RECLAIMED') continue
    // The fixed wallet stops a bundle only on a real end or an outcome it could not learn.
    stoppedAt = `${i}:${part.ended}`
    break
  }
  // The parts the probe reclaimed were taken back by choice; the rest must all have arrived.
  const ok = stoppedAt === null && completed + reclaimedByUs === PARTS
  bundle_complete.add(ok)
  if (!ok) console.warn(`bundle ${bundleId.slice(0, 8)} stopped at part ${stoppedAt} (${completed}/${PARTS} completed)`)
  outcome_verified.add(ok)
  if (ok) succeeded.add(1)
  else failed.add(1)
  bundle_ms.add(Date.now() - started)
  iteration_ms.add(Date.now() - started)
  check(null, { 'bundle reached the stall whole': () => ok })
}

export function teardown(data) {
  const after = faultStats()
  if (after) {
    console.log(`faults injected: ${after.dm_failed} failed DM publishes over ${after.sends_chosen} sends (${after.dm_seen} DMs seen)`)
  }
}

export function handleSummary(data) {
  const m = data.metrics
  const count = (k) => (m[k] && m[k].values && m[k].values.count) || 0
  // A Rate with no samples is not 0%: say so, or a run where the probe took back every retried
  // part reads as a gateway that recovered nothing.
  const samples = (k) => (m[k] && m[k].values ? (m[k].values.passes || 0) + (m[k].values.fails || 0) : 0)
  const rate = (k) =>
    samples(k) === 0
      ? 'n/a (no samples)'
      : `${(m[k].values.rate * 100).toFixed(1)}% of ${samples(k)}`
  const p = (k, q) => (m[k] && m[k].values && m[k].values[q] !== undefined ? `${Math.round(m[k].values[q])}ms` : 'n/a')
  const retried = count('parts_seen_retrying')
  const lines = [
    '',
    '  Bundle under relay failure (#552)',
    `    bundles        ${count('bundles_attempted')} attempted, complete ${rate('bundle_complete')}`,
    `    parts          ${count('parts_sent')} sent, ${count('parts_completed')} completed, ${count('parts_unfinished')} unfinished at the wait limit`,
    `    retried parts  ${retried}${retried === 0 ? '  (NO PART WENT THROUGH A RETRY: the fault proxy injected nothing, so part_recovered is vacuous)' : `, recovered ${rate('part_recovered')}`}`,
    `    reclaim probes ${count('reclaims_probed')} (won ${count('reclaims_won')}, refused 409 ${count('reclaims_refused')}), correct ${rate('reclaim_refused_while_retrying')}, no double hand-out ${rate('no_double_handout')}`,
    `    part end       p50 ${p('part_end_ms', 'med')}  p95 ${p('part_end_ms', 'p(95)')}   retried p50 ${p('retried_part_end_ms', 'med')}  p95 ${p('retried_part_end_ms', 'p(95)')}`,
    `    bundle         p50 ${p('bundle_ms', 'med')}  p95 ${p('bundle_ms', 'p(95)')}`,
    `    setup          ${count('setup_failures')} iterations could not mint ${PARTS} coupons, ${count('rate_limited')} rate limited`,
    '',
  ]
  const failedThresholds = Object.entries(m)
    .filter(([, metric]) => metric.thresholds && Object.values(metric.thresholds).some((t) => !t.ok))
    .map(([name]) => name)
  lines.push(failedThresholds.length ? `    THRESHOLDS CROSSED: ${failedThresholds.join(', ')}` : '    all thresholds held', '')
  return {
    stdout: lines.join('\n'),
    [__ENV.SUMMARY_FILE || 'loadtest/results/bundle-retry-summary.json']: JSON.stringify(data, null, 2),
  }
}
