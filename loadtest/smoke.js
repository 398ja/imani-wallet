// Prove the helpers work, at one customer, in a few seconds.
//
//   node loadtest/signer.mjs &
//   GATEWAY_URL=http://localhost:28082 k6 run loadtest/smoke.js
//
// Every full run starts with this. The retired imani-apps project's first two
// real runs both spent fifteen minutes discovering bugs in the *scripts*
// rather than anything about the system, which is exactly what a cheap check
// at one customer catches in seconds.
//
// This asserts the plumbing, not performance: that the signer is up, that a
// signature is accepted, and that the gateway answers. It deliberately does
// not assert latency, because one customer says nothing about capacity.

import { check } from 'k6'
import { requireSigner, derivePub } from './lib/signed-request.js'
import { resolve, drainNotifications, GATEWAY } from './lib/gateway.js'
import { iteration_ms, succeeded, failed, outcome_verified, signingShare } from './lib/metrics.js'

export const options = {
  vus: 1,
  iterations: 3,
  // A smoke run that "passes" while every request fails is worse than none.
  thresholds: {
    checks: ['rate==1.0'],
    outcome_verified: ['rate==1.0'],
  },
}

// A throwaway key. Nothing here needs a funded customer: the point is that a
// signature is well-formed and the gateway is reachable.
const PRIV = '0000000000000000000000000000000000000000000000000000000000000042'

export function setup() {
  requireSigner()
  const pubHex = derivePub(PRIV)
  console.log(`gateway  ${GATEWAY}`)
  console.log(`customer ${pubHex.slice(0, 16)}…`)
  return { customer: { privHex: PRIV, pubHex } }
}

export default function (data) {
  const started = Date.now()
  let ok = true

  // Unauthenticated first: if this fails, the gateway is unreachable and
  // nothing about signing is worth investigating yet.
  const resolved = resolve('nobody@example.invalid')
  ok = check(resolved, {
    'gateway answers an unauthenticated call': (r) => r.status > 0 && r.status < 500,
  }) && ok

  // Then a signed call. A 200 or a 4xx both prove the signature was read and
  // understood; only 401 AUTH_002 means the signing itself is wrong.
  const drained = drainNotifications(data.customer, 1)
  ok = check(drained, {
    'gateway accepts a signed request': (r) => r.status !== 0,
    'signature is not rejected as malformed': (r) =>
      !(r.status === 401 && String(r.body).includes('AUTH_002')),
  }) && ok

  if (drained.status === 401 && String(drained.body).includes('AUTH_002')) {
    console.error(
      'AUTH_002 URL mismatch: the u tag disagrees with the URL the gateway ' +
        'rebuilt from the Host header. Check GATEWAY_URL matches how the ' +
        'gateway sees itself, including scheme and port.',
    )
  }

  outcome_verified.add(ok)
  if (ok) succeeded.add(1)
  else failed.add(1)
  iteration_ms.add(Date.now() - started)
}

export function handleSummary(data) {
  const checks = data.metrics.checks?.values
  const lines = [
    '',
    `  checks       ${checks ? `${checks.passes} passed, ${checks.fails} failed` : 'none ran'}`,
    `  iterations   ${data.metrics.iterations?.values?.count ?? 0}`,
    `  gateway      avg ${(data.metrics.gateway_ms?.values?.avg ?? 0).toFixed(1)}ms`,
  ]

  const share = signingShare(data)
  if (share) {
    lines.push(
      `  signing      ${share.signing_avg_ms}ms of ${share.iteration_avg_ms}ms ` +
        `(${share.signing_share_percent}%)`,
      `               ${share.verdict}`,
    )
  }

  // A smoke run that ran no checks at all must not read as a pass: k6's
  // rate==1.0 threshold is vacuously true when nothing was checked.
  if (!checks || checks.passes === 0) {
    lines.push('', '  NO CHECKS RAN. This did not prove anything.')
  }

  return { stdout: lines.join('\n') + '\n' }
}
