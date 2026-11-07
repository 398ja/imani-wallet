# Real market day: smoke, FAIL

- **Population:** 5 customers + 2 stalls (0:corda, 1:bart)
- **Split:** 3 customers and 2 stalls in the real app (Playwright), 2 customers in the k6 crowd (market-day.js)
- **Target:** https://wallet.staging.398ja.xyz, day 5m, SEED=550
- **Started:** 2026-11-07T12:15:19.082Z, ran 741s
- **Rate-limit probe:** no 429 on 6 probes (200)
- **Limits still on (paced by the harness):**
  - register: paced to 8/min under gateway-core path-rate-limit 10/min/address on /api/v1/nip05 and /api/v1/accounts/register (no override)
  - codes: paced to 12/min under imani-checkout-codes CHECKOUT_CODES_RL_PER_IP (60/min/IP default; a code is several calls)
  - claims: paced to 6/min under cashback-claim per-address claim limiter (not lifted)

## Journeys

| journey | attempts | ok | fail | 429 app | 429 pacing | skip | success | p50 | p95 | p99 |
|---|---|---|---|---|---|---|---|---|---|---|
| arrive | 3 | 3 | 0 | 0 | 0 | 0 | 100% | 17.7s | 17.7s | 17.7s |
| buy | 2 | 2 | 0 | 0 | 0 | 0 | 100% | 17.7s | 17.7s | 17.7s |
| pay | 1 | 1 | 0 | 0 | 0 | 0 | 100% | 5.0s | 5.0s | 5.0s |
| send | 1 | 1 | 0 | 0 | 0 | 0 | 100% | 9.1s | 9.1s | 9.1s |
| link | 1 | 1 | 0 | 0 | 0 | 0 | 100% | 20.5s | 20.5s | 20.5s |
| online | 1 | 0 | 0 | 0 | 0 | 1 | - | - | - | - |
| cashlink | 1 | 1 | 0 | 0 | 0 | 0 | 100% | 25.7s | 25.7s | 25.7s |
| browse | 1 | 1 | 0 | 0 | 0 | 0 | 100% | 11.1s | 11.1s | 11.1s |
| card | 1 | 1 | 0 | 0 | 0 | 0 | 100% | 133.8s | 133.8s | 133.8s |
| leave | 1 | 1 | 0 | 0 | 0 | 0 | 100% | 7.5s | 7.5s | 7.5s |

### SKIPs

- **online**: code made in 5.1s and taken by the shop's cart (cart total 43.9 -> 42.9); redemption needs the shop admin (E2E_SHOP_ADMIN_PASSWORD unset)

## Gates

- PASS arrive success >= 95%: 3/3
- PASS buy success >= 95%: 2/2
- PASS buy p95 < 20s: p95 17.7s
- PASS pay success >= 95%: 1/1
- PASS pay p95 < 20s: p95 5.0s
- PASS send success >= 95%: 1/1
- PASS send p95 < 30s: p95 9.1s
- PASS link success >= 95%: 1/1
- PASS cashlink success >= 95%: 1/1
- PASS browse success >= 95%: 1/1
- PASS card success >= 95%: 1/1
- PASS leave success >= 95%: 1/1
- PASS harness paced under the un-lifted limits (no 429 there): none
- PASS no uncaught page errors: none
- PASS no settled-but-not-saved: none
- FAIL money is conserved: cust0004 EUR observed 99 expected 100
- FAIL k6 sale_delivered > 95%: 50.0%
- PASS k6 voucher-poll failures < 5%: 0.0%
- FAIL k6 thresholds held: sale_delivered

## Money

- EUR: observed change 99, expected 100 (issued 300, burnt 200, links outstanding 0) minor units
- GBP: observed change 200, expected 200 (issued 200, burnt 0, links outstanding 0) minor units

## k6 crowd

- exit 99; sale_delivered 50.0%; voucher-poll failed 0.0%
- boot_ticks: 2
- coupons_acquired: 2
- coupons_delivered: 1
- customer_drains: 32
- customer_envelopes: 1
- data_received: 241215
- data_sent: 217484
- failed: 1
- hidden_ticks: 19
- http_reqs: 340
- iterations: 130
- receipt_drains: 60
- receipts_drained: 0
- stall_drains: 60
- succeeded: 1

## Timeline (per minute)

| min | started | completed | failed |
|---|---|---|---|
| 0 | 0 | 0 | 0 |
| 1 | 1 | 0 | 0 |
| 2 | 1 | 1 | 0 |
| 3 | 1 | 1 | 0 |
| 4 | 3 | 3 | 0 |
| 5 | 2 | 2 | 0 |
| 6 | 2 | 1 | 0 |
| 7 | 2 | 2 | 0 |
| 8 | 0 | 0 | 0 |
| 9 | 1 | 1 | 0 |
| 10 | 0 | 1 | 0 |

## Notes

- Real-stall public records the guard kept from being republished (the app tried on login and retried): bart: blocked a kind-30078 d=imani:merchant publish via gateway mirror (with online_shop) x130; bart: blocked a kind-30078 d=imani:merchant publish via relay (with online_shop) x63; bart: blocked a kind-30078 d=imani:terminals publish via gateway mirror (unreadable content) x10; bart: blocked a kind-30078 d=imani:terminals publish via relay (unreadable content) x5
- FINDING (#123, not gated: first login of an existing wallet on a fresh device): settled-but-not-saved logged for receives from its history, 46 lines: [corda] [tokenRedemption] receive replayed without a fresh token — not saved, needs reconciliation {fp: 3beabd56, receiveId: 1cdb1808-4cc8-4092-aaec-b80752397663} || [corda] [unsaved-receipt] RECEIVE_SETTLED_NOT_SAVED {receiveId: 1cdb1808-4cc8-4092-aaec-b80752397663, eventId: 2c1038fc…, reason: replay-without-token, at: 2026-11-07T12:15:28.006Z} || [corda] [tokenRedemption] receive replayed without a fresh token — not saved, needs reconciliation {fp: 3827a0cc, receiveId: ce753ce1-40cd-47dc-ba65-6af044355672} || [corda] [unsaved-receipt] RECEIVE_SETTLED_NOT_SAVED {receiveId: ce753ce1-40cd-47dc-ba65-6af044355672, eventId: 47217312…, reason: replay-without-token, at: 2026-11-07T12:15:28.872Z}
