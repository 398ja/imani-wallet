// Sending coupons under load.
//
//   node loadtest/signer.mjs &
//   node loadtest/pool.mjs --size 50
//   GATEWAY_URL=http://localhost:28082 PORTAL_URL=http://localhost:28084 \
//     ACCOUNT_URL=http://localhost:28081 EDGE_SECRET=dev-edge-secret-local-only \
//     k6 run loadtest/send.js
//
// Sending consumes coupons, so each iteration issues one first and then sends
// it. That makes an iteration two gateway calls plus a poll, and it means this
// scenario inherits the issuance rate limit: a send run cannot go faster than
// coupons can be created for it.
//
// The alternative was a pre-funded pool of coupons. It was rejected because
// coupons are bearer instruments held by the customer, so "pre-funded" means
// holding tokens in a file between runs, and a run that crashes mid-send
// leaves real value stranded in a JSON blob nobody reads.

import { check, sleep } from 'k6'
import exec from 'k6/execution'
import { requireSigner } from './lib/signed-request.js'
import { abortIfInvalid } from './lib/abort.js'
import {
  issueCoupon,
  readCoupon,
  sendCoupons,
  resolve,
  GATEWAY,
  ACCOUNT,
} from './lib/gateway.js'
import { Counter } from 'k6/metrics'
import {
  iteration_ms,
  succeeded,
  failed,
  outcome_verified,
  signingShare,
} from './lib/metrics.js'

const rate_limited = new Counter('rate_limited')
const no_token_yet = new Counter('no_token_yet')

const POOL = JSON.parse(open('../.loadtest-pool.json'))
const CUSTOMERS = Object.values(POOL).sort((a, b) => a.index - b.index)

const MAX_VUS = Number(__ENV.MAX_VUS || 10)
const FACE_VALUE_MINOR = Number(__ENV.FACE_VALUE_MINOR || 500)
const CURRENCY = __ENV.CURRENCY || 'EUR'
const TOKEN_POLL_ATTEMPTS = Number(__ENV.TOKEN_POLL_ATTEMPTS || 10)

export const options = {
  scenarios: {
    baseline: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: 3,
      exec: 'send',
      tags: { phase: 'baseline' },
    },
    ramp: {
      executor: 'ramping-vus',
      startTime: '45s',
      startVUs: 1,
      stages: [
        { duration: __ENV.RAMP_DURATION || '2m', target: MAX_VUS },
        { duration: __ENV.PLATEAU_DURATION || '1m', target: MAX_VUS },
        { duration: __ENV.DOWN_DURATION || '30s', target: 0 },
      ],
      exec: 'send',
      tags: { phase: 'ramp' },
      gracefulRampDown: '10s',
    },
  },
  thresholds: {
    // Correctness only, as with issuance: capacity discovery, not a pass mark.
    outcome_verified: ['rate>0.90'],
  },
}

export function setup() {
  requireSigner()
  if (CUSTOMERS.length < 2) {
    throw new Error('sending needs at least two customers; run `node loadtest/pool.mjs --size 50`')
  }

  const probe = resolve('nobody@example.invalid')
  if (probe.status === 0) throw new Error(`${GATEWAY} did not answer; is the stack up?`)

  // Establish that issuance works before load, so opaque 500s during the ramp
  // can be read as throttling rather than breakage. Same reasoning as the
  // issuance ramp, and the same workaround for #37.
  let issuanceWorks = false
  for (let attempt = 1; attempt <= 3 && !issuanceWorks; attempt++) {
    const res = issueCoupon(CUSTOMERS[0], {
      faceValueMinor: FACE_VALUE_MINOR,
      currency: CURRENCY,
      expiryDays: 90,
      memo: 'pre-run probe',
    })
    issuanceWorks = String(res.body).includes('voucher_id')
    if (!issuanceWorks && attempt < 3) sleep(30)
  }

  console.log(`gateway   ${GATEWAY}`)
  console.log(`account   ${ACCOUNT}`)
  console.log(`customers ${CUSTOMERS.length}`)
  console.log(`issuance  ${issuanceWorks ? 'confirmed working before load' : 'NOT working'}`)

  return { issuanceWorks }
}

function throttled(res, issuanceWorks) {
  return (
    res.status === 429 ||
    (res.status >= 500 && String(res.body).includes('RATE_001')) ||
    (res.status >= 500 && !String(res.body).includes('voucher_id') && issuanceWorks)
  )
}

export function send(data) {
  abortIfInvalid()

  // Sender and recipient are different customers, paired by position so the
  // pairing is the same on every run.
  const sender = CUSTOMERS[exec.vu.idInTest % CUSTOMERS.length]
  const recipient = CUSTOMERS[(exec.vu.idInTest + 1) % CUSTOMERS.length]
  const started = Date.now()

  const issued = issueCoupon(sender, {
    faceValueMinor: FACE_VALUE_MINOR,
    currency: CURRENCY,
    expiryDays: 90,
    memo: 'send run',
  })

  if (throttled(issued, data && data.issuanceWorks)) {
    rate_limited.add(1)
    iteration_ms.add(Date.now() - started)
    sleep(2)
    return
  }

  let couponId = null
  try {
    couponId = JSON.parse(issued.body).items[0].voucher_id
  } catch {
    couponId = null
  }

  if (!couponId) {
    outcome_verified.add(false)
    failed.add(1)
    iteration_ms.add(Date.now() - started)
    return
  }

  // A coupon is not sendable the moment it is created: the token appears once
  // the mint has backed it. Poll rather than sleep, so a fast stack is
  // measured as fast and a slow one is not mistaken for a broken one.
  let token = null
  let coupon = null
  for (let attempt = 0; attempt < TOKEN_POLL_ATTEMPTS && !token; attempt++) {
    const read = readCoupon(sender, couponId)
    try {
      const body = JSON.parse(read.body)
      if (body.token && body.status === 'ISSUED') {
        token = body.token
        coupon = body
      }
    } catch {
      // Keep polling: a malformed body here is transient often enough that
      // failing on the first one would report a slow mint as a broken gateway.
    }
    if (!token) sleep(0.5)
  }

  if (!token) {
    // Distinguished from a failure: the coupon exists, it is simply not backed
    // yet. Counting it as a send failure would blame the send path for the
    // mint's latency.
    no_token_yet.add(1)
    iteration_ms.add(Date.now() - started)
    return
  }

  // SNAKE_CASE on the wire. The wallet's `buildSendParams` uses camelCase and
  // its client layer converts (imani-apps `shared/api.js` initiateAtomicSend
  // is the mapping), so copying the wallet's field names sends
  // `recipientPubkey` and the gateway answers:
  //
  //   VALIDATION_001 field_errors:[{field:"recipientPubkey",
  //                                 message:"Recipient pubkey is required"}]
  //
  // which names the field it wanted using the name it was given, so it reads
  // as though the field was absent rather than misspelled.
  //
  // face_value is the SEND amount, not the coupon's face value. pay.ts records
  // why: passing the coupon's value made a partial send complete as a full
  // one, the recipient got the whole coupon, and the customer got no change.
  const sent = sendCoupons(sender, {
    token,
    amount: FACE_VALUE_MINOR,
    recipient_pubkey: recipient.pubHex,
    memo: 'load run',
    face_value: FACE_VALUE_MINOR,
    face_unit: coupon.face_unit || CURRENCY,
    face_decimals: coupon.face_decimals != null ? coupon.face_decimals : 2,
    voucher_id: couponId,
    issuer_id: coupon.issuer_id,
  })

  // Assert the send actually happened before its duration counts.
  let accepted = false
  try {
    const body = JSON.parse(sent.body)
    accepted = Boolean(body.send_id || body.id || body.status)
  } catch {
    accepted = false
  }

  if (!accepted && __ENV.DEBUG_SEND) {
    console.error(`send ${sent.status}: ${String(sent.body).slice(0, 300)}`)
  }

  const ok = check(sent, {
    'send was accepted': () => accepted,
    'not a server error': (r) => r.status < 500,
  })

  outcome_verified.add(accepted)
  if (accepted) succeeded.add(1)
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
    '  Send ramp',
    `    sent          ${m.succeeded?.values?.count ?? 0}`,
    `    failed        ${m.failed?.values?.count ?? 0}`,
    `    rate limited  ${m.rate_limited?.values?.count ?? 0}`,
    `    not backed    ${m.no_token_yet?.values?.count ?? 0}   (coupon issued, token not ready)`,
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

  lines.push(
    '',
    '    Each iteration issues a coupon before sending it, so this run is',
    '    bounded by the issuance rate limit as well as by the send path.',
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
    'loadtest/results/send-summary.json': JSON.stringify(data, null, 2),
  }
}
