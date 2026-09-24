# Staging dashboard review, 2026-09-24

A sweep of the Grafana dashboards on staging, after `/v1/swap` p95 1.70s prompted
[the swap investigation](staging-2026-09-24-swap-latency.md). Six issues filed
across five repositories.

Method: the Grafana API proxied to the staging Prometheus, over the full
seven-day retention. No access to service logs or databases, so everything here
is metrics and several issues end with a request for the row-level detail.

## What is firing

Three alerts, two of them `critical` / `route: pagerduty`:

| Alert | Value | Verdict |
|---|---|---|
| `MintQuotePaidUnissued` | 8 | **real**, and monotonic over three days |
| `PaymentAdapterPaidUnforwarded` | 9 | **real**, single step at 22:07 |
| `TracePublisherDisabledStaging` | 1 | **expected**, documented in the rules file |

The third is correct behaviour, not a defect: the publisher is deliberately off
on staging and the rules file says so.

## The incident

Everything below happened inside one 70-minute window tonight, and the pieces
are almost certainly connected.

| Time (UTC) | Event | Filed as |
|---|---|---|
| 22:07 | `payment_adapter_paid_unforwarded` 0 → 9 | `payment-adapter#246` |
| 22:18 | `/webhook/payment` starts refusing, 183/h | `cashu-mint#468` |
| 22:19 | `webhook_event{outcome=amount_mismatch}` 0 → 194 | `cashu-mint#468` |
| 23:17 | `cashu_mint_quote_paid_unissued` 7 → 8 | `cashu-mint#469` |
| ~00:21 | `gateway-portal` voucher endpoints begin 500ing | `imani-gateway-portal#44` |
| now | 2430 mismatches, ~18/min, **zero successes** | |

**The headline finding is the webhook flood.** Over two hours
`/webhook/payment` answered **2241 x 422 against 28 x 200**, a 98.8% rejection
rate, every one of them `amount_mismatch`. It is running right now at 17.7
rejections per minute with zero successes, and it is still climbing.

No customer-paid voucher can be funded while that holds.

## The issues

| Repo | Issue | What |
|---|---|---|
| `cashu-mint` | [#468](https://github.com/398ja/cashu-mint/issues/468) | Every payment webhook refused as `amount_mismatch` |
| `cashu-mint` | [#469](https://github.com/398ja/cashu-mint/issues/469) | Paid-unissued quotes only ever increase, 2 → 8 over three days |
| `payment-adapter` | [#246](https://github.com/398ja/payment-adapter/issues/246) | Nine settled payments never forwarded to the mint |
| `imani-deploy` | [#61](https://github.com/398ja/imani-deploy/issues/61) | A 98.8% rejection rate fired no alert |
| `imani-gateway-customer` | [#104](https://github.com/398ja/imani-gateway-customer/issues/104) | Concurrent issuance races on the same backing proofs |
| `imani-gateway-portal` | [#44](https://github.com/398ja/imani-gateway-portal/issues/44) | Every portal voucher write returns 500 |

## The monitoring gap is the durable finding

`imani-deploy#61` deserves picking up even after the others are fixed.

There are **55 alert rules** across nine files, and **none watches the webhook
rejection rate**. The loudest signal in the system, an endpoint refusing
everything at 18/min, produced no page. What did page were its quietest
consequences: two gauges counting in ones and nines, several steps downstream.

`VoucherUnfundedRejectedOnly` was the closest existing rule and stayed at **0**
throughout, because it counts *quotes left unfunded* rather than *payments
refused*.

Three properties made this invisible, and all three will recur:

1. The gauges count **survivors, not casualties**: by the time `paid_unissued`
   moves, the damage is done.
2. A **rate** of failure is not a **level** of failure. Nothing expresses "this
   endpoint is refusing everything".
3. **Ratio, not count.** 28 successes and 2241 rejections are each unremarkable
   alone; together they are a total outage.

## What was checked and found healthy

Recorded so the next reviewer does not repeat it:

| Area | Finding |
|---|---|
| Scrape targets | 7 up, 0 down |
| JVM heap | 17-44% across all five services |
| GC pause | ~0s p99 everywhere |
| Restarts | none within 2h |
| nostrdb cache | 353,755 events, healthy counters |
| float replication | 7,313 proofs, 32.8M sats published |
| `net_conntrack_dialer_conn_failed_total` | 2,967, but **all `job=prometheus`**: historical scrape failures from service restarts, not a user-facing path |

That last one is worth noting as a near-miss: it is the largest number on the
dashboards and it means nothing. Chasing it first would have cost an hour.

## Corroboration of the swap investigation

The mint's own error counters confirm what was measured from the client side in
[the swap report](staging-2026-09-24-swap-latency.md):

```
23  /v1/swap                            http_400
18  /v1/mint/quote/{method}/{quote_id}  http_400
 9  /v1/mint/quote/{method}/{quote_id}  http_500
```

Those 23 swap 400s are the `Proof already used` refusals in `#104`, seen from
the server.
