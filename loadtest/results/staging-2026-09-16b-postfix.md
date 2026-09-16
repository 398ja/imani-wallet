# Staging load test re-run — 2026-09-16 (post-fix)

Re-run of the gateway suite after the rate-limit and replay-cache fixes reached
staging. Same host, same ramp, same 21-VU pool as the morning run, so the
numbers are comparable.

- staging carries the fixes: `nip98_eventid_cache_is_process_local
  ttl_seconds=600 max_size=60000` at boot, against `120`/`10000` before
- imani-wallet `03bd7b9`, k6 v2.0.0, signer sidecar 12 workers

## The headline

| | before | after |
|---|---|---|
| drains completed | 241 | **5013** |
| rate limited | **2083** | **0** |
| http failure rate | 44.8% | 0.1% |
| nip98 ttl-mismatch warnings | 2573 | **0** |
| gateway p95 | 321ms | 442ms |
| signing median | 3ms | 3ms |

**20.8x more work through the same ramp, and nothing throttled.** The p95 rose
by 121ms, which is the honest cost of the service actually doing 20x the work
rather than rejecting most of it — the earlier 321ms was largely the latency of
being told "no".

Both fixes are confirmed in production behaviour, not just in tests:

- **The rate limit.** Zero 429s across 5013 authenticated drains from one host.
  The anonymous path is unchanged and still bounded, verified separately: 60
  requests through before the first 429, exactly the configured budget.
- **The replay window.** The `requested_seconds=600 actual_seconds=120`
  mismatch is gone entirely. That 480-second gap, in which a captured request
  passed the clock check but was no longer remembered, is closed.

## What the fix uncovered

Removing the limiter let load reach two things it had been shielding.

### The JMS session cache was sized for one caller

9 of 5013 drains failed — 0.18%, seven 500s and a 504 — with
`AMQ219010: Connection is destroyed` and `AMQ219014: Timed out after waiting
30000 ms`. The morning run failed **zero** drains, because it only ever
completed 241.

Spring Boot does wrap the Artemis connection factory in a
`CachingConnectionFactory`; `spring.jms.cache.enabled` is `matchIfMissing=true`.
(I wrote a bean to do that before checking, and deleted it.) What Boot does not
do is cache more than one **session**: `sessionCacheSize` defaults to 1. Both
drain endpoints open a `QueueBrowser` with a per-recipient selector on every
request, so concurrent drains contend for that single cached session and build
the overflow per call — each one a synchronous round trip to the broker.

Fixed as configuration, not code: `session-cache-size: 32`, consumers left
uncached deliberately because a per-pubkey selector means a cached consumer is
never reused. `imani-gateway-core` `8b3ffaf`.

### The overflow alarm was measuring the wrong thing

Staging still reported `nip98_eventid_cache_overflowing` after the sizing fix —
119 times in 15 minutes, against a 60,000-entry cache holding a few thousand
ids. The sizing fix had plainly worked, and the alarm could not tell me so.

The alarm read Caffeine's `evictionCount()`, which counts **expired** entries as
evictions. A cache doing exactly what it was configured to do therefore began
reporting overflow the moment its TTL first elapsed, and never stopped.

Only `RemovalCause.SIZE` counts now — an id forgotten while still inside its
replay window, which is the case that actually weakens protection. Exposed as
`sizeEvictionCount()` so the distinction is observable. `imani-security`
`2bd21e8`.

This one is worth more than its diff. It was the loudest ERROR in the log, it
is the alarm that says replay protection is degraded, and it meant nothing. An
alarm that fires when nothing is wrong is one people learn to scroll past.

## Still true from the morning run

- **Drain measures an empty queue.** 5013 drains, 5013 empty, 0 envelopes. What
  is measured is the cost of answering "nothing waiting". The real work of
  returning and acknowledging envelopes is still unmeasured, and
  `payment-receipts.q` still holds entries stamped `Jul 05` and `Jul 21`.
- **Issuance and send still cannot run against staging**, by design: the portal
  is gated on a session cookie a NIP-98 client cannot obtain. Both now abort in
  about a second instead of ramping for three and a half minutes.
- **gateway-core runs at ~63% of a 1 GiB cap.** Unchanged, still the tightest
  headroom on the host.

## What this still does not establish

A capacity ceiling. The limiter no longer bounds the run, but the JMS session
cache did — at 0.18%, quietly — and that fix is not yet deployed. The next run
against a build carrying `8b3ffaf` is the one that can honestly look for where
staging breaks, because it will be the first where nothing known is bounding it
first.

Worth stating plainly: each fix so far has revealed the next bottleneck rather
than reaching a wall. That is the expected shape, and it means "where does
staging break first" is answered one layer at a time, not in one run.

## Reproducing

    node loadtest/signer.mjs &
    GATEWAY_URL=https://wallet.staging.398ja.xyz \
    ACCOUNT_URL=https://wallet.staging.398ja.xyz \
    PORTAL_URL=https://wallet.staging.398ja.xyz \
      k6 run loadtest/smoke.js && k6 run loadtest/drain.js

Raw summary: `staging-2026-09-16b-drain-summary.json`.
