# Staging market day at 100 customers, with corda and bart (2026-11-06)

## Setup

- **Stack:** wallet v0.57.0, gateway-core 0.37.0, gateway-customer 0.42.0, gateway-portal 0.18.0, payment-adapter 0.29.0.
- **Stalls:** 10 in total.
  - Slots 0 and 1 were the real merchants **corda** (`1c4be7be…`) and **bart** (`b233db85…`). Both held `coupon:issue`, checked with `probe-acl.mjs`.
  - Slots 2 to 9 were pool test stalls.
  - Customers came from the pool, at index 10 and up.
- **Command:** `DAY_DURATION=20m CUSTOMER_PEAK=100 STALL_COUNT=10 k6 run loadtest/market-day.js`, 13:48:39 to 14:09:14 UTC.
- **Checks before the run:**
  - signer check passed (0 invalid);
  - smoke test 9/9;
  - a 60 s dry run at 4 customers: 4 minted, 148 checks, 0 failed.
- **Purchase Issuer:** not measured. `PURCHASE_API_URL` was unset.

## Result

**gateway-customer ran out of heap and was out of service from about 13:58 until it was restarted at 14:15.** k6 exited 0 and all 7194 checks passed, so the run read as green. It was not: the harness's checks do not cover the voucher poll that failed.

| Measure | 2026-10-01 (130 customers) | This run (100 customers) |
|---|---|---|
| Coupons minted / delivered | 98 / 98 | **22 / 18**, 4 never minted |
| Mint wait (seller's view) | about 6 s | **avg 111 s, p95 252 s** |
| `http_req_failed` | 0.17% | **9.3%** (952 of 10,262) |
| `http_req_duration` p95 | 262 ms | **60 s** (the client timeout) |
| Customer drains | 7833, 72 envelopes | 2497, 36 envelopes (they still worked) |
| Stall takings drains | | 1200, p95 592 ms (still worked) |
| Edge: `GET /api/v1/wallet/vouchers/{id}` | | **730 × 499, 141 × 504, 7 × 500, 4 × 502**, 117 × 200 |
| Edge: `POST /api/v1/nostr/query` | | 47 × 504 |

Drains and the takings poll are on gateway-core and stayed healthy. Every failure was on gateway-customer.

## What happened on gateway-customer

| Time (UTC) | Event |
|---|---|
| 13:49 to 13:52 | CPU 120 to 216%. Sales poll `GET /wallet/vouchers/{id}`, and each pending voucher is finalised (mint, swap) on the request thread. Mint `checkstate` calls take 6 to 7 s. |
| 13:50:04 | First `11001 Proof already used` on a swap. Several sales selected the same float proofs at once. |
| 13:51 to 13:56 | `prepare_retried_after_spent_proofs` and `settled_swap_inputs_retired` each run `reconcileSpentProofs` over the **whole float, about 20,700 unspent proofs** (`checked=20719` at the next start), in batches of 100. Up to **8 of these ran at the same time**, on separate request threads, each holding the full proof list and its Y index in memory. The mint's circuit breaker opened, producing 1,767 `reconcile_spent_batch_failed` lines. **10 sales were aborted as `quote_already_issued`**: the mint had minted them, the gateway lost the proofs, and recovery goes through imani-wallet-lib#104. Finalisation locks were held for up to 439 s. |
| 13:57 | `OutOfMemoryError: Java heap space`, first in Tomcat's poller thread. The heap is `-Xmx512m`, under a 1408m container limit. |
| 13:57:36 onwards | The H2 wallet store closed (`The database has been closed [90098]`), 2,754 times. Every voucher request failed, so the edge returned 499/504. |
| 14:00 to 14:15 | gateway-customer was idle at 0% CPU but **reported `unhealthy` and was never restarted**: docker does not restart on health. |
| 14:14:31 | I saved the log to `/home/nostr/gateway-customer-oom-20261106T1414.log` (37 MB) and restarted the container. It was healthy within 50 s. The startup reconcile over 20,719 proofs ran for about 8 minutes at 100 to 170% CPU, retired 23 spent proofs, and settled at 940 MiB. A smoke test afterwards passed 9/9. |

## Root cause (to confirm in an issue)

1. **The full float reconciles on the request path, and several times at once.** Each sale that hits a spent proof starts a whole-float `reconcileSpentProofs` (about 20,700 proofs, 207 mint calls). Nothing stops concurrent runs, so N sales mean N copies of the float in the heap and N times the mint load. One run would have been enough.
2. **The float is large and shared.** Every portal sale draws from gateway-customer's single H2 float, selected largest-first. Concurrent sales therefore collide on the same proofs (11001), which is what triggers (1).
3. **A 512 MB heap leaves little room** once the float is resident several times.
4. **An OOM leaves the process alive and broken.** Neither `-XX:+ExitOnOutOfMemoryError` nor a restart on unhealthy is set, so the service stayed down until someone restarted it by hand.

## Proposed fixes

- **Single-flight reconcile** (wallet-lib or gateway-customer): one reconcile per mint at a time. Other callers wait for it, or reuse its result.
- **Stream the float.** Page `listProofs` by id instead of loading every row, and stop holding the full Y map.
- **Add `-XX:+ExitOnOutOfMemoryError`** to gateway-customer, and the other Java services, so docker's `restart: unless-stopped` brings it back. Also add an alert for `unhealthy` for more than 2 minutes.
- **Reduce proof collisions.** Randomise proof selection among the candidates, or reserve proofs before the mint swap, so concurrent sales stop picking the same proofs.
- Then **re-run this scenario** at 100 customers and expect about 100 minted at a mint wait under 10 s.

## Harness findings

- **k6 passed a run in which the service was down for half the day.** The voucher poll's 499/504 answers were not counted as check failures. Add a threshold on `coupons_delivered / sales attempted`, and on `http_req_failed{name=voucher_poll}`.
- **The per-address auth limit refused some stalls' first logins** (7 × `auth/init` or `auth/complete` 429 at 13:48:48). Those stalls recovered later in the run.

## Effect on corda and bart

Some of the 22 coupons were minted by corda and bart. All of them are real staging coupons in their histories, takings and business metrics, as agreed before the run. Their keys were in a temporary pool file during the run only. That file and `merchant-keys.env` have been shredded, and the pool file is back to its original 140 test identities.
