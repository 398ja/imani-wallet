# Staging load test — 2026-09-16 (post-deploy, run C)

Third run of the day, and the first against a deployment carrying **all** the
fixes. Same host, same ramp, same 21-VU pool throughout, so all three runs are
directly comparable.

Deployed build verified before measuring, not assumed:

- `ttl_seconds=600 max_size=60000` at boot (replay cache sized from the window)
- `GATEWAY_TRUSTED_PROXY_COUNT=2` inside gateway-portal
- gateway-core and gateway-portal restarted 13:21Z from `0ad927d`

## Three runs

| | orig | post rate-limit | **post JMS** |
|---|---|---|---|
| drains completed | 241 | 5013 | **9118** |
| failed | 0 | 9 | **0** |
| rate limited | 2083 | 0 | 328 |
| http failure rate | 44.8% | 0.1% | 1.7% |
| gateway p95 | 321ms | 442ms | **356ms** |
| gateway max | 4786ms | 60001ms | **4095ms** |
| signing median | 3ms | 3ms | 3ms |

**37.8x more successful drains than the original run, and zero failures.**

The p95 also *improved* against run B (442ms → 356ms) while carrying 82% more
traffic, and the worst-case max fell from 60 seconds to 4. That 60s was the JMS
timeout: a drain waiting 30s for a broker response, twice. With sessions cached
it is gone, and so are all nine failures.

Three things confirmed fixed by their absence in the logs over the run:

| Signal | before | now |
|---|---|---|
| `AMQ219010` / `AMQ219014` | 9 | **0** |
| `nip98_eventid_cache_overflowing` | 452 / 20min | **0** |
| `nip98_eventid_ttl_shorter_than_requested` | 2573 | **0** |

The overflow alarm being silent is the meaningful one. It is not quiet because
the cache stopped evicting — it still expires ids constantly — but because it
now only reports the case that actually weakens replay protection.

## The 328 rate-limited are the backstop working

Not a regression, and worth being precise about since the whole point of run B
was that this number reached zero.

The load generator sustained **77.6 req/s = 4656 req/min from a single
address**, against the per-address aggregate of 3000/min. So 3.5% were refused,
and gateway-core logged 332 `rate_limit_address_aggregate_exceeded` — the
backstop introduced precisely to stop a re-rollable keypair buying an unlimited
budget.

This is the designed behaviour meeting a load generator that looks, to an
address-keyed limiter, exactly like the abuse it exists to bound. Note what
did **not** happen: no per-pubkey budget was hit. Each of the 21 wallets stayed
well inside its own 300/min, which is the distinction the fix was built for.

It does mean a single-host run now tops out around 3000 drains/min. Raising
`GATEWAY_RATE_LIMIT_ADDRESS_AGGREGATE_PER_MINUTE` for a load-test window is the
honest way past it, and the fact that it must be raised deliberately is the
protection working rather than a defect.

## Where staging breaks first

With the limiter no longer masking it and the broker no longer failing, this
run is the first that can answer the question honestly, and the answer is:

**Nothing in the service broke.** 9118 drains, 0 failures, 18236/18236 checks
passed, p95 356ms including a transatlantic round trip, and a median of 219ms
that barely moved across a 38x throughput range. The first limit reached was a
policy limit we chose, not a resource one.

What that does *not* establish is the ceiling of the drain path itself, because
the aggregate cap now bounds the run before any subsystem does. Finding the
real ceiling needs either a raised aggregate for the window, or load from
several addresses — which is also a more honest model of production, where
3000/min from one address is not the shape traffic arrives in.

## Unchanged from earlier runs

- **Drain still measures an empty queue.** 9118 drains, 9118 empty. The cost of
  answering "nothing waiting" is now well characterised; the work of returning
  and acknowledging envelopes is still unmeasured, and `payment-receipts.q`
  still holds entries stamped `Jul 05` and `Jul 21`.
- **Issuance and send remain local-stack scenarios**, gated behind a session
  cookie a NIP-98 client cannot obtain.
- **gateway-core sits at ~63% of a 1 GiB cap.** Still the tightest headroom on
  the host, still no OOM.

## Reproducing

    node loadtest/signer.mjs &
    GATEWAY_URL=https://wallet.staging.398ja.xyz \
    ACCOUNT_URL=https://wallet.staging.398ja.xyz \
    PORTAL_URL=https://wallet.staging.398ja.xyz \
      k6 run loadtest/smoke.js && k6 run loadtest/drain.js

Raw summary: `staging-2026-09-16c-drain-summary.json`.
