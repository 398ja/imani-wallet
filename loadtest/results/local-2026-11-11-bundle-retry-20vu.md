# Bundle under relay failure, 20 VUs, local stack (2026-11-11)

imani-wallet#552. Scenario `loadtest/bundle-retry.js`, fault proxy `loadtest/stub/dm-fault-proxy.mjs`.
**Local `imani-test` stack only. Nothing was run against staging.**

## What ran

| | |
|---|---|
| gateway-core, account-app | `imani-gateway-core:fix552-local`, branch `fix/552-reclaim-transition-first` (imani-gateway-core#215) |
| DM path | gateway-core → `dm-fault-proxy` → customer-wallet. Fails the first DM publish of 30% of sends with `502 RELAY_PUBLISH_FAILED`. |
| load | 20 VUs, 10 min, bundles of 4 parts × €2.00, 4 stalls, `RECLAIM_SHARE=0.25` |
| started | 2026-11-11T22:37:44Z |

## Result: all thresholds held

| Gate | Threshold | k6 | Postgres (`imani_core`) |
|---|---|---|---|
| `bundle_complete` | >95% | **100% of 47** finished bundles | **50/50** bundles: every part `COMPLETED`, or `RECLAIMED` by the probe. **0 left part-paid.** |
| `part_recovered` | >95% | **100% of 39** | **42/42** parts the gateway retried (`DM_RETRY_FROM_ERROR`, SYSTEM) ended `COMPLETED` |
| `reclaim_refused_while_retrying` | 100% | **13/13** answered with the token (0 × 422) | 13 × `RECLAIM_FROM_DM_ERROR` (USER) |
| `no_double_handout` | 100% | **13/13** | **0** sends both `COMPLETED` and `RECLAIMED` |

The fault proxy injected **141** failed DM publishes, one per chosen send, over 565 DMs.

After the run, Postgres held **0** `RECLAIMED` rows still carrying a token (each was acked and
cleared) and **0** non-terminal sends. The 3 bundles k6 counted as unfinished when the run stopped
were completed by the gateway's own retry afterwards.

## Latency (reported, not gated)

| | p50 | p95 |
|---|---|---|
| part, initiate to end | 2.2 s | 96 s |
| part that went through a retry | 18.7 s | 120.7 s |
| whole 4-part bundle | 157 s | 308 s |
| any gateway request | | 452 ms |

A retried part takes about one to two minutes. That is gateway-core's DM retry sweep
(`retryStuckDmDeliveries`, every 120 s by default), and it is why the fixed wallet waits up to
150 s on a retry state (`RETRY_WAIT_MS`). The pre-fix wallet listed `DM_ERROR` as terminal, so it
stopped on the first read that showed it, called reclaim (422) and ended the bundle. All 42
retried parts reached `DM_ERROR` (that is how they were counted), so under the old wallet each of
their bundles would have stopped part-paid, however quickly the retry then delivered. That is the
2026-11-07 incident. This comparison is inferred from the old code, not measured: the old wallet
was not run against the proxy.

## Not about #552

- **36 of 83 iterations could not mint 4 coupons** (`mint_misses`, `never_issued`): the
  coupon stayed ISSUED with no token for the whole poll. The local mint's invoice lookup
  (`phoenixd_lookup_failed`, payment-adapter → phoenixd-mock) fails under load, and
  customer-wallet's circuit to the mint opens. It was already failing before this run (122
  lookups failed in the hour before the fix was deployed) and recovers at idle. These iterations
  sent nothing, so they are not in any gate.
- Two coupon reads timed out (`http_req_failed` 0.01%).

## Earlier runs, kept honest

Two earlier 20-VU attempts measured the harness rather than the fix, and each found a bug in it:

1. The reclaim probe was rolled on every status read. That made it nearly 100%, so all 34 faults
   ended `RECLAIMED` by the probe and the gateway's retry was never seen. Fixed: one roll per part.
2. `GATEWAY_URL=:28082` failed NIP-98 on every coupon read (`401 URL mismatch`; the stack
   verifies against the wallet origin), so 138 of 165 iterations never got a backed coupon.
   Fixed: run with `GATEWAY_URL=http://localhost:5173`.

Both are recorded in `loadtest/README.md` under "The bundle under relay failure".
