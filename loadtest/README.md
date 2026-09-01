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
