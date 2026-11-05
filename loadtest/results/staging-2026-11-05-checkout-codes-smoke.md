# Checkout codes: smoke against staging, 2026-11-05

Not a load run. One pass of each half at the lowest rate that exercises every
path, to prove the scripts against the real store before anyone ramps them.

Target: `https://wallet.staging.398ja.xyz` (store proxied same-origin at
`/v1/checkout-codes`). Stalls: pool indices 0 and 1, already enrolled.

## Generation

    npx vite-node loadtest/checkout-codes-make.mts -- --stalls 2 --codes 3 --rate-start 2 --rate-end 2 --concurrency 2

| | |
|---|---|
| made | 3 of 3, 0 rate limited, 0 failed |
| issue | avg 2.7s, max 4.7s |
| mint wait | avg 15.8s, max 20.9s |
| lock + deposit | avg 9.0s, max 12.5s |
| deposit call alone | avg 1.5s, max 2.1s |
| whole code | avg 27.5s, max 38.0s |

It crossed the first thresholds (deposit p95 2s, whole code p95 30s). They were
set from market-day's ~6s mint wait; staging's was 13-21s here. Re-derived from
the client budgets (README, "Choosing the thresholds") to 3s and 45s.

Shortly before, staging's gateway-core answered 502 on `/api/v1/config` and
`/api/v1/auth/init` for under a minute, then recovered. The store answered
throughout. Not caused by this run, which had not started issuing yet.

## Validation and redemption

    SMOKE=1 RACE_ROUNDS=1 k6 run loadtest/checkout-codes.js

| | |
|---|---|
| lookups | 7 verified, 0 failed |
| race | 1 round, exactly one winner, R4 replay identical |
| R2 misses | 3 of 3 byte-identical (unknown, typo, wrong shop) |
| expired | NOT MEASURED, no code old enough |
| unexpected answers | 0 of 10 |
| checks | 18 passed, 0 failed, exit 0 |
| lookup | p95 370ms |
| hold | p95 452ms |
| redeem | p95 354ms |
| public check | p95 439ms |

## Cleanup

    npx vite-node loadtest/checkout-codes-make.mts -- --cleanup

`{"redeemed":1,"reserved":2}`. The two reserved codes were made with the
shortest `x` (about 01:32 UTC) and expire then by design.

## Not verified

- No ramp, on purpose: staging is shared.
- The `expired` scenario has run only against the stub.
- The `ramping-arrival-rate` configuration has been checked with `k6 inspect`,
  not run.
- Generation above three codes, and therefore issuance's per-IP limit on this
  path, has not been met.
