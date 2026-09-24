/**
 * Does concurrent issuance still lose proofs? (imani-gateway-customer#104)
 *
 * THIS IS A PROBE, NOT A LOAD TEST. It answers one question with a number:
 * when N stalls issue at the same instant, how many sales survive? Nothing
 * here is about latency or throughput at scale, and the amounts are deliberately
 * trivial.
 *
 * WHY IT EXISTS AS A FILE. The measurement that found the race was run ad-hoc
 * and then written up, so the numbers in
 * `results/staging-2026-09-24-swap-latency.md` could be read but not re-run:
 *
 *   | concurrency | attempts | succeeded | success rate |
 *   |-------------|----------|-----------|--------------|
 *   | 1           | 3        | 3         | 100%         |
 *   | 2           | 6        | 3         | 50%          |
 *   | 3           | 9        | 3         | 33%          |
 *
 * Exactly three succeeded at every level: ONE PER BATCH, whatever the
 * concurrency. That flat line is the signature of a fully serialised resource
 * whose losers are destroyed rather than queued, and it is what the fix had to
 * move. A claim that the fix works is worth only as much as the command that
 * re-checks it, so the experiment now lives here.
 *
 * WHAT A PASS LOOKS LIKE. Success rate stays near 100% as concurrency rises,
 * and `proof_already_used` stays at zero. A rate that still falls as 1/N means
 * the reservation is not in the running image.
 *
 * Each VU sells through its OWN stall, because two stalls selling at the same
 * moment is the case that broke: they drew from the same gateway float and
 * raced for the same proof. Sharing one stall would measure something else.
 *
 *   node loadtest/stalls.mjs --count 3 --verify   # once, enrols the stalls
 *   k6 run loadtest/swap-race.js                  # the probe
 *   CONCURRENCY=3 ROUNDS=3 k6 run loadtest/swap-race.js
 */
import { check, sleep } from 'k6'
import exec from 'k6/execution'
import { Counter, Trend } from 'k6/metrics'
import { requireSigner, napLogin } from './lib/signed-request.js'
import { issueCouponAsStall, PORTAL } from './lib/gateway.js'

const POOL = JSON.parse(open('../.loadtest-pool.json'))
const IDENTITIES = Object.values(POOL).sort((a, b) => a.index - b.index)

// Matches market-day.js: stalls are the FIRST identities in the pool, which is
// what `stalls.mjs --count N` enrols.
const CONCURRENCY = Number(__ENV.CONCURRENCY || 3)
const ROUNDS = Number(__ENV.ROUNDS || 3)

// Which stall to start from. Exists to ask the one question this probe cannot
// otherwise ask: after one stall's burst bucket is exhausted, can a DIFFERENT
// stall still sell? A shared bucket refuses it; a per-merchant bucket does not.
// That is the only way to prove from outside that the identity header actually
// reaches the mint, rather than inferring it from a run that never hit a limit.
const STALL_OFFSET = Number(__ENV.STALL_OFFSET || 0)
const STALLS = IDENTITIES.slice(STALL_OFFSET, STALL_OFFSET + CONCURRENCY)

// One satoshi of face value. The race is about WHICH proof is selected, not how
// many, and a large amount would drag in the mint's per-operation cap and the
// token-size ceiling, neither of which is under test here.
const FACE_VALUE_MINOR = Number(__ENV.FACE_VALUE_MINOR || 1)
const CURRENCY = __ENV.CURRENCY || 'XAF'

// The refusal that IS the bug, counted separately from every other failure.
// NUT-07 11001: the mint burned the proof for whoever got there first and
// refuses everyone else. A run where sales fail for some other reason is a
// different finding and must not be reported as this one.
const proof_already_used = new Counter('proof_already_used')
const issue_succeeded = new Counter('issue_succeeded')
const issue_failed = new Counter('issue_failed')
const rate_limited = new Counter('rate_limited')
const session_renewals = new Counter('session_renewals')
const issue_ms = new Trend('issue_ms', true)

export const options = {
  scenarios: {
    // Every VU starts its iteration at the same moment, which is the whole
    // point: a staggered start would let each sale finish before the next
    // began and the race would never happen.
    batch: {
      executor: 'per-vu-iterations',
      vus: CONCURRENCY,
      iterations: ROUNDS,
      maxDuration: '10m',
    },
  },
  // No thresholds. This probe reports a rate; it does not assert one, because
  // the honest pass mark depends on what the previous run measured and that
  // comparison belongs to a person.
  thresholds: {},
}

export function setup() {
  requireSigner()

  if (IDENTITIES.length < CONCURRENCY) {
    throw new Error(
      `the pool holds ${IDENTITIES.length} identities and this probe needs ${CONCURRENCY}.\n` +
        `  Run: node loadtest/pool.mjs --size ${CONCURRENCY}`,
    )
  }

  // Prove every stall can issue BEFORE measuring, so a permission problem
  // cannot be mistaken for the race. A stall that cannot issue fails 100% of
  // the time, which looks exactly like total contention.
  const broken = []
  for (const stall of STALLS) {
    const session = napLogin(PORTAL, stall)
    if (session.error || !session.permissions.includes('coupon:issue')) {
      broken.push(
        `#${String(stall.index).padStart(4, '0')}: ` +
          (session.error ?? (session.permissions.join(',') || 'no permissions')),
      )
    }
  }
  if (broken.length > 0) {
    throw new Error(
      `${broken.length} of ${CONCURRENCY} stalls cannot issue, so a measured ` +
        `failure would mean nothing:\n  ${broken.join('\n  ')}\n` +
        `  Run: node loadtest/stalls.mjs --count ${CONCURRENCY} --verify`,
    )
  }

  console.log(`swap-race: ${CONCURRENCY} stalls from index ${STALL_OFFSET} x ${ROUNDS} rounds, `
    + `${FACE_VALUE_MINOR} ${CURRENCY} each`)
  return { concurrency: CONCURRENCY }
}

let mySession = null

export default function () {
  if (mySession === null) {
    mySession = napLogin(PORTAL, STALLS[exec.vu.idInTest % STALLS.length])
  }

  const started = Date.now()
  const created = issueCouponAsStall(mySession, {
    faceValueMinor: FACE_VALUE_MINOR,
    currency: CURRENCY,
    expiryDays: 90,
    memo: 'swap race probe',
  })
  issue_ms.add(Date.now() - started)

  let body = String(created.body ?? '')

  // A SESSION CAN LAPSE MID-RUN, and that is not a lost race. Observed at
  // concurrency 3: every attempt after the first round returned 401, which the
  // probe reported as 0% success and would have read as the race being WORSE
  // than before the fix. Re-login once and retry, so an expired cookie is a
  // detail rather than a finding.
  if (created.status === 401) {
    mySession = napLogin(PORTAL, STALLS[exec.vu.idInTest % STALLS.length])
    const again = issueCouponAsStall(mySession, {
      faceValueMinor: FACE_VALUE_MINOR,
      currency: CURRENCY,
      expiryDays: 90,
      memo: 'swap race probe',
    })
    session_renewals.add(1)
    created.status = again.status
    created.body = again.body
    body = String(again.body ?? '')
  }

  // Checked BEFORE the generic failure branch: a 429 means the request never
  // reached the swap, so counting it as a lost race would overstate the bug.
  if (created.status === 429 || body.includes('RATE_001')) {
    rate_limited.add(1)
    sleep(3)
    return
  }

  // The refusal this probe exists to count. Matched on the NUT-07 text and the
  // code, because the wrapping differs by tier and a miss here would silently
  // report the bug as fixed.
  const burned =
    body.includes('already used') || body.includes('11001') || body.includes('Proof already spent')

  if (burned) proof_already_used.add(1)

  const ok = created.status >= 200 && created.status < 300 && body.includes('voucher_id')
  if (ok) issue_succeeded.add(1)
  else issue_failed.add(1)

  check(created, {
    'issuance was not refused for a burned proof': () => !burned,
  })

  if (!ok && !burned) {
    // Any OTHER failure is a different finding, said out loud once rather than
    // folded into the rate. Truncated: a stack trace would bury the run.
    console.warn(`issue failed status=${created.status} body=${body.slice(0, 200)}`)
  }

  // Between rounds, not within one. Long enough that the next batch is a fresh
  // race rather than the tail of this one.
  sleep(3)
}

export function handleSummary(data) {
  const count = (name) => (data.metrics[name] && data.metrics[name].values.count) || 0
  const succeeded = count('issue_succeeded')
  const failed = count('issue_failed')
  const burned = count('proof_already_used')
  const limited = count('rate_limited')
  const attempts = succeeded + failed

  const rate = attempts > 0 ? ((succeeded / attempts) * 100).toFixed(1) : 'n/a'
  const median =
    (data.metrics.issue_ms && Math.round(data.metrics.issue_ms.values.med)) || 0

  const lines = [
    '',
    `=== swap race, concurrency ${CONCURRENCY} ===`,
    `  attempts            ${attempts}`,
    `  succeeded           ${succeeded}`,
    `  proof already used  ${burned}`,
    `  other failures      ${failed - burned}`,
    `  rate limited        ${limited}  (excluded from the rate)`,
    `  session renewals    ${count('session_renewals')}  (a lapsed cookie is not a lost race)`,
    `  success rate        ${rate}%`,
    `  median issue        ${median}ms`,
    '',
    burned > 0
      ? '  STILL RACING: a proof was burned under concurrency.'
      : '  No burned proofs. Concurrent stalls did not take each other down.',
    '',
  ]
  return {
    stdout: lines.join('\n'),
    [`loadtest/results/swap-race-c${CONCURRENCY}.json`]: JSON.stringify(data, null, 2),
  }
}
