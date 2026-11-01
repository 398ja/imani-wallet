# Staging market day at full scale, after the fix (130 customers, 10 stalls, run 3)

This report covers a rerun of the [full-scale market day that wedged gateway-core](staging-2026-09-30-market-day-130.md), on imani-gateway-core **v0.17.3**. The fix for imani-gateway-core#115 reads merchants' stall records from gateway-core's own nostrdb instead of asking the relay on every new session. Nothing else on staging changed between the two runs.

## Setup

- Stack: gateway-core v0.17.3 (imani-bom 0.1.121), gateway-customer 0.19.1, cashu-mint 0.41.0.
- Before the run:
  - gateway-core's log showed `stall_record_replay complete pages=1 records=82` before the server started.
  - Smoke test: 9/9.
  - `stalls.mjs --count 10 --verify`: 10/10 stalls can issue.
- Run: `DAY_DURATION=20m CUSTOMER_PEAK=130 STALL_COUNT=10 k6 run loadtest/market-day.js`, from 2026-10-01 01:00:25 to 01:20:37 UTC, same pool and stalls as run 2.
- k6 exit code: 0. Every threshold held.

## Result

| Measure | Run 2 (v0.17.2) | Run 3 (v0.17.3) |
|---|---|---|
| Checks | 1546 passed, 1472 failed | **17806 passed, 0 failed** |
| HTTP failed | 48.9% | **0.17%** (29 × 429 from the per-address auth limit, 3 × 401) |
| `http_req_duration` p95 | 59.8 s | **262 ms** |
| Coupons minted / delivered | 0 / 0 | **98 / 98** |
| Customer drains | 1235, 0 envelopes | 7833, 72 envelopes |
| Per iteration, customer | avg 18.3 s, p95 60 s | avg 156 ms, p95 291 ms |
| `up{job="gateway-core"}` | 0 from 21:38:10 until a manual restart | **1 throughout** |
| Edge 499 / 504 | about 1,500 | **0** |

Run 3's 0.17% failures are expected throttling, not errors. All 32 of gateway-core's non-2xx responses were 429s on `/api/v1/auth/init` and `/auth/validate`, from k6's single source address hitting the documented per-address limit. There were no 5xx.

## What changed on the server

| Signal | Run 2 | Run 3 |
|---|---|---|
| `acl_resolve_failed` / `Connection is not available` | 169 | **0** |
| `ApiKeyPool` connections, max active / pending | 10 / up to 124 | **3 / 0** |
| Relay queries in the permission check | 3 or 4 at a time, each 5.5 s | **none** |
| gateway-core p95 latency (Prometheus) | no data, scrapes timed out | **103 ms** |
| Peak CPU: gateway-core / gateway-customer / mint | (scrape blocked) / 18% / 1% | 10% / 22% / 7% |

The only relay queries left in gateway-core during run 3 came from `IncomingNotificationService`, which reads the incoming-notification cache, and they took 59 to 78 ms. The permission check never contacted the relay.

## Dashboards

Over the run-3 window, 126 of 238 panel queries returned data, 112 were empty, and none errored. Run 1 had 132 with data and 51 empty across the dashboards it reported.

The empty panels are mostly ones with nothing to measure in this window:
- the support-agent dashboards (no support traffic);
- the mint's lock and Tomcat panels (the metrics are not exported, see #85);
- the mint's error and task-failure panels. These held data in run 1 and are empty now because no mint errors or task failures happened in this window, so `cashu_mint_task_failure_total`, `cashu_mint_requests_errors_total` and the 4xx/5xx series do not exist yet.

None of the empty panels hides an outage.

## Capacity

At 130 concurrent customers and 10 stalls, the gateway tier sits far below its limits:
- p95 is 262 ms at the edge;
- gateway-core's p95 is 103 ms;
- at most 3 of 10 API-key connections were in use, with none ever waiting;
- CPU peaked at 22% on gateway-customer and 10% on gateway-core.

The first limit the run reached was the per-address auth rate limit, which is a property of a single load-generator address, not of the service. Measuring true capacity means spreading the load across addresses or keys (see the [run-1 report](staging-2026-09-30-market-day-grafana.md) on how), then raising `CUSTOMER_PEAK` until latency or errors climb.

## What is left

These are follow-ups from the reviews of the fix. None of them showed in this run.

- imani-wallet-lib#127 (severity 2): the relay client drops subscriptions when it reconnects. gateway-core works around it by reopening its subscription every 5 minutes.
- imani-security#21 (severity 2): the NIP-98 filter accepts uppercase pubkeys. gateway-core now denies them itself.
- imani-deploy#93 (severity 3): gateway-core has no persistent nostrdb volume in prod.
- imani-wallet-lib#128 (severity 3): nostrdb pruning is a no-op, and the configured map size is never applied.
- imani-deploy#92 (severity 2): no alert fires when a tier's metrics scrape goes down (`up == 0`).

## Reproduce

    node loadtest/signer.mjs &
    GATEWAY_URL=https://wallet.staging.398ja.xyz node loadtest/stalls.mjs --count 10 --verify
    DAY_DURATION=20m CUSTOMER_PEAK=130 STALL_COUNT=10 k6 run loadtest/market-day.js

If `stalls.mjs --verify` reports `auth/init 429`, wait a minute: that is the per-address rate limit, not a fault.
