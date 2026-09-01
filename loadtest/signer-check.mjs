#!/usr/bin/env node
/**
 * Prove the signer before trusting a run that depends on it.
 *
 *   node loadtest/signer-check.mjs [--seconds 20] [--concurrency 50]
 *
 * Three questions, in the order they matter:
 *
 * 1. Is every signature valid? A fast signer producing wrong signatures would
 *    fail every request at the gateway, and the run would read as a gateway
 *    problem rather than a load-generator one.
 * 2. Does it sustain the rate a ramp will demand?
 * 3. What does a signature cost, as a share of an iteration? The sidecar is
 *    fast, not free, and once its share grows large the run is measuring the
 *    load generator instead of the gateway.
 *
 * WHAT THE LATENCY HERE DOES AND DOES NOT MEAN
 *
 * This checker and the signer share one machine, so they compete for the same
 * cores and the round-trip includes that contention. Measured on a 12-core
 * laptop, throughput FALLS as signer workers rise:
 *
 *   2 workers -> 412/s, p99 62ms      8 workers  -> 374/s, p99 72ms
 *   4 workers -> 394/s, p99 68ms      12 workers -> 371/s, p99 76ms
 *
 * More workers is worse, because each one takes a core this checker needed.
 * A single signature costs about 2ms of CPU (measured directly), so twelve
 * cores could produce several thousand a second; nothing near that is reached
 * here because the client, not the signer, is the constraint.
 *
 * So treat these numbers as a floor on the signer and a ceiling on this
 * checker. Under a real run the load generator is the busy party and the
 * signer has cores to itself, which is the arrangement the retired project
 * measured at 2401/s and p99 61ms. Reporting this checker's latency as the
 * signer's cost would be the same mistake as quoting a laptop figure as
 * production capacity.
 */

import { schnorr } from '@noble/curves/secp256k1.js'
import { randomBytes } from 'node:crypto'
import { Agent, setGlobalDispatcher } from 'undici'

// Node's fetch opens ONE connection per origin by default, so without this
// every worker below would queue behind a single socket. Set explicitly so
// the transport is not silently the constraint.
//
// It made little difference in practice, which was itself informative: the
// limit here is CPU contention between this checker and the signer, not
// sockets. Left in place because a hidden single-socket queue is exactly the
// kind of thing that would matter on different hardware and be invisible.
setGlobalDispatcher(new Agent({ connections: 256, pipelining: 0 }))

const PORT = Number(process.env.SIGNER_PORT || 8765)
const BASE = `http://127.0.0.1:${PORT}`

function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : Number(process.argv[i + 1])
}

const SECONDS = flag('seconds', 20)
const CONCURRENCY = flag('concurrency', 50)

const hex = (b) => Buffer.from(b).toString('hex')

async function main() {
  const health = await fetch(`${BASE}/health`).catch(() => null)
  if (!health?.ok) {
    console.error(`No signer on ${BASE}. Start it with:\n\n  node loadtest/signer.mjs\n`)
    process.exit(2)
  }

  // One customer key per worker, the way a run gives each VU its own.
  const keys = Array.from({ length: CONCURRENCY }, () => {
    const priv = randomBytes(32)
    return { privHex: hex(priv), pub: schnorr.getPublicKey(priv) }
  })

  // Derivation is checked separately: a signer that derives the wrong public
  // key would sign correctly for an identity nobody expects, and every
  // signature would verify locally while the gateway rejected all of them.
  for (const key of keys.slice(0, 5)) {
    const res = await fetch(`${BASE}/derivePub`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ privHex: key.privHex }),
    })
    const { pubHex } = await res.json()
    if (pubHex !== hex(key.pub)) {
      console.error(`derivePub disagrees with local derivation:\n  ${pubHex}\n  ${hex(key.pub)}`)
      process.exit(1)
    }
  }

  console.log(`Signing for ${SECONDS}s at concurrency ${CONCURRENCY}…`)

  const latencies = []
  let signed = 0
  let invalid = 0
  let failed = 0
  const until = Date.now() + SECONDS * 1000

  async function worker(key) {
    while (Date.now() < until) {
      const msg = randomBytes(32)
      const msgHex = hex(msg)
      const started = performance.now()
      try {
        const res = await fetch(`${BASE}/sign`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ privHex: key.privHex, msgHex }),
        })
        if (!res.ok) {
          failed++
          continue
        }
        const { sigHex } = await res.json()
        latencies.push(performance.now() - started)

        // Verified against a locally derived public key, so a signer that
        // silently signed with the wrong key would be caught.
        if (!schnorr.verify(Buffer.from(sigHex, 'hex'), msg, key.pub)) invalid++
        signed++
      } catch {
        failed++
      }
    }
  }

  const wall = performance.now()
  await Promise.all(keys.map(worker))
  const elapsed = (performance.now() - wall) / 1000

  latencies.sort((a, b) => a - b)
  const at = (q) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * q))]
  const rate = signed / elapsed

  console.log(`
  signatures     ${signed}
  invalid        ${invalid}
  failed         ${failed}
  throughput     ${rate.toFixed(0)}/s
  latency        median ${at(0.5).toFixed(1)}ms   p95 ${at(0.95).toFixed(1)}ms   p99 ${at(0.99).toFixed(1)}ms`)

  // What this costs a run, which is the number that decides whether the
  // sidecar is distorting a measurement.
  const p99 = at(0.99)
  console.log(`
  A signature costs ${p99.toFixed(0)}ms at p99 as measured HERE, which includes
  this checker competing with the signer for cores. Under a real run the signer
  has cores to itself and this is an overestimate. As a share of an iteration:`)
  for (const [scenario, iterMs, signs] of [
    ['issuance', 4000, 2],
    ['send', 3000, 2],
    ['split', 2000, 2],
    ['bundle of 5', 6000, 10],
  ]) {
    const share = ((p99 * signs) / iterMs) * 100
    console.log(
      `    ${scenario.padEnd(12)} ${signs} signs / ${iterMs}ms  ->  ${share.toFixed(1)}%` +
        (share > 25 ? '   <- over 25%, the run would be measuring the signer' : ''),
    )
  }

  let bad = false
  if (invalid > 0) {
    console.error(`\n${invalid} signatures did not verify. The signer is wrong, not slow.`)
    bad = true
  }
  if (failed > 0) {
    console.error(`\n${failed} requests failed outright.`)
    bad = true
  }
  // Gated on the demand a ramp actually makes, not on the retired project's
  // 2401/s: that figure came from its hardware, and demanding it here would be
  // cargo-culting someone else's laptop. Fifty customers signing twice per
  // iteration at roughly one iteration every four seconds is about 25/s, so
  // 250/s is ten times the requirement.
  //
  // The gate is deliberately not tightened toward what this machine can do.
  // The number measured here is bounded by this checker competing with the
  // signer for cores, and a gate set from it would fail on a busier machine
  // for a reason that has nothing to do with the signer.
  if (rate < 250) {
    console.error(`\n${rate.toFixed(0)}/s is below the 250/s a ramp needs with headroom.`)
    bad = true
  }
  process.exit(bad ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
