# Staging load run and Grafana review, 2026-09-30

A k6 market-day run against staging, followed by a check of every Grafana
dashboard panel over the run window. Stack under test: cashu-mint 0.41.0,
gateway-customer 0.19.1, wallet-lib 0.6.2.

## The run

- **Script:** `loadtest/market-day.js`, with `DAY_DURATION=6m CUSTOMER_PEAK=4 STALL_COUNT=3`. It was small on purpose, the same scale as the 2026-09-23 run, because staging limits a caller address to 100 requests a minute.
- **Where:** from a laptop over WAN to `https://wallet.staging.398ja.xyz`, 20:50:18 to 20:56:21 UTC.
- **Before the run:**
  - signer check: 0 invalid signatures, 377/s
  - smoke test: 9/9 checks
  - `stalls.mjs --verify`: 3 of 3 stalls could issue
- **Not covered:** the Purchase Issuer behaviour did not run, because `PURCHASE_API_URL` was unset.

| Measure | Result |
|---|---|
| Checks | **428 passed, 0 failed** |
| HTTP requests | 491, 1.35/s, **1 failed** (0.2%) |
| `http_req_duration` | avg 103 ms, med 123 ms, **p95 230 ms**, max 1.74 s |
| Coupons minted and delivered | 4 of 4 |
| Mint wait | avg 138 ms, p95 157 ms, 1 poll each |
| Customer drains | 109 (5 envelopes) |
| Stall drains | 109 (0 envelopes) |
| Signing share | 2.1% of an iteration |

Compared with 2026-09-23, the two-population drain latency (17% of drains at a fixed ~2.2 s) is gone. The drain p95 is now under 400 ms per iteration.

### Server side, over the run window

| Measure | Result |
|---|---|
| 5xx on any gateway or the mint | **0** |
| New 429s | **0** (the counter stayed at 1) |
| Mint non-2xx | **0** |
| Circuit breakers open | **0** |
| Hikari pending connections | **0** |
| JVM heap | 11% to 46% across the services |
| Process CPU | at most 0.3% |
| gateway-core p95 | drain 83 ms, `profiles/{pubkey}/relays` 56 ms (was 2.13 s on 2026-09-24), `auth/validate` 3 ms |
| gateway-portal `POST /portal/vouchers` avg | **1212 ms** (the Sell path) |
| gateway-customer `/internal/v1/wallet/vouchers` avg | **1204 ms**; `/dm/tokens/send` 724 ms |

At this scale the stack is healthy: no errors, no throttling, and no resource
pressure. The slowest step is issuance (about 1.2 s at the portal and at
gateway-customer). Nothing can compute a p95 for it or alert on it (see
imani-deploy#91).

## The dashboards

All **238 panel queries** in the 19 dashboards were run over 20:45 to 20:57.

| Dashboard | Data | Empty | Why empty |
|---|---|---|---|
| cashu-mint-integrity | 25 | 0 | |
| cashu-mint-operations | 8 | 0 | |
| cashu-mint-overview | 9 | 0 | |
| float-replication | 16 | 0 | |
| mint-circuit-breakers | 9 | 0 | |
| nostrdb-cache | 12 | 0 | |
| redemption-audit-ledger | 17 | 0 | |
| voucher-liability-overview | 4 | 0 | |
| voucher-token-integrity | 5 | 0 | |
| voucher-iou-liability | 2 | 1 | "Outstanding IOUs" returns no rows: nothing is owed |
| cashu-mint-slo | 9 | 7 | The SLI divides the 5xx rate by the total, and at zero 5xx the numerator has no series (#85). With `or vector(0)` it reads 100% |
| cashu-mint-vt | 6 | 10 | Lock waits are rare (9 in the last hour), so `rate()` over 1m is empty. No Tomcat thread metrics exist (#85) |
| cashback-overview | 3 | 4 | No cashback was generated in the window. The error ratio divides 0 by 0 |
| payment-receipts-014 | 6 | 17 | `wallet_payment_*` is not exported by anything (#83) |
| trace-publisher-048 | 1 | 12 | The publisher is disabled on staging (#84) |
| support-agent (4 dashboards) | 1 | 54 | The agent is not running on staging, so its scrape target is down (#86) |
| **Total** | **133** | **105** | **0 query errors** |

Of the 105 empty queries:
- **Known dashboard issues:** 83, covered by imani-deploy #83, #84, #85 and #86.
- **Correct:** 15, where nothing happened to measure (no lock contention, no cashback, no IOUs).
- **Zero-denominator:** 7 SLO panels, also #85.

## Alerts

| Alert | State | Verdict |
|---|---|---|
| TracePublisherDisabledStaging | firing | expected (the publisher is off on staging) |
| MintQuotePaidUnissued | firing | real backlog of 17 PAID quotes (#163 and older) |
| PaymentAdapterPaidUnforwarded | firing | real, 9, unchanged since 2026-09-24 (payment-adapter#246) |
| SupportAgentMetricsDown | firing | expected (#86) |
| PaidUnissuedGrowing | pending | the count went from 16 to 17 when I made a live NUT-20 quote at 17:28 (imani-gateway-customer#163). It was not caused by the load |

The load raised no new alert.

## New findings, filed

| Issue | Severity | Finding |
|---|---|---|
| imani-deploy#90 | 3 | Each gateway healthcheck curls an unmapped `/health` every 10 s. That adds about 6 requests a minute of 403/404 to every tier's request metrics: 71% of what gateway-portal recorded during the run. The check also accepts any status code, so a gateway answering 500 still counts as healthy |
| imani-deploy#91 | 2 | Only gateway-core exports latency histograms, so `GatewayRequestLatencyHigh` cannot fire for gateway-customer or gateway-portal, where the 1.2 s issuance calls are |

## Limitations

- **Scale:** 4 customers and 3 stalls over 6 minutes is a correctness and health check, not a capacity test. The per-address rate limit caps a single-origin run. A capacity run needs several origins, or to run inside the deployment (see README "Keep MAX_VUS low over a tunnel").
- **Purchase Issuer:** not measured (`PURCHASE_API_URL` unset).
- **Sends and redemption:** the device does these, so they are outside this mix (ADR 0003, 0004).
