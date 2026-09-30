# Staging market day at full scale, 2026-09-30 (130 customers, 10 stalls)

The same k6 mix as [the small run earlier today](staging-2026-09-30-market-day-grafana.md), at the README's full population. Stack: cashu-mint 0.41.0, gateway-customer 0.19.1, gateway-core on imani-bom 0.2.2.

## Setup

- `pool.mjs --size 140 --verify`: 30 grown to 140, 140/140 usable.
- `stalls.mjs --count 10 --verify`: 7 enrolled (about 61 s for the ACL each), **10/10 issued a real coupon**.
- Signer: 0 invalid signatures, 373/s. Smoke test: 9/9.
- `DAY_DURATION=20m CUSTOMER_PEAK=130 STALL_COUNT=10`, from a laptop to `https://wallet.staging.398ja.xyz`, 21:37:47 to 21:58:21 UTC.

## Result: gateway-core wedged, so the run is invalid as a capacity measurement

| Measure | Small run (4/3) | This run (130/10) |
|---|---|---|
| Checks | 428 passed, 0 failed | 1546 passed, **1472 failed** |
| HTTP failed | 0.2% | **49%** |
| `http_req_duration` p95 | 230 ms | **59.8 s** (k6's 60 s timeout) |
| Coupons minted | 4/4 | **0** |
| Envelopes drained | 5 | 0 |

**Edge responses per minute:**

```
21:37  200=9    201=1
21:38  200=53   499=1   504=2
21:39  200=21   499=21  504=10
21:40  200=4    499=56  504=6
21:41-21:53  200=4  499=77..115 per minute
```

- `up{job="gateway-core"}` = 0 from **21:38:10**, about 20 s into the ramp, until a manual restart at 22:01. The container reported `unhealthy` the whole time.
- gateway-core did **not recover** after the load stopped.
- gateway-customer, gateway-portal and the mint were healthy throughout: no 5xx, no 429, low CPU and heap. The failure was confined to gateway-core.

## Root cause (imani-gateway-core#115, severity 1)

1. **A relay lookup inside every auth decision.** Every NIP-98 request resolves the caller's ACL. `MerchantAclService.decide` reads `nap_acl` through a pooled JDBC connection, then asks the relay whether the key has a stall record, with a 5 s timeout.
2. **130 new keys at once:** every lookup missed the 60 s cache. The relay did not answer in time, so each decision took **5.55 s**.
3. **Resources ran out:** all 10 `ApiKeyPool` connections were checked out by stalled decisions (Postgres showed them `idle`, not busy), and 4 virtual-thread carriers served everything.
4. **Everything queued behind the pool:** 169 `acl_resolve_failed`, up to 124 threads waiting, the metrics scrape and the healthcheck included.
5. **Fail-open to a customer role:** stalls lost `coupon:issue` as a side effect, so 0 coupons were minted.

Logs saved at `$JCODE_SCRATCH_DIR/gwcore-wedge-2026-09-30.log` (93,802 lines).

## Monitoring gaps this exposed

- **No alert on `up == 0`** for any service tier: 23 minutes of a dead gateway-core paged nobody. Filed as imani-deploy#92 (severity 2).
- **Frozen metrics:** a wedged tier's metrics freeze at the last good scrape, so Grafana showed a healthy Hikari pool (pending 0) throughout.

## What this says about capacity

The small run's clean result (p95 230 ms) does **not** extend to a realistic crowd. The first bottleneck is gateway-core's auth path, reached with fewer than 130 concurrent new users. That is well before the mint issuance limit, which this run never reached. A capacity figure needs #115 fixed first. Then rerun this exact command to find the next limit.

## Reproduce

    node loadtest/pool.mjs --size 140
    node loadtest/stalls.mjs --count 10 --verify
    DAY_DURATION=20m CUSTOMER_PEAK=130 STALL_COUNT=10 k6 run loadtest/market-day.js

Expect gateway-core to stop answering within about 30 s. It needs `docker restart gateway-core` afterwards.
