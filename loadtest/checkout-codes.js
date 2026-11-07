// Checkout codes under load: VALIDATION and REDEMPTION by online shops (imani-wallet#402).
//
//   node loadtest/signer.mjs &
//   npx vite-node loadtest/checkout-codes-make.mts -- --stalls 2 --codes 12   # GENERATION, writes .loadtest-codes.json
//   k6 run loadtest/checkout-codes.js                                          # this file
//   SMOKE=1 k6 run loadtest/checkout-codes.js                                  # a few iterations, no ramp
//
// GENERATION is the other half and lives in `checkout-codes-make.mts`, because making a code is
// the wallet's own multi-step lock-and-deposit, which k6 cannot run. Its output is this file's input.
//
// Three behaviours, each its own k6 scenario so their numbers stay apart:
//
//   validate   a shop's checkout looking a code up, ramped by ARRIVAL RATE. Mostly real codes, plus
//              the misses a shop sees: a well-formed code nobody made, a typo (bad check symbol),
//              and a real code asked for by the WRONG shop. All three misses must answer the same
//              bytes, 404 {"refusal":"NOT_FOUND"} (R2), or the store leaks which miss it was.
//   race       two orders at two checkouts fighting over ONE code, fired with http.batch so they
//              land together: both hold at once (exactly one 200, the other 409 HELD), then both
//              redeem at once (exactly one 200 with parts, the other 409), then the winner asks
//              again (R4: the same parts), then a third order is refused 409 REDEEMED.
//   expired    a code whose x has passed (from an earlier generation run, see `previous`): the
//              lookup says `expired` and a hold is 409 EXPIRED. NOT MEASURED, and said so, when the
//              codes file holds none.
//   check      the PUBLIC balance check, GET /v1/code-check/{code}, no NIP-98 (imani-checkout-codes#9).
//              At a token rate: its edge zone is 10/min per address.
//
// Every request is signed by the SHOP key S (NIP-98 via the sidecar), never the customer's: the
// store answers a code only to the shop it is locked to.
//
// THE CEILING FROM ONE HOST IS THE EDGE. Lookups have their own nginx zone, 30/min per address with
// burst 10; holds and redeems share 60/min burst 30; the store adds 60/min per IP and per caller and
// 20/min per code. A single load generator is one address, so the default ramp stays under 30/min
// and a 429 is counted as `rate_limited` rather than failed, as issuance.js counts its limit.

import { check, sleep } from 'k6'
import exec from 'k6/execution'
import { Counter, Rate } from 'k6/metrics'

import { requireSigner } from './lib/signed-request.js'
import { abortIfInvalid } from './lib/abort.js'
import { iteration_ms, succeeded, failed, outcome_verified, signingShare } from './lib/metrics.js'
import {
  CODES,
  NOT_FOUND_BODY,
  requests,
  batch,
  lookupCode,
  holdCode,
  redeemCode,
  codeCheck,
  storeInfo,
  refusalOf,
  isRateLimited,
  unknownCode,
  typoOf,
} from './lib/checkout-codes.js'

const rate_limited = new Counter('rate_limited')
const race_rounds = new Counter('race_rounds')
/** One per race round: exactly one hold won AND exactly one redeem won. The point of the race. */
const race_one_winner = new Rate('race_one_winner')
/** R4: the winning order asking again gets the same parts. */
const redeem_replays = new Rate('redeem_replays')
/** R2: every miss answers byte-identical NOT_FOUND. */
const misses_indistinguishable = new Rate('misses_indistinguishable')
/** An answer that was not one of the answers this request may get. Latency aside, the error rate. */
const unexpected_answer = new Rate('unexpected_answer')
const expired_refused = new Rate('expired_refused')

const FILE = JSON.parse(open('../.loadtest-codes.json'))
const SHOPS = FILE.shops
const NOW = Math.floor(Date.now() / 1000)
// Live codes only: a code whose x passed since generation is expired, not a lookup target.
const LIVE = FILE.codes.filter((c) => c.expires_at > NOW + 120)
const EXPIRED = [...(FILE.previous || []), ...FILE.codes].filter((c) => c.expires_at <= NOW)

const SMOKE = __ENV.SMOKE === '1'
// The race CONSUMES a code per round (it ends redeemed), so the live codes are split: the first
// RACE_ROUNDS go to the race, the rest are looked up. Lookups never change a code.
const RACE_ROUNDS = Math.min(Number(__ENV.RACE_ROUNDS || (SMOKE ? 1 : 10)), Math.max(0, LIVE.length - 1))
const RACE_CODES = LIVE.slice(0, RACE_ROUNDS)
const LOOKUP_CODES = LIVE.slice(RACE_ROUNDS)

/** Lookups per minute. Defaults stay under the edge's 30/min per address; see the header. */
const START_RATE = Number(__ENV.START_RATE || 5)
const PEAK_RATE = Number(__ENV.PEAK_RATE || 25)
/** Share of lookups that are misses, split evenly between unknown, typo and wrong-shop. */
const MISS_SHARE = Number(__ENV.MISS_SHARE || (SMOKE ? 0.5 : 0.3))

const scenarios = SMOKE
  ? {
      // Six lookups at the smoke miss share: real and miss alternate, one miss of each kind.
      validate: { executor: 'shared-iterations', vus: 1, iterations: 6, exec: 'validate', tags: { phase: 'smoke' } },
      race: { executor: 'shared-iterations', vus: 1, iterations: Math.max(RACE_ROUNDS, 1), exec: 'race', startTime: '2s' },
      expired: { executor: 'shared-iterations', vus: 1, iterations: 1, exec: 'expired', startTime: '4s' },
      check: { executor: 'shared-iterations', vus: 1, iterations: 1, exec: 'publicCheck', startTime: '5s' },
    }
  : {
      validate: {
        executor: 'ramping-arrival-rate',
        startRate: START_RATE,
        timeUnit: '1m',
        preAllocatedVUs: 2,
        maxVUs: Number(__ENV.MAX_VUS || 5),
        stages: [
          { duration: __ENV.RAMP_DURATION || '3m', target: PEAK_RATE },
          { duration: __ENV.PLATEAU_DURATION || '2m', target: PEAK_RATE },
          { duration: __ENV.DOWN_DURATION || '30s', target: 0 },
        ],
        exec: 'validate',
      },
      // Spread across the run so the race happens under lookup load, not before it.
      race: {
        executor: 'per-vu-iterations',
        vus: 1,
        iterations: Math.max(RACE_ROUNDS, 1),
        maxDuration: '6m',
        exec: 'race',
        startTime: '30s',
      },
      expired: { executor: 'shared-iterations', vus: 1, iterations: Math.min(EXPIRED.length, 5) || 1, exec: 'expired', startTime: '1m' },
      check: {
        executor: 'constant-arrival-rate',
        rate: Number(__ENV.CHECK_RATE || 4),
        timeUnit: '1m',
        duration: '5m',
        preAllocatedVUs: 1,
        exec: 'publicCheck',
      },
    }

export const options = {
  scenarios,
  // p(99) is not in k6's default summary, and the thresholds and handleSummary both read it.
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  thresholds: {
    // Correctness first, as everywhere in this directory. These are not tunable: a store that lets
    // two orders win one code has double-spent a customer's money, whatever the latency.
    race_one_winner: ['rate==1.0'],
    redeem_replays: ['rate==1.0'],
    misses_indistinguishable: ['rate==1.0'],
    // The error rate. 404/409 are correct answers here, so http_req_failed cannot be the gate;
    // an answer outside the expected set for that request is.
    unexpected_answer: ['rate<0.01'],
    outcome_verified: ['rate>0.95'],
    // Latency, per call. How they were chosen is in the README ("Choosing the thresholds").
    'http_req_duration{name:code lookup}': ['p(95)<500', 'p(99)<1500'],
    'http_req_duration{name:code hold}': ['p(95)<1000', 'p(99)<2500'],
    'http_req_duration{name:code redeem}': ['p(95)<1000', 'p(99)<2500'],
    'http_req_duration{name:code check}': ['p(95)<1000', 'p(99)<2500'],
  },
}

export function setup() {
  requireSigner()
  const info = storeInfo()
  if (info.status !== 200) {
    throw new Error(`the code store did not answer at ${CODES}/v1/checkout-codes/info (${info.status}); is it deployed?`)
  }
  if (FILE.store && FILE.store.replace(/\/$/, '') !== CODES) {
    console.warn(`codes were made against ${FILE.store} and this run targets ${CODES}: every lookup will 404`)
  }
  if (LIVE.length === 0) {
    throw new Error(
      'no live checkout codes in .loadtest-codes.json. Make some first:\n\n' +
        '  npx vite-node loadtest/checkout-codes-make.mts -- --stalls 2 --codes 12\n',
    )
  }
  if (LOOKUP_CODES.length === 0) throw new Error('every live code went to the race; make more or lower RACE_ROUNDS')
  // `--shops published` codes are locked to a stall's real shop, whose key only its plugin holds.
  // This run signs as the shop, so it cannot drive them; the real shop's checkout does.
  const unsignable = (SHOPS || []).filter((s) => !s.privHex)
  if (unsignable.length > 0) {
    throw new Error(
      `${unsignable.length} shop(s) in .loadtest-codes.json are a stall's published shop (${unsignable.map((s) => s.url).join(', ')}).\n` +
        '  This run signs as the shop and holds no key for them. Validate those codes at the shop itself,\n' +
        '  or generate test codes with the default --shops derived.',
    )
  }

  // Prove a real code answers before load, so a 404 during the ramp means a miss, not a routing slip.
  const probe = LOOKUP_CODES[0]
  const first = lookupCode(SHOPS[probe.shop], probe.code)
  console.log(`store     ${CODES}`)
  console.log(`codes     ${LIVE.length} live (${RACE_CODES.length} for the race, ${LOOKUP_CODES.length} looked up), ${EXPIRED.length} expired`)
  console.log(`lookup    ${first.status} ${String(first.body).slice(0, 120)}`)
  if (first.status !== 200 && !isRateLimited(first)) {
    throw new Error(`a code made by checkout-codes-make answered ${first.status} ${first.body}; the store or its route is wrong`)
  }
  // At least one lookup code per 15/min of peak, or the store's 20/min per-code limit binds first.
  if (!SMOKE && LOOKUP_CODES.length < PEAK_RATE / 15) {
    console.warn(`${LOOKUP_CODES.length} lookup codes at ${PEAK_RATE}/min will meet the store's per-code limit (20/min) before the edge's`)
  }
  // The R2 bytes as THIS store sends them, read from a code nobody made. Every later miss must match
  // them exactly; the literal in the lib is only a sanity check on what came back.
  const miss = lookupCode(SHOPS[0], unknownCode())
  console.log(`miss      ${miss.status} ${miss.body}`)
  if (miss.status !== 404 || refusalOf(miss) !== 'NOT_FOUND') {
    throw new Error(`an unknown code answered ${miss.status} ${miss.body}, not 404 NOT_FOUND`)
  }
  if (miss.body !== NOT_FOUND_BODY) console.warn(`the store's 404 bytes differ from the README's: ${miss.body}`)
  return { notFound: miss.body }
}

function limited(res) {
  if (!isRateLimited(res)) return false
  rate_limited.add(1)
  return true
}

/** One checkout's lookup. */
export function validate(data) {
  abortIfInvalid()
  const started = Date.now()
  const it = exec.scenario.iterationInTest
  const real = LOOKUP_CODES[it % LOOKUP_CODES.length]
  const shop = SHOPS[real.shop]
  // By iteration, not Math.random: a few-iteration smoke run must still meet every kind of miss.
  // Every `1 / MISS_SHARE`-th lookup is a miss, cycling unknown, typo, wrong shop.
  const period = Math.max(1, Math.round(1 / Math.max(MISS_SHARE, 0.01)))
  const isMiss = MISS_SHARE > 0 && it % period === period - 1

  let ok
  if (!isMiss) {
    const res = lookupCode(shop, real.code)
    if (limited(res)) return void iteration_ms.add(Date.now() - started)
    let body = null
    try {
      body = JSON.parse(res.body)
    } catch {
      body = null
    }
    ok = check(res, {
      'lookup answered 200': (r) => r.status === 200,
      'lookup is reserved with its amount': () => body !== null && body.status === 'reserved' && body.amount === real.amount,
      'lookup names the stall': () => body !== null && body.stall_pubkey === real.stall,
    })
    unexpected_answer.add(res.status !== 200)
  } else {
    // A miss. Which kind, by thirds of the miss share.
    const kind = Math.floor(it / period) % 3
    const otherShop = SHOPS[(real.shop + 1) % SHOPS.length]
    const res =
      kind === 0
        ? lookupCode(shop, unknownCode())
        : kind === 1
          ? lookupCode(shop, typoOf(real.code))
          : lookupCode(SHOPS.length > 1 ? otherShop : shop, SHOPS.length > 1 ? real.code : unknownCode())
    if (limited(res)) return void iteration_ms.add(Date.now() - started)
    const same = res.status === 404 && res.body === data.notFound
    misses_indistinguishable.add(same)
    unexpected_answer.add(res.status !== 404)
    ok = check(res, { [`miss (${['unknown', 'typo', 'wrong shop'][kind]}) is the R2 404`]: () => same })
  }
  outcome_verified.add(ok)
  if (ok) succeeded.add(1)
  else failed.add(1)
  iteration_ms.add(Date.now() - started)
}

/** Two orders, one code. Exactly one may win each step. */
export function race() {
  abortIfInvalid()
  const n = exec.scenario.iterationInTest
  if (n >= RACE_CODES.length) return
  const started = Date.now()
  const c = RACE_CODES[n]
  const shop = SHOPS[c.shop]
  const tag = `${Date.now()}-${exec.vu.idInTest}-${n}`
  const orderA = `lt-race-${tag}-a`
  const orderB = `lt-race-${tag}-b`

  // Signed first, fired together: signing is not in the race.
  const holds = batch([requests.hold(shop, c.code, orderA), requests.hold(shop, c.code, orderB)])
  if (holds.some(isRateLimited)) {
    rate_limited.add(1)
    return void iteration_ms.add(Date.now() - started)
  }
  const holdWins = holds.filter((r) => r.status === 200)
  const holdLoses = holds.filter((r) => r.status === 409 && refusalOf(r) === 'HELD')
  unexpected_answer.add(holdWins.length + holdLoses.length !== 2)

  // Both orders redeem at once. Only the holder may; the other gets 409.
  const winner = holds[0].status === 200 ? orderA : orderB
  const loser = winner === orderA ? orderB : orderA
  const redeems = batch([requests.redeem(shop, c.code, winner), requests.redeem(shop, c.code, loser)])
  const redeemWins = redeems.filter((r) => r.status === 200 && String(r.body).includes('"parts"'))
  const redeemLoses = redeems.filter((r) => r.status === 409)
  unexpected_answer.add(redeemWins.length + redeemLoses.length !== 2)
  const exactlyOne = holdWins.length === 1 && redeemWins.length === 1 && redeems[0].status === 200

  // R4: the winner asking again gets the same body. A third order is refused with the state.
  const again = redeemCode(shop, c.code, winner)
  const replayed = again.status === 200 && again.body === redeems[0].body
  const third = holdCode(shop, c.code, `lt-race-${tag}-c`)
  const closed = third.status === 409 && refusalOf(third) === 'REDEEMED'
  unexpected_answer.add(!replayed || !closed)

  race_rounds.add(1)
  race_one_winner.add(exactlyOne)
  redeem_replays.add(replayed)
  const ok = check(null, {
    'race: exactly one hold won': () => holdWins.length === 1,
    'race: exactly one redeem won, and it was the holder': () => redeemWins.length === 1 && redeems[0].status === 200,
    'race: the winner replays the same parts (R4)': () => replayed,
    'race: a later order is refused REDEEMED': () => closed,
  })
  outcome_verified.add(ok)
  if (ok) succeeded.add(1)
  else failed.add(1)
  iteration_ms.add(Date.now() - started)
  // Space the rounds over the lookup ramp rather than firing them all in its first seconds.
  if (!SMOKE) sleep(Math.max(1, 300 / Math.max(RACE_CODES.length, 1)))
}

/** A code past its x: still found, never usable. */
export function expired() {
  abortIfInvalid()
  if (EXPIRED.length === 0) return
  const c = EXPIRED[exec.scenario.iterationInTest % EXPIRED.length]
  const shop = SHOPS[c.shop]
  const look = lookupCode(shop, c.code)
  const hold = holdCode(shop, c.code, `lt-expired-${Date.now()}`)
  if (limited(look) || limited(hold)) return
  let status = null
  try {
    status = JSON.parse(look.body).status
  } catch {
    status = null
  }
  // A code made by an earlier run may since have been redeemed by that run's race; that is not expiry.
  const wasRedeemed = status === 'redeemed'
  const refused = wasRedeemed || (status === 'expired' && hold.status === 409 && refusalOf(hold) === 'EXPIRED')
  expired_refused.add(refused)
  unexpected_answer.add(!refused)
  const ok = check(hold, { 'expired code is refused EXPIRED': () => refused })
  outcome_verified.add(ok)
}

/** The public balance check. No signature; the code is the credential. */
export function publicCheck() {
  abortIfInvalid()
  const c = LOOKUP_CODES[exec.scenario.iterationInTest % LOOKUP_CODES.length]
  const res = codeCheck(c.code)
  if (limited(res)) return
  let body = null
  try {
    body = JSON.parse(res.body)
  } catch {
    body = null
  }
  const ok = check(res, {
    'public check answers 200 active': (r) => r.status === 200 && body !== null && body.status === 'active',
    'public check never shows parts or S': () => body !== null && body.parts === undefined && body.shop_key === undefined,
  })
  unexpected_answer.add(res.status !== 200)
  outcome_verified.add(ok)
}

export function handleSummary(data) {
  const m = data.metrics
  const checks = m.checks?.values
  const share = signingShare(data)
  const dur = (name) => m[`http_req_duration{name:${name}}`]?.values
  const line = (label, name) => {
    const v = dur(name)
    return v ? `    ${label.padEnd(13)} p95 ${v['p(95)'].toFixed(0)}ms  p99 ${v['p(99)'].toFixed(0)}ms` : `    ${label.padEnd(13)} none`
  }
  const rate = (name) => (m[name] ? `${(m[name].values.rate * 100).toFixed(1)}% of ${m[name].values.passes + m[name].values.fails}` : 'NOT MEASURED')

  const lines = [
    '',
    '  Checkout codes: validation and redemption',
    `    store          ${CODES}`,
    `    lookups        ${m.succeeded?.values?.count ?? 0} verified, ${m.failed?.values?.count ?? 0} failed`,
    `    race rounds    ${m.race_rounds?.values?.count ?? 0}`,
    `    one winner     ${rate('race_one_winner')}`,
    `    R4 replays     ${rate('redeem_replays')}`,
    `    R2 misses      ${rate('misses_indistinguishable')}`,
    `    expired        ${EXPIRED.length ? rate('expired_refused') : 'NOT MEASURED: no expired code in .loadtest-codes.json (generate again after x passes)'}`,
    `    unexpected     ${rate('unexpected_answer')}`,
    `    rate limited   ${m.rate_limited?.values?.count ?? 0}`,
    `    checks         ${checks ? `${checks.passes} passed, ${checks.fails} failed` : 'none ran'}`,
    '',
    line('lookup', 'code lookup'),
    line('hold', 'code hold'),
    line('redeem', 'code redeem'),
    line('public check', 'code check'),
  ]
  if (share) lines.push(`    signing       ${share.signing_avg_ms}ms of ${share.iteration_avg_ms}ms (${share.signing_share_percent}%)`, `                  ${share.verdict}`)
  if ((m.rate_limited?.values?.count ?? 0) > 0) {
    lines.push(
      '',
      '    Rate limited answers are the edge (30/min lookups, 60/min writes, per address) or the store',
      '    (60/min per IP and caller, 20/min per code). From one host that is the ceiling, not the store.',
    )
  }
  lines.push('', `    ${RACE_CODES.length} codes are now REDEEMED and cannot be reused; make new ones for the next run.`, '')
  if (!checks || checks.passes === 0) lines.push('  NO CHECKS RAN. This run proved nothing.', '')
  return {
    stdout: lines.join('\n'),
    'loadtest/results/checkout-codes-summary.json': JSON.stringify(data, null, 2),
  }
}
