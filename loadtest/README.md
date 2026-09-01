# Gateway load testing

Measures the service under load. Needs a real deployment, and because staging
is shared and single-host, a run cannot gate anything: two runs collide and
neither is reproducible. An operator runs this deliberately.

The device-side counterpart lives in [`perf/`](../perf/README.md), and the
decisions common to both are recorded there.

## The signer

    node loadtest/signer.mjs          # 12 workers on 127.0.0.1:8765
    node loadtest/signer-check.mjs    # prove it before trusting a run

Signing happens in a sidecar process rather than inside the load generator.
This is settled by measurement, not preference: the retired imani-apps project
measured in-engine signing at **p99 676ms**, about 67x over its budget, and the
same work in a Node sidecar at **p99 61ms, 2401 req/s**. Both results are in
that repo's `loadtest/spike-0/` and `spike-0b/`. Re-running the failed
experiment to rediscover the same answer is the most predictable waste
available here.

`signer-check.mjs` asks three things, in this order:

1. **Is every signature valid?** First, because a signer that is fast and wrong
   fails every request at the gateway, and the run then reads as a gateway
   problem. Verified against locally derived public keys, and `derivePub` is
   checked separately so a signer signing with the wrong key cannot pass.
2. **Does it sustain the rate a ramp demands?** Gated at 250/s, ten times the
   ~25/s that 50 customers signing twice per iteration actually need.
3. **What share of an iteration does signing cost?** Reported per scenario, so
   the moment the run starts measuring the load generator is visible rather
   than inferred.

### Reading its latency correctly

The checker and the signer share one machine, so they compete for cores.
Throughput *falls* as workers rise, measured on a 12-core laptop:

| Workers | Throughput | p99 |
|---|---|---|
| 2 | 412/s | 62ms |
| 4 | 394/s | 68ms |
| 8 | 374/s | 72ms |
| 12 | 371/s | 76ms |

More workers is worse because each takes a core the checker needed. A single
signature costs about **2ms of CPU** measured directly, so twelve cores could
produce several thousand a second; nothing near that appears here because the
*client* is the constraint.

So these numbers are a floor on the signer and a ceiling on the checker. Under
a real run the load generator is the busy party and the signer has cores to
itself. Quoting the checker's latency as the signer's cost would be the same
error as quoting a laptop figure as production capacity.

## The helper library

    loadtest/lib/signed-request.js   NIP-98 signing, via the sidecar
    loadtest/lib/gateway.js          the calls the wallet makes
    loadtest/lib/metrics.js          what a run measures
    loadtest/smoke.js                prove it all works, at one customer

Ported from the retired imani-apps project and renamed on the way in: it spoke
of vouchers, merchants and users, all of which this repository's `CONTEXT.md`
lists under terms to avoid. Since that project is retired and nothing will be
merged back, preserving a comparable diff has no value, and a port is the one
moment renaming is free.

Two things were checked against this wallet's own source rather than carried
over. The signature has **no nonce tag**: imani-apps added one, `src/lib/nip98.ts`
does not, and a load test that signs differently from the wallet measures a
path no customer takes. And the request bodies match what the wallet sends,
read from `src/lib/issue.ts` and `src/lib/incomingNotifications.ts`.

### The smoke run

    node loadtest/signer.mjs &
    GATEWAY_URL=http://localhost:28082 PORTAL_URL=http://localhost:28084 \
      k6 run loadtest/smoke.js

Every full run starts with this. imani-apps' first two real runs each spent
fifteen minutes discovering bugs in the *scripts* rather than anything about
the system; one customer and three iterations catches that in seconds.

Verified to fail when it should, which is what makes a pass mean anything:

| Situation | Result |
|---|---|
| Everything working | 9 checks passed, exit 0 |
| Signer not running | exit 107, names the command to start it |
| Gateway unreachable | exit 99, 6 checks failed, thresholds crossed |
| No checks ran at all | reported explicitly, since `rate==1.0` is vacuously true against nothing |

### Reading the signing share

Every run reports what fraction of an iteration was spent signing, because the
sidecar is fast but not free and a run whose iterations are mostly signing has
stopped measuring the gateway.

The share is only judged once iterations are doing real work (500ms or more). A
smoke run is ~78% signing by construction: it makes two trivial calls, so
almost all of its time is signature overhead. Warning about that would be noise
that teaches people to ignore the warning when it matters, so the number is
printed and the conclusion withheld.

## The customer pool

    node loadtest/pool.mjs --size 50            # create, or top up to 50
    node loadtest/pool.mjs --size 50 --verify   # and check each is usable

Customers are named by position (`loadtest-customer-0000`), so the same index
is the same customer on every run. That is what makes topping up possible, and
it lets a scenario pair customer N with customer M reproducibly.

Running it again **tops up rather than rebuilds**, which matters beyond
convenience: rebuilding would orphan the coupons previous runs issued, under
keys nothing references any more. The pool accumulates value across runs,
since issuance is what funds sending, splitting and draining.

| Command | Result |
|---|---|
| `--size 10` on an empty pool | added 10, total 10 |
| `--size 10` again | added 0, "already had 10" |
| `--size 25` | added 15, total 25, **customer 0000 keeps its key** |
| `--size 5 --verify` against a live gateway | 5/5 usable, exit 0 |
| `--verify` against a dead gateway | 0/3 usable, exit 1 |

Keys land in `.loadtest-pool.json`, which git ignores. They are throwaway
identities on a test deployment and worth nothing, but they are still keys.

## The issuance ramp

    node loadtest/signer.mjs &
    node loadtest/pool.mjs --size 50
    GATEWAY_URL=http://localhost:28082 PORTAL_URL=http://localhost:28084 \
      EDGE_SECRET=dev-edge-secret-local-only \
      k6 run loadtest/issuance.js

Issuance goes first because it produces the coupons that sending, splitting and
draining all consume. It is both the first measurement and the tool that funds
everything after it.

**No latency threshold, on purpose.** This is capacity discovery: the output is
a report saying where the deployment degraded. Inventing a pass mark before a
baseline exists would produce a number nobody could defend. The only thresholds
are correctness ones.

### The first finding

The gateway rate-limits issuance, keyed on **client IP**, so every customer in
the pool shares one budget. On this stack a run issues 20-40 coupons before
`PathRateLimitFilter` starts refusing, and the window clears after about a
minute.

That is the answer to "where does this break first", and it is reported as a
finding rather than as failures.

### Why the script has to infer throttling

`gateway-customer` returns a proper `429` with a `RATE_001` body. `gateway-portal`
catches it and re-emits a bare `500 {"error":"Internal server error"}`, so
**nothing a caller receives says "rate limited"**. Filed as #37.

Until that is fixed, the script issues one coupon before applying load, and
then reads later opaque 500s as throttling. The inference is only sound because
the pre-run probe established the endpoint works; if it did not, failures are
reported as failures, which is the safe way round. A genuine outage must not be
excused as a rate limit.

That probe retries for up to a minute, because a previous run can leave the
window saturated. Without the retry, two runs back to back reported **12660
failures** and **0** respectively for a deployment that was healthy both times.

## Aborting a run whose data is already invalid

    node loadtest/abort-watch.mjs &                     # watch, serve on :8766
    node loadtest/abort-watch.mjs --check               # one pass, then exit

    ABORT_WATCHER_URL=http://127.0.0.1:8766 k6 run loadtest/issuance.js

A run that keeps going after a subsystem has failed generates data that is
already invalid, and buries the moment things went wrong under minutes of
consequences.

### Observed signals, and unproven ones

Every pattern is marked `observed` or `unproven`, and that distinction is the
whole point.

imani-apps' plan predicted a connection pool would fail with `Connection is not
available, request timed out`. Under load it failed with `HikariDataSource has
been closed` — a *closed* pool, not a timeout waiting for a slot. Its own run
report records "Hikari `Connection is not available`: **0 observations**". The
predicted signal never fired while the run produced hours of worthless data.

| Signal | Confidence | Evidence |
|---|---|---|
| `HikariDataSource has been closed` | observed | 316 in imani-apps run 002 |
| `relay_subscription_failed` | observed | 332, starting ~564ms before the pool closures |
| `proof_repository persist_failed` | observed | 243, downstream of the closed pool |
| `check_pending_voucher_failed` | observed | 117 |
| `Connection is not available` | **unproven** | predicted, 0 observations |
| `proofs_not_bound` | **unproven** | never seen |

Adding a pattern is cheap. *Believing* an unproven one is what costs a run.

### Two kinds of invalid

A **subsystem failure** means the deployment is unwell: the run found something
and should stop before recording the consequences.

**Load generator saturation** means this machine ran out of capacity before the
gateway did, so the numbers describe the laptop. That is not a gateway capacity
finding, and the two are easy to confuse because the graphs look alike.

**Rate limiting is deliberately not an abort signal.** It is the deployment
defending itself, and aborting on it would end every issuance run at the moment
it discovered what it went looking for.

### Demonstrated, not merely implemented

| Case | Result |
|---|---|
| A signal that is present | k6 exits **108**, `test aborted: SUBSYSTEM FAILED: … (observed)` |
| Healthy stack, watcher live | 39 issued, 0 failed, exit 0, no spurious abort |
| No watcher configured | run proceeds unchanged |
| Watching staging (no local containers) | no breach, since there is nothing to read |

Abort logic that has never been seen to fire is indistinguishable from none.
