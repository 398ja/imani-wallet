// Measure the cost of the commitment scheme, to settle the range-proof question.
//
// Usage: npx tsx scripts/bench-commitments.mts
//
// ## Why this is a script and not a test
//
// It answers a DESIGN question — is a per-nullifier-openings disclosure
// affordable, or is the homomorphic sum the only shape that fits a
// single-threaded public service — and the answer is a number that depends on
// the machine. A test would have to assert a threshold, and a timing threshold
// on shared CI is a flake generator. This prints and lets a human decide.
//
// ## Read the methodology note before trusting any number here
//
// Two wrong answers came out of this work before the method was fixed, both
// from single-shot timing on a cold VM:
//
//   - `/verify-total` was reported at ~2,000 ms for 500 entries. It is ~57 ms.
//     The 2,000 ms figure was 500 `commitTo` calls, which is a DIFFERENT
//     operation: `verifyDisclosedTotal` does 500 cheap point ADDITIONS and
//     exactly one `commitTo`, not 500 of them.
//   - Precomputing the Pedersen `H` point was reported as a 7.9x speedup. It is
//     not; noble already caches internally, and the "speedup" was JIT warm-up.
//     The same call measured 0.39 ms and 4.1 ms in two runs on one machine.
//
// Hence: warm hard, take the MEDIAN, never the mean, and never a single shot.
// Mean is wrong here because a GC pause or a deopt lands entirely in one sample
// and drags the average; the median ignores it.
import { commitTo, verifyDisclosedTotal } from '../src/lib/audit.ts'

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

/** Enough iterations that V8 has tiered up before anything is recorded. */
const WARM = 2000
for (let i = 0; i < WARM; i++) commitTo(1000, BigInt(i) + 1n)

// --- one commitment: what a single redemption costs, and what each opening costs
const perCommit = median(
  Array.from({ length: 50 }, () => {
    const t = performance.now()
    for (let i = 0; i < 20; i++) commitTo(5000, BigInt(i) + 1n)
    return (performance.now() - t) / 20
  }),
)

// --- the homomorphic sum at the service's own cap
const N = Number(process.argv[2] ?? 500)
const entries = Array.from({ length: N }, (_, i) => ({
  amount: 1000 + i,
  blind: BigInt(i) + 1n,
}))
const commitments = entries.map((e) => commitTo(e.amount, e.blind))
const total = entries.reduce((s, e) => s + e.amount, 0)
const blindSum = entries.reduce((s, e) => s + e.blind, 0n).toString(16)

for (let i = 0; i < 5; i++) verifyDisclosedTotal(commitments, total, blindSum)
const perSum = median(
  Array.from({ length: 15 }, () => {
    const t = performance.now()
    verifyDisclosedTotal(commitments, total, blindSum)
    return performance.now() - t
  }),
)

// Guard: a benchmark of a function that silently returns false measures nothing.
if (!verifyDisclosedTotal(commitments, total, blindSum)) {
  throw new Error('verifyDisclosedTotal rejected a correct set — the benchmark is invalid')
}

const perOpenings = N * perCommit

console.log(`n = ${N}\n`)
console.log(`commitTo (one redemption)     ${perCommit.toFixed(2)} ms`)
console.log(`verifyDisclosedTotal @${N}     ${perSum.toFixed(1)} ms   <- today's design`)
console.log(`per-nullifier openings @${N}   ${perOpenings.toFixed(0)} ms   <- the "cheap" alternative`)
console.log(`\nopenings cost ${(perOpenings / perSum).toFixed(1)}x the homomorphic sum`)

console.log(`\nIf openings replace the sum, the disclosure cap must fall with them:`)
for (const budget of [50, 100, 200]) {
  console.log(`  ${String(budget).padStart(3)} ms of blocked event loop -> ${Math.floor(budget / perCommit)} openings`)
}
console.log(
  `\nAUDIT_DISCLOSURE_LIMIT is currently 500, which under openings would be` +
    `\n${perOpenings.toFixed(0)} ms on a single-threaded, public, CORS-open service.`,
)
